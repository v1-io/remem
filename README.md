# remem

`remem` records one memory artifact per coding session and retrieves relevant prior sessions back into agent context on each new prompt.

## What ships in this repo

- A local-first `remem` CLI with prompt-time retrieval.
- A SQLite FTS index and JSON artifact store under `~/.remem/`.
- A small HTTP sync server for cross-machine sharing.
- Agent integrations in `integrations/`.

## Why this is fast

- No daemon.
- No vector database.
- No embeddings on the hot path.
- Deterministic lexical retrieval over session summaries, files, symbols, errors, and prompt samples.

## Quick start

If you just want to try `remem` locally:

```bash
git clone https://github.com/v1-io/remem.git
cd remem
npm link
remem doctor
```

Then choose one integration:

- Claude Code: follow [Claude Code install](#claude-code-install) or run `remem init claude`
- Codex: follow [Codex install](#codex-install) or run `remem init codex`
- Cross-machine sync: follow [Cloud sync](#cloud-sync)

`npm link` puts `remem` on your `PATH`. That is the easiest way to let hook scripts call the CLI from any repo.

## Config

Create `~/.config/remem/config.json`:

```json
{
  "sync": {
    "baseUrl": "http://127.0.0.1:8787",
    "token": "replace-me",
    "workspace": "personal"
  }
}
```

Environment variables override config file values:

- `REMEM_ROOT`
- `REMEM_CONFIG_PATH`
- `REMEM_SYNC_URL`
- `REMEM_SYNC_TOKEN`
- `REMEM_WORKSPACE`
- `REMEM_DEVICE_NAME`

## Claude Code install

Claude Code uses project-local hook config. Install `remem` once, then add the hook files to each repo where you want memory retrieval.

Recommended setup for the current repo:

```bash
remem init claude
```

Manual setup if you want to install the files yourself:

1. Install the CLI once:

```bash
npm link
```

2. In the project where you use Claude Code, create the hook directories:

```bash
mkdir -p .claude integrations/claude/scripts
```

3. Copy the Claude integration files from this repo into that project:

```bash
cp /path/to/remem/integrations/claude/settings.json .claude/settings.json
cp /path/to/remem/integrations/claude/scripts/remem-hook.sh integrations/claude/scripts/remem-hook.sh
chmod +x integrations/claude/scripts/remem-hook.sh
```

4. If you already have `.claude/settings.json`, merge the `hooks` block from [integrations/claude/settings.json](/Users/danielhostetler/src/remem/integrations/claude/settings.json) instead of overwriting it.

5. Start Claude Code in that project and verify the hook can find `remem`:

```bash
remem doctor
claude
```

What Claude will do after install:

- On session start: create or recover the pending session record.
- On each prompt submit: search prior memories and inject a compact relevant summary.
- On stop: finalize the session into a durable memory artifact.

## Codex install

Codex uses a marketplace file plus a local plugin directory. The official Codex docs describe two supported patterns:

- repo-scoped marketplace at `$REPO_ROOT/.agents/plugins/marketplace.json`
- personal marketplace at `~/.agents/plugins/marketplace.json`

This repo includes a sample repo-scoped marketplace file.

Recommended setup:

Repo-local:

```bash
remem init codex
```

Personal:

```bash
remem init codex --personal
```

Manual setup if you want to install the files yourself:

1. Install the CLI once:

```bash
npm link
remem doctor
```

2. In the repo where you use Codex, copy the Codex plugin into `plugins/`:

```bash
mkdir -p ./plugins
cp -R /path/to/remem/integrations/codex ./plugins/remem-codex
```

3. Add or update `$REPO_ROOT/.agents/plugins/marketplace.json`:

```json
{
  "name": "local-repo",
  "interface": {
    "displayName": "Remem Local Plugins"
  },
  "plugins": [
    {
      "name": "remem-codex",
      "source": {
        "source": "local",
        "path": "./plugins/remem-codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Coding"
    }
  ]
}
```

This repo already includes a sample marketplace file at [.agents/plugins/marketplace.json](/Users/danielhostetler/src/remem/.agents/plugins/marketplace.json). Update its `source.path` so it matches the plugin location you chose.

4. Restart Codex so it reloads marketplaces.

5. Open the plugin directory in Codex and verify that the marketplace and plugin appear, then install or enable `remem-codex`.

6. If your Codex build still requires the experimental hook flag, enable it:

```bash
codex features enable codex_hooks
```

7. Restart Codex again if you changed feature flags.

Personal install instead of repo install:

- Copy the plugin to `~/.codex/plugins/remem-codex`
- Add a personal marketplace at `~/.agents/plugins/marketplace.json`
- Point `source.path` at the plugin directory relative to your home directory

Example personal marketplace entry:

```json
{
  "name": "remem-local",
  "interface": {
    "displayName": "Remem Local Plugins"
  },
  "plugins": [
    {
      "name": "remem-codex",
      "source": {
        "source": "local",
        "path": "./.codex/plugins/remem-codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Coding"
    }
  ]
}
```

What Codex will do after install:

- On session start: create or recover the pending session record.
- On each prompt submit: retrieve relevant prior sessions into prompt context.
- On stop: finalize and optionally sync the session memory.

## Cloud sync

`remem` works locally without sync. Add sync only if you want to share memory artifacts across machines.

1. Start the sync server on a machine you control:

```bash
node ./bin/remem.js sync serve 8787
```

2. Register a device and get a token:

```bash
curl -X POST http://127.0.0.1:8787/v1/devices/register \
  -H 'content-type: application/json' \
  -d '{"workspace":"personal","deviceName":"laptop"}'
```

3. Save that token in `~/.config/remem/config.json` on each machine:

```json
{
  "sync": {
    "baseUrl": "http://127.0.0.1:8787",
    "token": "replace-me",
    "workspace": "personal"
  }
}
```

4. Keep using Claude Code or Codex normally. `remem` will push finalized session artifacts on stop and pull remote updates before retrieval when the local sync state is stale.

## Hook lifecycle

- `session-start`: open or recover a pending session record.
- `user-prompt`: append the current prompt to the pending session, pull remote updates if stale, search prior memories, and print a bounded context block.
- `stop`: finalize the session into one durable artifact and push it if sync is enabled.

## Local usage

```bash
printf '{"session_id":"abc","cwd":"%s"}' "$PWD" | node ./bin/remem.js hook session-start
printf '{"session_id":"abc","cwd":"%s","prompt":"The ThreadContext component seems to have a race condition preventing threads from rendering"}' "$PWD" | node ./bin/remem.js hook user-prompt
printf '{"session_id":"abc","cwd":"%s"}' "$PWD" | node ./bin/remem.js hook stop
```

## Sync server API

The built-in sync server exposes:

- `GET /v1/healthz`
- `POST /v1/artifacts`
- `GET /v1/artifacts?since=<ended_at>`
- `POST /v1/devices/register`

## Integration files

- Codex plugin manifest: [integrations/codex/.codex-plugin/plugin.json](/Users/danielhostetler/src/remem/integrations/codex/.codex-plugin/plugin.json)
- Codex hooks: [integrations/codex/hooks.json](/Users/danielhostetler/src/remem/integrations/codex/hooks.json)
- Claude hooks: [integrations/claude/settings.json](/Users/danielhostetler/src/remem/integrations/claude/settings.json)

## Testing

```bash
npm test
```
