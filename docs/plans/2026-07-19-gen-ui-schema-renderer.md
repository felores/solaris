# Generative UI: Schema + Vanilla Renderer

Add mid-screen interactive components (confirm, choices, input) produced by
LLM structured output and rendered as vanilla DOM, reusing the theme system.

---

## Constraints

-   No React, no framework deps. Vanilla TS only.
-   Must use existing CSS custom properties (`--accent`, `--bg`, `--panel`,
    `--border`, `--fg`, `--muted`, `--success`, `--danger`) so theme switching
    applies automatically.
-   All user-facing text needs entries in `web/src/i18n.ts` (en + es).

---

## Schema (LLM output, validated at runtime)

```typescript
type GenUiCommand =
  | "apply_wiki_ingest"
  | "choose_wiki_target"
  | "confirm_delete_note"
  | "rename_note"
  | "add_tag"
  | "generic_confirm";

interface GenUiSchema {
  type: "confirm" | "choices" | "input";
  title: string;              // max 120 chars
  body?: string;              // max 500 chars
  options?: {
    label: string;             // max 40 chars
    value: string;             // max 40 chars
    variant?: "primary" | "secondary" | "danger";
  }[];                         // max 6 items, unique values
  fields?: {
    key: string;               // max 20 chars, unique
    label: string;             // max 60 chars
    type: "text" | "textarea";
    placeholder?: string;
  }[];                         // max 3 items
  command: GenUiCommand;       // closed enum, not a URL
  payload?: Record<string, unknown>; // per-command validated
}
```

No `info` or `status` types — those already exist as `setOpsStatus()`,
research banners, and save-state announcements in the existing codebase.

---

## Command allowlist (not URLs)

The LLM cannot manufacture endpoints. Every generative UI interaction maps to
a predefined command the client handles:

| Command | Requires | Handler does |
|---|---|---|
| `apply_wiki_ingest` | proposal server ID | POST `/api/wiki-ingest/apply` |
| `choose_wiki_target` | — | POST `/api/wiki-ingest/propose` with user choice |
| `confirm_delete_note` | note path | POST `/api/notes/delete` (archive) |
| `rename_note` | note path, new title | PUT `/api/notes/rename` |
| `add_tag` | note path, tag | PUT `/api/notes/tags` |
| `generic_confirm` | server-chosen action ID | POST `/api/generic-action` with id |

The client maps command to endpoint + payload shape. The LLM never controls
the URL or method.

---

## Renderer placement

Put the runtime parser + DOM builder in a new file `web/src/gen-ui.ts`, not in
`main.ts`. `main.ts` imports `renderGenUi(schema)` and wires it to the LLM
call chain.

### Overlay

Reuse the existing modal element (`#modal` in `index.html`) at z-index 100
(current value). Set its `role="dialog"` and `aria-modal="true"`, with
`aria-labelledby` pointing to the title element.

### Accessibility

-   Focus trap inside overlay (Tab cycles through interactive elements)
-   Close on Escape (but not on backdrop click for confirm/choices)
-   Restore focus to previous element on close
-   Disable submit button while request is in-flight
-   `aria-live="polite"` region for status updates
-   `textContent` everywhere — never `innerHTML` for model-produced content
-   Loading spinner on the submit button during request

### Styling

CSS classes in `style.css` using `var(--panel)` for the card background,
`var(--border)` for the border, `var(--fg)` for text, `var(--accent)` for
primary button, `var(--danger)` for destructive buttons.

```css
.gen-ui-overlay {
  position: fixed; inset: 0; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.5);
}
.gen-ui-card {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 8px; padding: 24px; max-width: 480px; width: 90%;
}
```

---

## Server route

`POST /api/generative-ui` — same pattern as `POST /api/selection-assist` but
returns a `GenUiSchema` object. Register the operation in
`server/integrations/registry.ts` alongside `selection_assist`, with its tier,
route, and token requirement.

---

## Validation

Runtime validation before rendering:

-   Struct: discriminated union on `type`
-   Required fields present
-   String length limits (title 120, body 500, labels 40, values 40)
-   Options ≤ 6, fields ≤ 3, unique keys
-   Command is in allowlist
-   Reject malformed → show fallback text via `setOpsStatus`

---

## What NOT to build

-   No `info` / `status` types (use existing `setOpsStatus`, research banners)
-   No freeform LLM-generated UI (only constrained schema components)
-   No `dangerous` variant security (it's presentational; authorization is
    independent)
-   No double-submit protection (handle with button disable)
-   No stale-context tokens (the server owns proposal IDs)

---

## Files

| File | What | Δ lines |
|---|---|---|
| `web/src/gen-ui.ts` | Types + parser + DOM builder | ~80 |
| `web/src/main.ts` | Import + wire `renderGenUi` into call chain | ~20 |
| `server/app.ts` | `POST /api/generative-ui` route | ~25 |
| `server/integrations/registry.ts` | Register operation | ~5 |
| `web/src/style.css` | `.gen-ui-*` classes | ~25 |
| `web/src/i18n.ts` | English + Spanish labels | ~15 |
| `web/index.html` | (reuse existing `#modal`) | 0 |

**Total: ~170 lines.**
