---
topic: Embedding OpenCode as a sandboxed agent child process
date: 2026-07-02
tags: [opencode, agent, security, integrations]
---

# Embedding OpenCode: what the docs assume vs what ships

Grounded against opencode 1.17.13 + @opencode-ai/sdk (2026-07). Version
drifts near-daily; re-verify these before major upgrades.

## Config schema drift

The permission config no longer has `websearch`/`task`/`skill` keys (the
plan assumed it did). Current lockdown = two layers:

- `permission: { edit, bash, webfetch, external_directory, doom_loop }`
  with "deny" — `external_directory: "deny"` is what scopes READS to the
  project dir.
- `tools: { write: false, edit: false, patch: false, bash: false,
  webfetch: false, websearch: false, task: false, skill: false }` — the
  boolean map is where non-permission tools get disabled.

## Key mechanics

- `opencode serve` has NO directory flag: scope by spawning with
  `cwd = <project>`.
- Inject config via the `OPENCODE_CONFIG_CONTENT` env var (JSON) — never
  touch the user's opencode.json.
- `OPENCODE_SERVER_PASSWORD` enables HTTP basic auth, username `opencode`.
  Pass `Authorization: Basic base64(opencode:pw)` via client headers.
- Parse the port from the stdout line `opencode server listening on <url>`
  (spawn with `--port=0`). The SDK's own `createOpencodeServer` spawns bare
  `opencode` from PATH and inherits cwd — useless for GUI launches; spawn
  the detected binary yourself.
- Connected state: `~/.local/share/opencode/auth.json` has provider
  entries (read key names only, never values).
- Custom tools without polluting anything: `config.plugin: [abs-path.mjs]`
  loads a plugin from ANY path; the plugin's `Hooks.tool` map registers
  tools (`import { tool } from "@opencode-ai/plugin"` resolves inside
  opencode's bun runtime). Tool `execute(args, ctx)` gets `ctx.sessionID`.
  This is how Solaris keeps its propose-only mutation path with all
  write tools denied.
- Async prompting: `session.promptAsync` + the global `client.event`
  SSE stream; filter events by `properties.sessionID` (nested variously
  under `info`/`part`/`message`).

## Sandbox self-test (added after v1)

- `OPENCODE_CONFIG_CONTENT` is MERGED with the user's global opencode
  config: user-level permission entries and MCP tool enables (e.g.
  `exa_*: true`) ride along inside the "sandboxed" child. They are
  user-sanctioned but mean extra capabilities beyond the lockdown.
- `client.tool.ids()` lists tools regardless of enablement — useless for
  capability assertions. `client.config.get()` returns the effective
  merged config — assert the injected deny/false keys survived there.
- Solaris fails closed: if any lockdown key is missing/weakened in the
  effective config, the child is killed and Agent mode 503s
  (sandbox-unverified). User MCP enables are surfaced as sandbox notes in
  /api/agent/status, not failures.
