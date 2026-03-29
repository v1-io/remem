import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { initClaude, initCodex } from "../src/init.js";
import { MemoryStore } from "../src/store.js";
import { retrieveContext } from "../src/retrieve.js";
import { createSyncServer, pullArtifacts, pushArtifacts } from "../src/sync.js";

function withTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remem-"));
  process.env.REMEM_ROOT = root;
  process.env.REMEM_CONFIG_PATH = path.join(root, "config.json");
  return root;
}

function cleanupEnv() {
  delete process.env.REMEM_ROOT;
  delete process.env.REMEM_CONFIG_PATH;
  delete process.env.REMEM_SYNC_URL;
  delete process.env.REMEM_SYNC_TOKEN;
  delete process.env.REMEM_WORKSPACE;
}

test("session lifecycle indexes a finalized memory and retrieves it by symbol", async () => {
  const root = withTempRoot();
  const config = loadConfig();
  const store = new MemoryStore(config);

  store.startSession({ session_id: "s1", cwd: "/repo/app" }, { agent: "codex" });
  store.appendPrompt("s1", "The ThreadContext component seems to have a race condition preventing threads from rendering");
  store.finalizeSession({ session_id: "s1" }, { agent: "codex" });

  store.startSession({ session_id: "s2", cwd: "/repo/app" }, { agent: "codex" });
  const context = retrieveContext(store, config, {
    sessionId: "s2",
    projectRoot: "/repo/app",
    promptText: "Check ThreadContext before we debug the rendering race condition again",
  });

  assert.match(context.text, /ThreadContext/);
  assert.equal(context.results[0].sessionId, "s1");

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
  cleanupEnv();
});

test("sync server replicates artifacts between machines", async () => {
  const serverRoot = withTempRoot();
  const serverConfig = loadConfig();
  const serverStore = new MemoryStore(serverConfig);
  const server = createSyncServer({ config: serverConfig, store: serverStore });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const registerResponse = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: "test", deviceName: "laptop" }),
  });
  const { token } = await registerResponse.json();

  process.env.REMEM_SYNC_URL = baseUrl;
  process.env.REMEM_SYNC_TOKEN = token;
  process.env.REMEM_WORKSPACE = "test";

  const clientOneRoot = withTempRoot();
  process.env.REMEM_SYNC_URL = baseUrl;
  process.env.REMEM_SYNC_TOKEN = token;
  process.env.REMEM_WORKSPACE = "test";
  const clientOneConfig = loadConfig();
  const clientOneStore = new MemoryStore(clientOneConfig);
  clientOneStore.startSession({ session_id: "shared-1", cwd: "/repo/app" }, { agent: "codex" });
  clientOneStore.appendPrompt("shared-1", "Investigate ThreadContext render ordering bug");
  clientOneStore.finalizeSession({ session_id: "shared-1" }, { agent: "codex" });
  const pushResult = await pushArtifacts(clientOneStore, clientOneConfig);
  assert.equal(pushResult.pushed, 1);

  const clientTwoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remem-"));
  process.env.REMEM_ROOT = clientTwoRoot;
  process.env.REMEM_CONFIG_PATH = path.join(clientTwoRoot, "config.json");
  process.env.REMEM_SYNC_URL = baseUrl;
  process.env.REMEM_SYNC_TOKEN = token;
  process.env.REMEM_WORKSPACE = "test";
  const clientTwoConfig = loadConfig();
  const clientTwoStore = new MemoryStore(clientTwoConfig);
  const pullResult = await pullArtifacts(clientTwoStore, clientTwoConfig);
  assert.equal(pullResult.pulled, 1);

  clientTwoStore.startSession({ session_id: "query-1", cwd: "/repo/app" }, { agent: "codex" });
  const context = retrieveContext(clientTwoStore, clientTwoConfig, {
    sessionId: "query-1",
    projectRoot: "/repo/app",
    promptText: "Something regressed in ThreadContext ordering",
  });
  assert.match(context.text, /ThreadContext/);

  clientOneStore.close();
  clientTwoStore.close();
  server.close();
  serverStore.close();
  fs.rmSync(serverRoot, { recursive: true, force: true });
  fs.rmSync(clientOneRoot, { recursive: true, force: true });
  fs.rmSync(clientTwoRoot, { recursive: true, force: true });
  cleanupEnv();
});

test("initClaude installs hook config and script into a target repo", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remem-claude-"));
  const result = initClaude(repoRoot);

  assert.equal(result.agent, "claude");
  assert.equal(fs.existsSync(path.join(repoRoot, ".claude", "settings.json")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "integrations", "claude", "scripts", "remem-hook.sh")), true);

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test("initCodex installs plugin and marketplace into a target repo", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remem-codex-"));
  const result = initCodex(repoRoot);

  assert.equal(result.agent, "codex");
  assert.equal(fs.existsSync(path.join(repoRoot, "plugins", "remem-codex", ".codex-plugin", "plugin.json")), true);

  const marketplace = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
  );
  assert.equal(marketplace.plugins[0].source.path, "./plugins/remem-codex");

  fs.rmSync(repoRoot, { recursive: true, force: true });
});
