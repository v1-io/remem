import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_CONFIG = {
  local: {
    rootDir: path.join(os.homedir(), ".remem"),
  },
  retrieval: {
    limit: 5,
    minScore: 1.5,
    maxContextChars: 2400,
    staleSyncMs: 5 * 60 * 1000,
  },
  sync: {
    baseUrl: "",
    token: "",
    workspace: "default",
    deviceName: os.hostname(),
    autoPush: true,
    autoPull: true,
  },
};

function merge(base, overrides) {
  const next = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      next[key] = merge(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

export function getConfigPath() {
  return process.env.REMEM_CONFIG_PATH || path.join(os.homedir(), ".config", "remem", "config.json");
}

export function loadConfig() {
  const configPath = getConfigPath();
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  const envConfig = {
    sync: {
      baseUrl: process.env.REMEM_SYNC_URL || undefined,
      token: process.env.REMEM_SYNC_TOKEN || undefined,
      workspace: process.env.REMEM_WORKSPACE || undefined,
      deviceName: process.env.REMEM_DEVICE_NAME || undefined,
    },
    local: {
      rootDir: process.env.REMEM_ROOT || undefined,
    },
  };

  const config = merge(DEFAULT_CONFIG, merge(fileConfig, envConfig));
  config.paths = buildPaths(config.local.rootDir);
  return config;
}

export function buildPaths(rootDir) {
  return {
    rootDir,
    artifactsDir: path.join(rootDir, "artifacts"),
    sessionsDir: path.join(rootDir, "sessions"),
    dbPath: path.join(rootDir, "index.sqlite"),
    syncStatePath: path.join(rootDir, "sync-state.json"),
    tokensPath: path.join(rootDir, "tokens.json"),
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureBaseDirs(config) {
  ensureDir(config.paths.rootDir);
  ensureDir(config.paths.artifactsDir);
  ensureDir(config.paths.sessionsDir);
}
