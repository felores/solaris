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
