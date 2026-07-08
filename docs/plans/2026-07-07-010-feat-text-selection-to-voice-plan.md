---
title: Text Selection Context for Voice and Search - Plan
type: feat
date: 2026-07-07
topic: text-selection-context
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Text Selection Context for Voice and Search - Plan

## Goal Capsule

- **Objective:** Let the user select text in the left content reader and/or the right research panel, then explicitly act on that selection through a right-click menu, the search bar, or voice.
- **Product authority:** User clarification in this session supersedes the narrower voice-only and search-bar-only drafts. Product Contract preservation: changed scope to make right-click the primary selected-text action path, add Keyword as a first-class Vault search path, and add a visible search-bar context strip with a send button.
- **Execution profile:** Frontend selection state, custom selected-text context menu, search-bar context strip, Vault `Semantic | Keyword` scope, voice WebSocket context cache, `current_view` response expansion, deterministic Semantic query augmentation, keyword research-panel results, and contextual Web/Deep query rewrite inside existing server routes. No new database, no persistent highlight store, no vault writes.
- **Stop conditions:** Stop and ask before adding persistent selection history, a full context manager/sidebar, multi-select saved snippets, new vault write paths, or automatic model/search execution on selection alone.
- **Open blockers:** None.

---

## Product Contract

### Summary

Solaris has two reading surfaces: the content reader on the left and the research panel on the right. Users naturally point at passages by selecting text. The product should preserve that pointing gesture as context, but selection alone must not run a model, search the web, write a file, or spend credits.

Right-clicking selected text is the primary action path because it is explicit, familiar, and local to the selected passage. The user should be able to select text and immediately choose `Semantic search`, `Keyword search`, `Web search`, or `Deep research` from a custom context menu.

The search bar remains useful for composed queries. If selected text exists and the user focuses the search box, Solaris should show a small strip below the bar that says selected text can be included as context, shows source chips, and lets the user toggle that context off. A paper-plane send button appears when there is typed text, or when selected context alone can be sent through an active `Vault` or `Web` mode.

Voice uses the same selected context through `current_view`. The important product shape is two context slots, not one global slot. The user may select a passage in the note and another passage in the research panel, then ask the voice agent to compare them or dig deeper from both.

### Requirements

**Selection capture**

- R1. Capture selections whose selection range is fully inside `#reader-body` or fully inside `#research-body` only. Ignore selections in menus, the graph canvas, the search input, the reader find input, and any selection crossing between panels.
- R2. Keep two independent selection slots: `reader` and `research`. A new reader selection replaces only the reader slot. A new research selection replaces only the research slot.
- R3. Clear the reader slot when a different note opens or the reader closes. Clear the research slot when a different research history entry opens, a new research result replaces the panel, or the research panel closes.
- R4. Selection alone must not call OpenRouter, Exa, qmd, `/api/search`, write APIs, or any provider model. It may update in-memory frontend state. If a voice session is active, it may update the local Solaris voice relay cache only; that cache update must not be forwarded to the provider as a model message.

**Context shape and limits**

- R5. A reader selection context must include `source: "reader"`, `text`, `noteId`, and `noteTitle` when available. `noteId` is the vault-relative note path from `openNodeId`.
- R6. A research selection context must include `source: "research"`, `text`, `entryId` when available, `mode` when available, and a human-readable `title` or `query` derived from the current research history entry. For article entries, include `url` when available.
- R7. Outbound selected context is capped to 300 words or 3000 characters total across both slots. If both slots are present, the most recently selected slot gets priority and the other slot is clipped to the remaining budget. Every clipped slot carries `truncated: true`, `originalWordCount`, and `originalCharCount`.
- R8. The user receives no warning while selecting. Warnings are shown only when selected context is actually used by voice, context menu action, or a written query. The warning is non-blocking and says selected context was trimmed when `truncated: true` is present.

**Right-click selected-text menu**

- R9. Right-clicking inside a valid reader or research selection opens a custom context menu instead of the native browser menu.
- R10. The custom menu includes `Semantic search`, `Keyword search`, `Web search`, `Deep research`, and `Copy`.
- R11. Selecting `Semantic search` runs a local Vault Semantic search from the selected context, without OpenRouter or Exa.
- R12. Selecting `Keyword search` runs local keyword search from the selected text, without OpenRouter or Exa.
- R13. Selecting `Web search` or `Deep research` uses the existing Web consent gate before any selected text leaves the machine. If consent is missing, show the existing Web consent flow instead of running the action.
- R14. `Copy` copies the selected text to the clipboard. If clipboard write is unavailable, do not run a search as fallback; fail softly or let the native shortcut remain the fallback.

**Search bar**

- R15. If selected context exists and the user focuses the search box, show a context strip below the bar. The strip says `Include selected text as context`, shows source chips such as `Reader: foo.md` and `Research: query title`, and includes an on/off toggle.
- R16. The context strip toggle defaults on for a new selection, can be turned off by the user, and remains off until the selection changes or is cleared. The toggle state is in-memory only and is not persisted.
- R17. A paper-plane send button appears inside the search field when the field has typed text, or when the include-selection toggle is on, selected context exists, and the active mode can consume selected context (`Vault` or `Web`). Clicking the button behaves like pressing Enter. With no active mode, selected-context-only send is disabled and typed queries keep the existing dropdown/open-first-result behavior.
- R18. Search bar selected context is used only when the user presses Enter or clicks the send button. Typing, focusing, toggling, and selecting still do not run searches or models.
- R19. The search bar supports composed queries: typed query plus optional selected context. If the input is empty and included selected context exists, the action uses the selected text as the query/context for the active mode.

**Search modes**

- R20. Replace the current single `Semantic` top-level mode with a `Vault` top-level mode that has a visible `Semantic | Keyword` scope toggle, similar to the existing Web `Deep | Web` scope toggle.
- R21. Vault `Semantic` calls qmd passage search through `/api/passages` and stays local. The effective query passed to `/api/passages` must be explicitly typed as `vec:<composed local query>` so qmd does not trigger slow LLM expansion.
- R22. Vault `Keyword` calls MiniSearch-backed keyword search through `/api/search` and stays local.
- R23. Web mode keeps its existing `Deep | Web` toggle. `Deep` asks for synthesized research. `Web` asks for raw web results.
- R24. Ingest mode ignores selected context.

**Voice**

- R25. When a voice session is active, the browser sends selection context updates to the local voice WebSocket as `{ type: "context", context }`. The server stores the latest reader slot and research slot for that voice session only. If the user selected text before starting voice, the browser sends the current capped selection snapshot as soon as voice reports `onReady`.
- R26. The voice `current_view` tool response includes `selectedContext: { reader, research, lastSource }`, where each slot is either a capped context object or `null`. Existing `openNote` and `recentResearch` fields remain.
- R27. The voice prompt tells the model that `selectedContext` is grounding for phrases like "this", "esto", "compare these", "dig deeper into this research", or "relate this to the note". It is not a command by itself.
- R28. Voice session end drops all selected context because the data lives in the per-session tool state.

**Backend history and display queries**

- R29. `/api/passages` accepts an optional `displayQuery` for history storage. It searches with the effective local query and stores `displayQuery` when present.
- R30. `/api/search` accepts an optional history flag and optional `displayQuery` for Vault Keyword research-panel use. The existing default search dropdown continues calling `/api/search` without history and keeps its current behavior.
- R31. `/api/research` sends the effective query to Exa, but research history and visible UI keep the user's original typed query or action label as `displayQuery` so history does not become a giant internal context prompt.

### Key Flows

- F1. Right-click selected note text and run Semantic.
  - **Trigger:** User selects a passage inside the reader and right-clicks the selection.
  - **Steps:** Frontend captures the reader slot, opens the custom menu, user clicks `Semantic search`, and Solaris runs Vault Semantic with the capped selected context.
  - **Outcome:** Research panel opens with local qmd passage results related to the selected passage.
  - **Covers:** R1, R5, R7, R9, R10, R11, R21.

- F2. Right-click selected research text and run Deep Research.
  - **Trigger:** User selects text inside a research result and chooses `Deep research` from the custom menu.
  - **Steps:** Existing Web consent gate runs first. `/api/research` receives selected context plus `deep: true`, rewrites with OpenRouter when available, falls back deterministically otherwise, and sends the effective query to Exa.
  - **Outcome:** The external research query reflects the selected passage only after explicit menu action.
  - **Covers:** R6, R7, R8, R10, R13, R23, R31.

- F3. Search bar exposes selected context.
  - **Trigger:** User selects text, then focuses the search box.
  - **Steps:** The context strip appears below the bar with source chips and an include toggle. The paper-plane button appears if typed text exists, or if selected context exists and the active mode is `Vault` or `Web`. User can turn context off before sending.
  - **Outcome:** The user sees that selected text will be included and can opt out before Enter/send.
  - **Covers:** R15, R16, R17, R18, R19.

- F4. Vault Keyword search uses selected context.
  - **Trigger:** User selects text, opens the search bar, leaves the query empty, keeps context included, chooses Vault Keyword, and clicks send.
  - **Steps:** Frontend uses selected text as the effective keyword query, calls `/api/search` with history enabled, and renders keyword results in the research panel.
  - **Outcome:** Literal/fuzzy vault matches appear without qmd, OpenRouter, or Exa.
  - **Covers:** R12, R19, R20, R22, R30.

- F5. Reader and research selections reach voice together.
  - **Trigger:** User selects one note passage and one research passage, then says "compare these".
  - **Steps:** Frontend stores both slots and syncs them to the active local voice relay. The voice model calls `current_view`, and `current_view` returns both capped selections with source metadata.
  - **Outcome:** The voice agent knows which selected text came from the vault note and which came from research.
  - **Covers:** R2, R5, R6, R25, R26, R27.

- F6. Oversized selection warns only when used.
  - **Trigger:** User selects more than the 300 word or 3000 character cap, then chooses a context-menu action or sends a search query.
  - **Steps:** Selection capture stores/caps counts silently. On use, the research panel shows a one-line non-blocking notice. On voice use, `current_view` includes `truncated: true`, and the prompt instructs the model to mention truncation briefly if it matters.
  - **Outcome:** Selection feels normal. The user learns about clipping only when clipping affects an operation.
  - **Covers:** R7, R8, R27.

- F7. Stale context is cleared.
  - **Trigger:** User selects text in `notes/foo.md`, then opens `notes/bar.md`.
  - **Steps:** `openReader` clears the reader selection slot because `openNodeId` changed and resyncs voice if active.
  - **Outcome:** Later voice/search actions cannot accidentally use a passage from the previous note.
  - **Covers:** R3, R25.

### Acceptance Examples

- AE1. Given selected text in the reader and no voice session, when the user selects text, then no WebSocket error appears and no network request is made.
- AE2. Given selected reader text, when the user right-clicks inside the selection, then a custom menu appears with `Semantic search`, `Keyword search`, `Web search`, `Deep research`, and `Copy`.
- AE3. Given no valid selected text in reader/research, when the user right-clicks, then the custom menu does not appear.
- AE4. Given selected text in the reader, when the user chooses `Keyword search`, then `/api/search` is called and neither OpenRouter nor Exa is called.
- AE5. Given selected text in the reader, when the user chooses `Semantic search`, then `/api/passages` is called and neither OpenRouter nor Exa is called.
- AE6. Given selected text, Web mode consent missing, and the user chooses `Deep research`, then the Web consent flow appears and no external request is made before consent.
- AE7. Given selected text, Web consent, Exa key, and OpenRouter key, when the user chooses `Deep research`, then `/api/research` calls OpenRouter to rewrite and Exa to search, stores history under a readable display query, and never echoes API keys.
- AE8. Given selected context, active `Vault` or `Web` mode, and the search box focused, when the include toggle is on and the box is empty, then the paper-plane button appears and sends the selected context through the active mode.
- AE9. Given selected context, no active mode, and an empty search box, when the search box is focused, then the context strip may appear but the paper-plane button does not send selected context alone.
- AE10. Given selected context and the search box focused, when the user turns the include toggle off, then Enter/send uses only the typed query and no selected context.
- AE11. Given selected text in reader and research, when `current_view` runs in an active voice session, then the response includes both `selectedContext.reader` and `selectedContext.research` with source metadata.
- AE12. Given a long unbroken selection over 3000 characters, when the context is used, then it is capped and the trim notice appears only at use time.
- AE13. Given a reader selection in `notes/foo.md`, when `notes/bar.md` opens, then `selectedContext.reader` becomes `null`.

### Scope Boundaries

**In scope**

- Selection slots for reader and research panels.
- Source metadata for vault notes and research history entries.
- Custom selected-text context menu.
- Search-bar context strip, include toggle, and send button.
- Vault mode with `Semantic | Keyword` scope.
- Keyword results rendered in the research panel/history.
- Voice `current_view` grounding.
- Semantic local query augmentation.
- Web/Deep contextual query rewrite inside existing `/api/research`.
- Non-blocking use-time notice for clipped selected context.

**Deferred for later**

- Persistent selection history beyond one slot per panel.
- Full context manager/sidebar.
- Visual re-highlighting after native browser selection clears.
- Context chooser UI beyond the simple include toggle and source chips.
- Selection context for non-reader surfaces like graph labels, menus, and search results dropdown.
- Keyboard shortcut menu equivalent beyond normal search-bar accessibility.

---

## Planning Contract

### High-Level Technical Design

```mermaid
flowchart TB
  A[User selects text] --> B[web/src/main.ts reads current Selection]
  B --> C[web/src/selection-context.ts caps and stores reader/research slot]
  C --> D{Explicit action}
  D -->|Right-click menu| E[Selected-text context menu]
  E -->|Semantic| F[/api/passages q + displayQuery]
  E -->|Keyword| G[/api/search history=1 + displayQuery]
  E -->|Web/Deep| H[/api/research contexts + displayQuery]
  D -->|Search focus| I[Context strip + include toggle + send button]
  I --> J{Mode and scope}
  J -->|Vault Semantic| F
  J -->|Vault Keyword| G
  J -->|Web/Deep| H
  D -->|Voice asks about screen| K[voice WS local context cache]
  K --> L[current_view returns selectedContext]
  H --> M{OpenRouter key?}
  M -->|yes| N[rewrite query with OpenRouter]
  M -->|no| O[deterministic fallback query]
  N --> P[Exa search]
  O --> P
```

### Key Technical Decisions

- KTD1. **Right-click is the primary selected-text action path.** It is explicit, local to the passage, and matches user expectations from browsers and document tools. Selection still does nothing until the menu action is chosen.
- KTD2. **Two slots instead of one latest highlight.** The user can select a note passage and a research passage before asking a combined question. A single latest slot would lose one side of that task.
- KTD3. **Search bar context is visible and opt-out.** If selected context exists, focusing the search bar shows a context strip with source chips and a toggle. Hidden context injection would be surprising.
- KTD4. **Vault has two scopes: Semantic and Keyword.** Semantic is meaning-based qmd passage retrieval. Keyword is MiniSearch literal/fuzzy title/content retrieval. They solve different jobs and both are local.
- KTD5. **Selection capture is not execution.** Capturing text updates in-memory state and, when voice is active, the local relay cache. It never calls a provider model, qmd, Exa, `/api/search`, or any write route by itself.
- KTD6. **Semantic stays local.** The `docs/solutions/qmd-vsearch-latency.md` note says typed `vec:` queries avoid qmd's slow LLM expansion. Adding OpenRouter before qmd would violate the local-first posture and add unnecessary latency.
- KTD7. **Web/Deep rewrite lives inside `/api/research`.** This reuses the existing token guard, Web consent, Exa key checks, retry behavior, and history persistence. No new spending endpoint is needed.
- KTD8. **Display query is separate from effective query.** The effective query may contain clipped selected text. The UI and history should preserve what the user typed or clicked, not the internal augmented prompt.
- KTD9. **Cap at outbound use boundaries.** The helper stores enough metadata to know clipping happened, then builds a capped outbound snapshot for menu/search/voice use. This prevents accidental huge context payloads while preserving normal selection behavior.

### Existing Patterns To Follow

- `web/src/main.ts` owns reader/research state: `openNodeId`, `currentEntryId`, `researchHistory`, `historyIdx`, `runSemanticQuery`, `runWebQuery`, and `runModeQuery`.
- `web/src/voice.ts` owns the browser voice socket and already returns a `VoiceSession` handle.
- `web/src/prefs.ts` owns persisted UI preferences such as current mode and Web scope.
- `web/src/i18n.ts` owns UI strings.
- `server/integrations/voice.ts` owns provider bridges and browser WebSocket message handlers.
- `server/integrations/voice-tools.ts` owns per-voice-session mutable tool state and the `current_view` implementation.
- `server/app.ts` owns `/api/passages`, `/api/search`, and `/api/research` history persistence.
- `server/integrations/notes-index.ts` owns MiniSearch keyword search.
- `server/integrations/openrouter.ts` is the only OpenRouter adapter. Reuse `chatCompletion`, `DEFAULT_MODEL`, and configured `integrations?.openrouter`.
- `server/integrations/exa.ts` is the only Exa adapter. Do not build Exa request shapes outside it.

### Assumptions

- The existing Web mode consent covers sending selected passages as part of a Web/Deep Research action after the user chooses a menu item or presses send.
- OpenRouter key presence is sufficient consent for the server to use OpenRouter on explicit LLM operations, matching existing `/api/note-questions` behavior.
- A local voice relay context message is acceptable because it does not reach Gemini/OpenAI/xAI until the model later calls `current_view`.

---

## Implementation Units

### U1. Pure selection-context helpers

- **Goal:** Create small pure helpers so context rules are testable outside the large DOM-heavy `main.ts`.
- **Requirements:** R2, R5, R6, R7, R8, R16, R19.
- **Files:** `web/src/selection-context.ts`, `web/src/selection-context.test.ts`.
- **Approach:** Define `SelectionSource = "reader" | "research"`, `SelectionContext`, `SelectionContextState`, `MAX_CONTEXT_WORDS = 300`, `MAX_CONTEXT_CHARS = 3000`, and action/scope helpers for `semantic`, `keyword`, `web`, and `deep`. Implement helpers to normalize whitespace, count words/chars, apply a slot update, clear a slot, build the capped outbound snapshot with `lastSource` priority, build deterministic Vault Semantic and Vault Keyword effective queries, build display labels/source chips, and build a short use-time notice string. The Vault Semantic helper must return the exact `/api/passages` query string value in `vec:<composed local query>` form; do not rely on downstream qmd code to add typing for selected-context queries.
- **Test scenarios:** Empty and whitespace text returns no slot. Reader and research slots coexist. Updating reader does not erase research. Clearing reader does not erase research. A 400 word single slot is capped to 300 words and marked truncated. Long unbroken text is capped by the 3000 character limit and marked truncated. Two long slots are capped to 300 total words with `lastSource` priority. Source chips include note title/path and research title/query. Semantic effective query starts with `vec:` and contains the typed query when present, source labels, origin metadata, and capped selected text.
- **Verification:** `npm test -- web/src/selection-context.test.ts` and `npm run typecheck`.

### U2. Frontend selection capture, custom context menu, and search strip

- **Goal:** Wire reader/research text selection into the helper state and expose explicit UI actions without automatic execution.
- **Requirements:** R1, R3, R4, R9, R10, R14, R15, R16, R17, R18, R19, AE1, AE2, AE3, AE8, AE9, AE11, AE12.
- **Files:** `web/src/main.ts`, `web/src/style.css`, `web/index.html`, `web/src/i18n.ts`.
- **Approach:** Add one in-memory `selectionContextState` and one in-memory `includeSelectionContext` flag. Add a DOM reader that checks `window.getSelection()`, requires non-collapsed text, requires all ranges to live inside the same `#reader-body` or `#research-body`, and ignores form controls. For reader origin, use `openNodeId` and `byId.get(openNodeId)?.title`. For research origin, resolve the current entry from `currentEntryId`, `historyIdx`, and `researchHistory`, then include `entryId`, `mode`, `query`, `title`, and article `url` if present. Add a delegated `contextmenu` handler for valid selections that prevents the native menu and shows a small positioned menu with the five actions. Add `Copy` with `navigator.clipboard.writeText(selectedText)` when available. Add a hidden search context strip under `#search-wrap` that appears on search focus when selected context exists. Add a send button inside or adjacent to the search field that triggers the same function as Enter. Clear source slots on panel/source changes and resync voice if active.
- **Test scenarios:** Covered mostly through `web/src/selection-context.test.ts`; DOM-specific behavior needs manual smoke because Vitest runs in node and `main.ts` is not currently DOM-unit-tested.
- **Manual smoke:** Select inside reader, right-click, and see the custom menu. Select outside reader/research and see no custom menu. Copy action copies only selected text. Focus the search bar with selection and see the context strip and source chips. Toggle context off and verify send uses only typed text. Empty search plus included context shows the send button. Open a different note and verify reader slot clears. Open a different research history entry and verify research slot clears.
- **Verification:** `npm test -- web/src/selection-context.test.ts`, `npm run typecheck`, and manual smoke with `npm run dev`.

### U3. Vault Semantic and Keyword scopes

- **Goal:** Make local vault search a first-class mode with `Semantic | Keyword` scopes and render keyword results in the research panel/history.
- **Requirements:** R11, R12, R20, R21, R22, R24, R29, R30, AE4, AE5.
- **Files:** `web/index.html`, `web/src/main.ts`, `web/src/prefs.ts`, `web/src/prefs.test.ts`, `web/src/i18n.ts`, `server/app.ts`, `server/integrations/qmd.test.ts`, `server/integrations/notes-index.test.ts`.
- **Approach:** Change the visible top-level mode from `Semantic` to `Vault`. Update all mode entry points, not only the topbar button: `web/index.html` button id/data, topbar rail/mobile rail `data-mode`, `ModeName`, `MODE_LIST`, `modeIdx`, `modeReady`, placeholders, research titles, i18n keys, and persisted prefs. Add a `#vault-scope` control next to the search box when Vault mode is active, mirroring `#web-scope`, with `Semantic` and `Keyword` buttons. Add `vaultScope` persistence in `web/src/prefs.ts`; migrate old persisted mode value `semantic` to the new `vault` mode on read. Add `runVaultQuery(query, contextSnapshot, source)` that dispatches to `runSemanticQuery` or new `runKeywordQuery`. Add `renderKeywordInto` to render `/api/search` hits as research rows grouped similarly enough to semantic rows. Extend `/api/search` with optional `history=1` and `displayQuery`; without `history=1`, keep existing dropdown behavior exactly. Add research history entries with `mode: "keyword"` for keyword panel results. Context menu `Semantic search` and `Keyword search` call the same query functions with selected-context snapshots. Ingest ignores selected context.
- **Test scenarios:** `prefs.test.ts` migrates persisted `semantic` mode to `vault` and round-trips `vaultScope`. `/api/search` without `history=1` returns the existing array shape and does not create research history. `/api/search?history=1` returns results plus `historyId`. `/api/search?history=1&displayQuery=x` stores `x` as the history query. `/api/passages` searches effective `q` but stores `displayQuery` when present. Frontend manual smoke verifies Vault Semantic and Vault Keyword toggles appear only in Vault mode, run the right local endpoint, and are reachable from both desktop topbar controls and rail/mobile controls.
- **Verification:** `npm test -- web/src/prefs.test.ts server/integrations/notes-index.test.ts server/integrations/qmd.test.ts`, `npm run typecheck`, and manual smoke with `npm run dev`.

### U4. Voice context cache and current_view grounding

- **Goal:** Make selected context available to the voice agent through the existing voice session and `current_view` tool.
- **Requirements:** R25, R26, R27, R28, AE10.
- **Files:** `web/src/voice.ts`, `web/src/main.ts`, `server/integrations/voice.ts`, `server/integrations/voice-tools.ts`, `server/integrations/voice-tools.test.ts`, `server/integrations/voice.test.ts`.
- **Approach:** Extend `VoiceSession` with `sendContext(contextStateOrSnapshot)`. The method no-ops unless the browser WebSocket is open and sends JSON with `type: "context"`. When `onReady` fires, `main.ts` immediately calls `voiceSession.sendContext(current capped snapshot)` so selections made before voice startup are available. Later selection updates and source clears resend the capped snapshot while voice remains active. Extend `VoiceToolSession` with a setter such as `setSelectedContext(context)`. In both provider bridges in `server/integrations/voice.ts`, parse browser messages with `type === "context"`, validate the shape, and update the tool session without forwarding anything to the provider. In `server/integrations/voice-tools.ts`, revalidate and reapply the same 300 word / 3000 character total cap before storing selected reader/research slots alongside `workingDocId`, then include `selectedContext` in `current_view`. Update the `current_view` tool description and the voice system prompt to explain the field.
- **Test scenarios:** `current_view` returns `selectedContext` with both slots after setter calls. A new reader context replaces only reader. Invalid context is ignored. A new `createVoiceToolSession` starts with both slots null. `buildVoiceSystemPrompt` contains the selectedContext instruction. Realtime tool declarations still include `current_view` after description changes.
- **Verification:** `npm test -- server/integrations/voice-tools.test.ts server/integrations/voice.test.ts` and `npm run typecheck`.

### U5. Contextual Web/Deep research and history-safe display queries

- **Goal:** Use selected context for Web and Deep Research only after explicit menu/send action, while keeping history readable and preserving deterministic fallback when OpenRouter is absent.
- **Requirements:** R13, R23, R29, R31, AE6, AE7.
- **Files:** `server/integrations/contextual-query.ts`, `server/integrations/contextual-query.test.ts`, `server/app.ts`, `server/integrations/exa.test.ts`, `web/src/main.ts`.
- **Approach:** Add a small server helper that validates incoming selected contexts, builds an OpenRouter rewrite prompt, parses a JSON response of shape `{ "query": "..." }`, clamps the rewritten query to a safe length, and provides a deterministic fallback query. Modify `/api/research` to accept optional `contexts` and `displayQuery`. After Web consent and key checks, derive `effectiveQuery`: use OpenRouter when context exists and `cfg.openrouterKey` is set, otherwise use deterministic fallback. Send `effectiveQuery` to Exa. Save history with `displayQuery || query`. Return `effectiveQuery`, `contextApplied`, `contextRewriteSource`, and `contextWarning` for UI notices. Context menu `Web search` sets `deep: false`; `Deep research` sets `deep: true`. Search bar Web mode continues using the existing `webScope` toggle.
- **Test scenarios:** `/api/research` with context and OpenRouter key posts to OpenRouter and sends rewritten query to fake Exa. Response and history never echo keys. `/api/research` with context and no OpenRouter key still sends deterministic effective query to fake Exa. `/api/research` stores `displayQuery` in history when provided. Malformed contexts are ignored or sanitized, not thrown back as 500s. Missing Web consent blocks before OpenRouter or Exa calls.
- **Verification:** `npm test -- server/integrations/contextual-query.test.ts server/integrations/exa.test.ts` and `npm run typecheck`.

### U6. Notices and final integration smoke

- **Goal:** Make context use visible only when it matters, without turning selection into an automatic action.
- **Requirements:** R8, R15, R17, R18, AE8, AE11.
- **Files:** `web/src/main.ts`, `web/src/style.css`, `web/src/i18n.ts`.
- **Approach:** When a menu action or search send uses selected context, render one muted notice at the top of the research body before results: examples are `Using selected context from Reader and Research.` and `Selected context was trimmed to 300 words.` Reuse existing muted styling if possible. Search-bar focus shows the strip, but no trim warning appears until send/menu action. For voice, do not add browser UI; the model sees `truncated` through `current_view` and can mention clipping only if relevant.
- **Test scenarios:** Context-menu action with one selected slot shows a context-used notice. Web action with truncated context shows a trimming notice. Search focus shows the context strip but no trim notice. Query with the include toggle off shows no context-used notice. No notice appears at selection time.
- **Verification:** Manual smoke with `npm run dev`, plus `npm run typecheck`.

---

## Verification Contract

| Check | Command | Proves |
|---|---|---|
| Frontend helper tests | `npm test -- web/src/selection-context.test.ts` | Slot behavior, caps, source chips, effective local query construction |
| Prefs tests | `npm test -- web/src/prefs.test.ts` | Vault mode and Vault scope persistence/migration |
| Voice tool tests | `npm test -- server/integrations/voice-tools.test.ts server/integrations/voice.test.ts` | Voice session context storage and prompt/tool response shape |
| Local search tests | `npm test -- server/integrations/notes-index.test.ts server/integrations/qmd.test.ts` | Keyword history behavior and Semantic display query behavior |
| Contextual web tests | `npm test -- server/integrations/contextual-query.test.ts server/integrations/exa.test.ts` | Web rewrite/fallback, Exa effective query, consent gate, history display query |
| Full suite | `npm test` | No regressions in scanner, server, and frontend pure modules |
| Type safety | `npm run typecheck` | New payload types, mode state, and route changes compile |
| Manual app smoke | `npm run dev` | DOM selection, context menu, search strip, Vault scopes, Web scopes, voice relay, and notices work in the real UI |

Manual smoke checklist:

- Start the app with `npm run dev` and open a note in the reader.
- Select text in the reader and verify no visible notice or network request appears yet.
- Right-click the selection and verify the custom menu appears with five actions.
- Run `Copy` and verify clipboard text matches the selection.
- Run `Semantic search` and verify `/api/passages` runs, no OpenRouter/Exa request occurs, and results open in research.
- Run `Keyword search` and verify `/api/search` runs, no OpenRouter/Exa request occurs, and results open in research/history.
- Run `Web search` and `Deep research` and verify Web consent still gates outbound work.
- Focus the search box with selected text and verify the context strip, source chips, include toggle, and paper-plane button.
- In the rail/mobile layout, verify the Vault mode control still activates Vault and exposes the Semantic/Keyword scope.
- Toggle context off and verify send uses only typed text.
- Send with no typed text and included context, then verify the active mode receives the selected context.
- Select text in both reader and research, start voice, ask "compare these", and verify the agent uses both contexts through `current_view`.
- Select a very long passage, use it, and verify the trim notice appears only at use time.
- Open a different note and verify the previous reader context no longer applies.
- Open a different research history entry and verify the previous research context no longer applies.

---

## Definition of Done

- DOD1. Reader and research selections are captured independently and cleared on source changes.
- DOD2. Selection alone does not trigger model, qmd, `/api/search`, Exa, write, or visible warning work.
- DOD3. Right-clicking valid selected text opens a custom menu with Semantic, Keyword, Web, Deep, and Copy actions.
- DOD4. The search bar shows a context strip and opt-out toggle when selected context exists.
- DOD5. The paper-plane button sends typed text, selected context, or both through the active mode.
- DOD6. Vault mode supports Semantic and Keyword scopes, both local.
- DOD7. Keyword results can render in the research panel/history without changing default dropdown search behavior.
- DOD8. Voice `current_view` returns selected reader and research contexts with source metadata and capped text.
- DOD9. Web and Deep Research use selected context only after explicit menu/send action and Web consent, with OpenRouter rewrite when configured and deterministic fallback otherwise.
- DOD10. Research history stores the user's typed query or action label, not the internal effective context query.
- DOD11. Oversized selected context is capped to 300 words or 3000 characters total and warns only when used.
- DOD12. `npm test` and `npm run typecheck` pass.
- DOD13. Manual smoke verifies right-click, search strip, send button, Vault Semantic, Vault Keyword, Web, Deep, voice, stale clearing, and trimming notices.

---

## Appendix

### Research Notes

- `docs/solutions/qmd-vsearch-latency.md` is load-bearing: qmd queries should stay typed/local and avoid untyped LLM expansion. This supports KTD6 and R21.
- `server/integrations/voice-tools.ts` is the correct home for `current_view` and per-session voice tool state.
- `web/src/main.ts` already has the state needed to identify origins: `openNodeId`, `byId`, `currentEntryId`, `researchHistory`, `historyIdx`, `runSemanticQuery`, `runWebQuery`, and `runModeQuery`.
- `server/integrations/notes-index.ts` already implements MiniSearch keyword search for `/api/search`; the new work is first-class research-panel/history usage and UI scope, not a new keyword engine.
- `server/app.ts` currently saves search history in `/api/passages` and `/api/research`; `/api/search` needs opt-in history support so the existing live dropdown does not become a history-writing route.
