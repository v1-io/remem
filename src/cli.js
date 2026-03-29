import fs from "node:fs";
import { loadConfig } from "./config.js";
import { extractPrompt } from "./extract.js";
import { initClaude, initCodex } from "./init.js";

async function readStdinJson() {
  if (process.stdin.isTTY) {
    return {};
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function printUsage() {
  process.stdout.write(`remem

Usage:
  remem init claude [repo-dir]
  remem init codex [repo-dir]
  remem init codex --personal
  remem hook session-start
  remem hook user-prompt
  remem hook stop
  remem sync push
  remem sync pull
  remem sync serve [port]
  remem doctor
`);
}

async function runHook(eventName, config, store, helpers) {
  const payload = await readStdinJson();
  store.maybeRecoverPendingSessions();

  if (eventName === "session-start") {
    store.startSession(payload, { agent: inferAgent(payload) });
    process.stdout.write("");
    return;
  }

  if (eventName === "user-prompt") {
    const session = store.startSession(payload, { agent: inferAgent(payload) });
    await helpers.maybeAutoPull(store, config);
    const promptText = extractPrompt(payload);
    if (!promptText) {
      return;
    }
    store.appendPrompt(session.sessionId, promptText);
    const context = helpers.retrieveContext(store, config, {
      sessionId: session.sessionId,
      projectRoot: session.projectRoot,
      promptText,
    });
    if (context.results.length > 0) {
      store.markInjected(session.sessionId, context.results.map((result) => result.sessionId));
      process.stdout.write(`${context.text}\n`);
    }
    return;
  }

  if (eventName === "stop") {
    const artifact = store.finalizeSession(payload, { agent: inferAgent(payload) });
    if (artifact && config.sync.autoPush) {
      await helpers.pushArtifacts(store, config);
    }
    process.stdout.write("");
    return;
  }

  throw new Error(`Unknown hook event: ${eventName}`);
}

function inferAgent(payload) {
  return payload.agent || payload.hook_event_name || payload.hookEventName || process.env.REMEM_AGENT || "unknown";
}

export async function main(args) {
  const [command, subcommand, extra] = args;
  if (!command) {
    printUsage();
    return;
  }

  if (command === "init") {
    if (subcommand === "claude") {
      const result = initClaude(extra || process.cwd());
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (subcommand === "codex") {
      const personal = args.includes("--personal");
      const targetDir = personal ? process.cwd() : extra || process.cwd();
      const result = initCodex(targetDir, { personal });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
  }

  const { MemoryStore } = await import("./store.js");
  const { retrieveContext } = await import("./retrieve.js");
  const { createSyncServer, maybeAutoPull, pullArtifacts, pushArtifacts } = await import("./sync.js");
  const config = loadConfig();
  const store = new MemoryStore(config);

  try {
    if (command === "hook") {
      await runHook(subcommand, config, store, { retrieveContext, maybeAutoPull, pushArtifacts });
      return;
    }

    if (command === "sync" && subcommand === "push") {
      process.stdout.write(`${JSON.stringify(await pushArtifacts(store, config), null, 2)}\n`);
      return;
    }

    if (command === "sync" && subcommand === "pull") {
      process.stdout.write(`${JSON.stringify(await pullArtifacts(store, config), null, 2)}\n`);
      return;
    }

    if (command === "sync" && subcommand === "serve") {
      const port = Number(extra || process.env.PORT || 8787);
      const server = createSyncServer({ config, store });
      await new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          process.stdout.write(`remem sync server listening on http://127.0.0.1:${port}\n`);
        });
        process.on("SIGINT", () => {
          server.close(() => resolve());
        });
      });
      return;
    }

    if (command === "doctor") {
      const report = {
        node: process.version,
        configPath: process.env.REMEM_CONFIG_PATH || "default",
        rootDir: config.paths.rootDir,
        dbExists: fs.existsSync(config.paths.dbPath),
        artifactsDirExists: fs.existsSync(config.paths.artifactsDir),
        syncConfigured: Boolean(config.sync.baseUrl && config.sync.token),
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    printUsage();
  } finally {
    store.close();
  }
}
