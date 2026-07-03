# Progress Log — solaris-optional-integrations

Initialized 2026-07-02 from docs/plans/2026-07-01-002-feat-optional-integrations-qmd-exa-opencode-plan.md (12 units -> F001-F012, 3 milestones).

## Session 2026-07-02 (1)

**Features:**
- F001: not_started -> active -> passing (integrations config, detection, status API, origin+token guard, tsconfig fix)
  - verification: npm test 32/32 + typecheck green (now covers bin/, desktop/)
  - commit: d27a035

**Passing:** 1/12 (8.3%)

## Session 2026-07-02 (2-4): Milestone 1 complete

**Features:**
- F002: not_started -> passing (mode selector chrome + integrations settings UI) — commit a65e9c8
- F003: not_started -> passing (qmd bridge: related, semantic search, setup/status) — commit c68d28a
  - Real-vault finding: vsearch must be vec:-typed (skips 30s+ LLM expansion); per-spawn floor 5-9s, upgrade path = warm qmd mcp child. See docs/solutions/qmd-vsearch-latency.md
- F004: not_started -> passing (semantic surfaces UI + DOMPurify sanitize) — playwright smoke on FeloVault: F2 flow, collections toggles, semantic search swap all verified in browser

**Passing:** 4/12 (33%) — M1 done. Next: F005 (topology/gaps, M2)

## Session 2026-07-02 (5-8): Milestone 2 complete

**Features:**
- F005: passing (topology/gaps + /api/gaps) — commit 6879b3b. Deviation: linker-title context instead of per-suggestion qmd snippets (latency)
- F006: passing (Exa adapter + /api/research) — commit 0d5c8cf. Grounded on exa-js dist types; consent 403 before any call; 401 not retried
- F007: passing (guarded write endpoint) — commit 85439c9. All negative trust paths automated incl. symlink escape
- F008: passing (Web mode UI) — commit a055473. Playwright F3 end-to-end on scratch vault with mocked Exa; AE8 decline verified; global config restored after test

**Passing:** 8/12 (67%) — M2 done. Next: F009 (OpenCode bridge, M3)

## Session 2026-07-02 (9-12): Milestone 3 complete — ALL FEATURES PASSING

**Features:**
- F009: passing (OpenCode bridge) — commit 20608a1. Live-verified against opencode 1.17.13; lockdown adapted to current config schema (tools map + permission keys; no websearch/task/skill permission keys anymore)
- F010: passing (proposals, audit, provenance) — commit 35f4b69. Open question resolved: propose tools via config.plugin in data dir (not ask-intercept)
- F011: passing (agent chat UI) — commit c3e054b. Live smoke: consent -> real serve spawn -> session -> SSE. Deferred: live model turn (F4/F5)
- F012: passing (installer + trust docs) — this commit

## Session 2026-07-02 (13-17): post-plan iteration from user testing

**Features (all passing):**
- F013: integrations moved to Tools menu, per-tool install buttons — 16ab68d
- F014: agent model selector (live Zen free models + custom entry) — ec8d5d7
- F015: warm qmd mcp child + per-note cache (7-9s -> 1.3-1.9s warm, 1.5ms cached) — 50486c6
- F016: progressive gap enrichment — 48d6bd2
- F017: fail-closed sandbox self-test + drift warning — 635e2ba
- Exa keyless: RESEARCHED, NOT possible (402 x402 crypto micropayments only); per user instruction Exa left unchanged

**Passing: 17/17.**

**Passing: 12/12 (100%).** Definition of Done met except deferred human-review items (see features.json evidence fields):
- Live Exa query with a real key (F006/F008)
- Live agent conversation with a model turn: propose -> approve -> node+edge (F011)
- Fresh-machine addons dry-run (F012)
- M1 F1 flow on a vault without qmd coverage (F004)

## Session 2026-07-02 (18-23): design round 2 (deep research, LLM questions, markitdown, terminal)

- F020 passing: Exa deep research (synthesized answer + cited citations, deep toggle, questions run deep) — 2a6b1b0
- F021 passing: LLM note questions via sandboxed bridge, template fallback — 0d7cee8
- F023 passing: markitdown ingestion (File -> Ingest Document, live verified) — 92d6015
- F022 ACTIVE: terminal split pane — server+UI complete and tested; opentui paint under xterm.js pending (diagnosis in features.json) — aaf7972
- Also: cursor affordances, matching close buttons, Lucide icons, question phrasing — e4cb4b6
- Exa keyless: not possible (402 x402 crypto payments); Exa unchanged per user instruction

**22/23 passing, 142 tests.**

## Session 2026-07-03: Phase 0.4 — multilingual embedding model

**Features (F024-F026, from docs/plans/2026-07-03-003-...-plan.md):**
- F024: not_started -> passing (config.embedModel + Runner env param + maintenance embed carries QMD_EMBED_MODEL/-f)
  - verification: npm test 132 + typecheck
- F025: not_started -> passing (embedModel via guarded /api/integrations/config, returned by GET /api/integrations; maintenance reads it + ?force=1)
  - verification: npm test 134 (unguarded write 403; persist+reflect; embed spawn carries model+-f)
- F026: not_started -> passing (Tools -> Semantic embedding-model selector default/Qwen3/custom; change persists + marks model-dirty; re-embed becomes "re-embed (full)" force)
  - verification: typecheck + agent-browser LIVE (3 options, Qwen3 persisted, dirty flag, button relabel). Real config reset to null after test.

Model wiring: QMD_EMBED_MODEL = hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf (1024-dim). Heavy re-embed intentionally NOT run (user re-embeds later).

**Gates:** 134 tests + typecheck + build green.
**Passing (this run):** 3/3 (F024-F026).

## Session 2026-07-03 (late): Phase 0.4 shipped, i18n queued for resume

**Shipped:** F024-F026 (multilingual embed model) + Phase M maintenance + big UX
pile. Commits through 7af8ad1. qmd.ts split into qmd-maintenance.ts.

**RESUME POINT:** Phase 0.1 (i18n) is next, NOTHING built yet. Queued as F027
(i18n foundation + EN/ES toggle), F028 (tag + translate menubar/chrome), F029
(DESIGN.md). Full self-contained detail + all locked decisions are in
docs/plans/2026-07-03-003-qmd-semantic-layer-and-i18n-plan.md → "Status & resume
point". Language chips are NEUTRAL EN/ES (not country flags).

## Session 2026-07-03 (i18n): Phase 0.1 shipped — F027/F028/F029

**Features:**
- F027: not_started -> passing. web/src/i18n.ts (t/getLang/setLang/hydrate, EN+ES
  dicts, localStorage akasha-lang). Language menu after Help. hydrate handles
  [data-i18n] (leading-text-node when children present), [data-i18n-ph],
  [data-i18n-title], [data-i18n-html] (loading hint's <kbd>). Top-level hydrate
  before boot() avoids EN flash.
- F028: not_started -> passing. Menubar + Tools integrations + settings panel +
  search + loading + reader/research chrome tagged and translated to neutral ES.
  Dynamic strings (mode titles/missing, search+research placeholders, dock
  titles, reader-path phantom, research titles) routed through i18n.t() and
  re-applied on toggle (refreshDynamicChrome). Content-language: note-questions
  prompt now asks to reply in the note's language (server/app.ts). Filters panel
  deliberately left EN (dynamic show/ignore surfaces, out of scope).
- F029: not_started -> passing. DESIGN.md at repo root (146 lines), grounded in
  style.css; corrected z-index ladder (floating 5 < docked 20).

**DECISION CHANGE:** user overrode the neutral-chips decision -> wants COUNTRY
FLAGS. Shipped 🇬🇧 English / 🇪🇸 Español chips + flag as the menubar label
(#lang-label). Noted the flags-for-languages anti-pattern once; user chose flags.
Flag vertical alignment tuned (#menubar top:3px, #lang-label top:2px).

**Also this session (not features):** Obsidian reader-icon fill #7C3AED ->
currentColor (renders white, matches sibling icons). Bug fix: #reopen-content
(bottom-left) now toggles closed via clearSelection() when the panel is open
(was open-only, appeared stuck; clearSelection deselects the node) — mirrors
#reopen-research.

**Gates:** npm run typecheck clean, npm test 134/134, agent-browser EN<->ES
swap+persist verified, ES key audit missingKeys=[]. Verified live in dev.
