# CLAUDE.md — Solaris

Solaris is a local-first 3D visualizer for an Obsidian vault (or any folder of interlinked Markdown). It scans the vault into a graph and renders it as a navigable 3D force-directed map; click a note to read it in a side pane, double-click to open it in Obsidian. Fork of `chntnm/akasha`, MIT.

## Commands

```bash
npm install
npm run scan -- "<vault-path>" [--exclude rel/path]...   # build data/graph.json (incremental; cached by mtime+size)
npm run dev                                               # vite (5173) + express (5175), hot-reload → http://localhost:5173
npm test                                                  # vitest: scanner + server path-traversal guard
npm run typecheck                                         # tsc --noEmit
npm run build                                             # build web/ for prod
npm start                                                 # serve built app on http://localhost:5175
npm run desktop                                           # Electron shell (GPU unlocked)
```

Rescan without restarting: `/api/rescan` (or File → Rescan) re-parses changed files and hot-swaps the graph.

## Architecture

- `scanner/scan.ts` — walks the vault; parses `[[wiki]]` (by basename) + `[text](path.md)` (relative) links and YAML frontmatter (`title`/`type`/`tags`); emits `data/graph.json`. Pure, file-cacheable. Exclude list in `DEFAULT_EXCLUDES`.
- `server/app.ts` — Express app factory, bound to **127.0.0.1 only**. `GET /api/graph`, `/api/note?id=`, `/api/search`, `POST /api/rescan`, `/api/layout`.
- `web/src/main.ts` — the whole frontend (Three.js / `3d-force-graph`, themes, reader pane, menubar). `web/index.html` is the DOM skeleton, `web/src/style.css` the chrome.
- `desktop/main.ts` — Electron shell that runs the server and loads it in a hardened window (`contextIsolation: true`, `nodeIntegration: false`).
- `bin/cli.ts` — zero-install `npx` on-ramp (scan + serve + open).

Data flow: `scanner` → `data/graph.json` → `server` → `web`. Nothing is uploaded.

## Conventions & gotchas

- **The vault is read-only.** Scanner and server only read it; writes go to `data/` (graph, scan-cache, layout — all gitignored). Never write into the scanned vault.
- **Path-traversal guard** (`server/app.ts` `/api/note`): `resolve(vaultRoot, id)` must stay under `vaultRoot + sep` and end in `.md`; `phantom:` ids return 404. Tests live in `server/app.test.ts` — keep them green when touching the server.
- **Frontend has no test framework.** `npm test` covers the scanner and the server guard only. Verify UI changes manually with `npm run dev`.
- **Themes** are CSS-variable sets in `THEMES` (`web/src/main.ts`); `--accent` drives link/active colors. Adding a theme = append to `THEMES` and to the `<select id="theme">` options in `web/index.html`.
- **Reader pane** docks/undocks: drag its header to float, double-click the header (or the dock button) to re-dock. Geometry persists in `localStorage` (`akasha-reader`).
- **Menubar** (`File / Layers / View / Tools / Help`) is click-to-open. The global click handler closes menus only when the click lands **outside** any `.menu`, so interacting with controls inside a dropdown (checkbox, `<select>`, layer toggle) keeps it open — preserve this when adding dropdown content.
- **`localStorage` keys are `akasha-*`** (theme, filters, reader geometry, custom colors) — kept from upstream for continuity, not renamed.
- **Fork remotes:** `upstream` = `chntnm/akasha`, `origin` = `felores/solaris`. Keep the fork rebasable on upstream.

## Env

- `AKASHA_GRAPH` — override graph.json path (default `data/graph.json`).
- `AKASHA_PORT` — override server port (default `5175`).

Node 22+, npm. No external services; everything runs on localhost.
