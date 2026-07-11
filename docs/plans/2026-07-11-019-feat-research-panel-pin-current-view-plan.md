---
title: Research Panel Pinning, Agent Current View, and Editable Working Documents - Plan
type: feat
date: 2026-07-11
topic: research-panel-pin-current-view
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Research Panel Pinning, Agent Current View, and Editable Working Documents - Plan

## Goal Capsule

- **Objective:** Make the research panel a stable shared workspace: users can pin the visible research entry, agents know what the user is seeing, working documents are editable by both user and agent, and evidence results stay immutable.
- **Product authority:** User conversation on 2026-07-11 plus existing product trust model in `PRODUCT.md` and `AGENTS.md`.
- **Execution profile:** Frontend research-panel UI/state, voice `current_view` context sync, working-document read/write route hardening, research-document editor reuse, selection eligibility, typography/snippet polish, shortcut/menu updates, and `DESIGN.md` documentation.
- **Stop conditions:** Stop before adding a second vault write path, allowing agents to mutate web/semantic/keyword/article evidence, exposing browser-visible state to non-voice agents without explicit browser-session identity, or replacing the research history store.
- **Product Contract preservation:** New bootstrap Product Contract. No upstream requirements-only artifact existed for this scope.
- **Open blockers:** None.

---

## Product Contract

### Summary

The research panel currently behaves like a result display that agents can replace opportunistically. That breaks the user's ability to keep a specific result or draft in view while the voice agent keeps searching, delegating, or writing. The panel should become a shared workspace with one clear rule: pinning locks what is visible for the user, not what agents may create in history.

Working documents are the collaborative surface. A user can create or edit a temporary document in the research panel, and the voice agent can update that same document through the existing working-document route. Web, semantic, keyword, and article entries are evidence, not mutable drafts. Agents may cite them or use them as context, but must create or update a document when they need to write.

### Problem Frame

Voice and background delegation can open research results or working documents while the user is reading something else. The user needs a pin that says, effectively, "keep this visible unless I choose otherwise." At the same time, the agent must know the pinned and visible research entry so it can reason correctly: it should know whether the user is seeing a pinned evidence result, a pinned editable document, or nothing at all.

The existing system already has most of the right pieces: `data/research/` history, `/api/document`, `write_document`, `current_view`, reader/editor CM6 modules, selection context, and move-to-vault promotion. The plan should wire those pieces together without creating a new persistence model.

### Requirements

**Research pinning and visibility**

- R1. The research header has a pin button as the first button in the nav row, left of previous/next, styled like the existing panel icon buttons.
- R2. Pinning records the currently visible persisted research entry id. Unpinning clears that pin.
- R3. While pinned, agent-triggered `open_research` or `show_document` actions must not replace the visible research entry unless the target id equals the pinned id.
- R4. User actions remain authoritative: previous/next history navigation, explicit user searches, explicit user opens, delete, save/promote, and close work even while pinned.
- R5. If the pinned visible entry is a working document and an agent updates that same document id, the panel refreshes in place only when there are no unsaved local edits; otherwise the app preserves the local draft and surfaces a conflict.
- R6. If a pinned entry is deleted or promoted into a vault note, the pin clears and never points at a missing history id.

**Agent current view**

- R7. Voice `current_view` reports actual browser state, not inferred server history order: reader note, research panel open/closed, visible research entry, pinned research entry, and selected context.
- R8. The visible and pinned research summaries include id, mode, title/query, source URL when applicable, `mutable`, and bounded document summary when mode is `document`.
- R9. `mutable` is true only for `mode: "document"`.
- R10. Browser state is sent to the voice session on voice ready, reader open/close, research open/close, history navigation, pin toggle, document refresh, and selection change.
- R11. Agent-triggered display actions receive a browser acknowledgment reporting whether the target displayed, refreshed, or was blocked, plus the resulting visible and pinned ids. The agent prompt and tool descriptions still direct the agent to call `current_view` before broader reasoning about what the user sees.

**Working documents**

- R12. The user can create a new temporary working document from the research panel without saving it to the vault.
- R13. Working documents render as editable markdown using the existing CM6 editor patterns where practical, including selection toolbar and AI instruction row when an LLM key is configured.
- R14. User and agent edits persist to `/api/document` with the expected document revision. Stale updates return a conflict instead of silently replacing newer content.
- R15. Agents can create, read, and update working documents by id, but cannot update evidence entries.
- R16. A full-document replace operation must be based on the complete current document body. If `current_view` provides only a truncated summary, the agent must read the working document before replacing it.
- R17. Saving/promoting a working document into the vault keeps the existing guarded write path and removes the temporary history entry after success.

**Evidence and selection**

- R18. Web, semantic, keyword, and article entries are immutable evidence. The app must reject attempts to overwrite those ids through `/api/document`.
- R19. Selecting text in a working document has editable behavior: formatting controls and AI replace/insert may change that document.
- R20. Selecting text in web or article evidence can show an ask-LLM-only bubble or context menu action, but no formatting controls and no direct mutation of the evidence.
- R21. Semantic and keyword result snippets remain selection-context sources for search/voice when feasible, but are not editable surfaces.
- R22. Selection alone remains passive. It never calls Exa, OpenRouter, qmd, search routes, or write routes until the user chooses an explicit action.

**Research panel polish**

- R23. Research panel default text sizes move closer to the content panel: body text and article/document content use the reader's readable scale, while metadata remains smaller.
- R24. Web result snippets and semantic/keyword snippets show about seven lines by default, with an expand/collapse button aligned to the right on the same row where date/metadata stays left.
- R25. `DESIGN.md` documents the research typography, clamp/expand behavior, pin semantics, and current-view boundary.

### Key Flows

- F1. Pin protects the visible result.
  - **Trigger:** User pins web result A, then voice/delegation creates document B.
  - **Steps:** B is saved into research history. Browser receives an auto-open request for B. The pin gate sees A is pinned and B is different.
  - **Outcome:** A remains visible and pinned. B is available through history navigation.
  - **Covers:** R1, R2, R3, R4, R8.

- F2. Same pinned document refreshes.
  - **Trigger:** User pins document A, then voice updates document A.
  - **Steps:** `/api/document` updates A. Browser receives `show_document` or refresh context for A. The pin gate allows it because ids match.
  - **Outcome:** Document A refreshes in place without switching away from the pinned artifact.
  - **Covers:** R5, R12, R14, R15.

- F3. Agent reasons about pinned evidence.
  - **Trigger:** User pins an article and asks voice to write a synthesis.
  - **Steps:** Agent calls `current_view`, sees pinned article is immutable evidence, and writes into a working document instead of trying to mutate the article.
  - **Outcome:** The article stays unchanged. The synthesis appears as a document in history, but only auto-opens when unpinned.
  - **Covers:** R7, R8, R9, R11, R18.

- F4. User creates and edits a working document.
  - **Trigger:** User clicks new document in the research panel.
  - **Steps:** App creates a `mode: "document"` history entry, renders it in an editable markdown surface, autosaves changes through `/api/document`, and keeps it in the research pager.
  - **Outcome:** The document is collaborative app-local state until the user saves/promotes it to the vault.
  - **Covers:** R12, R13, R14, R17.

- F5. Evidence selection asks, not edits.
  - **Trigger:** User selects text inside a web result.
  - **Steps:** The ask-only bubble or context menu appears with LLM/search actions, but no formatting row.
  - **Outcome:** The user can ask about the selected evidence without mutating source evidence.
  - **Covers:** R18, R20, R22.

### Acceptance Examples

- AE1. Given web result A is visible and pinned, when voice creates document B, then B enters history and A remains visible.
- AE2. Given document A is visible and pinned with no unsaved local edits, when voice updates document A at the current revision, then A refreshes in place.
- AE3. Given document A is pinned, when voice creates document B, then A remains visible and B is reachable with next/previous history navigation.
- AE4. Given the panel is unpinned, when voice opens result B, then B becomes visible as today.
- AE5. Given the user navigates previous/next while pinned, then navigation succeeds and the pin target updates only when the user explicitly toggles pin on that visible entry.
- AE6. Given a pinned entry is deleted or promoted, then the pin clears and `current_view.research.pinned` is null.
- AE7. Given voice is active and the research panel is closed, then `current_view.research.panelOpen` is false and `visible` is null.
- AE8. Given a pinned document is visible, then `current_view` includes that document id, title, mutable true, bounded content summary, char count, and truncation flag.
- AE9. Given a pinned article is visible, then `current_view` includes mutable false and its source URL when available.
- AE10. Given `/api/document` receives an id that belongs to a web, semantic, keyword, or article history entry, then the route returns 409 and the evidence entry is unchanged.
- AE11. Given an agent only has a truncated document summary, when it wants to replace the full document, then it must call `read_working_document` or `GET /api/document/:id` first.
- AE12. Given the user creates a new document from the research panel, then it appears in history as `mode: "document"` and can be edited without writing to the vault.
- AE13. Given the user selects text in a working document, then the edit toolbar can modify the document.
- AE14. Given the user selects text in web evidence, then no formatting controls appear.
- AE15. Given a long web result snippet, then only about seven lines show until expand is clicked; date/meta remains left and expand sits right.

### Scope Boundaries

**In scope**

- Research header pin button and state.
- Agent auto-open gate for research actions.
- Browser-to-voice current-view synchronization.
- Current-view visible/pinned research contract.
- Working-document creation, editing, reading, and update hardening.
- Immutable evidence guard at `/api/document`.
- Selection eligibility split between editable documents and evidence.
- Research typography, clamp/expand, and `DESIGN.md` update.

**Deferred for later**

- Cross-session browser-state access for MCP/CLI agents.
- Multi-pin collections or a pin board.
- Full research evidence annotation/highlight persistence.
- Mobile-specific document editing polish beyond not breaking the existing responsive layout.

**Outside this product's identity**

- Mutating web/semantic/keyword/article evidence entries.
- Saving evidence to the vault without explicit user action.
- Creating another vault write path outside `server/integrations/write.ts` and existing guarded note routes.
- Sending selected text or pinned evidence to external providers without an explicit user or agent action that already passes the existing consent/key gates.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Pinning is a browser display gate, not a persistence or security boundary.** It blocks agent-driven visible-entry replacement. It does not stop agents from creating history entries, updating matching documents, or the user from navigating.
- KTD2. **Gate agent display actions centrally in the browser.** `open_research` and `show_document` both arrive as browser actions, including delegation completion. A single frontend helper should decide whether an agent-requested research id may become visible.
- KTD2a. **Acknowledge the display decision.** The browser returns `displayed`, `refreshed`, or `blocked` with resulting visible and pinned ids so the agent never infers success from history creation alone.
- KTD3. **The browser sends actual view state to voice.** Server history order is not enough to know what the user sees. `web/src/main.ts` should call the existing voice context channel when visible research, pin state, reader state, or selection changes.
- KTD4. **Server resolves browser-sent ids against research history.** The browser sends ids and state hints, not trusted document content. `server/integrations/voice-tools.ts` builds bounded summaries from `/api/research/history` so `current_view` stays authoritative and compact.
- KTD5. **Evidence is immutable at the `/api/document` boundary.** Voice checks are not sufficient because MCP/CLI can reach document tools. The route must reject id collisions with non-document history entries.
- KTD6. **Working documents are the shared mutable surface.** Agents needing to write from web or semantic evidence create/update a document. Evidence stays a source.
- KTD7. **Research document editing should reuse the reader editor stack where it pays.** `web/src/editor.ts`, `editor-toolbar.ts`, and `ai-assist.ts` already solve markdown editing and selection instruction. Reuse them for `mode: "document"`, but route persistence to `/api/document` instead of `PUT /api/notes`. AI toolbar submission, preview, and apply state must be parameterized by the target editor and document identity rather than the reader's global editor state.
- KTD8. **Full replace requires full body.** `write_document` replaces the complete markdown. `current_view` summaries are for reasoning, not safe replacement when truncated. Add a read-document tool/route so agents can fetch the full app-local document body by id before replacing.
- KTD8a. **Working-document writes use optimistic concurrency.** Document responses carry a revision token; user and agent updates submit the expected revision, and stale writes return a conflict without replacing content.
- KTD9. **Evidence selection gets ask-only UI.** The content panel toolbar's formatting row is only valid for mutable text. Evidence selections should expose context/search/LLM actions without formatting or replace controls that imply mutation.
- KTD10. **Research typography follows reader scale, metadata stays compact.** The panel should read like content, not like a tooltip. Metadata/date/score rows remain secondary.
- KTD11. **External research skipped.** This is local UI/agent-contract work with established repo patterns. No external API behavior changes beyond current provider gates.

### High-Level Technical Design

```mermaid
flowchart TB
  User[User pins visible research entry] --> Browser[web/src/main.ts research state]
  Browser --> PinGate{Agent wants to show entry?}
  PinGate -->|unpinned| Show[Show requested entry]
  PinGate -->|pinned same id| Refresh[Refresh visible document]
  PinGate -->|pinned different id| Keep[Keep pinned entry visible]
  Agent[Voice/delegate/tools] --> History[data/research history]
  History --> Browser
  Browser --> Context[voiceSession.sendContext]
  Context --> Server[server/integrations/voice-tools.ts]
  Server --> CurrentView[current_view visible + pinned + selectedContext]
  CurrentView --> Agent
  Agent -->|write evidence| Reject[/api/document 409]
  Agent -->|write document| Doc[/api/document mode document]
```

### Current View Contract

Directional TypeScript shape, not a generated type:

```ts
type CurrentView = {
  viewStateKnown: boolean;
  openNote: { path: string; title: string; preview: string; truncated: boolean } | null;
  research: {
    panelOpen: boolean;
    visible: ResearchViewEntry | null;
    pinned: ResearchViewEntry | null;
  };
  selectedContext: SelectionSnapshot;
  recentResearch: Array<{ id: string; mode: string; query: string }>;
};

type ResearchViewEntry = {
  id: string;
  mode: "web" | "semantic" | "keyword" | "article" | "document" | "ingest";
  title: string;
  query: string;
  url?: string;
  mutable: boolean;
  document?: {
    id: string;
    title: string;
    contentSummary: string;
    charCount: number;
    truncated: boolean;
  };
};
```

Rules:

- `viewStateKnown` is false until the browser sends its first context message for the voice session.
- `research.visible` is null when the panel is closed or showing an unpersisted transient proposal.
- `research.pinned` is null when unpinned.
- `mutable` is true only for `mode: "document"`.
- Document summaries use the same cap posture as selected context: bounded text plus truncation metadata.
- Existing top-level `openNote`, `recentResearch`, and `selectedContext` compatibility remains.

### Existing Patterns To Follow

- `web/src/main.ts` owns research state: `researchMode`, `researchHistory`, `historyIdx`, `currentEntryId`, `openResearch()`, `showHistoryEntry()`, and voice `onAction` handling.
- `web/src/voice.ts` already exposes `sendContext()` for browser-to-voice context messages.
- `server/integrations/voice-tools.ts` owns per-session tool state and `current_view`.
- `server/app.ts` already owns `/api/document`, `/api/document/:id/promote`, and `/api/research/history`.
- `server/integrations/research-history.ts` already supports multiple document entries and upsert by id.
- `web/src/editor.ts`, `web/src/editor-toolbar.ts`, `web/src/ai-assist.ts`, and `web/src/autosave.ts` are the reader editor primitives to reuse carefully.
- `web/src/selection-context.ts` is the pure helper location for selection source metadata and query/context formatting.
- `DESIGN.md` documents panel anatomy and must be updated when research panel layout/semantics change.

### Assumptions

- Research pin state survives only the current browser session.
- App-local working documents use a lightweight revision token for compare-and-swap. Vault-note hashes and persistence remain unchanged because temporary documents are not vault files.
- Existing Web consent covers explicit evidence use in Web/Deep research and article fetches.
- The current reader editor modules are reusable enough for working documents. If reuse creates more complexity than a small document-specific editor, the implementer may choose the smaller path while preserving toolbar/AI parity for document selections.

---

## Implementation Units

### U1. Research pin control and agent display gate

- **Goal:** Add the pin button/state and prevent agent actions from replacing a pinned visible entry.
- **Requirements:** R1, R2, R3, R4, R5, R6, AE1, AE2, AE3, AE4, AE5, AE6.
- **Dependencies:** none.
- **Files:** `web/index.html`, `web/src/main.ts`, `web/src/style.css`, `web/src/i18n.ts`.
- **Approach:** Add a `research-pin` header button before `research-prev`. Track `pinnedResearchEntryId: string | null` in `main.ts`. Add helpers `currentVisibleResearchId()`, `setResearchPinned(on)`, `syncResearchPinUi()`, and `agentMayShowResearch(id)`. Wrap voice/delegate `open_research` and `show_document` action handling with the gate and return a display acknowledgment containing the decision and resulting visible/pinned ids. Allow same-id refresh only when the document editor has no unsaved local edits; otherwise preserve the draft and show a conflict. Clear pin when the pinned entry is deleted, promoted, or no longer exists after `loadHistory()`. Set `aria-pressed` on the pin control and announce automatic refreshes and pin clearing through a polite live region. Keep user previous/next and explicit user query behavior unchanged.
- **Test scenarios:** Pin A then simulate agent open B, A stays visible. Pin A then simulate agent refresh A, A rerenders. Unpinned agent open B still opens B. Delete/promote pinned A clears pin. Previous/next still work while pinned.
- **Verification:** `npm run typecheck`; browser smoke with `npm run dev` for pin, history nav, and voice/delegate action simulation.

### U2. Browser-to-voice current-view synchronization

- **Goal:** Make `current_view` reflect the actual reader/research/pin state the user sees.
- **Requirements:** R7, R8, R9, R10, R11, AE7, AE8, AE9.
- **Dependencies:** U1.
- **Files:** `web/src/main.ts`, `web/src/voice.ts`, `server/integrations/voice-tools.ts`, `server/integrations/voice.ts`, `server/integrations/registry.ts`, `server/integrations/voice-tools.test.ts`, `server/integrations/voice.test.ts`, `server/integrations/__fixtures__/voice-tools.snapshot.json`.
- **Approach:** Use existing `VoiceSession.sendContext()` from `web/src/voice.ts`. Add one frontend `syncVoiceContext()` that sends selected context plus browser view ids: open reader note id, research panel open state, visible research id, pinned research id. Call it on voice ready, reader open/close, research open/close, `showHistoryEntry()`, pin toggle, document refresh, and selection capture. Server session state stores the latest browser view envelope. `current_view` resolves ids against `/api/research/history`, returns visible/pinned summaries, and sets `viewStateKnown` false until the first context arrives. Agent display actions wait for the browser acknowledgment defined in U1 before reporting their visible outcome. Update voice prompt/tool wording so the model knows pinned panels may keep the user's visible context unchanged.
- **Test scenarios:** `current_view` before browser context has `viewStateKnown:false`. After browser context with visible document id, it returns mutable document summary. Pinned article returns mutable false and URL. Closed panel returns panelOpen false and visible null. Existing selectedContext still returns. Tool declaration snapshot includes updated schema/description.
- **Verification:** `npm test -- --run server/integrations/voice-tools.test.ts server/integrations/voice.test.ts server/integrations/registry.test.ts` and `npm run typecheck`.

### U3. Agent-safe working-document read/write boundary

- **Goal:** Let agents create/read/update working documents safely while preserving immutable evidence.
- **Requirements:** R15, R16, R17, R18, AE10, AE11.
- **Dependencies:** none.
- **Files:** `server/app.ts`, `server/integrations/registry.ts`, `server/integrations/voice-tools.ts`, `server/integrations/mcp-bridge.ts` if route mapping needs adjustment, `server/integrations/voice-tools.test.ts`, `server/integrations/registry.test.ts`, `server/app.test.ts`, `server/integrations/voice-promote.test.ts`.
- **Approach:** Harden `POST /api/document`: if an id exists in research history with a non-document mode, return 409. Support create/update semantics consistently with registry declarations. Add `GET /api/document/:id` or a registry-backed `read_working_document` tool that returns full markdown only for `mode: "document"`. Document reads return a revision token; updates require the expected revision and return 409 on mismatch. Update `write_document` handling so create without id can mint a safe id and update requires an existing document id. Keep `/api/document/:id/promote` as the save-to-vault path and preserve delete-after-promote behavior.
- **Test scenarios:** Evidence id overwrite returns 409. Document id update at the expected revision succeeds. Stale document revision returns 409 without changing content. Create without id returns generated id and revision. Update missing id fails. Read document returns full content and revision. Read evidence id fails. Promote document still writes through existing path and removes history entry.
- **Verification:** `npm test -- --run server/app.test.ts server/integrations/voice-tools.test.ts server/integrations/voice-promote.test.ts server/integrations/registry.test.ts`.

### U4. Editable working documents in the research panel

- **Goal:** Let users edit temporary working documents in place and autosave them to research history.
- **Requirements:** R12, R13, R14, R17, R19, AE12, AE13.
- **Dependencies:** U3.
- **Files:** `web/src/main.ts`, `web/src/editor.ts`, `web/src/editor-toolbar.ts`, `web/src/ai-assist.ts`, `web/src/autosave.ts` if reuse is practical, `web/src/style.css`, `web/index.html`, `web/src/i18n.ts`, `web/src/editor.test.ts`, `web/src/editor-toolbar.test.ts`, `web/src/autosave.test.ts`.
- **Approach:** Add a research header action or compact empty-state control to create a new document via `/api/document` (entry-point choice remains in Open Questions). Render `mode: "document"` entries with an editable markdown surface. Prefer reusing `createNoteEditor()` so selection formatting and AI row behavior match the content panel. Extract the AI toolbar submission, preview, and apply path so each editor instance receives its target editor and document metadata, with separate state for reader and working-document surfaces. Persistence targets `/api/document` with document id/title/content and expected revision, not `PUT /api/notes`. Keep save-as-note/promotion button separate and explicit. If the existing autosave state machine is reused, configure an app-local save function with revision conflicts and preserve local edits for retry. If full editor reuse is too heavy, implement the smallest document-specific CM6 wrapper that preserves selection toolbar and AI instruction parity.
- **Test scenarios:** New document creates a history entry. Typing edits and persists to `/api/document`. Reloading history shows edited content. Selection toolbar formats working-document text. AI replace/insert changes only the targeted working document and cannot alter the open reader note. A stale revision preserves local edits and shows a conflict. Save-as-note promotes and removes temporary entry. Failed document save keeps document editable for retry.
- **Verification:** `npm test -- --run web/src/editor.test.ts web/src/editor-toolbar.test.ts web/src/autosave.test.ts`; `npm run typecheck`; manual dev smoke for create, edit, agent refresh, and promote.

### U5. Research selection eligibility and ask-only evidence bubble

- **Goal:** Split selection behavior by mutability: documents can be edited, evidence can be used as context or LLM/search input only.
- **Requirements:** R18, R19, R20, R21, R22, AE13, AE14.
- **Dependencies:** U4 for document editor selection path.
- **Files:** `web/src/main.ts`, `web/src/selection-context.ts`, `web/src/selection-context.test.ts`, `web/src/style.css`, `web/src/i18n.ts`, `server/app.ts` if `/api/selection-assist` prompt needs a research-source variant, `server/app.test.ts`.
- **Approach:** Add pure helpers for research entry mutability and selected-source action eligibility. Keep existing right-click context menu actions for searches. For web/article evidence, add or adapt a floating ask-only bubble that contains the AI input row without the formatting row. It may use `/api/selection-assist` with research metadata or a small route extension so the prompt treats the selection as evidence, not a note to rewrite. Do not offer Replace/Insert for immutable evidence. Working document selections use the editor toolbar from U4.
- **Test scenarios:** Document selection returns editable actions. Web/article selection returns ask-only actions. Semantic/keyword selection can become selection context but cannot show formatting controls. Selection capture alone performs no network calls. Research URL metadata is preserved for selected web result text.
- **Verification:** `npm test -- --run web/src/selection-context.test.ts server/app.test.ts`; manual dev smoke for document selection, web selection, and semantic result selection.

### U6. Research panel readability and chrome polish

- **Goal:** Fix the visible research-panel UI issues called out by the user.
- **Requirements:** R23, R24, R25, AE15.
- **Dependencies:** none.
- **Files:** `web/src/style.css`, `web/src/main.ts`, `web/index.html`, `web/src/i18n.ts`, `DESIGN.md`.
- **Approach:** Increase `#research-body`, `.article-body`, document body, `.web-snippet`, and `.rel-snippet` sizes toward `#reader-body` scale while keeping metadata small. Reuse `attachExpand()` for web snippets, set an exact seven-line clamp (replacing the current four-line semantic/keyword clamp and adding the web clamp), and adjust `.expand-btn` alignment so metadata/date remains left and expand/collapse aligns right. Document the new conventions in `DESIGN.md`.
- **Test scenarios:** Long web and semantic snippets clamp to exactly seven lines and expand/collapse. Expand button click does not trigger result open. Research typography visually matches reader scale. `DESIGN.md` mentions pin/current-view boundary and research typography/clamp rules.
- **Verification:** `npm run typecheck`; browser smoke with `npm run dev`; `npm run test:e2e` catches console/layout regressions where applicable.

### U7. End-to-end pinning and document collaboration proof

- **Goal:** Prove the main user-agent collaboration flows under the browser diagnostics harness.
- **Requirements:** AE1 through AE15.
- **Dependencies:** U1 through U6.
- **Files:** `tests/e2e/research-pinning.spec.ts` or existing E2E spec, `tests/e2e/global-setup.ts` only if fixture data needs extension.
- **Approach:** Use a hermetic vault and mocked/local routes. Add a Playwright fixture that stubs browser audio APIs, returns a configured voice provider from `/api/integrations`, intercepts `/api/voice/ws` with Playwright WebSocket routing, sends `ready`, and injects deterministic `open_research` and `show_document` action frames. Drive the research panel: create/open result A, pin it, inject an agent action that creates/opens B, assert A remains visible and B appears in history. Then unpin and assert agent open can switch. Create a document, edit it, pin it, simulate same-id update, stale-revision conflict, and different-id update. Assert diagnostics remain clean.
- **Test scenarios:** Pin blocks different auto-open. Pin allows same-id refresh. Unpin restores auto-open. User navigation works while pinned. Editable document persists. Evidence id cannot be overwritten through document route. Browser diagnostics have zero unallowlisted errors.
- **Verification:** `npm run test:e2e`.

---

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Focused selection/frontend units | `npm test -- --run web/src/selection-context.test.ts web/src/editor.test.ts web/src/editor-toolbar.test.ts web/src/autosave.test.ts` | Selection eligibility and editor/document helper behavior stay deterministic. |
| Focused server/voice units | `npm test -- --run server/app.test.ts server/integrations/voice-tools.test.ts server/integrations/voice-promote.test.ts server/integrations/registry.test.ts server/integrations/voice.test.ts` | Current-view contract, document boundary, registry/tool declarations, and promotion behavior are safe. |
| Full unit suite | `npm test` | Existing server and frontend pure-module coverage remains green. |
| Type gate | `npm run typecheck` | Cross-file TypeScript contracts are coherent. |
| Build gate | `npm run build` | Production web bundle compiles. |
| Browser gate | `npm run test:e2e` | Pin/document collaboration flows and diagnostics are clean in Chromium. |
| Release serial gate | `npm test && npm run typecheck && npm run build && npm run test:e2e` | Repo-required final verification passes. |

Manual smoke that should accompany the automated gates:

- Pin a web result, trigger or simulate a voice-created document, confirm the web result stays visible and the document is in history.
- Pin a working document, trigger or simulate a same-id update, confirm it refreshes in place.
- Select text in a working document and in web evidence, confirm the toolbar/action differences.
- Check research typography and snippet expand/collapse in at least one dark theme and one light theme.

---

## Definition of Done

- The pin button exists in the research header and blocks agent-driven visible replacement exactly as defined.
- `current_view` reports actual browser visible/pinned research state with mutable/evidence boundaries.
- Working documents can be created and edited by the user, updated by agents, read by id, and promoted through the existing vault write path.
- `/api/document` cannot overwrite non-document research evidence.
- Research selection behavior is explicit and mutability-aware.
- Research panel text, snippet clamping, and `DESIGN.md` are updated.
- The focused tests, full unit suite, typecheck, build, and E2E gates pass.
- Abandoned prototypes or duplicate editor/document code paths are removed before completion.

---

## Deferred / Open Questions

### From 2026-07-11 document review

- **Working-document entry point:** Choose between an always-available research-header action and a compact empty-state control. The implementation unit intentionally does not select one until the interaction priority and header crowding are decided.
- **Pinned-state treatment:** Define the active visual treatment for the pin toggle in addition to required `aria-pressed` state, using the existing research-panel visual language.

---

## Appendix

### Sources And Research

- Product source: `PRODUCT.md` describes Sinapso as a local-first visualizer and agent workspace where results become notes, not lost chat scroll.
- Repo contract: `AGENTS.md` requires local-first behavior, BYO keys, token-guarded mutating routes, and vault writes only through `server/integrations/write.ts` plus explicit Git sync.
- Prior plan: `docs/plans/2026-07-07-010-feat-text-selection-to-context.md` defines passive selection, current-view selected context, and typed `vec:` semantic queries.
- Prior plan: `docs/plans/2026-07-08-016-fix-voice-documents-and-url-routing-plan.md` defines multiple working documents, document ids, URL/resource routing, and bounded recent research identity.
- Prior plan: `docs/plans/2026-07-10-018-feat-editable-reader-live-preview-plan.md` defines the CM6 editor, toolbar, AI assist, autosave, and trust-model constraints for vault notes.
- Tactical learning: `docs/solutions/editable-reader-round-trip-gate.md` warns about CM6 EOL restoration, frontmatter write-protection, single-flight saves, and localStorage mirrors.
- Tactical learning: `docs/solutions/qmd-vsearch-latency.md` requires pre-typed `vec:` qmd queries to avoid slow LLM expansion.
- Tactical learning: `docs/solutions/gemini-live-async-function-calling.md` confirms voice/delegation completions can arrive asynchronously and must not assume the panel is replaceable.
