# AGENTS.md - Sinapso

Sinapso is a local-first 3D visualizer for an Obsidian vault (or any folder of interlinked Markdown). It scans the vault into a graph and renders it as a navigable 3D force-directed map; click a note to read it in a side pane, double-click to open it in Obsidian. Fork of `chntnm/akasha`, MIT.

## Strategic Context

`STRATEGY.md` owns product direction, metrics, tracks, and exclusions. `PRODUCT.md` translates that direction plus shipped evidence into the product promise, current/planned experience, business model, and trust contract. `ROADMAP.md`, when present, owns mutable outcome sequencing. `CONTEXT.md`, when needed, is the domain glossary. Durable implementation prose is limited to `docs/plans/` and `docs/solutions/`; marketing work lives outside the repository by default.

## Tech Stack and Infrastructure

- Vite + TypeScript frontend, Express loopback server, and Electron desktop shell; npm is the package manager.
- No application database. Optional semantic search reads qmd's SQLite index read-only.
- BYO secrets live in the local `~/.sinapso/config.json`; they stay server-side and are never returned by APIs.

## Development

```bash
npm install
npm run scan -- "<vault-path>" [--exclude rel/path]...   # build data/graph.json (incremental; cached by mtime+size)
npm run dev                                               # vite (5173) + express (5175), hot-reload → http://localhost:5173
npm test                                                  # vitest: server/unit + pure frontend modules
npm run test:e2e                                          # Playwright smoke + browser diagnostics
npm run typecheck                                         # tsc --noEmit
npm run build                                             # build web/ for prod
npm start                                                 # serve built app on http://localhost:5175
npm run desktop                                           # Electron shell (GPU unlocked)
```

Rescan without restarting: `/api/rescan` (or File → Rescan) re-parses changed files and hot-swaps the graph.

## Development Harness

- Required serial gate: `npm test && npm run typecheck && npm run build && npm run test:e2e`.
- Vitest covers server/unit and pure frontend modules and excludes `.scratchpad/`. There is no React component runner; frontend logic is tested as pure modules with Vitest and browser behavior with Playwright.
- Playwright is hermetic: frontend `6173`, dedicated backend `6175`, one worker, Chromium only. All 10 tests must run with zero skips and zero failures, independent of services on development ports.
- Browser diagnostics fail on unallowlisted console, page, request, or HTTP 500+ errors. Each test writes and attaches its own diagnostic artifact; the most recently completed test is also written to `test-results/browser-diagnostics.json`.
- The Codebase Memory graph is available for architecture navigation and impact analysis.
- Future implementation-ready plans enter tracking through `harness-progress init`, then use `harness-progress next` and `harness-progress verify`; historical features remain immutable.
- codebase-memory-mcp project = Users-felo-Documents-GitHub-sinapso 

## Architecture

- `scanner/scan.ts` — walks the vault; parses `[[wiki]]` (by basename) + `[text](path.md)` (relative) links and YAML frontmatter (`title`/`type`/`tags`); emits `data/graph.json`. Pure, file-cacheable. Exclude list in `DEFAULT_EXCLUDES`.
- `server/app.ts` — Express app factory, bound to **127.0.0.1 only**. `GET /api/graph`, `/api/note?id=`, `/api/search`, `POST /api/rescan`, `/api/layout`.
- `web/src/main.ts` — the frontend shell (Three.js / `3d-force-graph`, reader pane, menubar, DOM wiring). Pure frontend logic lives in `web/src/theme.ts`, `spectrum.ts`, `filters.ts`, `clusters.ts`, `api.ts`, `prefs.ts`, `editor.ts` (CM6 live-preview editor core), `editor-toolbar.ts` (selection bubble + markdown transforms), `autosave.ts` (save state machine), and `ai-assist.ts` (selection-assist envelope/apply). `web/index.html` is the DOM skeleton, `web/src/style.css` the chrome.
- `desktop/main.ts` — Electron shell that runs the server and loads it in a hardened window (`contextIsolation: true`, `nodeIntegration: false`).
- `bin/cli.ts` — zero-install `npx` on-ramp (scan + serve + open; `--addons` installs missing qmd/markitdown).
- `server/integrations/` — the optional integrations layer (all detection-based, core works without any tool):
  - `config.ts` — `~/.sinapso/config.json` (0600): Exa + OpenRouter keys, web consent, default model, addons state, active vault path, vault-scoped wiki config, and prompt overrides. `loadConfig()` is mtime-cached; `updateConfig()` refreshes the cache. Secrets never appear in API responses.
  - `detect.ts` — qmd/markitdown detection: PATH, known install dirs (`~/.bun/bin`, `~/.local/bin`), login-shell fallback. Injectable runner for tests.
  - `security.ts` — Host/Origin validation on all routes + per-session token (`x-sinapso-token`) on mutating/spending routes (CSRF/DNS-rebinding guard).
  - `paths.ts` — shared vault-note path confinement for read routes and the write path: `.md` only, `phantom:` rejected, traversal rejected, route-specific 400/404 behavior preserved.
  - `gates.ts` — shared route gate helpers for web consent + Exa key, OpenRouter key, and markitdown availability. Helpers write the route's existing response body/status; do not normalize divergent messages without auditing callers.
  - `wiki.ts` — discovers folders named exactly `wiki`, detects `AGENTS.md`/`CLAUDE.md`/`index.md`/`README.md`, assigns confidence, and merges saved enabled/label/rawDestination state.
  - `qmd.ts` — Semantic mode: `/api/related`, `/api/semantic-search`, setup/status. vsearch queries are `vec:`-typed (untyped triggers 30s+ LLM expansion; see `docs/solutions/qmd-vsearch-latency.md`).
  - `qmd-vectors.ts` — **the semantic layer's data source** (F030): opens `~/.cache/qmd/index.sqlite` READ-ONLY (better-sqlite3 + sqlite-vec, lazy-required so a wrong-ABI binary degrades to "unavailable" not a crash). `docVector`/`allDocVectors`/`knn`; dimension read from the `vectors_vec float[N]` schema (never hardcode 768); reconciles qmd collection paths → graph.json node ids via `store_collections`. Quarantines ALL sqlite coupling behind a schema guard.
  - `semantic.ts` — mutual-KNN edge builder (F031): `data/semantic.json` (gitignored) via `GET /api/semantic` (builds once, caches by graph fingerprint). Anti-hairball: mutual-KNN + cosine≥0.5 + K≤8. Feeds arrangement modes (F032), semantic-cluster grouping (F033), orphan suggestions (F034).
  - `topology.ts` — phantoms/orphans/sparse clusters → `/api/gaps` suggestions (orphans enriched with their top semantic neighbor from the cached edges); also the template fallback for `/api/note-questions`.
  - `excerpt.ts` — markdown/frontmatter cleanup for note excerpts and qmd query text (`excerptFor`, `norm`, `stripSnippet`, `clip`).
  - `questions.ts` — OpenRouter note-question prompt assembly, JSON-array parsing, and LLM fallback orchestration; routes keep the `{ questions, source }` adapter shape.
  - `notes-index.ts` — MiniSearch index construction/snippets and literal `/api/note-grep` matching with context windows. `SearchIndex.grepAll` reuses the in-memory contents for `search_vault`'s global literal (exact) scan.
  - `search-vault.ts` — pure helpers for the consolidated agent discovery route `/api/search-vault` (modes `auto`/`semantic`/`exact`/`path`, multi-query merge/dedup, folder/note scope, vault-confined path matching; no regex).
  - `exa.ts` — Web mode: `/api/research` proxy (deep synthesis only); the exa-js request shape stays behind this adapter only.
  - `openrouter.ts` — the shared OpenAI-compatible chat-completions adapter + `/api/llm/models` proxy. BYO keys are server-side only, never echoed. Call sites resolve their model through `llm.ts`, never directly.
  - `llm.ts` — **two-tier model resolution (worker/thinker)**. `resolveTier()` maps a tier to provider+model+key+endpoint+thinking options: OpenRouter slots pick any model; DeepSeek slots pin the fixed v4 pair (`deepseek-v4-flash`/`-pro`, thinking enabled on the thinker). Degradation: thinker → worker → legacy `defaultModel` → the caller's non-LLM fallback. Tier assignment per operation lives in `registry.ts` (worker: note questions, commit messages, contextual rewrite; thinker: wiki-ingest synthesis).
  - `registry.ts` — **the operation/tool registry (single declaration source)**: name, description, provider-neutral JSON-schema params, tier, surfaces (`voice|http|mcp|cli`), route binding. Voice declarations (Gemini + realtime), MCP tools, and the CLI derive from it; browser-bound tools are voice-only and `edit_vault_note` carries the MCP opt-in marker. `mcpRouteAllowed()` backs the server-side surface check for MCP-scoped tokens.
  - `mcp-bridge.ts` — registry→MCP tool mapping + loopback proxy for `server/mcp.ts` (stdio entry, `npm run mcp` / `sinapso mcp`). Fetches a surface-scoped token from `GET /api/session?surface=mcp` (re-fetched once on 403 so restarts recover); the server-side guard — not the bridge — rejects that token outside the registry's `mcp` surface. Client setup in `docs/mcp-clients.md`.
  - `ingest.ts` — Ingest mode: `/api/ingest` (path/URL) and `/api/ingest-upload` (browser bytes) convert via markitdown into a vault note through `write.ts`, or into converted markdown reused by wiki-ingest proposals.
  - `wiki-ingest.ts` — contract-aware proposal layer: reads selected wiki contracts, asks OpenRouter for JSON create/edit proposals, adds raw-copy proposals for per-wiki rawDestination, validates proposal paths under the selected wiki/raw destination, and applies approvals only through `write.ts`.
  - `voice.ts` — Gemini Live voice relay. Its system prompt is built at session start from the Admin voice prompt plus enabled wiki paths/raw destinations/contract filenames. Audio/session plumbing stays here; tool dispatch delegates to `voice-tools.ts`. The Gemini live model is config-selectable (`voice.model`; 3.1 preview default), and Gemini, OpenAI Realtime, and xAI Realtime expose the same voice-tool list.
  - `voice-tools.ts` — voice tool declarations (derived from `registry.ts`; characterization snapshot in `__fixtures__/`) and per-session tool state (`activeWorkingDocId`, known document ids, contract-read tracking), driven through injected `fetchFn` loopback HTTP so tests do not need Gemini or a WebSocket. Discovery is consolidated into one `search_vault` tool (modes `auto`/`semantic`/`exact`/`path`, multi-query variants, optional folder/note scope) backed by the `/api/search-vault` route; `read_note` (anchored line context with `before`/`after`, or `from`+`count` range/pagination, via `/api/note-lines`) and `browse_folder` round out navigation, all returning `{path, title, snippet, line?}`.
  - `write.ts` - **the single sanctioned app-authored vault-write path** (`POST/PUT /api/notes`, plus `guardedAppendLink` for orphan links via `POST /api/gaps/link`): path-confined, `.md`-only, symlink-aware, never overwrites on create, journals to `data/changes.jsonl` (audit-only; entries carry no content). `guardedEdit` supports an optional `baseHash` compare-and-swap (sha256 hex over UTF-8 bytes, 409 on stale — the editor autosave's staleness guard), skips write+journal when content equals disk, and replaces atomically via symlink-aware temp+rename. Add append/edit helpers HERE; never a second app writer. User-triggered Git sync is the only repo-level exception and lives in `git.ts`.
  - `git.ts` - Git history and maintenance for vault repos. Read-only note history stays safe (`GET /api/note-versions`, `/api/note-version`); restore re-reads old content and writes only the target note through `guardedEdit()`. Git commit/sync may move HEAD only from token-guarded, user-triggered endpoints using `execFile` arg arrays, clean-tree checks, `fetch`, `merge --ff-only` for behind-only sync, `merge --no-edit` for clean divergent sync, `merge --abort` after failed conflict merges, and `push`. Never run `git checkout/reset/revert/rebase`, amend, or force push. Vaults without `.git` get `available:false` silently.
  - `install.ts` — addons flavor: installs only missing tools, never touches existing setups.

Data flow: `scanner` → `data/graph.json` → `server` → `web`. External clients (Claude Code, agents) reach the same routes via the stdio MCP server (`server/mcp.ts`) or `sinapso call` — no new listener, loopback + surface-scoped token only. **The core uploads nothing except explicit, user-triggered Git push/sync.** Optional Web mode sends queries to Exa only after web consent + key. OpenRouter-backed note questions and wiki-ingest synthesis send selected note/source/contract context only when the user triggers that action and a key is configured.

## Conventions & gotchas

- **The vault is read-only except through `server/integrations/write.ts`, plus the explicit Git sync exception in `server/integrations/git.ts`.** Scanner, reader, search, wiki discovery, and proposal generation only read; runtime data goes to `data/` (gitignored). App-authored note writes are user-initiated (save a web result, capture-only ingest, approve wiki-ingest proposal, promote a voice working document, confirm orphan link) and always journaled. Git sync is also user-initiated, token-guarded, clean-tree, fast-forward when possible, merge-commit on clean divergence, and abort-on-conflict. Never add another write path.
- **Path-traversal guard** (`server/app.ts` `/api/note`, mirrored in `write.ts`): `resolve(vaultRoot, id)` must stay under `vaultRoot + sep` and end in `.md`; `phantom:` ids return 404. Tests live in `server/app.test.ts` and `server/integrations/*.test.ts` — keep them green when touching the server. The trust-model negatives (traversal, consent gates, token enforcement) are release-blocking.
- **Frontend pure modules have Vitest coverage.** `npm test` includes `web/src/*.test.ts` for extracted data-in/data-out helpers. DOM behavior still needs manual `npm run dev` checks.
- **Browser diagnostics are release-blocking.** Playwright E2E must capture and fail on unallowlisted `console.error`, `pageerror`, `requestfailed`, and HTTP `>=500`, and write `test-results/browser-diagnostics.json` for agent debugging.
- **The reader is an always-editable CM6 live-preview editor** (`web/src/editor.ts`, plan 018): the CodeMirror document IS the note's markdown (byte-for-byte round-trip incl. CRLF; fixtures in `web/src/editor-fixtures/` are the gate), frontmatter is folded AND write-protected by a transaction filter, wiki-links render as click-to-navigate widgets, and typing `[[` opens native local autocomplete that inserts canonical vault-relative targets. Note content is never assigned via `innerHTML`. Debounced autosave flows through `PUT /api/notes` with the `baseHash` guard; conflicts surface as a non-blocking banner (reload/overwrite); a vault-scoped `localStorage` mirror (`sinapso-editor-mirror`) covers unload loss. **DOMPurify stays on every remaining `innerHTML` surface** (phantom/error fallbacks, git version previews, research column, working documents) — integration-created notes carry untrusted content.
- **Themes** are CSS-variable sets in `THEMES` (`web/src/theme.ts`); `--accent` drives link/active colors. Adding a theme = append to `THEMES` and to the `<select id="theme">` options in `web/index.html`.
- **Reader pane** docks/undocks only via the dock button (`#reader-dock`); the header drag moves it when already floating (never undocks). Geometry persists in `localStorage` (`sinapso-reader`).
- **Menubar** (`File / Layers / View / Tools / Help`) is click-to-open. The global click handler closes menus only when the click lands **outside** any `.menu`, so interacting with controls inside a dropdown (checkbox, `<select>`, layer toggle) keeps it open — preserve this when adding dropdown content.
- **`localStorage` keys are `sinapso-*`** and main frontend persistence goes through `web/src/prefs.ts`.
- **User-facing UI text must go through `web/src/i18n.ts`** with matching English and Spanish entries; do not hardcode labels, button text, empty states, or status/error copy in components.
- **Admin/wiki config**: File → Admin is the only UI for active vault path, saved wiki enable/label/path/rawDestination, and prompt overrides. Browser/CLI vault switching is typed path; Electron can pass `pickVault` into `createApp()`. Wikis are detected by folder basename `wiki`, not by contract-file presence. New wikis default enabled and infer rawDestination from existing folders in this order: `raw/`, `../raw/`, `research/`, `../research/`, `docs/`, `../docs/`, then fallback `../raw/`; blank rawDestination means no raw-copy proposal.
- **Integration modes are mutually exclusive** (`sinapso-mode`) and **search-first**: Semantic / Web / Ingest buttons change what the search field's Enter does; results open in the shared `#research` column (search bar hides, docked reader force-docks left via `ctx-left` — `!important` because the reader geometry engine sets inline `inset`). Ingest mode also shows a target selector and Browse button. `Inbox / capture only` uses `/api/ingest` or `/api/ingest-upload`; wiki targets use `/api/wiki-ingest/propose*` then `/api/wiki-ingest/apply` after approval. Web activation walks a consent modal first (R18) — never bypass it; web queries never auto-run while typing (they spend Exa credit).
- **Semantic layer** (all optional, degrades to unavailable without qmd/vectors): **arrangement** (View menu, `sinapso-arrangement`) swaps the force-sim edge set — Links (structural), Semantic (`data/semantic.json`), Hybrid (both, semantic dampened 0.4×). Semantic edges render in a separate dashed buffer; the "semantic lines" toggle hides lines but keeps their physics. Positions cache per arrangement (`/api/layout?arrangement=`). **`group by: semantic cluster`** colors by deterministic label propagation (⟂ to layout). **Passage highlight** (F035): opening a semantic hit paints the matched snippet via the CSS Custom Highlight API (`::highlight(passage)`, no DOM mutation — keep DOMPurify intact); normal opens stay at the top. **Note-questions** carry per-question Web + Semantic buttons (F036).
- **Live structural edits:** reader/research autosave compares scanner-owned structural-link signatures. Prose edits refresh search only; changed wiki/relative Markdown links return the rescanned graph to the browser. `applyGraphUpdate()` pins every node except the edited source for a bounded local settle, follows a selected moving source with the camera, clears stale arrangement memory on fingerprint changes, and restores temporary fixed coordinates on engine stop. Semantic arrangement and reduced-motion mode hot-swap without motion. Preserve durable-write success when the post-write graph refresh fails.
- **Fork remotes:** `upstream` = `chntnm/akasha`, `origin` = `felores/sinapso`. Keep the fork rebasable on upstream.

## Env

- `SINAPSO_GRAPH` — override graph.json path (default `data/graph.json`).
- `SINAPSO_PORT` — override server port (default `5175`).

Node 22+, npm. The core has no external services; everything runs on localhost. Optional integrations (qmd, markitdown, Exa, OpenRouter) are detected at runtime, never bundled.
