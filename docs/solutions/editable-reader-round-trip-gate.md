---
title: Editable reader — CM6 live-preview with a byte-for-byte round-trip gate
module: reader/editor
problem_type: architecture_pattern
component: web/src/editor.ts, server/integrations/write.ts
tags:
  - codemirror
  - live-preview
  - round-trip
  - autosave
  - compare-and-swap
  - vault-trust-model
severity: high
date: 2026-07-10
---

# Editable reader: what mattered and what almost went wrong

Plan 018 made the reader pane always-editable (Obsidian live-preview style)
with autosave into the user's real vault. Durable learnings:

## Architecture: markdown string as the document, never an AST

AST/WYSIWYG editors (Milkdown, Tiptap, Lexical, ToastUI) regenerate the whole
file on save and corrupt untouched content — confirmed upstream bugs include
frontmatter fence mangling and wiki-link escaping. CodeMirror 6 keeps the raw
string as the document and renders the look via decorations, so round-trip is
byte-for-byte **by construction**. For an app that writes into a vault, this
choice eliminates the entire serializer bug class. The npm "live-preview"
packages were too young or React-tied; assembling `@codemirror/*` +
~350 lines of decorations (`web/src/editor.ts`) was cheaper and sturdier.

The gate that keeps this honest: `web/src/editor-fixtures/` round-trip
fixtures (frontmatter, wiki-links, CRLF, raw HTML, blank runs, no-final-
newline) asserted byte-equal in `web/src/editor.test.ts`. Touch the editor →
keep the gate green.

## Pitfalls hit (would bite again)

- **CM6 normalizes line endings to LF.** `getContent()` must restore the
  note's dominant EOL or every CRLF vault note gets silently rewritten.
- **`changeFilter` range suppression eats select-all-retype.** Returning
  `[0, fmEnd]` suppressed the WHOLE replacement (typed text lost). A
  `transactionFilter` that clips changes to start at the protected boundary
  keeps the typed text and the frontmatter.
- **`EditorState.readOnly` does not block programmatic dispatch** — add a
  `changeFilter(() => false)` for hard read-only (phantom fallback).
- **Generic `#reader-body img { display:block }` broke widget layout**:
  CM6 inserts inline `img.cm-widgetBuffer` around widgets; the rule forced a
  line break around every wiki-link. Scope or override for `.cm-widgetBuffer`.
- **mtime is the wrong staleness signal.** A CAS on `mtimeMs` false-409s on
  the app's own next save (mtime changes on every write, and PUT didn't
  return it) and false-passes on same-millisecond or mtime-preserving
  external writes. Content-hash CAS (`baseHash`, sha256 over UTF-8) closes
  both and needs no server round-trip: the client promotes its own saved
  content to base.
- **Overlapping saves self-conflict.** A blur flush while a debounce save is
  in flight sends the same pre-promotion base twice → the second 409s
  against our own write. Autosave must be single-flight with one queued
  follow-up (`web/src/autosave.ts`).
- **`beforeunload` cannot await**: keepalive PUTs cap at 64KB and the hash
  must be precomputed. The real recovery net is a vault-scoped
  `localStorage` mirror, not the network. The change journal is useless for
  recovery — entries carry no content.
- **jsdom + CM6**: stub `Range.getClientRects`, and don't trust
  `visibleRanges` (no layout) — decorate the full doc under a size cap,
  which is also correct in the browser at note sizes.
- **E2E must never touch the developer's vault.** The Playwright suite now
  builds a hermetic vault (`tests/e2e/global-setup.ts`, invoked from the
  webServer command chain because Playwright starts webServers BEFORE
  globalSetup) and the write-tests skip unless the served vault is the
  hermetic one.
- **Expected-empty endpoints should not 404** — browsers auto-log 404
  fetches as console errors, tripping the release-blocking diagnostics on
  fresh vaults (`GET /api/layout` now returns 204 when no cache exists).
