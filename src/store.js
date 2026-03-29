import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ensureBaseDirs } from "./config.js";
import { buildPromptFeatures, buildSessionSummary, uniq } from "./extract.js";

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeProjectName(projectRoot) {
  return projectRoot.replaceAll(path.sep, "__").replaceAll(":", "");
}

export class MemoryStore {
  constructor(config) {
    this.config = config;
    ensureBaseDirs(config);
    this.db = new DatabaseSync(config.paths.dbPath, { timeout: 2000 });
    this.setupDb();
  }

  close() {
    this.db.close();
  }

  setupDb() {
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memories (
        session_id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        project_root TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        files_json TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        errors_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        checksum TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        session_id UNINDEXED,
        project_root,
        summary,
        files,
        symbols,
        errors,
        tags,
        prompt_samples,
        tokenize = 'porter unicode61'
      );
    `);
  }

  getPendingSessionPath(sessionId) {
    return path.join(this.config.paths.sessionsDir, `${sessionId}.json`);
  }

  startSession(payload, options = {}) {
    const sessionId = String(payload.session_id || payload.sessionId || crypto.randomUUID());
    const cwd = payload.cwd || process.cwd();
    const now = new Date().toISOString();
    const sessionPath = this.getPendingSessionPath(sessionId);
    const existing = readJson(sessionPath, null);
    const session = existing ?? {
      version: 1,
      sessionId,
      agent: options.agent || payload.agent || "unknown",
      projectRoot: cwd,
      transcriptPath: payload.transcript_path || payload.transcriptPath || "",
      startedAt: now,
      updatedAt: now,
      promptSamples: [],
      files: [],
      symbols: [],
      errors: [],
      tags: [],
      entities: [],
      lastAssistantMessage: "",
      pendingInjections: [],
    };
    session.updatedAt = now;
    writeJson(sessionPath, session);
    return session;
  }

  appendPrompt(sessionId, promptText) {
    const sessionPath = this.getPendingSessionPath(sessionId);
    const session = readJson(sessionPath, null);
    if (!session) {
      throw new Error(`Session ${sessionId} not initialized`);
    }

    const features = buildPromptFeatures(promptText);
    if (!features.text) {
      return session;
    }

    session.promptSamples.push({
      text: features.text,
      ts: new Date().toISOString(),
    });
    session.files = uniq([...session.files, ...features.files]);
    session.symbols = uniq([...session.symbols, ...features.symbols]);
    session.errors = uniq([...session.errors, ...features.errors]);
    session.tags = uniq([...session.tags, ...features.tags]);
    session.entities = uniq([...session.entities, ...features.phrases]);
    session.updatedAt = new Date().toISOString();
    writeJson(sessionPath, session);
    return session;
  }

  markInjected(sessionId, injectedSessionIds) {
    const sessionPath = this.getPendingSessionPath(sessionId);
    const session = readJson(sessionPath, null);
    if (!session) {
      return;
    }
    session.pendingInjections = uniq([...(session.pendingInjections ?? []), ...injectedSessionIds]);
    session.updatedAt = new Date().toISOString();
    writeJson(sessionPath, session);
  }

  getPendingSession(sessionId) {
    return readJson(this.getPendingSessionPath(sessionId), null);
  }

  finalizeSession(payload, options = {}) {
    const sessionId = String(payload.session_id || payload.sessionId || "");
    if (!sessionId) {
      throw new Error("Missing session_id for finalize");
    }

    const sessionPath = this.getPendingSessionPath(sessionId);
    const session = readJson(sessionPath, null);
    if (!session) {
      return null;
    }

    if (typeof payload.last_assistant_message === "string") {
      session.lastAssistantMessage = payload.last_assistant_message;
    }
    if (typeof payload.lastAssistantMessage === "string") {
      session.lastAssistantMessage = payload.lastAssistantMessage;
    }

    const endedAt = new Date().toISOString();
    const artifact = {
      version: 1,
      session_id: session.sessionId,
      agent: options.agent || session.agent,
      project_root: session.projectRoot,
      started_at: session.startedAt,
      ended_at: endedAt,
      summary: buildSessionSummary(session),
      files: session.files,
      symbols: session.symbols,
      entities: session.entities,
      errors: session.errors,
      tags: session.tags,
      raw_prompt_samples: session.promptSamples.slice(-8),
      raw_transcript_ref: session.transcriptPath,
      origin_device: this.config.sync.deviceName,
      last_assistant_message: session.lastAssistantMessage,
    };

    const checksum = crypto.createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
    artifact.checksum = checksum;

    const projectDir = path.join(this.config.paths.artifactsDir, safeProjectName(session.projectRoot));
    fs.mkdirSync(projectDir, { recursive: true });
    const artifactPath = path.join(projectDir, `${sessionId}.json`);
    writeJson(artifactPath, artifact);

    this.db.prepare(`
      INSERT INTO memories (
        session_id, agent, project_root, started_at, ended_at, summary, artifact_path,
        files_json, symbols_json, errors_json, tags_json, checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        agent = excluded.agent,
        project_root = excluded.project_root,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        summary = excluded.summary,
        artifact_path = excluded.artifact_path,
        files_json = excluded.files_json,
        symbols_json = excluded.symbols_json,
        errors_json = excluded.errors_json,
        tags_json = excluded.tags_json,
        checksum = excluded.checksum
    `).run(
      artifact.session_id,
      artifact.agent,
      artifact.project_root,
      artifact.started_at,
      artifact.ended_at,
      artifact.summary,
      artifactPath,
      JSON.stringify(artifact.files),
      JSON.stringify(artifact.symbols),
      JSON.stringify(artifact.errors),
      JSON.stringify(artifact.tags),
      artifact.checksum,
    );

    const memoryRow = this.db.prepare(`SELECT rowid FROM memories WHERE session_id = ?`).get(artifact.session_id);
    this.db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(memoryRow.rowid);
    this.db.prepare(`
      INSERT INTO memories_fts (
        rowid, session_id, project_root, summary, files, symbols, errors, tags, prompt_samples
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoryRow.rowid,
      artifact.session_id,
      artifact.project_root,
      artifact.summary,
      artifact.files.join(" "),
      artifact.symbols.join(" "),
      artifact.errors.join(" "),
      artifact.tags.join(" "),
      artifact.raw_prompt_samples.map((sample) => sample.text).join(" "),
    );

    fs.rmSync(sessionPath, { force: true });
    return artifact;
  }

  maybeRecoverPendingSessions() {
    const files = fs.readdirSync(this.config.paths.sessionsDir).filter((entry) => entry.endsWith(".json"));
    for (const file of files) {
      const sessionPath = path.join(this.config.paths.sessionsDir, file);
      const session = readJson(sessionPath, null);
      if (!session) {
        continue;
      }
      const updatedAt = Date.parse(session.updatedAt || session.startedAt || 0);
      if (Number.isNaN(updatedAt)) {
        continue;
      }
      const ageMs = Date.now() - updatedAt;
      if (ageMs > 30 * 60 * 1000) {
        this.finalizeSession({ session_id: session.sessionId }, { agent: session.agent });
      }
    }
  }

  queryMemories({ query, projectRoot, limit, excludeSessionIds = [] }) {
    const queryText = buildSearchQuery(query);
    if (!queryText) {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT
        m.session_id,
        m.project_root,
        m.started_at,
        m.ended_at,
        m.summary,
        m.artifact_path,
        m.files_json,
        m.symbols_json,
        m.errors_json,
        m.tags_json,
        bm25(memories_fts, 5.0, 4.0, 3.0, 6.0, 5.0, 4.0, 2.0, 1.0) AS rank
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
      LIMIT ?
    `).all(queryText, limit * 5);

    return rows
      .map((row) => {
        const score = scoreRow(row, { query, projectRoot });
        return {
          sessionId: row.session_id,
          projectRoot: row.project_root,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          summary: row.summary,
          artifactPath: row.artifact_path,
          files: JSON.parse(row.files_json),
          symbols: JSON.parse(row.symbols_json),
          errors: JSON.parse(row.errors_json),
          tags: JSON.parse(row.tags_json),
          score,
        };
      })
      .filter((row) => !excludeSessionIds.includes(row.sessionId))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  upsertRemoteArtifact(artifact) {
    const projectDir = path.join(this.config.paths.artifactsDir, safeProjectName(artifact.project_root));
    fs.mkdirSync(projectDir, { recursive: true });
    const artifactPath = path.join(projectDir, `${artifact.session_id}.json`);
    writeJson(artifactPath, artifact);

    this.db.prepare(`
      INSERT INTO memories (
        session_id, agent, project_root, started_at, ended_at, summary, artifact_path,
        files_json, symbols_json, errors_json, tags_json, checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        agent = excluded.agent,
        project_root = excluded.project_root,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        summary = excluded.summary,
        artifact_path = excluded.artifact_path,
        files_json = excluded.files_json,
        symbols_json = excluded.symbols_json,
        errors_json = excluded.errors_json,
        tags_json = excluded.tags_json,
        checksum = excluded.checksum
    `).run(
      artifact.session_id,
      artifact.agent,
      artifact.project_root,
      artifact.started_at,
      artifact.ended_at,
      artifact.summary,
      artifactPath,
      JSON.stringify(artifact.files ?? []),
      JSON.stringify(artifact.symbols ?? []),
      JSON.stringify(artifact.errors ?? []),
      JSON.stringify(artifact.tags ?? []),
      artifact.checksum ?? "",
    );

    const memoryRow = this.db.prepare(`SELECT rowid FROM memories WHERE session_id = ?`).get(artifact.session_id);
    this.db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(memoryRow.rowid);
    this.db.prepare(`
      INSERT INTO memories_fts (
        rowid, session_id, project_root, summary, files, symbols, errors, tags, prompt_samples
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoryRow.rowid,
      artifact.session_id,
      artifact.project_root,
      artifact.summary,
      (artifact.files ?? []).join(" "),
      (artifact.symbols ?? []).join(" "),
      (artifact.errors ?? []).join(" "),
      (artifact.tags ?? []).join(" "),
      (artifact.raw_prompt_samples ?? []).map((sample) => sample.text).join(" "),
    );
  }

  listArtifactsSince(cursorEndedAt = "") {
    if (!cursorEndedAt) {
      return this.db.prepare(`
        SELECT artifact_path FROM memories ORDER BY ended_at ASC
      `).all().map((row) => readJson(row.artifact_path, null)).filter(Boolean);
    }

    return this.db.prepare(`
      SELECT artifact_path FROM memories WHERE ended_at > ? ORDER BY ended_at ASC
    `).all(cursorEndedAt).map((row) => readJson(row.artifact_path, null)).filter(Boolean);
  }
}

function scoreRow(row, { query, projectRoot }) {
  let score = Math.max(0.1, 30 - Number(row.rank || 0));
  for (const symbol of query.symbols) {
    if (JSON.parse(row.symbols_json).includes(symbol)) {
      score += 10;
    }
  }
  for (const file of query.files) {
    if (JSON.parse(row.files_json).includes(file)) {
      score += 8;
    }
  }
  for (const error of query.errors) {
    if (JSON.parse(row.errors_json).includes(error)) {
      score += 4;
    }
  }
  if (row.project_root === projectRoot) {
    score += 6;
  }
  return score;
}

function buildSearchQuery(query) {
  const pieces = [];
  pieces.push(...query.symbols.map((value) => `"${value}"`));
  pieces.push(...query.files.map((value) => `"${value}"`));
  pieces.push(...query.phrases.map((value) => `"${value}"`));
  pieces.push(...query.errors.map((value) => `"${value}"`));
  pieces.push(...query.terms.slice(0, 10));
  return uniq(pieces).join(" OR ");
}
