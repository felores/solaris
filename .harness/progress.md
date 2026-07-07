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

## Session 2026-07-03 (evening): topbar/panels + embed removal; queued semantic layer

**Shipped (commit 0f35c65):**
- Topbar redesign: brand+menu grouped (#nav-group) centering together when the left
  panel docks; search stacks below the menu on collision only; menu z-index above the
  search; Help items -> File menu (Help menu removed); flag centered + label-sized
  hover bg.
- Content/research panel fixes: #reopen-content docks the reader LEFT (not hide);
  setReaderCtxLeft() suppresses the transition on a hidden reader (was sliding across
  the screen when ctx-left flipped via open/closeResearch); removed the redundant
  research follow-up input.
- Embed model REMOVED (Qwen + selector): qmd ignores QMD_EMBED_MODEL (reads
  models.embed from ~/.config/qmd/index.yml). Dropped config.embedModel, env passing,
  i18n, tests. Re-embed (qmd embed -f) button kept. F024-F026 evidence noted as reverted.
- Loading graphic/text resized; Tools order = Ingestion/Semantics/Web Research/LLM.

**Tracking cleanup:** F022 (embedded terminal, OpenCode-era) active -> passing
(removed by design). F024-F026 kept passing with a REVERTED note.

**QUEUED — the core semantic layer (nothing built yet), self-contained in
features.json F030-F035 + plan #0.3/#1-5:**
- F030 (0.3) qmd-vectors.ts read-only sqlite-vec reader — GATES F031-F033, F035.
- F031 (Phase 1) mutual-KNN edges -> data/semantic.json (dep F030).
- F032 (Phase 2) arrangement Links/Semantic/Hybrid, Links default (dep F031).
- F033 (Phase 3) semantic-cluster color, orthogonal to layout (dep F031).
- F034 (Phase 4) orphan link suggestions, preview-then-confirm via write.ts (no dep).
- F035 (Phase 5) passage-level reader (dep F030).

**RESUME POINT: F030 (vector reader).** Full detail: plan "Status & resume point" +
features.json. typecheck clean, 132 tests green at session end.

## Session 2026-07-03 (afternoon) — semantic layer end to end

Built and shipped the **entire semantic layer F030–F035 + F036** in one autonomous
run. All 36 features passing; typecheck clean; 145 tests (was 132).

- **F030** `qmd-vectors.ts` read-only sqlite-vec reader (better-sqlite3 + sqlite-vec,
  lazy-required, schema-guarded, dim from `float[N]`). Real index: dim 768, 8671 vault
  docs, KNN semantically coherent. commit `5793773`.
- **F031** `semantic.ts` mutual-KNN edges → `data/semantic.json`; `GET /api/semantic`
  builds-once-caches by fingerprint (2078 edges, cold 14.6s → cached 14ms). `0b0a819`.
- **F032** arrangement Links/Semantic/Hybrid + dashed buffer + hide-lines toggle +
  per-arrangement layout cache. `74f17db`.
- **F036** per-question Web/Semantic research buttons (Felo request mid-flight). `0c1dd8a`.
- **F033** `group by: semantic cluster` — deterministic label propagation, ⟂ layout;
  identical clusters across reload. `5469726`.
- **F034** orphan link suggestions: `guardedAppendLink` + `POST /api/gaps/link` +
  reader preview-then-confirm card. 8 new write-path tests. `e294566`.
- **F035** passage-level reader: semantic hit highlights matched passage via CSS Custom
  Highlight API (DOMPurify intact); normal opens unchanged. `7b3c487`.

Deps added: better-sqlite3 + sqlite-vec (+ @types). Every feature verified via
agent-browser against the real 4k-node vault. Investigated a reported perf regression
(30s blank load / black stripe) — not reproducible on a clean single server; root cause
was stale dev-server pileup on ports 5173/5174/5175, cleaned up.

**All planned semantic work COMPLETE.** Follow-ups (non-blocking): electron-rebuild
better-sqlite3 for the desktop shell; F031 per-note incremental; F033 optional LLM labels.

## Session 2026-07-05-1700 — voice waveform + context footer + topbar z-index/collapse

**Features worked (all not_started → passing):**
- **F037** voice waveform spectrum: two Analysers tapped onto the existing voice
  graph (mic parallel to the worklet → muted sink; agent as a single bus every
  BufferSource routes through). Canvas above #brand-stats, rAF, fftSize 512,
  one color at a time (agent = --accent, human = HSL complement), idle flat dim.
  Mounts only during voiceSession. Plan 004 U1.
- **F038** context-aware footer: #brand-stats split into two spans;
  updateBrandStats() resolves per-side precedence (voice > panel > default).
  Left = provider+voice (voice) / words (reader) / notes; right = timer (voice)
  / mode-specific count (research) / links. Both old write sites replaced.
  Plan 004 U2.
- **F039** topbar z-index flip (10 → 25, above docked panels) + left-panel
  collapse mirror (centered-then-jump): layoutTopbar() now feeds leftPanelW
  into the collision math and toggles menu-jumped-right + search-stacked.
  Plan 005 U1.

**Verification:** npm run typecheck clean; npm test 161/161; npm run build green.
Behavioral AEs (turn-taking color, footer state transitions, panel-collapse
mirror) deferred to manual npm run dev review — frontend has no test framework.

**Plans:** docs/plans/2026-07-05-004 (spectrum+footer) and -005 (topbar),
both ce-brainstorm → ce-plan → harness-progress, implementation-ready.

## Session 2026-07-05-1740 — responsive topbar rail (F040-F042)

**Features worked (all not_started → passing):**
- **F040** three-state topbar resolver + left continuous-slide. layoutTopbar()
  now resolves ROW / STACKED / RAIL from available width (viewport minus docked
  panels). Left panel slides the whole row right via --left-inset (no jump).
  Removed F039's menu-centered / menu-jumped-right classes and collision branch;
  kept search-stacked for right-panel crowding; kept F039's z-index bump (25).
- **F041** rail UI. New #topbar-rail (right-edge icon strip: logo, search/mode/
  voice, File/Layers/View/Tools/Help). Rail icons proxy-drive the existing
  menubar menus (.open), #modes buttons, #voice-toggle, and #search — no
  duplicated logic. Search flyout reveals #search-wrap beside the rail.
- **F042** panel displacement. --rail-inset (52px in RAIL, 0 otherwise) shifts
  right-docked #research / #reader left of the rail so they don't underlap it.

**Verification:** typecheck clean; 161/161 tests; vite build green. Behavioral
AEs heavily deferred to manual npm run dev — the rail is the most visual feature
shipped this session; expect iteration on flyout positioning, the RAIL threshold,
and the left-slide geometry.

**Plan:** docs/plans/2026-07-05-006 (responsive topbar rail), ce-brainstorm with
visual probe (Variant B: icon rail + flyouts) → ce-plan → harness-progress.

**Also this session, uncommitted earlier:** voice spectrum tweak (180px wide,
bottom 29px) — folded into this commit.

## Session 2026-07-05-1810 — topbar rail rework (slot model + Lucide + right-panel restore)

Reworked F040-F042 after visual review feedback (icons terrible, slide model
wrong, right corner buttons desync). New model in layoutTopbar():
- right panel only → search slides with panel (--right-inset) + wraps below
  menu left-aligned on collision (RESTORED original "flawless" behavior).
- left panel only, not crossing center → menu centered.
- left panel crossing center → menu+search snap to right-side column, stacked
  (menu row 1, search row 2, right-aligned).
- both panels balanced → centered cluster.
- center gap < wider of menu/search → RAIL (vertical right-edge rail).
Lucide icons (inline SVG) replace the emoji; rail icons ~2x (44px, 26px svg).
Removed U3 panel displacement (--rail-inset) — the desync source; the rail now
overlays panels (z-index 25 > 20).
Verification: typecheck + build green. Still heavily deferred to manual review.

## Session 2026-07-05-2315 — vault Admin/wiki-ingest harness start

Queued docs/plans/2026-07-05-007-feat-vault-admin-wiki-aware-ingest-plan.md as F043-F049.

**Features worked:**
- **F043** not_started -> active -> passing. Extended `server/integrations/config.ts` for vault-scoped Admin config: `activeVaultPath`, per-vault `wikis`, per-wiki `rawDestination`, and local prompt overrides with built-in reset defaults. `/api/integrations` now exposes non-secret Admin config and effective/default prompt text.

**Verification:** `npm test -- server/integrations/config.test.ts` 9/9 pass; `npm run typecheck` clean.

**Next:** F044 — wiki discovery service.

## Session 2026-07-05-2337 — F044 worker/reviewer trial via Herdr

Used Herdr to assign **F044** to the idle OpenCode GLM-5.2 pane (`w5:p9`) and kept this pane as reviewer/verifier.

**Features worked:**
- **F044** active -> passing. Added `server/integrations/wiki.ts` discovery service, `server/integrations/wiki.test.ts`, and `GET /api/wikis`. Discovery finds directories named exactly `wiki`, respects graph excludes, detects `AGENTS.md`/`CLAUDE.md`/`index.md`/`README.md`, assigns confidence, defaults new discoveries to enabled + inferred rawDestination, and merges saved disabled/custom raw state.
- Reviewer fix: added `realpathSync` confinement so symlinked directories inside the vault cannot make discovery traverse outside the vault; added regression test.

**Verification:** `npm test -- server/integrations/wiki.test.ts` 18/18 pass; `npm run typecheck` clean.

**Next:** F045 — Admin modal UI.

## Session 2026-07-06-0354 — F045 Admin UI review

Reviewed the OpenCode GLM-5.2 worker implementation for **F045** and patched two save-path issues before marking it passing.

**Features worked:**
- **F045** active -> passing. Added File -> Admin, centered Admin modal, Vault/Wikis/Prompts sections, selected wiki rows with editable label/path/raw folder, confidence and contract badges, manual wiki rows, rediscovery, and prompt reset/save.
- Reviewer fixes: manual rows now have an editable path input and save that path; vault/contract/wiki values are escaped before HTML insertion; unchanged built-in prompt text saves as `null` instead of becoming a sticky override.

**Verification:** `npm run typecheck && npm run build` clean.

**Next:** F046 — safe vault switching + Electron browse.

## Session 2026-07-06-0402 — F046 safe vault switching

**Features worked:**
- **F046** not_started -> passing. Added token-guarded `POST /api/vault` for typed local paths and Electron `browse:true`, using existing `scanVault()` -> graph file -> `reload()` flow and returning the new graph for frontend hot-swap.
- Admin Vault section now has a typed path input plus Switch/Browse buttons; successful switches call `applyGraphUpdate()`, refresh Admin config, and rediscover wikis.
- Desktop now passes a native `pickVault` callback into `createApp()` by splitting the existing dialog picker from `pickAndScanVault()`.
- `reload()` now clears qmd collection/status caches and in-flight semantic build state in addition to search, related, and vector caches.

**Verification:** `npm test -- server/app.test.ts` 22/22 pass; `npm run typecheck` clean; `npm run build` clean.

**Next:** F047 — wiki target selection in ingest.

## Session 2026-07-06-0414 — F047 ingest target selection

**Features worked:**
- **F047** not_started -> passing. Added `resolveIngestDestination()` for capture-only, implicit single enabled wiki, selected wiki id/path, multi-wiki no-selection errors, and confined wiki-relative `rawDestination` values like `raw/` and `../research/`.
- `/api/ingest` and `/api/ingest-upload` now resolve against `/api/wikis`-style discovery merged with saved config, so unsaved discovered `wiki/` folders can be used. Uploads pass `destination` through `ingestBytes()` instead of silently falling back to `inbox/`.
- Ingest mode now shows a compact target selector when enabled wikis exist; it defaults to the sole wiki, forces a choice when multiple exist, and keeps `Inbox / capture only` available.

**Verification:** `npm test -- server/integrations/ingest.test.ts` 16/16 pass; `npm run typecheck` clean; `npm run build` clean.

**Next:** F048 — contract-aware wiki ingest proposals.

## Session 2026-07-06-0855 — F048 contract-aware wiki ingest proposals

**Features worked:**
- **F048** not_started -> passing. Added `server/integrations/wiki-ingest.ts` proposal/approval layer. It reads selected wiki contracts, uses the configured `wikiIngest` prompt via OpenRouter, returns structured create/edit previews, adds raw-copy create proposals for `raw/` or confined custom destinations like `../research/`, and validates every proposed path under the selected wiki or raw destination before approval.
- Added `POST /api/wiki-ingest/propose`, `POST /api/wiki-ingest/propose-upload`, and `POST /api/wiki-ingest/apply`. Apply writes only through `guardedCreate()`/`guardedEdit()` with approval journaling; reject is a UI no-op and writes nothing.
- Ingest UI now opens a proposal preview for wiki targets with approve/reject buttons. `Inbox / capture only` still uses the immediate existing ingest route.

**Verification:** `npm test -- server/integrations/wiki-ingest.test.ts server/integrations/write.test.ts` 29/29 pass; `npm run typecheck` clean; `npm run build` clean with the existing Vite chunk-size warning only.

**Next:** F049 — docs for Admin/wiki-aware ingest and trust wording.

## Session 2026-07-06-0858 — F049 docs

**Features worked:**
- **F049** not_started -> passing. Updated `README.md` with File -> Admin, browser typed-path vs Electron browse, wiki discovery by folders named exactly `wiki`, selected-by-default multi-wiki checklist, contract candidates, per-wiki raw destination defaults/overrides, prompt overrides, capture-only ingest, and approval-based wiki ingest.
- Updated `CLAUDE.md` so future agents preserve the config/wiki/wiki-ingest modules, OpenRouter egress scope, Admin/wiki config rules, and the single sanctioned write path for capture-only ingest, approved wiki proposals, and orphan links.

**Verification:** `npm run typecheck` clean.

**Result:** F043-F049 all passing; Admin + wiki-aware ingest plan complete pending manual UI polish/review.

## Session 2026-07-06-1420 — raw destination inference + Admin density correction

User feedback: existing wikis like agencia/felo/climatia/skandia/mineralia should not default to `wiki/raw/`; their source folders live beside the wiki, usually `../research/`. Also the Admin modal was too wide and crowded.

**Changes:**
- Wiki discovery now infers rawDestination in order: `raw/`, `../raw/`, `research/`, `../research/`, `docs/`, `../docs/`, then fallback `../raw/`.
- Rediscovery replaces stale legacy `raw/` saved defaults when the filesystem indicates a better destination.
- Manual wiki rows default to `../raw/`.
- Admin modal narrowed, wiki rows use a compact two-column/two-row layout (path + raw folder, then confidence + contracts), and prompt editing is two-column: prompt list on the left, selected textarea on the right.

**Verification:** `npm test -- server/integrations/wiki.test.ts` 20/20 pass; `npm run typecheck` clean.

## Session 2026-07-06-1455 — Admin vault row cleanup

**Changes:**
- Simplified Admin vault section to one typed path field; removed duplicate active-path display and separate Switch/Browse controls.
- Bottom Save now switches/rescans the vault through `/api/vault` when the typed path changes, refreshes integrations/wiki rows, and avoids saving old wiki rows into the new vault.
- Closing Admin with dirty fields now asks to save first, or discard if save is declined.
- Removed dead vault-action CSS and unused i18n strings.

**Verification:** `npm run typecheck` clean; `npm run build` clean with the existing Vite chunk-size warning only.

## Session 2026-07-06-1518 — voice wiki context + promote working document

**Changes:**
- Voice system prompt now includes Admin voice prompt plus enabled wiki paths, raw destinations, and contract filenames.
- Added voice tools to list wikis, read a selected wiki contract, and promote the current working document to either a structured wiki note or raw copy.
- Added guarded `/api/wiki-contracts` read route and `/api/document/:id/promote` mutation route; promotion writes only through `write.ts`, removes the temporary history document after success, and returns the saved note id.
- Frontend voice action `open_saved_note` rescans, opens the saved vault note, and refreshes history.

**Verification:** `npm run typecheck` clean; `npm test` 207/207 pass; `npm run build` clean with the existing Vite chunk-size warning only.

## Plan: solaris-architecture-deepening (2026-07-06-009)

Initialized tracking for the architecture-deepening refactor plan: 12 units (U1–U12) → F050–F061 (F050 active, rest not_started). Pre-U1 baseline: `npm test` 213/213 pass; `npm test && npm run typecheck` clean. Existing F001–F012 are already in use by the previous plan, so the new entries use F050–F061 to avoid collision — semantically the 12 units of the new plan, dependency order preserved (U1 → U2 → U3 → U4 → U5 → U6; U7 depends on U2; U8 depends on U6; U9 → U10 → U11 → U12).

This session implements U1 only (Vault-path guard module). Subsequent units land one per session, in dependency order.

## U1 completion — Vault-path guard module

**Features:**
- F050: active -> passing. Created `server/integrations/paths.ts` (WriteError canonical home + `confineNoteId` pure primitive + `noteFileOrFail` error-throwing wrapper, 61 lines) and `server/integrations/paths.test.ts` (19 tests covering happy path, nested, `.MD` case-insensitive, empty, `phantom:`, `..`/deep traversal, absolute, vaultRoot-resolving `..`/`.`, prefix-valid-looking traversal, non-md/no-extension, plus `noteFileOrFail` 404/400 split). Migrated the six inline guards in `server/app.ts` (`notePathOrFail`, `/api/related`, `/api/note-questions`, `/api/note`, `/api/note-lines`, `/api/note-grep`); `write.ts` `confine()` shares `confineNoteId` for the resolve+startsWith+.md invariant and keeps its 400 `"invalid note path"` messages + realpath/symlink check verbatim. `WriteError` re-exported from `write.ts` to avoid circular import.

**Verifier result:** `npm test` 232/232 pass (one pre-existing qmd.test.ts AE3 timeout flake on a single busy run — unrelated to U1; passes in isolation); `npm run typecheck` clean; inline-guard grep returns 0 (was 6).

## U2 completion — Application gates module

**Features:**
- F051: not_started -> passing. Created `server/integrations/gates.ts` (135 lines) with 5 exports: `requireWebConsent`, `requireExaKey`, `requireOpenRouterKey` (TypeScript type predicates so callers can use the narrowed key on the success branch), `requireOpenRouterKeyOrThrow` (paired with the helper-level gate in `wikiIngestProposal`), and `requireMarkitdown` (takes a `ToolCacheRef` and a `refresh` callback, lazily probes, populates the cache, returns the bin path or writes 503). All four response bodies are byte-identical to the inline copies: 403 `web-consent-required` (preserving both messages), 400 `no-exa-key`, 400 `{ error: message }` for OpenRouter (preserving both `no-openrouter-key` and the wiki-ingest prose), 503 `markitdown-missing`. Created `server/integrations/gates.test.ts` (15 tests). Migrated routes in `server/app.ts`: `/api/ingest` (YouTube branch + markitdown), `/api/ingest-upload`, `/api/research`, `/api/article`, `/api/wiki-ingest/propose`, `/api/wiki-ingest/propose-upload`, `/api/llm/models`, plus `wikiIngestProposal` helper and the factored `markitdownBinOrFail` (now a 1-line delegate). `toolCache` refactored from `let` to `const ToolCacheRef` so the helper and the closures share one cache. Out of scope (intentionally untouched): `/api/integrations/test/openrouter` and `/api/note-questions` are 200-OK fall-throughs, not gates; `/api/note-questions` is in U5.

**Verifier result:** `npm test` 247/247 pass; `npm run typecheck` clean; gate-body greps confirm response shapes live only in `gates.ts` (route-specific message strings passed in as arguments).

## U3 completion — Excerpt/snippet module

**Features:**
- F052: not_started -> passing. Created `server/integrations/excerpt.ts` (101 lines): `excerptFor(vaultRoot, id, title)`, `norm`, `stripSnippet`, `clip`. Moved verbatim from `server/app.ts`; `excerptFor` now takes `vaultRoot` as its first arg, the file read stays `try/catch -> ""` on failure, and every heuristic (frontmatter-key precedence `description|summary|excerpt`, 25-char gate, normalized title-echo check, 280-char clip, 4+ char divider regex) is preserved byte-for-byte. Created `server/integrations/excerpt.test.ts` (25 tests). `server/app.ts` loses 4 local helpers + comment block (-67 net, -2 line stubs); the only call site (line 728 in `/api/related`) updated to pass `vaultRoot`. One call site only.

**Verifier result:** `npm test` 272/272 pass (24 files), incl. `/api/related` qmd fixtures 32/32 (R5 in-graph-only, R8 collections-narrowed KNN path through `excerptFor`, R9 semantic-search mapping, F015 per-note cache), U1 paths.test.ts 18/18, U2 gates.test.ts 15/15, app.test.ts 28/28. `npm run typecheck` clean (0 errors). Path-guard grep count in `app.ts` still 0 (U1 invariant preserved; U3 did not touch it).

**Stash note:** A pre-existing stash at `stash@{0}` from the executor session was NOT restored (per instructions, `web/src/*` dirty files must not be touched). The orchestrator restored the stash out-of-band after this executor session; `stash@{0}` remains as a backup and may be dropped once the web changes are confirmed in main.

## U4 completion — Merge qmd query duplicates

**Features:**
- F053: not_started -> passing. New exported `runQmdQuery(deps, queryText, opts)` in `server/integrations/qmd.ts` next to `vsearch()`; one parameterized function replaces the two `semanticQuery`/`passagesQuery` closures in `server/app.ts`. Preserves `vec:` query typing and defensive JSON parsing from first `[`. A `qmdDeps(bin)` factory bundles the closure-owned bits (colCache invalidation, `collections()`, `qmdSearch()`, `vaultRoot`, `graph.nodes`) as a `QmdQueryDeps` DI surface. Three call sites re-expressed: `/api/related` fallback, `/api/semantic-search`, `/api/passages`. `collections()` and `qmdSearch()` left in place per plan (still used by `/api/gaps/enrich` and the MCP warm-path fallback). +423 test lines accepted for behavior fixtures (21 unit tests for `vsearch`/`runQmdQuery` + 2 new `/api/passages` route fixtures).

**Verifier result:** `npm test` 295/295 pass (24 files); `npm run typecheck` clean; `qmd.test.ts` 55/55. `/api/semantic-search` and `/api/passages` behavior unchanged against the fake runner.

## U5 completion — Note-questions module

**Features:**
- F054: not_started -> passing. New `server/integrations/questions.ts` (122 lines) exports `buildNoteQuestionsPrompt(note, excerpt, phantomTitles)` (pure: instruction lines + conditional phantom-hint line + title + excerpt + language + JSON-only directives, phantom line omitted via `filter(Boolean)` when `phantomTitles=[]`), `parseQuestionsReply(text)` (first-`[` to last-`]` slice, `JSON.parse` in try/catch, `!Array.isArray` defensive check, `typeof==string && .trim().length>0` filter, 5-item cap, returns `string[] | null` on any failure), and `noteQuestionsViaLLM(deps)` orchestrator that takes `chat:(messages)=>Promise<string>` in the `WikiIngestChat` DI style + `warn?(msg,err)=>void` so tests don't bind to `console`. 21 tests in `server/integrations/questions.test.ts` cover prompt phantom-line inclusion/omission, clean JSON, prose-wrapped, code-fence-wrapped, 5-cap, non-string/empty filtering, no-delimiter / mismatched-brackets / unparseable / empty-after-filter -> null, success path message shape (system+user), LLM throw -> templates + warn, LLM garbage -> templates + warn, unparseable JSON -> templates, no-string-items -> templates, phantom-titles embedded/omitted in prompt, `templates()` not called on llm-success path. `server/app.ts` route keeps: no-key guard -> templates; `confineNoteId`+`existsSync` invalid-id guard -> templates; reads 1500-char excerpt; computes `phantomTitles` (slice 0..8) from graph links; injects `chatCompletion` as the chat function; `res.json`s the module result. `{questions, source}` shape byte-identical. Existing `api.test.ts` note-questions regressions (3/3: no-key templates, LLM success, default-model fallback) all green.

**Verifier result:** `npm test` 316/316 pass (25 files); `npm run typecheck` clean; `questions.test.ts` 21/21; `api.test.ts` 10/10. Two accepted discrepancies: (1) plan's "non-array -> null" parse branch is unreachable from the public surface (first-`[` to last-`]` extraction guarantees bracket-delimited slice -> always parses to an array), so the parse-level test for it was dropped — the defensive `!Array.isArray(parsed) return null` line is retained. (2) Original code threw distinct messages inside the try so the catch logged them via `e.message`; refactor returns `null` from `parseQuestionsReply` so the orchestrator logs a single `"llm questions fell back to templates: parse failed"` for all parse-failure causes (slightly less specific log; response shape + fallback behavior identical).

## U6 completion — Search + grep module

**Features:**
- F055: not_started -> passing. New `server/integrations/notes-index.ts` (132 lines) exports `buildSearchIndex(nodes, vaultRoot) -> SearchIndex` with `search(query)` (lazy on first non-empty search, phantom nodes skipped, missing files silently dropped via the same try/catch the inline code had) and `invalidate()` (drops the index + the in-memory `contents` map used for snippet extraction), plus `grepNote(content, query, contextLines=2, options={ignoreCase, limit=30})` — pure literal substring scan, regex metacharacters in `query` treated as text, returns `{line, text, snippet}`. Types: `SearchHit`, `SearchIndexNode`, `GrepMatch`, `GrepOptions`, `SearchIndex`. `server/app.ts` shrank by 70 net lines: `MiniSearch` import removed; `let index`, `let contents`, `function buildIndex()`, `function snippet()` deleted. `/api/search` body is a 1-line `res.json(searchIndex.search(q))` after the empty-q short-circuit and the 500-on-throw guard. `/api/note-grep` body is `grepNote(content, q, ctx, { ignoreCase, limit })` after the path guard, request parsing (incl. the `parseInt("0") || 2` quirk preserved verbatim), and the read-fail 500 handler. `reload()` reassigns `searchIndex = buildSearchIndex(graph.nodes, vaultRoot)` so the new handle carries the new graph's nodes; the MiniSearch index inside still builds lazily on the next `/api/search`, preserving rebuild timing exactly. 22 tests in `server/integrations/notes-index.test.ts` (12 grepNote + 9 buildSearchIndex + 1 byte-identical route output fixture spanning 19 query shapes against `.scratchpad/2026-07-06-2244-u6/baseline-before.json`).

**Verifier result:** `npm test` 338/338 pass (26 files) on 3 consecutive runs; `npm run typecheck` clean. Before/after route baseline diff: empty (19 fixture queries across both routes, byte-identical). One transient app.test.ts flake on `/api/vault switch > rejects missing paths and files` (Invalid value undefined for header `x-solaris-token` from the supertest `.set("x-solaris-token", token)` call after a `sessionToken()` fetch) failed once during a full-suite run, passed on rerun and on `server/app.test.ts` standalone — pre-existing flake unrelated to U6, accepted as non-blocking.


## U7 completion — Config mtime cache

**Features:**
- F056: not_started -> passing. `loadConfig()` in `server/integrations/config.ts` gains module-level `configCache: Map<path, {mtimeMs, value}>` memo: `statSync` the file, return the cached parse when mtime is unchanged, re-read otherwise. `updateConfig()` re-stats after write and refreshes the memo. Interface (`loadConfig(path?)` / `updateConfig(patch, path?)`) unchanged; no new public API. Missing file and corrupt file paths are not cached, so external fixes are seen on the next call without an explicit reset. All 17 `loadConfig` call sites (16 in `app.ts`, 1 in `voice.ts`) plus 2 `updateConfig` sites untouched. 5 new tests in `server/integrations/config.test.ts` cover cache hit, external mtime bump, updateConfig refresh, missing file still defaults, and secrets stay in proper fields.

**Verifier result:** `npm test` 343/343 pass (26 files; +5 vs prior 338); `npm run typecheck` clean. Reference equality (`toBe` on the returned object) accepted as cache-hit proof — `vi.spyOn(fs, "readFileSync")` is blocked in vitest's module env ("Cannot redefine property"), and a fresh read+parse would produce a new object, so reference identity is the strongest direct signal. UpdateConfig post-write stat uses try/catch (file vanishing between write and stat is rare; cache untouched on failure so next loadConfig re-reads).

## U8 completion — Voice tool-dispatch seam

**Features:**
- F057: not_started -> passing. New `server/integrations/voice-tools.ts` (703 lines) exports `VOICE_TOOLS` (the full `FunctionDeclaration[]`, verbatim from `voice.ts`) and `createVoiceToolSession(ctx) -> { run(name, args) }`. `ctx` carries `{ base, fetchFn?, getSessionToken, send }` — `fetchFn` defaults to `globalThis.fetch`, `send` is the browser action side-channel. The session owns the per-conversation mutable state (`workingDocId` slug + base36 timestamp, `contractWikisRead` Set) and the loopback-HTTP bodies (read-only `callTool`: search_vault, search_passages, read_passage, grep_note, browse_folder, find_notes, list_wikis, read_wiki_contract; stateful `runTool`: current_view, open_note, open_last_note, open_last_research, read_wiki_contract with contract-tracking, write_document with id minting, save_working_document with the read_wiki_contract gate, edit_vault_note, web_research, fetch_url). 23 tests in `server/integrations/voice-tools.test.ts` cover VOICE_TOOLS declaration names, read-only URL/params/8-cap/path-prefix-trim/HTTP-error envelope, read_wiki_contract gating (reject-before-contract with current error, allow-after-contract, raw_copy bypass, no-working-doc error), write_document (id minting shape, same-id-on-reedit, slug fallback, could-not-save-on-500, show_document browser action), promote+edit (`/api/document/:id/promote` URL+session-token+body+server-error-propagation, edit_vault_note PUT+body, empty-path/empty-body early returns), web tools (`/api/research` with deep:true + historyId-driven + empty-query-reject, `/api/article` with http(s) guard), and the default-fetchFn global-fetch fallback. `voice.ts` shrank from 899 -> 296 lines (-603 net): `VOICE_TOOLS/Args/cap/stripFrontmatter/notePreview/ResearchHist/researchEntries/lastReaderNoteId/wikiSummaries/callTool/runTool/workingDocId/contractWikisRead` all moved to `voice-tools.ts`; `BASE_SYSTEM_PROMPT`, `buildVoiceSystemPrompt` (exported, used by `voice.test.ts`), `VoiceWikiSummary`, `VoiceRelayOpts`, `loopbackBase`, `attachVoiceRelay`, `bridge` kept. `bridge()` builds a session via `createVoiceToolSession({ base, fetchFn: globalThis.fetch.bind(globalThis), getSessionToken: () => opts.sessionToken, send })` and delegates `await runTool(fc.name, fc.args)` to `await toolSession.run(fc.name, fc.args)`. A tiny `wikiSummariesForPrompt(base)` helper is kept inline (used once at bridge startup for the system prompt, not on a tool path). Loopback-HTTP preserved: same loopback endpoints, same params, same error envelopes, same content cap; write/edit/promote still go through `/api/notes` and `/api/document/:id/promote`. Existing `voice.test.ts` (1/1) and `voice-promote.test.ts` (2/2) pass unmodified.

**Verifier result:** `npm test` 366/366 pass (27 files; +23 vs prior 343); `npm run typecheck` clean. Static checks I could run instead of the live bridge: `npx tsx server/index.ts` boots cleanly; `npx tsx -e "import('./server/integrations/voice.ts')"` and the `voice-tools.ts` import both resolve and export the expected symbols (`attachVoiceRelay`, `buildVoiceSystemPrompt`; `VOICE_TOOLS`, `createVoiceToolSession`); a curl of an unauthenticated `/api/voice/ws` WebSocket upgrade returns the expected 403 Forbidden (handler doesn't crash, no Gemini key path entered); `npm run build` (vite) green.

**SOFT BLOCKER:** full live voice round-trip (a `list_wikis` tool call, a `save_working_document`, or any actual Gemini-driven tool dispatch) cannot be exercised here. The bridge needs a configured Gemini API key in `~/.solaris/config.json` AND browser microphone + WebSocket access, neither of which is available in this environment. That smoke is a manual `npm run dev` + Tools -> Voice Assistant with a valid Gemini key, deferred to a real human session.

## U9 completion — Pure frontend modules: theme + spectrum

**Features:**
- F058: not_started -> passing. New `web/src/theme.ts` (361 lines) exports `THEMES`, `PALETTE`, `FALLBACK_COLORS`, `ThemeDef` (moved verbatim from `web/src/main.ts` lines 80–395), plus `GNodeLike`, `NodeColorDeps`, `resolveBaseColor(g, deps)` (precedence: customColors → theme palette → PALETTE → FALLBACK_COLORS[indexOf(g) % len]; Unwritten special-cased to never cycle), and `nodeColorFor(n, deps)` (pure: applies the base color plus the selected/hover/focus overlay that used to live in `boot()`). New `web/src/spectrum.ts` (49 lines) moves `spectrumComplement` and `spectrumHslToRgb` verbatim from `main.ts` (lines 3785–3832). `web/src/main.ts` shrank 377 lines: removed local `THEMES`/`PALETTE`/`FALLBACK_COLORS`/`ThemeDef` and the in-`boot()` `spectrumComplement`/`spectrumHslToRgb` definitions; `nodeColor(n)` replaced with one-liner `return nodeColorFor(n, colorDeps())` plus a `colorDeps()` factory binding `customColors` / `T().palette` / `PALETTE` / `FALLBACK_COLORS` / `groups` / `groupOf` / `theme.{selected,dim}` / `selected` / `inFocus` / `hoverNode` / `neighbors`. `recomputeColors` + `colorOf` map kept as-is (legend dot picker + search snippet rendering still need them). `groupOf` typing widened from `(n: GNode) => string` to `(n: GNodeLike) => string` so it satisfies `NodeColorDeps.groupOf` (function-parameter contravariance); `GNode` structurally has all `GNodeLike` fields, runtime unchanged. 23 new tests in `web/src/theme.test.ts` (THEMES shape, every theme carries the full CSS key set `--bg`/`--panel`/`--border`/`--fg`/`--muted`/`--accent` + scene fields, `PALETTE`/`FALLBACK_COLORS` shape, `resolveBaseColor` precedence incl. Unwritten-never-cycles + cycle index `indexOf(g) % len` + cycle wrap + override-does-not-skip-slot semantics, `nodeColorFor` overlay incl. selection-over-hover). 11 new tests in `web/src/spectrum.test.ts` (HSL anchors h=0/120°/240° at s=1 l=0.5, zero-saturation gray, hue-wrap round trip; `spectrumComplement` red↔cyan / green↔magenta / blue↔yellow, 6-char hex without leading `#` accepted, `complement(complement(x)) === x` for 5 theme accents, invalid-hex fallback `#f0883e`). 34 new tests total.

**Verifier result:** `npm test` 400/400 pass (29 files; +34 vs prior 366); `npm run typecheck` clean (0 errors); `npm run build` green (`vite build web` → 1.54 MB / 426 KB gzipped, identical envelope to pre-unit). Frontend tests visible in vitest output: `web/src/theme.test.ts (23 tests)`, `web/src/spectrum.test.ts (11 tests)`. No vitest config change (KTD7); the existing root `vitest.config.ts` (`include: ["**/*.test.ts"]`, `environment: "node"`) already discovers the new files. Manual load + theme-switch smoke verdict accepted by verifier.
