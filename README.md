<div align="center">
<pre>
███████╗ ██████╗ ██╗      █████╗ ██████╗ ██╗███████╗
██╔════╝██╔═══██╗██║     ██╔══██╗██╔══██╗██║██╔════╝
███████╗██║   ██║██║     ███████║██████╔╝██║███████╗
╚════██║██║   ██║██║     ██╔══██║██╔══██╗██║╚════██║
███████║╚██████╔╝███████╗██║  ██║██║  ██║██║███████║
╚══════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝
</pre>

**knowledge vault hyper-visualizer**

*Your Vault as a navigable 3D universe.*
</div>

<p align="center">
  <img src="assets/hero.png" alt="A vault of ~2,000 notes rendered as a 3D particle galaxy, clusters colored by domain" width="100%">
</p>

*Above: a vault of ~2,000 interlinked markdown files as a force-directed particle
galaxy. The layout engine builds the clusters from the links alone, with zero
configuration; each color is a knowledge domain, and the bright strands between
clusters are real cross-domain links.*

## Flythrough

<p align="center">
  <img src="assets/flythrough.gif" alt="Camera orbiting the whole graph, then diving into a cluster as note labels fade in" width="100%">
</p>

*Orbit the whole graph, then dive into a cluster; the note labels fade in as the
camera approaches. [Watch in HD (mp4).](assets/flythrough.mp4)*

## What it is

Solaris scans any
**folder of Markdown files connected by links** and renders the link graph as an
interactive force-directed map in WebGL: rotate it, fly through it, read any note
without leaving the map. It reads both link styles: Obsidian `[[wiki links]]`
resolved by basename, and standard markdown links to `.md` files (`[text](path.md)`)
resolved by relative path. An Obsidian vault is the natural fit, but **Obsidian
itself is never required**: the only contract is markdown files in folders, and
deep links into Obsidian are an optional convenience.

## Why I made it

Obsidian renders vaults and notes in 2d. When visualizing large data sets, 3d visualizations are often needed for seeing patterns at scale or discovering intersections. Solaris seeks to solve that problem by providing the ability to traverse and visualize your second brain in a 3d navigatable space.  

## Reads Google's Open Knowledge Format

Point Solaris at an [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
bundle — Google Cloud's open spec for markdown knowledge — and it renders like any
vault: concepts become nodes, the `[name](path.md)` links become edges, and the whole
bundle becomes a navigable 3D graph.

```bash
npx solaris "C:/path/to/okf-bundle"
```

Solaris reads OKF frontmatter fully: each concept is labeled by its `title` (falling back
to the filename), and its `type`, `tags`, and `description` are carried into the graph.
Markdown links between concepts become the edges; the folder hierarchy becomes the
pillars.

## Quickstart

```bash
npx solaris "C:/path/to/YourVault"     # scan, serve, open in one command
```

Or from a clone:

```bash
npm install
npm run scan -- "C:/path/to/YourVault" --exclude "Private/Drafts"
npm run build
npm start          # → http://localhost:5175
```

For development (hot reload): `npm run dev` and open http://localhost:5173.

### Desktop app

```bash
npm run desktop
```

Builds the frontend, bundles the Electron main process, and opens Solaris as a
native window with hardware acceleration unlocked (GPU rasterization,
zero-copy uploads, no GPU blocklist, `powerPreference: high-performance`). The
20k-link scene, bloom, and particles all render on the dedicated GPU.

Desktop-only conveniences: **File → Open Vault…** (`Ctrl+Shift+O`) picks any vault
directory and scans it on the spot; **Rescan Current Vault** (`Ctrl+Shift+R`)
refreshes the graph after you've added notes; the server binds a random
localhost-only port.

## How it works

```python
scanner/   walks the vault, resolves [[wiki links]] by basename (case-
           insensitive, like Obsidian) and standard [markdown](links.md) by
           relative path (the OKF link style), emits data/graph.json: nodes,
           links, pillars, degrees, phantom targets
server/    Express on localhost: /api/graph + /api/note (markdown read live
           from disk, path-confined to the vault root)
web/       Vite + TypeScript + three.js (3d-force-graph): the map, the reader
           panel, search, legend, focus mode
```

The scanner is vault-agnostic: point it at any Obsidian vault and the pillars,
colors, and clusters derive from your folder structure and your links.

### What it does

- **Navigate**: drag to rotate, scroll to zoom, right-drag to pan; arrow keys fly
  the camera (a tap nudges, holding accelerates to ~6× cruise, and speed scales
  with distance so long crossings are fast and close-in moves stay precise).
- **Search and fly**: press `/`, type, hit Enter; the camera travels to the top
  hit. The server builds a MiniSearch inverted index over note *content* (titles
  boosted, prefix + fuzzy matching) on first query; ~4 ms per query after that.
- **Read without leaving the map**: clicking a node opens the rendered Markdown in
  a draggable, resizable side panel; `[[wiki links]]` inside it are clickable and
  fly you to the next node. Double-click opens the note in Obsidian itself via
  the `obsidian://` URI.
- **Focus mode**: selecting a node dims everything outside its depth-N
  neighborhood (depth 1–3, like Obsidian's local graph).
- **Filters**: an ordered list of `show` / `ignore` rules decides which nodes
  render. Patterns match titles, tags, and folders by fuzzy text or wildcard
  (`macro*`, `*lipid`); `show` keeps matches (a whitelist), `ignore` hides them.
  The top rule wins, rules drag to reorder, and the list persists across sessions.
- **Your groups, your colors**: group nodes by top-level folder *or* by `#tag`;
  every legend swatch is a color picker, and clicking a legend row toggles that
  group's visibility.
- **Weighted node sizing**: node size reflects incoming links, outgoing links,
  and word count, each with its own weight slider, plus a contrast curve that
  exaggerates or flattens the spread between hubs and leaf notes.
- **Phantom nodes**: notes you've linked to but not yet written, rendered the way
  Obsidian renders unresolved links (off by default); an **orphans** toggle hides
  notes with no links.
- **Always-on labels, Obsidian style**: every node carries its name; labels fade
  in by camera distance, so names appear as you approach a cluster.
- **Deep links & sharing**: `?focus=`, `?theme=`, and `?nodes=` in the URL preset
  the view on load; **Tools → Copy Link to Selected Note** generates a shareable
  link to the current note.
- **Export & view**: File → **Export Image (PNG)** saves the current view; the
  View menu adds **Reset Camera** and **Toggle Fullscreen**.
- **Admin**: File → **Admin...** manages the active vault path, detected wikis,
  per-wiki ingest destinations, and prompt overrides.

### Built for massive vaults

Solaris holds the entire graph in view and stays interactive as vaults grow into
the thousands of notes. Below, the same vault from another angle, ~20k links,
every node and edge rendered at once:

<p align="center">
  <img src="assets/big-vault.png" alt="A 1,800-note vault rendered dense, clusters and cross-links visible" width="100%">
</p>

Solaris keeps rescan and render cost proportional to what changed:

- **Incremental rescans**: the scanner caches per-file parse results by mtime+size
  (`scan-cache.json`) and re-reads only the files that changed.
  Edit one note in a 2k-note vault: `108ms — 1 parsed, 1829 from cache`.
  At 50k notes the difference is seconds vs. minutes. `--full` forces a cold scan.
- **Content fingerprint**: a hash of the file manifest keys the layout cache,
  so a no-op rescan keeps your settled layout.
- **One-draw-call links**: all links render as a single merged `LineSegments`
  buffer; per-frame cost stays flat no matter how many links you have.
- **Label budget**: only the ~140 nearest labels draw per frame.
- **Lazy full-text index**: the server builds it once per session on first
  search; ~4 ms per query after that.

## Themes & node styles

Ten themes restyle the entire app (scene, links, starfield, bloom, node palette,
and UI panels), selectable from the bottom bar, the **View** menu, or `?theme=`
in the URL. Four node styles set how each note is drawn: **classic** glossy
spheres, faceted **dodecahedron** gems, glowing **starlight** cores, and
volumetric swirling **particle** shells (up to 16k points per node, tier-scaled),
selectable from the **nodes** dropdown or `?nodes=`.

Each shot below pairs a theme with a node style, so the first ten pictures cover
all ten themes and all four styles; the last two show tag grouping and the view
from inside a cluster:

<table>
  <tr>
    <td width="33%"><img src="assets/theme-midnight.png" alt="Midnight theme, classic spheres"><br><sub><b>Midnight</b>, classic spheres: cool dark default</sub></td>
    <td width="33%"><img src="assets/theme-cosmos.png" alt="Cosmos theme, particle shells"><br><sub><b>Cosmos</b>, particles: deep space, dense starfield</sub></td>
    <td width="33%"><img src="assets/theme-gilded.png" alt="Gilded theme, starlight nodes"><br><sub><b>Gilded</b>, starlight: near-black with gold links</sub></td>
  </tr>
  <tr>
    <td width="33%"><img src="assets/theme-manuscript.png" alt="Manuscript theme, classic spheres"><br><sub><b>Manuscript</b>, classic: light parchment</sub></td>
    <td width="33%"><img src="assets/theme-notebook.png" alt="Notebook theme, dodecahedron nodes"><br><sub><b>Notebook</b>, dodecahedrons: warm beige paper</sub></td>
    <td width="33%"><img src="assets/theme-dracula.png" alt="Dracula theme, particle shells"><br><sub><b>Dracula</b>, particles: purple-charcoal</sub></td>
  </tr>
  <tr>
    <td width="33%"><img src="assets/theme-nord.png" alt="Nord theme, starlight nodes"><br><sub><b>Nord</b>, starlight: arctic slate-blue</sub></td>
    <td width="33%"><img src="assets/theme-tokyonight.png" alt="Tokyo Night theme, dodecahedron nodes"><br><sub><b>Tokyo Night</b>, dodecahedrons: deep navy</sub></td>
    <td width="33%"><img src="assets/theme-gruvbox.png" alt="Gruvbox theme, classic spheres"><br><sub><b>Gruvbox</b>, classic: retro warm dark</sub></td>
  </tr>
  <tr>
    <td width="33%"><img src="assets/theme-monokai.png" alt="Monokai theme, starlight nodes"><br><sub><b>Monokai</b>, starlight: classic editor olive</sub></td>
    <td width="33%"><img src="assets/view-tags.png" alt="Midnight theme grouped by tag"><br><sub><b>Group by #tag</b>: your tags drive the legend and colors</sub></td>
    <td width="33%"><img src="assets/view-flythrough.png" alt="Camera inside a cluster, labels faded in"><br><sub><b>Inside a cluster</b>: labels fade in as you approach</sub></td>
  </tr>
</table>

### Capabilities

A selected node opens the rendered note in a draggable, resizable reader panel
while focus mode dims everything outside its neighborhood:

<p align="center"><img src="assets/ui-reader-focus.png" alt="Reader panel and focus mode" width="100%"></p>

Filters carve the graph down to what you want to see: an ordered list of
`show` / `ignore` rules matched against titles, tags, and folders by fuzzy text
or wildcard. The top rule wins, rows drag to reorder, and the list persists:

<p align="center"><img src="assets/ui-filters.png" alt="Filters panel with show and ignore rules narrowing the graph" width="100%"></p>

<table>
  <tr>
    <td width="50%"><img src="assets/ui-display-settings.png" alt="Display settings panel"><br><sub>⚙ <b>Display settings</b>: live sliders + node-size weighting</sub></td>
    <td width="50%"><img src="assets/ui-view-menu.png" alt="View menu"><br><sub><b>View menu</b>: themes + graphics tiers</sub></td>
  </tr>
</table>

## Controls

| Input | Action |
|-------|--------|
| Left-drag | Rotate |
| Scroll | Zoom |
| Right-drag | Pan |
| Arrow keys | Fly: `↑` forward, `↓` back, `←`/`→` strafe |
| `Shift`+arrows | Pan |
| `+` / `−` | Zoom |
| `F` | Toggle fullscreen |
| `R` | Reset camera |
| `G` / `L` / `U` / `O` | Toggle glow / labels / unwritten / orphans |
| `Ctrl/Cmd`+`C` | Copy link to selected note |
| `Ctrl/Cmd`+`O` | Open the selected note in Obsidian |
| Hover | Highlight node + neighbors |
| Click | Select, fly to node, open reader |
| Double-click / right-click | Open the note in Obsidian |
| `/` | Focus search (`Enter` flies to the top hit) |
| `Esc` | Close modal / menu, then clear selection |

The **View** menu carries the everyday controls: theme, graphics tier, node
style, focus depth, group-by, and the glow / labels / unwritten / orphans
toggles. The **⚙ settings** panel holds the live sliders, and **Help →
Keyboard & Mouse Controls** lists every input. **Filters** sits bottom-left,
**⚙ settings** bottom-right, with note/link counts centered between them. In
the desktop build, `Ctrl/Cmd+Shift+O` opens a vault.

## Optional integrations

Three mode buttons sit next to the search bar; each lights up only when its
tool is detected, and Solaris stays fully functional with none of them.
**The search field is the single entry point**: the active mode changes what
Enter does, and results open in a right-side research column (the reader
docks left while it's open — the note you're reading is the working
context). Every opened note also ends with a "research questions" action
that turns that note into 3-5 web queries.

| Mode | Tool | What Enter does |
|------|------|--------------|
| **Semantic** ◈ | [qmd](https://github.com/tobi/qmd) (local) | Semantic search over your notes in the column. Related notes at the end of every note work regardless of the mode button. All local. |
| **Web** ◍ | [Exa](https://exa.ai) (API key) | Web research in the column, save-as-note into `inbox/`. Never auto-runs while typing. |
| **Ingest** ⇩ | markitdown (local) + optional OpenRouter key | Converts a path, URL, or browser upload. Capture-only saves immediately; wiki targets preview proposed writes before anything is applied. |

Two install flavors: **core** (default, nothing extra) and **addons** —
`npx solaris "<vault>" --addons` or *Settings → install missing addons* —
which installs only what is missing and never touches an existing setup.

### Admin, wikis, and ingest

Open **File → Admin...** to manage the current vault and wiki settings.

- **Vault switching**: browser/CLI mode accepts a typed local path; the Electron
  desktop app also offers a native folder picker. Switching rescans and hot-swaps
  the graph.
- **Wiki discovery**: Solaris finds folders named exactly `wiki`. All detected
  wikis start enabled; you can disable, rename, or add manual paths. Contract
  candidates are `AGENTS.md`, `CLAUDE.md`, `index.md`, and `README.md`.
- **Raw destination**: Solaris picks the first existing source folder it finds:
  `raw/`, `../raw/`, `research/`, `../research/`, `docs/`, then `../docs/`.
  If none exist, it proposes `../raw/` so the source folder sits beside the
  wiki. You can still override or blank it per wiki.
- **Prompt overrides**: Admin exposes local prompt text for wiki ingest, note
  questions, voice, and web research. Reset restores the built-in default.
- **Wiki-aware ingest**: one enabled wiki is selected automatically. Multiple
  enabled wikis show a target selector. `Inbox / capture only` keeps the old
  immediate save behavior. A wiki target converts the source locally with
  markitdown, reads that wiki's contracts, asks OpenRouter for structured
  create/edit proposals, shows a preview, and writes only after you approve.
- **Voice-aware wiki saves**: the voice assistant receives the enabled wiki
  paths, raw folders, and contract filenames from Admin. When you ask it to save
  its working document, it can read the selected wiki contract first, promote the
  temporary document into the wiki or raw folder, rescan, open the saved note,
  and remove the temporary history entry.
- **Git-backed note history**: if your vault is inside a Git repository, the
  reader shows a Versions selector with commit history for the open note.
  Selecting an old commit previews that version read-only; a Restore button
  replaces only the current note's working-copy content with the old version
  (through the same guarded write path, journaled). It never runs
  `git checkout`, `reset`, or `revert`, and never moves HEAD or touches other
  files. Vaults without Git are unaffected.

### Trust model

- **The core uploads nothing.** Scanning, rendering, search, and reading are
  fully local; the server binds to `127.0.0.1` only.
- **Optional Web and LLM features are explicit.** Web queries go to Exa only
  after Web consent and with your own key. OpenRouter-backed note questions and
  wiki-ingest synthesis use your stored OpenRouter key; the relevant note,
  source excerpt, and wiki contracts are sent to that provider only for the
  action you requested.
- **The vault is written only through one guarded endpoint** (path-confined,
  `.md`-only, never overwrites) and only on your action: saving a web result,
  capture-only ingest, approving a wiki-ingest proposal, promoting a voice
  working document, or confirming an orphan link suggestion. Writes are
  journaled in `data/changes.jsonl`.
- Secrets (Exa, OpenRouter, and voice keys) live in `~/.solaris/config.json`
  (mode 600), outside the vault and outside version control, and never appear in
  API responses.

## Privacy

Everything in the core runs on `localhost`; data and files are never copied,
indexed, or uploaded. Optional Web and OpenRouter features are opt-in by key and
action, as described in the trust model above.

## Stack

TypeScript end to end · [3d-force-graph](https://github.com/vasturiano/3d-force-graph)
(three.js/WebGL) · Express 5 · Vite 6 · marked · tsx.

## License

MIT. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
