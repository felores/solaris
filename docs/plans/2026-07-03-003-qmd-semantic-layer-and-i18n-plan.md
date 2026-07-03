---
artifact: ce-unified-plan/v1
readiness: requirements-with-approach
title: QMD semantic layer + interface i18n
date: 2026-07-03
status: in-progress
---

# QMD Semantic Layer + Interface i18n — Plan

## 0. Thesis

Solaris's graph is built **only from explicit `[[links]]`**. That is its ceiling: it
renders the map the user deliberately drew, not the latent structure of what they
actually wrote. QMD already holds the missing half — per-chunk embeddings in a
`sqlite-vec` index. Today Solaris uses QMD as a **search box**
(`/api/related`, `/api/semantic-search` via `vsearch`). This plan uses it as a
**structural layer of the map itself**, adds a bilingual interface, and does the
prep work that makes both cheap to build and to extend.

Strategic fit: QMD is 100% local, no egress. Everything here keeps Solaris's
"the core uploads nothing" promise intact (unlike the Exa/OpenRouter paths).

## Status & resume point (updated 2026-07-03)

**Shipped to `main`** (commits `5e2370d` → `7af8ad1`, then i18n follows):
- **Phase M — QMD index maintenance (A+B)**: Tools → Semantics `update` / `embed`
  / `re-embed` buttons + progress bar (driven by polling `qmd status`); auto-
  refresh on rescan. Code in `server/integrations/qmd-maintenance.ts`
  (`createQmdMaintenance`, `parseQmdStatus`, `qmdIndexStatus`); endpoints
  `GET/POST /api/qmd/maintenance` (POST token-guarded).
- **Phase 0.4 — multilingual embedding model** (F024–F026): selectable qmd embed
  model in Tools → Semantics. Config field `embedModel` (`config.ts`,
  `~/.solaris/config.json`, `null` = default). `Runner` gained an optional `env`
  param (`detect.ts`); the embed spawn carries `QMD_EMBED_MODEL` + `-f` on force.
- Large UX pile: external-link `.ext-icon`, panel slide + floating-fade (phantom
  fix), Tools reorg (Ingestion → Web Research → Semantics → LLM Provider), honest
  weight-based model labels, OpenRouter dedupe + key/credit links + out-of-credits,
  moved Copy-link/Open-in-Obsidian to File menu, button centering.

**RESUME HERE → Phase 0.1 (i18n) is IN PROGRESS — nothing built yet.** Tracked as
F027–F029 in `.harness/features.json`. Order: 0.1 i18n foundation + language
toggle → translate menubar/chrome (ES) → 0.2 `DESIGN.md`. Then 0.3 vector reader
→ Phase 1 edges → 2 arrangement → 3 clusters; 4 orphans and 6 content-language are
independent quick wins; 5 passage-jump anytime after 0.3.

### Decisions locked this session (do NOT re-litigate)
- **Embedding models: keep BOTH + custom, labeled by WEIGHT not language** (both
  are multilingual). `EmbeddingGemma 300M · lighter` (default = `null` config) /
  `Qwen3 0.6B · premium · heavier`
  (`hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`, 1024-dim) /
  `custom…`. MMTEB 61.15 vs 64.33; Qwen3 is ~2× size + slower. Default stays
  EmbeddingGemma (matches the current 768-dim index); switching needs a full
  re-embed. `custom` = any HF GGUF embedding model (`hf:org/repo/file.gguf`).
- **qmd maintenance = three explicit buttons**: update (BM25 reindex) / embed
  (incremental — pending chunks only) / re-embed (`qmd embed -f`, rebuild ALL,
  after a model change). No "(full)" relabel magic. Refresh-on-rescan is automatic
  when qmd covers the vault (no checkbox); incremental embed keeps it light.
- **Language toggle (0.1): COUNTRY FLAGS 🇬🇧/🇪🇸 (user overrode the neutral-chips
  decision at implementation).** Last menu after Help; the menubar label shows the
  active language's flag (`#lang-label`), the dropdown lists 🇬🇧 English / 🇪🇸 Español.
  Interface strings only. (The flags-for-languages anti-pattern was flagged; user chose flags.)
- **Content language (Phase 6) follows the NOTE, never the UI toggle** — add "reply
  in the same language as the note" to the note-questions prompt (`app.ts` ~L721).
- **Arrangement (Phase 2): build all three, Links = default.** Separate *drawn* vs
  *simulated* edges; mutual-KNN + cosine ≥ ~0.5 + K≈6–8 (anti-hairball); weight
  semantic ~0.3–0.5× links in Hybrid; cache positions per mode + animate the swap.
  Arrangement (layout) ⟂ Grouping (color): `group by` gains a `semantic cluster`.
- **Orphan links (Phase 4): preview-then-confirm**, real `[[wiki]]` markdown edits
  via `write.ts` `guardedEdit` (portable to Obsidian) — never a Solaris-only overlay.
- **Background freshness (cron/launchd): OUT of scope — Hermes owns it later.**
- **OpenRouter: no free-model chasing** (they get pulled/break). Flash = default /
  cheapest; show credits via free `GET /key`; warn out-of-credits; link keys +
  add-credits (`openrouter.ai/workspaces/default/keys`, `.../settings/credits`;
  Exa: `dashboard.exa.ai/api-keys`, `.../billing`).

### i18n (0.1) implementation notes
- `web/src/i18n.ts`: `t(key, vars?)`, `EN`/`ES` dicts, `getLang()` (localStorage
  `akasha-lang`, default `navigator.language`, fallback EN), `setLang()`,
  `hydrate(root?)`.
- `hydrate` handles three attrs: `[data-i18n]` (set textContent; if the element has
  a child element like a `.mi-hint` span, set only the leading text node so the
  hint survives), `[data-i18n-ph]` (placeholder), `[data-i18n-title]` (tooltip).
- Mixed items keep the hint as its own tagged span, e.g.
  `<button id="mi-rescan" data-i18n="file.rescan">Rescan Vault <span class="mi-hint" data-i18n="hint.incremental">incremental</span></button>`.
- Call `hydrate()` on boot and inside `setLang()`. Skip proper nouns + model slugs.
  ES = neutral Spanish, `tú`, no em dashes (repo doc rule).
- String surface to tag: menubar labels (File/Layers/View/Tools/Help), all File/
  View/Help items + hints, Tools item labels (Display Filters/Settings, the
  integration section headings), the `#search` placeholder, the `#loading` hint,
  reader/research chrome. Dynamic strings in `main.ts` (`"searching semantically…"`,
  research titles, modal bodies) route through `t()`.

## 1. Feasibility (verified 2026-07-03, not assumed)

- **QMD**: v2.6.3 (`~/.bun/bin/qmd`). SDK `@tobilu/qmd` exists on npm (v2.5.3).
- **Index**: `~/.cache/qmd/index.sqlite` (823 MB for FeloVault: 9,117 docs /
  102,704 chunk vectors).
- **Vector table** `vectors_vec` is a `sqlite-vec` **vec0** virtual table:
  `hash_seq TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine`.
  → **KNN is a direct SQL query** (`embedding MATCH ? ORDER BY distance`), a few
  ms, **no model inference**. This is the key finding: the semantic-edge and
  clustering features need only a **vector reader**, not a running qmd process.
- **Join path**: `content_vectors(hash, seq, pos, model, total_chunks)` →
  `documents(id, collection, path, title, hash, active)`. So a chunk vector maps
  back to its note's path/title. `pos` = char offset of the chunk (enables
  passage-jump).
- **Dimension is model-dependent**: embeddinggemma-300M = 768. Switching to a
  multilingual model (Qwen3-Embedding-0.6B) changes it to 1024. **The reader must
  read the dimension from the schema, never hardcode 768.**
- **Derived-content language**: the note-questions prompt (`server/app.ts:721`)
  already feeds the LLM the note excerpt, so "reply in the note's language" is a
  one-line prompt instruction — **no language detector required** for LLM paths.
- **Live latency**: current `vsearch` spawns the CLI and reloads models each call
  (~5s floor, per `qmd.ts`). Only relevant to interactive search, NOT to the
  precomputed edge features.

## 2. Constraints & conventions (must hold)

- **One vault write path** (`server/integrations/write.ts`). Orphan-link insertion
  goes through it; never add a second writer.
- **Adapter isolation**: all QMD coupling (including the new direct-sqlite reader)
  stays behind `server/integrations/qmd*.ts`, with a schema-version guard and a
  graceful "semantic layer unavailable" fallback if QMD's schema changes.
- **Path-traversal guards** stay green (`server/app.test.ts`, `integrations/*.test.ts`).
- **No egress** on any QMD path. Reader HTML stays DOMPurify-sanitized.
- **localStorage keys** stay `akasha-*`.
- Everything gates on QMD being set up (existing pattern); core works without it.

---

## Phase 0 — Foundation & modularization (no user-visible features)

Prep that makes every later phase a small diff. "Make the change easy, then make
the easy change." Ship these first; they are independently valuable.

### 0.1 i18n module (EN/ES) — highest-leverage modularization

- New `web/src/i18n.ts`: `t(key, vars?)`, `EN`/`ES` dictionaries, current lang in
  `localStorage['akasha-lang']` (default from `navigator.language`, fallback EN).
- **Static strings** (menu labels, panel titles in `index.html`): tag with
  `data-i18n="key"` and hydrate once on boot + on language change. Keeps HTML as
  the skeleton, moves copy into the dictionary.
- **Dynamic strings** in `main.ts` (`"searching semantically…"`, `"Web research"`,
  modal bodies, tooltips): route through `t()`.
- Language menu item: **last menu, after Help**, **neutral `EN` / `ES` chips (NOT
  country flags)**, click toggles lang, re-hydrates, persists. Interface-only.
- **Scope discipline (ponytail):** extract strings into the dictionary; do NOT
  rewrite `main.ts` structure wholesale. String centralization is the win.
- Verify: switching lang swaps all tagged UI; no key misses (a dev assertion logs
  untranslated keys).

### 0.2 `DESIGN.md` at repo root

Capture the existing design system so visual changes stop being archaeology and
so `harness-preview`/DesignSync can consume it:

- Theme model (`THEMES` CSS-variable sets, `--accent` semantics, the 10 themes).
- Chrome conventions: panel anatomy (header divider flush to borders, 18px inset,
  45px header row, 25px icon-buttons, `.reader-actions-right` grouping), the
  dock/float geometry engine, the corner-button system, spacing scale, icon set
  (lucide-style line icons), z-index ladder (graph → panels 20 → floating 5 →
  chrome → menus 50 → modal 100).
- Interaction conventions: mode exclusivity, search-first, consent gate for web,
  keyboard map (a/d panels, r/g/l/u/o, Ctrl±).
- Verify: a new contributor can restyle a panel using only DESIGN.md.

### 0.3 QMD vector-access module (the real enabler)

- New `server/integrations/qmd-vectors.ts` behind the qmd adapter.
- Opens `~/.cache/qmd/index.sqlite` **read-only** with `better-sqlite3` +
  the `sqlite-vec` loadable extension.
- API: `docVector(path)` (mean-pool a note's chunk vectors), `knn(vector, k)`,
  `allDocVectors()` for batch. **Dimension read from schema**, not constant.
- Schema-version guard: probe `vectors_vec`/`content_vectors` shape on open;
  if unexpected, disable the semantic layer and report a clear status instead of
  crashing. Injectable path for tests (fixture sqlite).
- **Not** a daemon. Live `vsearch` stays as-is for now; a persistent SDK/daemon is
  a *later, optional* latency optimization, out of scope here.
- Verify: unit test against a tiny fixture index (KNN returns expected neighbors;
  dimension mismatch → disabled, not thrown).

### 0.4 Multilingual embedding option — SHIPPED 2026-07-03 (F024–F026)

- Selectable embed model in Tools → Semantics (default `null` / Qwen3 / custom);
  `config.embedModel` + `QMD_EMBED_MODEL` on the embed spawn (+ `-f` on the
  `re-embed` button). The heavy re-embed is user-run (deliberately not auto-run).
- Because a future 0.3 reads the dimension from the schema, a model switch (768→
  1024) "just works" downstream.

---

## Phase 1 — Semantic edge set (data)

- New endpoint/build step: doc-level KNN over `qmd-vectors`, producing
  `data/semantic.json` (gitignored, like `graph.json`).
- **Edge hygiene** (avoid the hairball): mutual-KNN only (A∈topK(B) AND B∈topK(A)),
  cosine ≥ threshold (~0.5), K capped (6–8). Store `{source, target, score}`.
- Incremental: keyed by `documents.hash`; on rescan, recompute only changed notes'
  neighborhoods.
- Verify: edge set is symmetric, thresholded, bounded (~K·N/2 upper bound);
  spot-check that known-related-but-unlinked notes are connected.

## Phase 2 — Arrangement modes (layout)

Force layout = "which edges drive the physics." One mechanism, three edge sets.

- **Arrangement** selector next to `group by`: **Links** (default), **Semantic**,
  **Hybrid**.
- Feed the chosen edge array into the force sim; in Hybrid weight semantic edges
  ~0.3–0.5× link strength (links define the skeleton, semantics fill gaps + rescue
  orphans).
- **Drawn ≠ simulated**: semantic edges always rendered in a distinct faint/dashed
  style; a toggle hides the lines while keeping their pull (declutter).
- **Cache positions per arrangement** (extend `/api/layout` + `cachedPositions`);
  tween on switch instead of re-simulating live.
- Perf risk: +10–15k edges at 4k nodes. Mitigate with server-side precompute +
  freeze (existing warmup-then-freeze pattern). Hybrid is the heaviest — measure.
- Verify: each mode produces a stable, distinct layout; toggling is animated and
  reuses cached positions; frame budget acceptable at full vault size.

## Phase 3 — Semantic grouping / color (orthogonal to Phase 2)

- `group by: semantic cluster` — community detection (e.g., label propagation) on
  the Phase 1 KNN graph. Works under **any** arrangement (color axis ⟂ layout axis).
- Optional cluster labels via one LLM pass (name each community from its top terms).
- Verify: clusters are stable across reloads; coloring is independent of the
  chosen arrangement.

## Phase 4 — Orphan link suggestions (best effort/impact ratio)

- Upgrade `/api/gaps`: for each orphan/sparse node, surface top semantic
  neighbor(s) as "link these?" with a one-click insert **through `write.ts`**
  (append a `[[wiki]]` link; journaled).
- Bounded (orphans only) → no batch cost, works even without Phase 1.
- Verify: suggestion resolves to a real in-vault node; insertion goes through the
  guarded writer and is journaled; traversal tests stay green.

## Phase 5 — Passage-level reader

- On a semantic hit, scroll/highlight the matched chunk instead of opening at top,
  using `content_vectors.pos` (or the `@@ -n,n @@` line range already in `vsearch`
  snippets).
- Verify: opening a hit lands on the relevant passage; non-semantic opens unchanged.

## Phase 6 — Content language follows the note (independent, tiny)

- LLM-derived content (note-questions, and any future generated text): add
  "Respond in the same language as the note content." to the prompt/system message.
  The model already sees the excerpt.
- Template fallback (`topology.ts noteQuestions`): pick language from frontmatter
  `lang:` if present, else a cheap stopword heuristic; keep an ES + EN template set.
- Exa research chains naturally: questions seeded in the note's language → answers
  in that language. **Interface language (Phase 0.1) never overrides this.**
- Verify: an English note yields English questions while the UI is set to Spanish,
  and vice-versa.

---

## Phase M — QMD index maintenance (A + B) — SHIPPED 2026-07-03

User-controlled index freshness (C/D dropped: launchd will be handled by Hermes,
out of scope).

- **A**: `qmd update` / `qmd embed` buttons in Tools → Semantic, with a status line
  (`N pending · updated Xh ago`) and a progress bar that fills as embed drains the
  Pending count. Server: `createQmdMaintenance` runner (single-flight, background) +
  `qmdIndexStatus`/`parseQmdStatus`; `GET/POST /api/qmd/maintenance` (POST
  token-guarded, 409 if running). Progress is observed via `qmd status` polling
  (determinate), not stdout parsing.
- **B**: "refresh index on rescan" opt-in (`akasha-qmd-refresh-rescan`) fires the
  guarded update+embed **before** the reload so it runs server-side and survives.
- Verified: 129 tests green (+7), live endpoints return real index status, token
  guard holds (403). Not yet exercised end-to-end: the bar animating during a real
  `qmd embed` (deferred — in-session embed is weak; run "re-embed" to watch it).

## 3. Sequencing

1. **Phase 0** first (unblocks everything; each sub-item ships independently).
   - 0.1 i18n and 0.2 DESIGN.md have zero dependency on QMD — can land immediately.
   - 0.3 vector reader gates Phases 1–3.
2. **Phase 6** (content-language) is a tiny, independent win — bundle with 0.1.
3. **Phase 4** (orphan suggestions) — quick, actionable, needs only live vsearch.
4. **Phase 1** (edge set) → then **Phase 2** (arrangement) → **Phase 3** (clusters,
   rides Phase 1's plumbing).
5. **Phase 5** (passage jump) any time after 0.3; low priority.

Rationale: front-load the invisible enablers and the cheap wins; save the compute-
and-UX-heavy flagship (2/3) for after the vector reader is proven.

## 4. Consolidated trade-offs

- **Direct-sqlite read vs SDK/daemon**: direct read is fastest and daemon-free but
  couples to QMD's schema → quarantined behind the adapter + schema guard + fallback.
  SDK is more "official" but adds a dependency and re-embeds on query. **Chosen:
  direct read for batch; keep CLI vsearch for live search.**
- **Arrangement default**: Links (familiar) vs Hybrid (most useful). **Chosen:
  Links default, Hybrid one click away** — don't surprise on first load.
- **Multilingual model**: better ES recall vs larger/slower/more disk. Opt-in.
- **main.ts modularization**: full split is a large, risky refactor with little
  user value → **do targeted extraction only** (strings now; panels later only if a
  feature demands it).

## 5. Open questions (confirm before build)

1. **Spanish flag**: 🇨🇴 (your locale), 🇪🇸, or a neutral "ES" chip? (You write in
   neutral Spanish.)
2. **Arrangement default** confirmed as **Links**? (Recommended.)
3. **Multilingual model** now (re-embed the whole vault) or later?
4. Should orphan-link insertion **auto-write** or only **draft/preview** the link
   for confirmation? (Recommend preview-then-confirm, given it mutates the vault.)

## 6. Verification (per phase, release-blocking items in bold)

- 0.1: language toggle swaps all tagged strings; **no untranslated-key regressions**.
- 0.3: **schema-guard fallback** (bad/absent index → semantic layer disabled, not a
  crash); KNN fixture test.
- 1: edge set symmetric + thresholded + bounded.
- 2: layouts stable/distinct; animated switch; **frame budget OK at full vault**.
- 4: **insertion via write.ts only, journaled; path-traversal + consent tests green**.
- 6: derived language tracks the note, not the UI.
