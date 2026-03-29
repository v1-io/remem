import fs from "node:fs";
import crypto from "node:crypto";
import { createServer } from "node:http";

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getSyncState(config) {
  return readJson(config.paths.syncStatePath, {
    lastPullEndedAt: "",
    lastPushEndedAt: "",
  });
}

function setSyncState(config, nextState) {
  writeJson(config.paths.syncStatePath, nextState);
}

function authHeaders(config) {
  return config.sync.token ? { authorization: `Bearer ${config.sync.token}` } : {};
}

export async function pushArtifacts(store, config) {
  if (!config.sync.baseUrl || !config.sync.token) {
    return { pushed: 0, skipped: true };
  }
  const state = getSyncState(config);
  const artifacts = store.listArtifactsSince(state.lastPushEndedAt);
  let pushed = 0;
  for (const artifact of artifacts) {
    const response = await fetch(new URL("/v1/artifacts", config.sync.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(config),
      },
      body: JSON.stringify({
        workspace: config.sync.workspace,
        artifact,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to push artifact ${artifact.session_id}: ${response.status}`);
    }
    pushed += 1;
    state.lastPushEndedAt = artifact.ended_at;
  }
  setSyncState(config, state);
  return { pushed, skipped: false };
}

export async function pullArtifacts(store, config) {
  if (!config.sync.baseUrl || !config.sync.token) {
    return { pulled: 0, skipped: true };
  }
  const state = getSyncState(config);
  const url = new URL("/v1/artifacts", config.sync.baseUrl);
  if (state.lastPullEndedAt) {
    url.searchParams.set("since", state.lastPullEndedAt);
  }
  url.searchParams.set("workspace", config.sync.workspace);
  const response = await fetch(url, {
    headers: authHeaders(config),
  });
  if (!response.ok) {
    throw new Error(`Failed to pull artifacts: ${response.status}`);
  }
  const body = await response.json();
  let pulled = 0;
  for (const artifact of body.artifacts ?? []) {
    store.upsertRemoteArtifact(artifact);
    state.lastPullEndedAt = artifact.ended_at;
    pulled += 1;
  }
  setSyncState(config, state);
  return { pulled, skipped: false };
}

export async function maybeAutoPull(store, config) {
  if (!config.sync.autoPull) {
    return;
  }
  const state = getSyncState(config);
  const lastPull = Date.parse(state.lastPullEndedAt || 0);
  const stale = !lastPull || Date.now() - lastPull > config.retrieval.staleSyncMs;
  if (stale) {
    await pullArtifacts(store, config);
  }
}

export function createSyncServer({ config, store }) {
  const tokens = readJson(config.paths.tokensPath, { tokens: [] });

  function isAuthorized(request) {
    const expected = request.headers.authorization || "";
    return tokens.tokens.some((tokenEntry) => expected === `Bearer ${tokenEntry.token}`);
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (url.pathname === "/v1/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/devices/register") {
      const body = await readRequestBody(request);
      const token = crypto.randomBytes(24).toString("hex");
      tokens.tokens.push({
        token,
        workspace: body.workspace || "default",
        deviceName: body.deviceName || "unknown",
      });
      writeJson(config.paths.tokensPath, tokens);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ token }));
      return;
    }

    if (!isAuthorized(request)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/artifacts") {
      const body = await readRequestBody(request);
      store.upsertRemoteArtifact(body.artifact);
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/artifacts") {
      const since = url.searchParams.get("since") || "";
      const artifacts = store.listArtifactsSince(since);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ artifacts }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}
