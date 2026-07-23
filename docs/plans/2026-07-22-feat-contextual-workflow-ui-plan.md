---
title: Contextual Workflow UI and Runtime-Neutral Run Contract - Plan
type: feat
date: 2026-07-22
topic: contextual-workflow-ui
roadmap_id: RM007
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
status: accepted
---

# Contextual Workflow UI and Runtime-Neutral Run Contract - Plan

## Goal Capsule

This document is RM007's implementation authority. Earlier generative-UI and Pi prototype plans were removed by user direction; their conclusions are retained here only where still applicable.

RM007 has exactly two linked outcomes:

1. **Contextual vanilla workflow presentation UI.** Present current workflow progress, terminal events, results, and ordinary decisions through the existing search, Research, and Inbox surfaces. Do not add a chat, transcript, agent pane, or competing activity feed.
2. **Runtime-neutral `WorkflowRunV1`.** Define a validated server-side run record that a future direct Sinapso workflow or a possible Flue runtime can map into the existing data-only `ToolPresentationV1` contract without making either runtime part of the UI.

Independent value: outcome 1 fixes current duplicate progress, progress-modal, pending-proposal, and current-context behavior with no workflow runtime. Outcome 2 establishes the future execution seam with no Flue dependency, database, scheduler, or new workflow endpoint.

## Product and Trust Requirements

### Outcome 1: contextual workflow presentation

- **R1. Existing surfaces only.** Use `#ops-status`, the active `#search-wrap`, `#research-body`, the Inbox view inside `#research`, and the existing modal layer. Add no chat, transcript, agent collection, agent pane, or activity-feed history.
- **R2. One lifecycle owner at a time.** A run state appears on exactly one lifecycle surface. Queued/running progress belongs only to `#ops-status`; an actionable terminal event belongs to one contextual card; an opened review or ordinary decision belongs inline in Research/Inbox. Moving an event to a richer surface removes it from the previous surface.
- **R3. Passive progress only.** `#ops-status` is the sole passive progress surface for rescan, qmd maintenance, wiki proposal preparation/apply, and future runs. Progress must not also create a transient card or progress modal.
- **R4. Contextual terminal cards.** Success, error, cancellation, or decision-ready events render as small dismissible cards only when they require attention or an action. Anchor the stack close to the currently visible search/input field on desktop; use the central mobile workspace when the rail is bottom-docked, never a remote corner.
- **R5. Existing visual language.** Cards use native DOM controls, small rounded surfaces, `var(--panel)`, `var(--border)`, `var(--fg)`, `var(--muted)`, and `var(--accent)`, with the existing blur convention. They remain compact and semi-transparent over the graph. They must not cover readable reader/research content; if a placement can overlap content, use DESIGN.md's opaque surface composition.
- **R6. Mobile central workspace.** When the search/input rail is at the bottom, terminal cards move into the central free viewport instead of stacking above the rail. The host derives a bounded safe rectangle between top chrome and the combined search, mode-button, footer, voice/spectrum, navigation, and safe-area chrome. It is not a modal: cards stay dismissible, do not trap focus, and never cover required controls. No card may be clipped outside the viewport at `390x844`.
- **R7. No loading takeover.** Starting or running work does not open Research, clear `#research-body`, change Research/Inbox collection, replace a pinned item, or destroy an editor. Wiki proposal preparation preserves the visible page exactly.
- **R8. Current context is browser-owned.** At presentation time, derive the visible collection, visible research/inbox id, pin, dirty editor, active input, rail state, and panel geometry from current browser state. Do not reuse a stale context snapshot from run start to decide placement or navigation.
- **R9. Stable provenance.** A workflow keeps the source and artifact references captured at start/completion, but those references do not claim that the source is still visible. Terminal CTAs open by stable run/artifact id and obey existing flush-before-switch, pin, and dirty-editor protections.
- **R10. Rich review inline.** Current wiki proposal review remains browser-owned: the existing proposal response and its `operations` stay in the bounded host-held pending-review map, and apply continues through the existing `/api/wiki-ingest/apply` route. Only bounded metadata and an opaque review id enter presentation data. Operation previews, source/artifact references, retryable conflicts, and ordinary approve/reject decisions render inline in Research or Inbox. The center modal is reserved for workflow consent or genuinely irreversible confirmation. Existing non-workflow Admin, Help, and About dialogs are outside RM007.
- **R10a. Explained choice decisions.** A disambiguation card always states what needs a decision and includes a short explanation of why the candidates differ. It never presents bare labels. The explanation uses safe text rendering and is bounded like other presentation text.
- **R10b. Direct choice and freeform answer.** A choice card shows at most seven directly selectable rows, numbered by display order and reachable by click or the corresponding number key while its root or a candidate row has focus. The normal case is two candidates followed by `3. Other...`; exceptional cases may show up to six candidates followed by `Other...` as the seventh row. There is no pagination. `Other...` opens one inline, focused text field; typed text is submitted through the same code-owned choice handler. The renderer never treats the text as an action, route, path, or navigation target.
- **R11. Progressive wiki disclosure.** A ready card shows only source, target wiki, and create/edit/move counts. Opening it shows an inline summary first. RAW handling, paths, per-operation content, hashes/revisions, and errors expand on demand. Content previews use the existing seven-line clamp and safe text rendering.
- **R12. Preserve workspace behavior.** Keep Research pinning, independent Research/Inbox cursors, current-view acknowledgments, single-editor ownership, flush-before-destroy, reader `ctx-left`, dock/float/resize geometry, and `sinapso-*` preferences unchanged.
- **R13. Durable work through existing paths.** Presentation never writes. Wiki apply continues through `/api/wiki-ingest/apply`; note changes continue through guarded `write.ts`; Git remains user-triggered through `git.ts`; web spending continues through consent/key gates.
- **R14. Localized and accessible.** Every new user-facing string has matching English and neutral-Spanish entries in `web/src/i18n.ts`. Cards and disclosures are keyboard-operable, focus-visible, labeled, announced once, and restore focus after dismissal or review close. Numeric shortcuts apply only while a choice-card root or candidate row owns focus, never while any text input, search, or editor owns focus; Arrow keys and Enter provide an equivalent non-numeric path.

### Outcome 2: runtime-neutral run contract

- **R15. Data-only contracts.** `WorkflowRunV1` and `ToolPresentationV1` contain validated data only. They carry no HTML, JSX, component name, import, CSS, prompt, executable code, route, HTTP method, header, token, command, shell input, or arbitrary navigation target.
- **R16. Code-owned names and renderers.** Workflow and presentation names are closed TypeScript unions extended only by a Sinapso code change. A closed renderer map selects dedicated UI. Unsupported external names map to a bounded, non-actionable `unknown` fallback rather than selecting a renderer.
- **R17. Bounded summaries.** Input/result summaries are flat, validated, and bounded: title at most 120 characters, text at most 600 characters, at most 12 scalar fields, field labels at most 80 characters, and string values at most 300 characters. Do not carry raw model/provider payloads or recursively render JSON.
- **R18. Bounded references.** A run carries at most 12 source references and 12 artifact references. Reference ids, labels, revisions, and URLs follow the exact formats in this plan. Vault paths remain confined server-side. An external URL is HTTPS, appears only on an `external-source` reference, and comes only from an existing validated server result field. A producer cannot supply a navigation target.
- **R19. Provider and cost are optional.** Provider/cost metadata appears only when a code-owned server adapter creates it. Provider ids come from the trusted catalog, labels are bounded, costs use non-negative integer micros plus `actual|estimated`, and secrets, endpoints, headers, request ids, prompts, raw usage payloads, and billing credentials are absent.
- **R20. Explicit retry/cancel semantics.** Cancellation is exposed only while the owning server workflow supports cooperative cancellation. Retry always creates a new run id with `retryOfRunId`, reruns current authorization/spend checks, and never mutates the historical run. No spending or mutating workflow retries automatically.
- **R21. Server-owned authority.** A run declares its effect and authorization mode, but never grants authority. An actionable decision either re-enters a named code-owned handler for an existing guarded route, which revalidates token, consent, path, CAS, and current state, or references an opaque server-issued decision id. The browser and runtime cannot mint or upgrade server decisions.
- **R22. Explicit execution only.** Workflows start from an explicit user intent or existing explicit product action. They do not run in the background, on a schedule, or from model initiative under this plan.
- **R23. Runtime neutrality.** Direct server code and a possible future Flue adapter may produce `WorkflowRunV1`; the renderer knows neither source. No runtime imports into the renderer, and no renderer logic enters the runtime.
- **R24. Future runtime boundary.** A future direct workflow or Flue adapter may emit only bounded `WorkflowRunV1` data. It cannot provide operation bodies, routes, or arbitrary actions. Runtime-produced wiki proposals are not reviewable or applicable until Sinapso implements a server-issued opaque review record plus guarded retrieval and decision contracts. Any later Flue evaluation may call only existing registry-declared and guarded Sinapso tools. It receives no local sandbox, shell, command execution, direct vault filesystem access, direct `write.ts` access, or provider secrets. Before adoption it must explicitly settle persistence owner, crash recovery, idempotency keys, replay behavior, cancellation, authorization records, retention, and redaction.

## UI Placement and State Ownership

| Lifecycle or content state | Sole owner | Behavior |
|---|---|---|
| `queued`, `running` | `#ops-status` | Passive label/detail/progress only. No card and no modal. Clear only when the owning operation reaches a non-running state. |
| Terminal with no useful action | Polite announcement only | Clear progress and announce once. Do not create decorative success cards. |
| Terminal with retry, review, open-artifact, or conflict action | Contextual terminal-card stack beside the visible `#search-wrap` on desktop; central mobile workspace when the rail is bottom-docked | At most three visible cards backed by the bounded actionable map. No silent eviction. |
| Rich result already open | `#research-body` or current Inbox body | Render result and its actions inline. Do not also keep a terminal card for the same run. |
| Ordinary decision, including wiki approve/reject | Inline Research/Inbox review | Summary first, expandable operation detail, guarded action handlers. Choice decisions include an explanation and up to seven direct numbered candidates. |
| Consent for network/spend or a genuinely irreversible confirmation | Existing center modal | Focus trap, explicit accept/cancel, focus restoration. A decline performs no external or mutating action. |
| Error while current inline review remains visible | Inline review/banner | Keep source/review visible and show the retry/conflict locally. Use a card only if that review is no longer visible. |

### Context and placement rules

1. Add one browser-owned resolver that returns the current presentation context from `#search-wrap`, `#research`, `currentVisibleResearchId()`, `pinnedResearchEntryId`, the active collection, editor dirty state, and current panel geometry.
2. Recompute placement on render, panel class/style mutation, topbar reflow, viewport resize, and mobile rail changes. Reuse the existing `layoutTopbar()` observer and inset variables; do not create a second geometry engine.
3. Initial desktop cards are fixed near the measured `#search-wrap`, align to the input edge, and avoid docked panels. When the rail is bottom-docked, cards use a measured central safe rectangle rather than the shrinking strip above the input; they clear all bottom chrome and any open reader/research surface.
4. Replace the singleton `pendingWikiProposal` with one browser-owned actionable map keyed by run id. `ACTIONABLE_CAP` is exactly 7, including in-flight reservations and unresolved reviews. A workflow that can yield an actionable result reserves a slot before its request starts. If all slots are reserved or occupied, do not start another such request; keep current work visible and show the localized capacity instruction. A future adapter that did not reserve a slot must reject completion presentation while full and retain ownership of the result. It must not acknowledge, discard, or replace an existing action.
5. Opening a review is an explicit user navigation. Flush or transfer an Inbox editor through the existing ownership controller before replacing its view. On close, reject, or successful apply, restore the recorded return collection/id only if it still exists and is safe to show.
6. Derive the three-card view from the actionable map. If all unresolved actions are uncollapsed and there are at most three, show each card. Otherwise reserve one slot for an `N actions ready` aggregate card, show at most the two newest uncollapsed actions individually, and include every other unresolved action in the aggregate. Expanding it shows every remaining unresolved action directly in the same terminal host, never a paged selector. It is not a feed or history. Selecting an item transfers that item's sole ownership to its inline review. Dismissing a review card only marks it collapsed; only explicit reject, successful apply, or a code-owned terminal resolution removes an actionable review.

## Directional Interfaces

These shapes are normative. Exact helper names may follow repository style, but fields and semantics must not expand without updating this plan.

```ts
export type PresentationName =
  | "vault-search"
  | "web-research"
  | "wiki-ingest"
  | "note-write"
  | "graph-refresh"
  | "qmd-maintenance"
  | "unknown";

export type ToolPresentationState =
  | "queued"
  | "running"
  | "decision-required"
  | "success"
  | "denied"
  | "error"
  | "cancelled";

export type BoundedSummaryV1 = {
  title?: string;
  text?: string;
  fields?: Array<{
    label: string;
    value: string | number | boolean | null;
  }>;
};

export type PresentationRefV1 = {
  kind: "vault-note" | "research-entry" | "external-source";
  id: string;
  label?: string;
  revision?: string;
  url?: string;
};

export type ChoiceDecisionV1 = {
  question: string;
  explanation: string;
  candidates: Array<{ id: string; label: string }>;
};

export type ToolPresentationV1 = {
  version: 1;
  id: string;
  name: PresentationName;
  state: ToolPresentationState;
  input?: BoundedSummaryV1;
  result?: BoundedSummaryV1;
  sources?: PresentationRefV1[];
  artifacts?: PresentationRefV1[];
  decision?: {
    kind: "review" | "approve-write" | "consent" | "irreversible-confirm" | "choose";
    decisionId: string;
    expiresAt?: string;
    review?: {
      reviewId: string;
      sourceLabel: string;
      targetLabel: string;
      counts: { create: number; edit: number; move: number };
    };
    choice?: ChoiceDecisionV1;
  };
};
```

`ToolPresentationV1` does not contain placement or actions. A code-owned policy maps `name + state + current browser context` to `ops | card | inline | modal`, and a code-owned handler maps a known affordance to an existing guarded route.

```ts
export type WorkflowName =
  | "vault-search"
  | "web-research"
  | "wiki-ingest"
  | "note-write"
  | "graph-refresh"
  | "qmd-maintenance";

export type WorkflowRunState =
  | "queued"
  | "running"
  | "waiting-for-decision"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowRunV1 = {
  version: 1;
  runId: string;
  name: WorkflowName;
  state: WorkflowRunState;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  inputSummary?: BoundedSummaryV1;
  resultSummary?: BoundedSummaryV1;
  sources?: PresentationRefV1[];
  artifacts?: PresentationRefV1[];
  execution?: {
    provider?: { id: string; label: string };
    cost?: { currency: "USD"; micros: number; kind: "actual" | "estimated" };
  };
  retry?: { allowed: boolean; retryOfRunId?: string };
  cancel?: { supported: boolean; requested: boolean };
  authorization: {
    effect: "read" | "spend" | "vault-write";
    mode: "none" | "existing-guarded-route" | "server-decision";
    decision?: {
      kind: "review" | "approve-write" | "consent" | "choose";
      id: string;
      expiresAt: string;
      review?: {
        reviewId: string;
        sourceLabel: string;
        targetLabel: string;
        counts: { create: number; edit: number; move: number };
      };
      choice?: ChoiceDecisionV1;
    };
  };
};
```

### Exact validation contract

Validators reject unknown fields and apply these limits before mapping or rendering:

- `runId`, `ToolPresentationV1.id`, `decisionId`, decision `id`, and `reviewId` are lowercase canonical RFC 4122 version-4 UUID strings: 36 ASCII characters matching `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. A mapped presentation id equals its run id. Current browser-owned reviews use `crypto.randomUUID()` locally; future runtime review and decision ids must be issued by the Sinapso server.
- A `vault-note` reference id is a normalized NFC, vault-relative POSIX path encoded in at most 512 UTF-8 bytes. It has no leading slash, backslash, empty segment, `.` or `..` segment, NUL/control character, or non-`.md` suffix, and must pass the existing server path-confinement check before becoming actionable.
- A `research-entry` reference id is 1 to 128 lowercase ASCII characters matching `^[a-z0-9][a-z0-9-]{0,127}$`. An `external-source` reference id is a server-issued opaque key of 1 to 128 ASCII characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- Every optional reference label, and every required provider, source, and target label, is trimmed, normalized NFC text of 1 to 80 Unicode scalar values with no control characters. Summary title and field-label limits remain 120 and 80 scalar values; summary text and string values remain 600 and 300 scalar values.
- A revision is either a lowercase 64-character SHA-256 hex digest or a lowercase canonical version-4 UUID. No other revision format is accepted.
- Every timestamp is a real UTC RFC 3339 instant with exactly millisecond precision, formatted `YYYY-MM-DDTHH:mm:ss.sssZ`. `updatedAt >= createdAt`. Nonterminal states forbid `completedAt`; terminal states require `completedAt === updatedAt`. A decision expiry is later than `updatedAt` and no more than 24 hours after it.
- A URL is a primitive string of at most 2,048 UTF-8 bytes. It is allowed only on `kind: "external-source"`, must be the canonical output of the server's WHATWG `URL` parser, must use `https:`, must have a nonempty hostname, no username, password, fragment, or non-default port, and must come from an existing server-validated research result, citation, or article URL field. Other reference kinds forbid `url`. A code-owned server adapter extracts this field from the guarded result; a runtime payload cannot populate it. A future runtime may supply only an opaque external-source id that the server resolves to such a field, and unresolved ids are non-navigable. Renderers may open only the resolved field with `target="_blank"` and `rel="noopener noreferrer"`; ids, labels, summaries, and runtime payloads never become URLs.
- Review counts are safe integers from 0 through 999, at least one count is positive, and their sum is at most 999. Review metadata has no paths, content, operations, route, method, or handler selector.
- A `choose` decision contains a normalized NFC question of 1 through 120 Unicode scalar values, a normalized NFC explanation of 1 through 600 values, and two through six candidate rows. Candidate ids are opaque server-issued ASCII keys of 1 through 128 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; labels are 1 through 120 values with no controls. The renderer derives numbering from row order, appends the localized `Other...` label/placeholder from `i18n.ts` as the final row, and accepts at most 600 characters of typed text. A choice decision has no action, route, URL, path, or handler field.
- Arrays contain at most 12 references each. Summary objects contain at most 12 scalar fields. Costs are non-negative safe integers. Provider ids must exist in the trusted code-owned catalog. `requested: true` requires cancellation support. `cancelled` requires `cancel.supported: true`; retry creates a different valid run id and `retryOfRunId` names an earlier valid run.

The following matrix is exhaustive. `none` in the final column means the decision object is absent. Any tuple not listed is invalid. `waiting-for-decision` requires the listed decision; every other state forbids one.

| Workflow name | Run state | Effect | Authorization mode | Decision kind |
|---|---|---|---|---|
| `vault-search` | `queued`, `running`, `succeeded`, `failed`, `cancelled` | `read` | `none` | none |
| `web-research` | `queued`, `running`, `succeeded`, `failed`, `cancelled` | `spend` | `existing-guarded-route` | none |
| `web-research` | `waiting-for-decision` | `spend` | `existing-guarded-route` | `consent` |
| `web-research` | `waiting-for-decision` | `spend` | `existing-guarded-route` | `choose` |
| `wiki-ingest` | `queued`, `running`, `succeeded`, `failed`, `cancelled` | `vault-write` | `existing-guarded-route` | none |
| `wiki-ingest` | `waiting-for-decision` | `vault-write` | `server-decision` | `review` |
| `note-write` | `queued`, `running`, `succeeded`, `failed`, `cancelled` | `vault-write` | `existing-guarded-route` | none |
| `note-write` | `waiting-for-decision` | `vault-write` | `server-decision` | `approve-write` |
| `graph-refresh` | `queued`, `running`, `succeeded`, `failed`, `cancelled` | `read` | `existing-guarded-route` | none |
| `qmd-maintenance` | `queued`, `running`, `succeeded`, `failed`, `cancelled` | `read` | `existing-guarded-route` | none |

For `existing-guarded-route`, handlers are selected only by the code-owned workflow/decision matrix, never by contract data. The current browser-owned wiki path maps its host-held proposal directly to `ToolPresentationV1`; it does not need `WorkflowRunV1` and does not create a generic action channel. Structural validation can recognize a `server-decision` tuple, but mapping it as actionable additionally requires an injected server resolver to find a live record whose workflow, decision id, expiry, effect, and authorization mode match the envelope, plus the review id when the kind is `review`. This plan adds no record or resolver, so its default adapter maps every `server-decision` envelope to a bounded non-actionable denied/fallback presentation. Runtime-produced wiki review remains unavailable until a later accepted plan defines and implements the record, guarded retrieval route, guarded decision route, and resolver.

State mapping is fixed: `queued -> queued`, `running -> running`, `waiting-for-decision -> decision-required`, `succeeded -> success`, `failed -> error`, and `cancelled -> cancelled`. The adapter may reduce detail or map an unsupported name to `unknown`; it may not add authority or invent an action.

## Architecture

```text
Current explicit browser action
  -> existing api() call and guarded server route
  -> current trusted result/lifecycle adapter
  -> ToolPresentationV1
  -> code-owned surface policy
       queued/running -> #ops-status
        terminal action -> desktop card near #search-wrap or central mobile workspace
       rich review/ordinary decision -> Research or Inbox inline
       consent/irreversible confirm -> existing modal

Future direct server workflow or possible Flue adapter
  -> validate WorkflowRunV1
  -> emit bounded summaries, references, and opaque decision/review ids only
  -> code-owned WorkflowRunV1 to ToolPresentationV1 adapter
  -> the same surface policy and renderer

Current browser-owned wiki review
  -> existing /api/wiki-ingest/propose response
  -> full operations remain in bounded browser host map
  -> ToolPresentationV1 carries counts, labels, and local opaque review id only
  -> inline review reads the host-held proposal
  -> explicit approve calls existing /api/wiki-ingest/apply

Any user action from presentation
  -> code-owned handler
  -> existing api() client
  -> existing Host/Origin, token, consent, key, path, CAS, and route checks
  -> existing guarded service and write.ts/git.ts boundary
```

The renderer does not dispatch arbitrary actions. It cannot retrieve rich review data from a runtime envelope. A future runtime review requires a server-owned review record and guarded retrieval/decision contract before it can enter this path. The run contract does not persist itself. Research history, Inbox files, vault notes, `data/changes.jsonl`, Git, and any future workflow runtime retain their current or explicitly chosen owners.

### Freeform choice input

Text input applies only to an active `choose` decision. The card owns the current choice id, equal to its `decisionId`, and submits normalized nonempty text of at most 600 scalar values through the code-owned choice handler. No transcript, free-form agent turn, generic tool action, voice bridge, or new provider route enters this path. The browser maps the known choice id and selection to the existing guarded research action; it never accepts a model-provided route or target.

## Migration from Current Surfaces

| Current behavior | Required migration |
|---|---|
| Wiki proposal preparation writes both `#ops-status` and a transient `activity.propose` card | Keep `#ops-status` only while preparing. |
| `#activity-cards` accepts transient and terminal states | Replace it with a terminal-only presentation host; remove transient states and their model logic. |
| Cards anchor in a distant top/bottom corner through `ac-top`/`ac-bottom` | Measure and anchor near the visible `#search-wrap` on desktop; use the central mobile safe rectangle when the rail is bottom-docked. |
| One global `pendingWikiProposal` and fixed `wiki-ingest` card id | Use UUID run/review ids and the capacity-7 browser-owned actionable map with reservations, aggregate access, and no silent eviction. |
| Opening a proposal directly empties `#research-body` without owning a current-view identity | Open an explicit ephemeral inline review with a recorded return context and existing flush/pin protections. |
| Wiki operation bodies are all expanded immediately | Show counts and paths first; use native disclosure plus the existing seven-line clamp for content. |
| `rescan()` shows `#ops-status` and a progress modal | Remove the progress modal. Keep `#ops-status`; show only an actionable terminal error card on failure. |
| qmd setup/maintenance and install failures use informational status modals | Keep consent where required; move ordinary running, busy, success, and error states to `#ops-status`, the invoking Admin/Tools row, or a terminal card. |
| A pinned/background Research result creates a card with no stable open action | Add an artifact-backed open action or keep the event as an announcement only. Never create a dead card. |

## Expected Files

### Create

- `web/src/tool-presentation.ts`: `ToolPresentationV1`, bounded validation, the type-only `WorkflowRunV1` mapping adapter, state mapping, and pure surface-policy inputs. Its `WorkflowRunV1` import is type-only so browser code gains no server runtime dependency.
- `web/src/tool-presentation.test.ts`: exact ids/timestamps/URLs, exhaustive tuple matrix, bounds, state mapping, unknown fallback, current-context policy, capacity, and no-authority fixtures.
- `web/src/tool-renderers.ts`: closed native-DOM renderer map, terminal card rendering, safe fallback, and inline wiki-review renderer.
- `web/src/tool-renderers.test.ts`: renderer selection, text safety, disclosure, focus, and safe-link tests.
- `server/integrations/workflow-run.ts`: authoritative pure `WorkflowRunV1` types, validator, and redaction with no runtime, route, Node-only dependency, or persistence. Keeping this module pure permits the frontend's erased type-only import.
- `server/integrations/workflow-run.test.ts`: exhaustive tuple matrix, exact ids/timestamps/URLs, bounds, references, trusted provider/cost, retry/cancel, authorization, redaction, and unknown-field rejection.
- `tests/e2e/workflow-presentation.spec.ts`: single-surface lifecycle, contextual placement, wiki review, current-context, mobile, and diagnostics proof.

### Modify

- `web/src/main.ts`: replace ad hoc activity-card wiring with presentation adapters/policy; migrate rescan, qmd, graph-refresh, background Research, and wiki-ingest states; preserve current geometry and editor controllers.
- `web/index.html`: replace or repurpose `#activity-cards` as the terminal-only workflow event host without adding a pane.
- `web/src/style.css`: contextual terminal-card placement and inline review styles using existing variables, insets, panel hierarchy, and mobile rail dimensions.
- `web/src/i18n.ts`: exact English/Spanish parity for lifecycle, review, disclosure, retry/cancel, and artifact labels.
- `tests/e2e/research-pinning.spec.ts`: move existing activity-card/wiki expectations to the new focused spec or update assertions without reducing pin/current-view coverage.
- `tsconfig.json` only if the authoritative contract is placed in a new shared source directory instead of `server/integrations/`; prefer the listed server location to avoid this change.

### Remove after migration

- `web/src/activity-cards.ts` and `web/src/activity-cards.test.ts`: the terminal stack and lifecycle policy move into `tool-presentation.ts`; do not keep two card authorities.

### Explicitly unchanged

- `package.json` and `package-lock.json`: no React, shadcn, Base UI, AI SDK, Pi, Flue, or other UI/workflow dependency.
- `server/integrations/write.ts`, `git.ts`, `registry.ts`, provider resolution, consent gates, Research history persistence, Inbox storage, and voice transport/dispatch.

## Non-Goals

- No chat, transcript, agent pane, agent collection, generic activity feed, or conversational session history.
- No React, shadcn, Base UI, AI SDK, Pi, Flue, or new frontend/runtime dependency.
- No Flue proof of concept, workflow engine, scheduler, queue, worker, database, event store, polling API, or run-history UI.
- No generic schema-to-component renderer, recursive JSON UI, model-generated UI, dynamic component lookup, or arbitrary action bus.
- No new note, wiki, Git, web, spending, consent, approval, or provider route.
- No direct shell, sandbox, filesystem, or vault access for a future runtime.
- No voice redesign, transcript change, shared-intent implementation, or dictation.
- No redesign of reader/research panel geometry, pin semantics, Inbox navigation, editor ownership, Admin, Help, or About.

## Implementation Units

### U1. Contracts, validation, and closed presentation policy

- **Depends on:** none.
- **Covers:** R15-R24.
- **Files:** `tool-presentation.ts`, `workflow-run.ts`, and focused tests.
- **Work:** Implement the exact UUID, reference, revision, timestamp, URL, summary, count, and array validators; exhaustive tuple matrix; unknown-field rejection; provider/cost redaction; retry/cancel invariants; and authorization modes in the pure server contract. Implement deterministic `WorkflowRunV1` to `ToolPresentationV1` mapping and the code-owned surface decision in the frontend module using only a type-only server import. Keep both contracts data-only and rich operation bodies outside them.
- **Acceptance:** every unlisted tuple, malformed or oversized value, producer URL, and unresolved server decision fails closed; unknown workflow names become non-actionable fallback; no contract field can select UI or transport; structurally valid `WorkflowRunV1` maps deterministically into `ToolPresentationV1`, with server decisions non-actionable because this plan adds no resolver.

### U2. Terminal renderer and contextual placement

- **Depends on:** U1.
- **Covers:** R1-R6, R8, R14-R16.
- **Files:** `tool-renderers.ts`, `main.ts`, `index.html`, `style.css`, `i18n.ts`, focused tests.
- **Work:** Implement the capacity-7 actionable map, in-flight reservations, two-newest-plus-aggregate overflow presentation, direct unpaged aggregate access, terminal-only renderer registry, safe fallback, current-context resolver, and placement tied to the existing topbar reflow. Add the explained choice renderer: two through six candidate rows plus localized `Other...`, focus-scoped number shortcuts, Arrow/Enter equivalence, and focused typed response. Use `textContent`; create anchors only from validated HTTPS external-source fields. Remove transient card states and the second card model.
- **Acceptance:** progress never creates a card; at most three cards are visible; all seven unresolved actions remain reachable; review dismissal cannot discard the action; an eighth actionable start is blocked before request; every choice carries an explanation, has at most seven direct rows, uses focused click/keyboard access, and accepts bounded typed `Other...` input; EN/ES parity passes; desktop cards clear panels and mobile cards use the central safe rectangle.

### U3. Migrate current lifecycle surfaces

- **Depends on:** U2.
- **Covers:** R2-R10, R12-R14.
- **Files:** `main.ts`, `i18n.ts`, existing focused tests.
- **Work:** Route rescan, qmd maintenance/setup, install outcomes, graph-refresh failures, and background Research events through the single-surface policy. Remove progress modals and duplicate progress/card emissions. Keep web consent modal and existing guarded calls.
- **Acceptance:** every migrated event has one lifecycle owner; loading never opens or clears Research; non-action terminal success creates no decorative card; actionable errors retain a working retry or dismiss path.

### U4. Wiki review, progressive disclosure, and current-context repair

- **Depends on:** U2, U3.
- **Covers:** R7-R14, R21-R22.
- **Files:** `main.ts`, `tool-renderers.ts`, `style.css`, `i18n.ts`, unit and E2E tests.
- **Work:** Give each current proposal browser-generated UUID run, decision, and review ids; reserve and store its full existing proposal only in the bounded browser-owned host map; emit only labels/counts and the opaque decision/review ids to presentation; show prepare progress only in `#ops-status`; open the host-held review only on explicit CTA; render summary plus disclosures inline; apply/reject through current handlers; restore the safe return context. Do not add runtime review retrieval or a generic action channel.
- **Acceptance:** concurrent completions do not overwrite or evict each other; all pending reviews remain reachable through individual or aggregate cards; pinned/dirty/current Inbox content survives preparation; approve applies only the host-held proposal through the existing route; no runtime envelope supplies operations; reject writes nothing; inline success or conflict does not duplicate a card.

### U5. Browser and release proof

- **Depends on:** U1-U4.
- **Covers:** all requirements.
- **Files:** `workflow-presentation.spec.ts`, migrated focused E2E assertions only.
- **Work:** Add hermetic scenarios for one-owner lifecycle, current-context changes during a run, multiple proposals, pin/dirty preservation, progressive disclosure, safe apply/reject, desktop/mobile placement, focus restoration, unknown fallback, and strict diagnostics.
- **Acceptance:** focused checks and the required serial gate pass with no new dependency, no skipped E2E, and no browser diagnostic failures.

## Deterministic Verification

| Gate | Command | Proves |
|---|---|---|
| Contract units | `npm test -- --run web/src/tool-presentation.test.ts web/src/tool-renderers.test.ts server/integrations/workflow-run.test.ts` | Exact formats, exhaustive tuple matrix, bounds, state mapping, renderer closure, authorization, redaction, retry/cancel, capacity, and safe fallback. |
| Workspace regressions | `npm test -- --run web/src/research-state.test.ts web/src/research-document.test.ts web/src/api.test.ts server/integrations/wiki-ingest.test.ts server/integrations/write.test.ts server/app.test.ts` | Pin/current-view, editor, API, apply, guarded-write, token, path, and CAS behavior remains authoritative. |
| Dependency negative | `node -e 'const p=require("./package.json");const d={...(p.dependencies||{}),...(p.devDependencies||{}),...(p.optionalDependencies||{})};for(const n of ["react","@shadcn/ui","@base-ui-components/react","ai","@mariozechner/pi-coding-agent","flue"])if(n in d)process.exit(1)'` | No prohibited framework/runtime dependency entered the repository. |
| Focused browser | `npm run test:e2e -- tests/e2e/workflow-presentation.spec.ts` | Real single-surface ownership, geometry, current context, wiki review, accessibility, mobile clearance, and clean diagnostics. |
| Required serial gate | `npm test && npm run typecheck && npm run build && npm run test:e2e` | Repository release contract remains green. |

Required browser scenarios:

1. Wiki preparation starts while a pinned Research page is visible: only `#ops-status` appears, the page stays byte-for-byte visible, and completion creates one ready card near search.
2. The user switches from Research to a dirty Inbox editor before completion: the card uses current placement, its provenance still names the original source, and preparation does not replace or flush the editor.
3. Seven reserved proposals finish out of order: the two newest cards plus `N actions ready` expose every review without pagination. An eighth start is blocked before calling propose. Dismissing a review card keeps it in the aggregate selector; no review is overwritten or evicted.
4. Review opens inline, defaults to summary, expands operation details on demand, rejects without a write, and applies through the existing guarded route.
5. Apply failure from stale hash/path/token remains inline and does not overwrite a note or create a duplicate terminal card.
6. Rescan and qmd maintenance use `#ops-status` without a progress modal or transient card.
7. At `390x844` with the rail bottom-docked, terminal cards stay inside the measured central safe rectangle rather than the strip above the input. Reader/research resize, float, dock, pin, and `ctx-left` behavior remain unchanged.
8. Unknown presentation input renders bounded escaped text, no links or actions, and no browser error.
9. URL fixtures reject HTTP, credentials, fragments, custom ports, non-external reference URLs, and producer-supplied navigation. A canonical server-validated HTTPS external source opens with the required rel attributes.
10. Every validity-matrix row passes structural validation; representative cross-product tuples outside the matrix fail. With no server decision resolver in scope, runtime wiki review maps to the non-actionable denied/fallback presentation.
11. An ambiguous research result renders a bounded question and explanation plus numbered candidates. `1` through `7` work only after the card root or candidate receives focus, not while its text field is active; `Other...` focuses its text field, accepts bounded typed text, and cannot alter a route, target, or vault state.

## Security Negatives

- No producer or runtime can select a component, renderer, placement, action, route, HTTP method, header, token, command, prompt, URL, or filesystem path through either contract.
- No presentation event authorizes, spends, writes, retries, cancels, or approves by itself.
- Existing Host/Origin, session-token, consent, key, trusted-provider, path confinement, RAW destination, create-absence, CAS, symlink, and Git-cleanliness failures remain release-blocking and visible.
- Unknown names, fields, provider ids, decision modes, and over-limit values fail closed or become a non-actionable fallback.
- External links come only from canonical validated HTTPS server source fields. They use `target="_blank"` and `rel="noopener noreferrer"`; contract ids, labels, summaries, and runtime data cannot become navigation targets.
- Provider/cost metadata never contains secrets, endpoints, headers, prompts, raw provider payloads, request ids, or billing credentials.
- Cancel does not imply rollback. Retry creates a new run and revalidates current authority. Neither is automatic for spending or mutation.
- A future Flue runtime receives only registry-declared guarded tools, never local shell/sandbox/filesystem or direct vault-write access.
- Flue or any other runtime can emit only bounded review metadata and server-issued opaque ids. It cannot supply operations or arbitrary bodies. Runtime-produced wiki review remains invalid until a separate server review record, guarded retrieval contract, and guarded decision contract are accepted and implemented.
- No envelope becomes a second Research, Inbox, vault, audit, or workflow-history store.

## Definition of Done

- RM007's two outcomes are implemented without adding a third surface or runtime.
- `ToolPresentationV1` remains data-only, code-owned, bounded, runtime-neutral, and rendered through one closed native-DOM registry.
- `WorkflowRunV1` carries exact ids and timestamps, code-owned name/state/effect tuples, bounded summaries and review metadata, source/artifact references, optional redacted provider/cost, retry/cancel semantics, and the server-owned authorization boundary. It never carries wiki operations or arbitrary action bodies.
- Passive progress appears only in `#ops-status`; terminal actionable cards sit near the active search/input on desktop and in the central mobile workspace on bottom-rail layouts; rich review and ordinary decisions are inline; workflow modals are limited to consent or genuinely irreversible confirmation.
- Wiki preparation never forces Research open or clears current content; progressive review, pin/current-view, Inbox editor ownership, and return-context behavior pass deterministically.
- The capacity-7 actionable map never silently evicts a review; its unpaged aggregate selector preserves access without adding a feed or history.
- Every disambiguation card explains the decision, presents at most seven direct choices, and supports bounded typed `Other...` input without creating a chat or transcript.
- Current duplicate progress/card, progress-modal, singleton pending-proposal, and stale current-context paths are removed rather than hidden behind new abstractions.
- All durable artifacts still flow only through existing guarded paths.
- No prohibited dependency, chat/transcript/agent pane, database, or Flue implementation is present.
- Focused tests and the full serial gate pass with zero skips and clean browser diagnostics.

## Evidence Consulted

- `STRATEGY.md`: grounded work should create durable artifacts instead of disposable conversations.
- `PRODUCT.md`: local-first ownership, explicit external action, guarded writes, quiet product register, and no chatbot transcript/activity-feed interaction model.
- `ROADMAP.md`: RM007's committed outcome and dependency on the delivered Inbox workspace.
- `DESIGN.md`: six-variable theme model, panel/z-index hierarchy, overlay opacity rule, search-first behavior, mobile rail, current-view pin boundary, seven-line disclosure pattern, and Research/Inbox editor ownership.
- `AGENTS.md`: vanilla Vite/TypeScript architecture, `main.ts` shell, `i18n.ts`, `api.ts`, guarded routes, `registry.ts`, `write.ts`, `git.ts`, voice boundary, strict browser diagnostics, and required serial gate.
- Current `web/index.html`, `web/src/main.ts`, `web/src/style.css`, `web/src/activity-cards.ts`, and `tests/e2e/research-pinning.spec.ts`: existing `#ops-status`, duplicate transient card emission, corner anchoring, singleton pending wiki proposal, progress modal, pin/current-view, and current wiki review behavior.
