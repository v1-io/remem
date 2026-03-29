import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function templatePath(...segments) {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ...segments);
}

function ensureExecutable(filePath) {
  fs.chmodSync(filePath, 0o755);
}

function upsertMarketplaceEntry(marketplacePath, entry, marketplaceName = "remem-local") {
  const payload = readJson(marketplacePath, {
    name: marketplaceName,
    interface: {
      displayName: "Remem Local Plugins",
    },
    plugins: [],
  });

  if (!Array.isArray(payload.plugins)) {
    payload.plugins = [];
  }

  const index = payload.plugins.findIndex((plugin) => plugin?.name === entry.name);
  if (index >= 0) {
    payload.plugins[index] = entry;
  } else {
    payload.plugins.push(entry);
  }

  writeJson(marketplacePath, payload);
}

export function initClaude(targetDir = process.cwd()) {
  const repoRoot = path.resolve(targetDir);
  const claudeSettingsPath = path.join(repoRoot, ".claude", "settings.json");
  const claudeScriptPath = path.join(repoRoot, "integrations", "claude", "scripts", "remem-hook.sh");

  const templateSettings = readJson(templatePath("integrations", "claude", "settings.json"), {});
  const existingSettings = readJson(claudeSettingsPath, {});
  const mergedSettings = {
    ...existingSettings,
    hooks: {
      ...(existingSettings.hooks ?? {}),
      ...(templateSettings.hooks ?? {}),
    },
  };

  writeJson(claudeSettingsPath, mergedSettings);
  fs.mkdirSync(path.dirname(claudeScriptPath), { recursive: true });
  fs.copyFileSync(templatePath("integrations", "claude", "scripts", "remem-hook.sh"), claudeScriptPath);
  ensureExecutable(claudeScriptPath);

  return {
    agent: "claude",
    repoRoot,
    files: [claudeSettingsPath, claudeScriptPath],
  };
}

export function initCodex(targetDir = process.cwd(), options = {}) {
  const personal = Boolean(options.personal);
  const repoRoot = path.resolve(targetDir);
  const pluginRoot = personal
    ? path.join(os.homedir(), ".codex", "plugins", "remem-codex")
    : path.join(repoRoot, "plugins", "remem-codex");
  const marketplacePath = personal
    ? path.join(os.homedir(), ".agents", "plugins", "marketplace.json")
    : path.join(repoRoot, ".agents", "plugins", "marketplace.json");
  const sourcePath = personal ? "./.codex/plugins/remem-codex" : "./plugins/remem-codex";

  fs.mkdirSync(path.dirname(pluginRoot), { recursive: true });
  fs.rmSync(pluginRoot, { recursive: true, force: true });
  fs.cpSync(templatePath("integrations", "codex"), pluginRoot, { recursive: true });
  ensureExecutable(path.join(pluginRoot, "scripts", "remem-hook.sh"));

  upsertMarketplaceEntry(
    marketplacePath,
    {
      name: "remem-codex",
      source: {
        source: "local",
        path: sourcePath,
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Coding",
    },
    personal ? "remem-local" : "local-repo",
  );

  return {
    agent: "codex",
    personal,
    repoRoot,
    files: [pluginRoot, marketplacePath],
    nextSteps: [
      "Restart Codex so it reloads marketplaces.",
      "Open the plugin directory in Codex and enable remem-codex.",
      "If needed, run: codex features enable codex_hooks",
    ],
  };
}
