# DESIGN.md: Solaris

Design system reference. Read this before restyling any panel, adding a theme, or touching z-index/layout: it should be enough on its own, without opening `style.css` first.

Source of truth for every value below: `web/src/style.css`, `web/index.html`, `web/src/main.ts`. If this file and the CSS ever disagree, the CSS wins; fix this file.

## 1. Theme model

Themes live in the `THEMES` object, `web/src/main.ts:126`. Each theme is a `ThemeDef` (`web/src/main.ts:111`) with two parts:

- **3D-graph fields** (not CSS): `bloom`, `bg`, `linkBase`, `linkOut`, `linkLit`, `dim`, `selected`, `star`, `labels`, optional `palette` (per-group node color overrides). These drive Three.js materials directly, they are not exposed as CSS variables.
- **`css` field**: a `Record<string, string>` of the UI panel CSS variables. This is the part relevant to restyling chrome/panels.

`applyTheme()` (`web/src/main.ts:774`) applies a theme by iterating `t.css` entries and calling `document.documentElement.style.setProperty(prop, val)` (`web/src/main.ts:778-779`), so switching themes just overwrites the `:root` custom properties defined in `style.css:1-8`.

### CSS variables (every theme defines exactly these 6)

| Variable | midnight default | Used for |
|---|---|---|
| `--bg` | `#070a10` | page/canvas background |
| `--panel` | `rgba(13,17,23,0.88)` | panel/menu/dropdown background (translucent, works with `backdrop-filter: blur`) |
| `--border` | `#30363d` | all hairline borders/dividers |
| `--fg` | `#e6edf3` | primary text |
| `--muted` | `#8b949e` | secondary text, labels, disabled-ish states |
| `--accent` | `#58a6ff` | **drives link/active colors**: focus borders, active mode buttons, checked menu items, hover states, selection accents |

All 10 shipped themes (`midnight`, `gilded`, `manuscript`, `notebook`, `cosmos`, `dracula`, `nord`, `tokyonight`, `gruvbox`, `monokai`, `web/src/main.ts:127-390`) define this same 6-key set; none add extra CSS vars. `--accent` is the single lever for making a theme feel distinct in the chrome.

### Adding a theme

1. Append a new entry to `THEMES` in `web/src/main.ts` (needs `label`, the graph-material fields, and a `css` block with all 6 variables).
2. Add a matching `<option value="...">` to `<select id="theme">` in `web/index.html:46-56`.
3. No CSS changes needed: the CSS never hardcodes a theme name, only reads the variables.

## 2. Panel anatomy

Applies to the reader panel (`#reader`, `web/index.html:281`) and the research panel (`#research`, `web/index.html:257`): they share the same structural conventions.

| Property | Value | Where |
|---|---|---|
| Content inset (left/right padding) | `18px` | `#reader-head` padding `11px 18px 8px` (`style.css:582`), `#reader-body` padding `14px 18px 30px` (`style.css:630`), `#research-head` padding `11px 18px 8px` (`style.css:1140`), `#research-body` padding `14px 18px` (`style.css:1174`), `#research-input-row` margin `8px 18px 14px` (`style.css:1186`) |
| Header row height | `11px` (padding-top) + `25px` (icon button) + `8px` (padding-bottom) = **~44-45px** | derived from `#reader-head`/`#research-head` padding + `.reader-icon` size, not a literal constant |
| `.reader-icon` size | `25px × 25px` | `style.css:616-625`: "~15% larger hit target than the default 22px; the SVG/glyph inside keeps its own size, so only the box grows" |
| `.reader-actions-right` | `margin-left: auto; display: flex; gap: 6px;` | `style.css:600`: pushes the trailing action buttons (dock/close/etc.) to the right end of the header row |
| Panel width | reader: `min(440px, 42vw)` (`style.css:510`); research: `min(400px, 38vw)` (`style.css:1078`) | resizable via the west-edge grip, clamped in JS (see below) |
| Header divider | `border-bottom: 1px solid var(--border)` | flush across the full panel width, no side margins |

### Dock/float geometry engine

Both panels use the same pattern (reader: `web/src/main.ts:1617-1789`; research: `web/src/main.ts:2864+` / `applyRGeom` at `:2957`):

- **Docked** (default): pinned to the right edge (or left, see "context-left" below), full viewport height, width adjustable via the west-edge resize grip (`#reader-resize-w`, `#research-resize-w`).
- **Float**: drag the header (`#reader-head` / `#research-head`, `cursor: grab`) to undock in place; the panel becomes a positioned/sized window (`left`/`top`/`width`/`height`) with a corner resize grip (`#reader-resize-corner`, only visible when `.floating`, `style.css:576`).
- **Re-dock**: double-click the header, or click the dock/undock icon button (`#reader-dock` / `#research-dock`).
- Geometry (`{ floating, width, height, left, top }`) persists to `localStorage` under key **`akasha-reader`** (`web/src/main.ts:1630, 1640`) for the reader panel; the research panel uses the separate key **`akasha-research`** (`web/src/main.ts:2932, 2956`).
- Width is clamped to `280px .. window.innerWidth - 40` (`web/src/main.ts:1657`); floating height clamped to `220px .. window.innerHeight - 24` (`:1661`).

## 3. Z-index ladder

Read directly from `style.css`. Note the two counter-intuitive facts documented in the CSS itself (`style.css:522-525`): **floating panels sit BELOW everything else (5)**, lower than the docked panels (20) and even lower than the topbar (10): this is intentional, so menus/search/filters/settings stay clickable on top of a detached (floating) reader/research window. The graph canvas (`#graph`, `style.css:21`) has no `z-index` set at all (default stacking, effectively behind anything positioned).

| z-index | Layer | Selector(s) |
|---|---|---|
| *(auto)* | 3D graph canvas | `#graph` (`style.css:21`) |
| 3 | Panel resize grips | `#reader-resize-w`, `#reader-resize-corner`, `#research-resize-w`, `#research-resize-corner` (`style.css:553, 569, 1117, 1127`) |
| 5 | **Floating** (undocked) reader/research | `#reader.floating`, `#research.floating` (`style.css:530, 1104`) |
| 10 | Topbar chrome | `#topbar` (`style.css:91`) |
| 11 | Search results dropdown | `#search-results` (`style.css:223`) |
| 12 | Bottom-corner icon buttons | `#filters-btn`, `#settings-btn`, `#reopen-content`, `#reopen-research`, `#brand-stats` (`style.css:319, 361`) |
| 15 | Settings / Filters flyout panels | `#settings`, `#filters` (`style.css:395, 427`) |
| 20 | **Docked** reader/research panels | `#reader`, `#research` (`style.css:514, 1082`) |
| 40 | Loading overlay | `#loading` (`style.css:36`) |
| 50 | Menu dropdowns | `.dropdown` (`style.css:124`) |
| 100 | Modal backdrop | `#modal-backdrop` (`style.css:162`) |

## 4. CSS gotchas

These are load-bearing; breaking them silently misaligns menu text or breaks nested button groups.

**a. `.dropdown button` is `display:flex`, not block text.**
`style.css:135-148`: `.dropdown button { display: flex; justify-content: space-between; gap: 18px; ... text-align: left; }`. Because it's a flex container, centering or aligning label text must go through `justify-content` (e.g. `#integ-recheck` and `#qmd-enable` set `justify-content: center` to center their single-line label, `style.css:804, 864`), **not** `text-align`, which flex ignores for a single flex child spanning full width in this way.

**b. `.mi-group button:not(.checked)` forces left padding: nested groups must out-specify it.**
`style.css:154`: `.mi-group button:not(.checked) { padding-left: 26px; }` (reserves space for the `✓` checkmark prefix used by `.mi-group .checked::before`, `style.css:153`). Specificity is `(0,2,1)` (`.mi-group` class + `:not(.checked)` contributes the specificity of `.checked`, a class, + `button` element). Any nested button group inside a `.mi-group` (e.g. the qmd maintenance buttons) needs a selector of **equal or greater specificity declared later in the file** to win the cascade. The actual fix in the codebase: `style.css:875` `.mi-group .qmd-maint-btns button { ...padding: 5px 4px... }`, same specificity `(0,2,1)`, but it appears later in `style.css` than the `:not(.checked)` rule, so it wins on source order. Don't rely on specificity alone here; the override must also come after in file order.

**c. Hidden-state transforms differ between reader and research (verify per-panel, don't assume symmetry).**

| Selector | Transform | Also sets `opacity:0`? | Line |
|---|---|---|---|
| `#reader.hidden` (docked, right) | `translateX(120%)` | no | `style.css:519` |
| `#reader.ctx-left:not(.floating).hidden` (docked, left) | `translateX(-120%)` | no | `style.css:1211` |
| `#reader.floating.hidden` | `translateY(120%)` | **yes** | `style.css:535-539` |
| `#research.hidden` (docked) | `translateX(120%)` | **yes** | `style.css:1090` |
| `#research.floating.hidden` | `translateY(120%)` | **yes** | `style.css:1092-1096` |

Docked `#reader.hidden` is the one exception without `opacity:0`: a translate-only slide is enough because the docked panel is always full-height, flush to a screen edge, so it can't "peek." Floating panels (both reader and research) and the docked research panel all add `opacity:0` (+ `pointer-events:none`) to kill any peek/phantom-window artifact on resized/short viewports (comment at `style.css:532-534`).

## 5. `.ext-icon` external-link icon convention

`style.css:133`: `.ext-icon { vertical-align: -1px; margin-left: 2px; opacity: 0.85; }`

Used as a small inline SVG (10×10, `viewBox="0 0 24 24"`) directly after the text of external help links, e.g. "Get a key ⧉" in the Integrations menu (`web/index.html:106-107, 122, 136-137, 151`). Always: text label, then the SVG with class `ext-icon`, inline inside the `<a>`.

## 6. Interaction conventions

### Mode exclusivity (Semantic / Web / Ingest)

- Type `ModeName = "semantic" | "web" | "ingest"` (`web/src/main.ts:2195`). At most one is active, persisted to `localStorage["akasha-mode"]` (`:2221, 2284-2285`).
- Each mode button (`#mode-semantic`, `#mode-web`, `#mode-ingest`) is `disabled` until its backing tool is detected (`modeReady()`, `:2242-2250`): qmd installed, Exa configured, or markitdown installed respectively.
- `setMode()` (`:2277-2289`) closes the research column on switch ("column content belongs to the previous mode") and updates the search field via `updateSearchField()`.

### Search-first behavior

- The mode changes what the search field's Enter does (F018): placeholder text swaps per mode (`SEARCH_PLACEHOLDERS`, `:2263-2268`: "Semantic search…", "Web research…", "/path/to/file.pdf or https://…"), and `searchBox` gets class `mode-active` (accent border via `#search.mode-active`, `style.css:1200`).
- Ingest mode repurposes the search box as a path/URL input and reveals a Browse button (`#ingest-browse`, shown via `.hidden` toggle, `:2272-2274`); results land in the shared `#research` column.
- Web queries never auto-run while typing: they only fire on Enter/submit, since each one spends Exa credit.

### Web-mode consent gate

`setMode()` checks `integrations.consents.web` before activating Web mode; if not yet granted it calls `promptWebConsent()` instead of activating (`:2278-2281`, referencing "R18/AE8"). The consent modal (`:2840-2861`) offers "Enable Web mode" (POSTs `{ consents: { web: true } }` via `postConfig`) or "Cancel" (`hideModal`, "declining sends nothing"). Never bypass this gate when wiring new Web-mode entry points.

### Keyboard map (verified against the `keydown` handler, `web/src/main.ts:3932-4046` and surrounding)

All bare-letter shortcuts are suppressed while typing in any `INPUT`/`TEXTAREA`/`SELECT`/contenteditable element (`typing` check, `:3936-3941`).

| Key | Action | Notes |
|---|---|---|
| `/` | Focus search (or `#research-input` if the research column is open) | `:3942-3948` |
| `Escape` | Step out of a focused field; else close modal → menus → research column → clear selection (in that order) | `:3950-3961` |
| `f` | Toggle Fullscreen API | uses `f` not `F11` (F11 is browser-reserved); desktop build also keeps native F11 (`:3962-3969`) |
| `Ctrl`/`Cmd` `+` / `=` | UI zoom in (`+0.1`, clamped `0.6..2`) | works even while typing (`:3971-3976`) |
| `Ctrl`/`Cmd` `-` / `_` | UI zoom out (`-0.1`) | `:3977-3980` |
| `Ctrl`/`Cmd` `0` | Reset UI zoom to `1` | `:3982-3986` |
| `r` | Reset Camera (clicks `#mi-resetcam`) | `:3995-3998` |
| `g` | Toggle glow (`#toggle-glow`) | `:3999-4002` |
| `l` | Toggle labels (`#toggle-labels`) | `:4003-4006` |
| `u` | Toggle unwritten/phantom nodes (`#toggle-phantoms`) | `:4007-4010` |
| `o` | Toggle orphans (`#toggle-orphans`) | `:4011-4014` |
| `a` | Toggle left/content panel (reader): close if open, else reopen last (`#reopen-content`) | `:4017-4022` |
| `d` | Toggle right/research panel: close if open, else reopen last (`#reopen-research`) | `:4023-4028` |
| `Ctrl`/`Cmd` `+C` | Copy link to selected note (`#mi-copyfocus`) | only when there's no active text selection, so native copy still wins (`:4032-4038`) |
| `Ctrl`/`Cmd` `+O` | Open selected note in Obsidian (`#mi-obsidian`) | `:4041-4045` |

Confirms the outline's claim (`a`=left panel, `d`=right panel, `r/g/l/u/o` for camera/display toggles, `Ctrl ±` for zoom): all bindings check out against the code as written above.

Note: `Escape` order is modal → menus → research column → selection; the reader panel itself has no dedicated Escape-close entry in this handler (it's closed via its own `#reader-close` button / the `a` shortcut).
