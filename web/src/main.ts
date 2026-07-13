/**
 * Sinapso: interactive 3D map of an Obsidian vault.
 *
 * Interaction model (Obsidian-style):
 *   Left drag    - rotate the graph
 *   Scroll       - zoom in/out
 *   Right drag   - pan the view
 *   Arrow keys   - fly: ↑ forward, ↓ back, ←/→ strafe (Shift+arrows pan)
 *   Hover        - highlight connected neighbors
 *   Click        - select a node and focus on its neighborhood
 *   Double-click - open the note in Obsidian
 *   Search       - find and fly to a specific note
 *
 * Visual design:
 *   - Nodes: sized by degree (# of links); colored by pillar (folder) or first #tag
 *   - Links: base color at rest; highlighted along visible paths; weight shown by thickness
 *   - Labels: fade by distance from camera (Obsidian-style); always visible when selected
 *   - Bloom: optional glow effect (theme-dependent; cheaper at half resolution)
 *   - Starfield: immersive backdrop (theme-dependent; dense mode on Cosmos theme)
 *   - Particles: flow along highlighted links to show directionality
 *
 * Performance:
 *   - 20k+ links rendered as one merged buffer (single draw call, not per-link)
 *   - Physics simulation optional: if layout cached, graph appears instantly
 *   - Quality tiers: low (6px nodes, 1x res), medium (9px, 1.5x), high (18px, 2x)
 *   - Search index built lazily on first query; kept in memory; cleared on rescan
 */

import ForceGraph3D, {
  type ForceGraph3DInstance,
  type ConfigOptions,
} from "3d-force-graph";
import SpriteText from "three-spritetext";
import { marked } from "marked";
import DOMPurify from "dompurify";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import * as i18n from "./i18n";
import { createNoteEditor, type NoteEditor } from "./editor";
import { createAutosave, type Autosave, type AutosaveState } from "./autosave";
import {
  createResearchDocument,
  createResearchDocumentController,
  type ResearchDocument,
  type ResearchDocumentController,
  type ResearchDocumentTransport,
} from "./research-document";
import {
  buildAssistRequest,
  insertBelow,
  replaceSelection,
  type AssistRequest,
} from "./ai-assist";
import { BOT_ICON_SVG, type ToolbarExtras } from "./editor-toolbar";
import { startVoice, type VoiceSession } from "./voice";
import {
  clearStaleResearchPin,
  decideAgentResearchDisplay,
  type ResearchDisplayAcknowledgment,
} from "./research-state";
import {
  THEMES,
  PALETTE,
  FALLBACK_COLORS,
  nodeColorFor,
  type GNodeLike,
  type NodeColorDeps,
} from "./theme";
import { spectrumComplement, spectrumHslToRgb } from "./spectrum";
import type { GNode, GLink } from "./types";
import { filterFields, compileMatcher } from "./filters";
import { computeSemanticClusters as computeSemanticClustersPure } from "./clusters";
import { api, apiRaw, ApiError, getApiToken, peekApiToken } from "./api";
import { pickerState } from "./model-picker";
import { createPrefs } from "./prefs";
import {
  buildKeywordQuery,
  buildSelectionSnapshot,
  buildSemanticQuery,
  clearSelectionSlot,
  contextTrimNotice,
  contextUseNotice,
  displayQuery,
  emptySelectionState,
  hasSelectionContext,
  selectionContextAppliesToMode,
  selectedText,
  selectionSlot,
  updateSelectionSlot,
  type SelectionContext,
  type SelectionContextState,
  type SelectionSnapshot,
  type SelectionSource,
} from "./selection-context";

// ===== DATA STRUCTURES =====
interface Graph {
  meta: {
    vaultName: string;
    vaultPath: string;
    scannedAt: string;
    fingerprint: string;
    notes: number;
    links: number;
    phantoms: number;
    excludes: string[];
    pillars: string[];
  };
  nodes: GNode[];
  links: GLink[];
}

const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// Reflect the current interface language in the active chip (File menu → EN/ES).
function syncLangUI() {
  const code = i18n.getLang();
  document
    .querySelectorAll<HTMLElement>(".lang-chip")
    .forEach((c) => c.classList.toggle("active", c.dataset.lang === code));
}

// ===== BOOT & INITIALIZATION =====
// The loading overlay (index.html) is up from first paint; fade it out once
// the constellation has settled. A short minimum keeps it from flashing on
// instant (cached-layout) loads.
const loadStart = performance.now();
function hideLoading() {
  const el = document.getElementById("loading");
  if (!el || el.classList.contains("done")) return;
  const wait = Math.max(0, 700 - (performance.now() - loadStart));
  window.setTimeout(() => {
    el.classList.add("done");
    window.setTimeout(() => el.remove(), 700);
  }, wait);
}

// Exa's article text (and some agent docs) repeat the page title as the first
// line, so the panel showed it twice (the h2 heading + the body's first line).
// Drop a single leading line that duplicates the title, plain or as a markdown
// heading; leave everything else untouched.
function stripLeadingTitle(content: string, title: string): string {
  const t = title.trim().toLowerCase();
  if (!t) return content;
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (
    i < lines.length &&
    lines[i]
      .replace(/^#{1,6}\s+/, "")
      .trim()
      .toLowerCase() === t
  ) {
    return lines
      .slice(i + 1)
      .join("\n")
      .replace(/^\n+/, "");
  }
  return content;
}

function ensureReaderTitle(content: string, title: string): string {
  const body = stripLeadingTitle(content, title);
  const first = body.split("\n").find((line) => line.trim());
  return first && /^#\s+/.test(first) ? body : `# ${title}\n\n${body}`;
}

function sanitizeRenderedMarkdown(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_ATTR: ["style"] });
}

// Open-in-new-tab glyph (lucide external-link), same as the Tools-menu links.
// Appended to external anchors so they read as "opens a new tab".
const EXT_ICON =
  '<svg class="ext-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/></svg>';

async function boot() {
  // Fetch graph data (scanned vault topology) and cached layout (node positions from previous session)
  // Layout cache is keyed by content fingerprint; if vault unchanged, positions are reused
  const [data, layout] = await Promise.all([
    apiRaw("/api/graph").then((r) => r.json()) as Promise<Graph>,
    api<{
      fingerprint: string;
      positions: Record<string, number[]>;
    } | null>("/api/layout").catch(() => null),
  ]);

  // Layout cache hit: seed every node with its settled position and skip
  // the physics warm-up; the map appears settled on the first frame.
  // Keyed by content fingerprint, so no-op rescans don't invalidate it.
  // If fingerprint matches, graph appears instantly, already stable
  const cachedPositions =
    layout && layout.fingerprint === data.meta.fingerprint
      ? layout.positions
      : null;
  if (cachedPositions) {
    for (const n of data.nodes) {
      const p = cachedPositions[n.id];
      if (p) {
        n.x = p[0];
        n.y = p[1];
        n.z = p[2];
      }
    }
  }

  // --- theme state (drives scene + UI colors; persisted, ?theme= overrides) ---
  // ===== THEME STATE =====
  // Theme drives scene (background, link colors, stars) + UI panel styles
  // Persisted via prefs; ?theme= query parameter overrides
  const prefs = createPrefs();
  let theme =
    new URLSearchParams(window.location.search).get("theme") ||
    prefs.getTheme();
  if (!THEMES[theme]) theme = "midnight";
  const T = () => THEMES[theme];

  // --- grouping: color by top-level folder or by first #tag ---
  // No app is required to produce the input: any folder of markdown with
  // [[wiki links]] works. Folders give structure-groups; #tags give
  // meaning-groups; the user picks colors per group (persisted locally).
  // ===== GROUPING: COLOR BY PILLAR (FOLDER) OR BY FIRST #TAG =====
  // Allows both structural (folder-based) and semantic (tag-based) coloring
  // User picks a grouping mode (persisted); group colors are customizable and persisted
  type GroupMode = "folder" | "tag" | "cluster" | "wiki";
  let groupMode = (new URLSearchParams(window.location.search).get("group") ||
    prefs.getGroup()) as GroupMode;
  if (!["folder", "tag", "cluster", "wiki"].includes(groupMode))
    groupMode = "folder";
  let groups: string[] = [];
  let groupCounts = new Map<string, number>();
  const groupOfId = new Map<string, string>();
  const groupOf = (n: GNodeLike) => groupOfId.get(n.id) ?? "other";
  // semantic-cluster labels (F033): node id -> friendly cluster name. Filled by
  // computeSemanticClusters() once the mutual-KNN edges (F031) are loaded.
  const clusterNameOfId = new Map<string, string>();
  let enabledWikis: AdminWikiConfig[] = [];
  let enabledWikisLoaded = false;
  let enabledWikisRequest: Promise<AdminWikiConfig[]> | null = null;
  const wikiOn: Record<string, boolean> = {};

  function wikiForId(id: string): AdminWikiConfig | null {
    const clean = id.replace(/\\/g, "/");
    return (
      enabledWikis.find((w) => {
        const path = w.path.replace(/\\/g, "/").replace(/\/+$/, "");
        return !!path && (clean === path || clean.startsWith(`${path}/`));
      }) ?? null
    );
  }

  function wikiDisplayName(
    wiki: Pick<AdminWikiConfig, "label" | "path">,
  ): string {
    return (wiki.label || wiki.path).replace(/\/wiki$/i, "");
  }

  function wikiColorKey(wiki: Pick<AdminWikiConfig, "id">): string {
    return `wiki:${wiki.id}`;
  }

  function colorGroupOf(n: GNodeLike): string {
    if (groupMode !== "wiki") return groupOf(n);
    const wiki = wikiForId(n.id);
    return wiki ? wikiColorKey(wiki) : "Unwritten";
  }

  function colorGroups(): string[] {
    return [
      ...new Set([...groups, "Unwritten", ...enabledWikis.map(wikiColorKey)]),
    ];
  }

  function layerVisible(n: GNode): boolean {
    const wiki = wikiForId(n.id);
    return wiki ? wikiOn[wiki.id] !== false : pillarOn[groupOf(n)] !== false;
  }

  function computeGroups() {
    groupOfId.clear();
    const raw = (n: GNode) =>
      n.phantom
        ? "Unwritten"
        : groupMode === "tag"
          ? (n.tags?.[0] ?? "untagged")
          : groupMode === "cluster"
            ? (clusterNameOfId.get(n.id) ?? "unclustered")
            : n.pillar;
    const rawCounts = new Map<string, number>();
    for (const n of data.nodes) {
      const g = raw(n);
      rawCounts.set(g, (rawCounts.get(g) ?? 0) + 1);
    }
    // cap the legend: keep the 18 largest groups, bucket the rest as "other"
    const keep = new Set(
      [...rawCounts.entries()]
        .filter(([g]) => g !== "Unwritten")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 18)
        .map(([g]) => g),
    );
    groupCounts = new Map();
    for (const n of data.nodes) {
      const g0 = raw(n);
      const g = g0 === "Unwritten" || keep.has(g0) ? g0 : "other";
      groupOfId.set(n.id, g);
      groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
    }
    groups = [...groupCounts.keys()].sort(
      (a, b) => groupCounts.get(b)! - groupCounts.get(a)!,
    );
  }

  // user-picked colors override theme + defaults; persisted per browser
  const customColors: Record<string, string> = prefs.getColors();
  const colorOf: Record<string, string> = {};
  function recomputeColors() {
    let fb = 0;
    for (const g of colorGroups()) {
      colorOf[g] =
        customColors[g] ??
        T().palette?.[g] ??
        PALETTE[g] ??
        FALLBACK_COLORS[fb++ % FALLBACK_COLORS.length];
    }
    colorOf.Unwritten =
      customColors.Unwritten ?? T().palette?.Unwritten ?? PALETTE.Unwritten;
  }
  computeGroups();
  recomputeColors();

  // --- adjacency for hover/focus neighborhoods ---
  const neighbors = new Map<string, Set<string>>();
  const addNb = (a: string, b: string) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    neighbors.get(a)!.add(b);
  };
  for (const l of data.links) {
    addNb(l.source as string, l.target as string);
    addNb(l.target as string, l.source as string);
  }
  const byBasename = new Map<string, GNode>();
  const byId = new Map<string, GNode>();
  for (const n of data.nodes) {
    byId.set(n.id, n);
    byBasename.set(n.title.toLowerCase(), n);
  }
  const degree = (n: GNode) => n.in + n.out;

  const initialSelectionParams = new URLSearchParams(window.location.search);
  const pendingSelect = sessionStorage.getItem("sinapso-pending-select");
  const pendingSelectNoLog =
    sessionStorage.getItem("sinapso-pending-select-nolog") === "1";
  if (pendingSelect) sessionStorage.removeItem("sinapso-pending-select");
  sessionStorage.removeItem("sinapso-pending-select-nolog");
  function hashNodeId(): string | null {
    return new URLSearchParams(window.location.hash.slice(1)).get("node");
  }
  let initialSelectionHandled = false;
  function tryHandleInitialSelection() {
    if (initialSelectionHandled) return;
    const nodeId = hashNodeId() ?? initialSelectionParams.get("node");
    if (nodeId !== null) {
      const target = byId.get(nodeId);
      if (target) select(target);
      initialSelectionHandled = true;
      return;
    }

    const focusParam = initialSelectionParams.get("focus");
    if (focusParam) {
      const target = byBasename.get(focusParam.toLowerCase());
      if (target) select(target);
      initialSelectionHandled = true;
      return;
    }

    if (pendingSelect) {
      const target = byId.get(pendingSelect);
      if (target) select(target, undefined, !pendingSelectNoLog);
      initialSelectionHandled = true;
    }
  }

  // --- view state ---
  const pillarOn: Record<string, boolean> = {};
  for (const p of data.meta.pillars) pillarOn[p] = true;
  let showPhantoms = prefs.getPhantoms(); // default off
  let showOrphans = prefs.getOrphans(); // default on
  let minWeight = 1; // hide links mentioned fewer than N times
  let hoverNode: GNode | null = null;
  let selected: GNode | null = null;
  // The left corner button pins the content panel to the left edge; unlike the
  // research-driven ctx-left, this persists after research closes.
  let readerLeftPinned = false;
  let focusSet: Set<string> | null = null; // depth-limited neighborhood of selected
  let focusDepth = prefs.getDepth();

  // --- node filters: an ordered list of show/ignore rules (topmost wins) ---
  type Filter = { mode: "show" | "ignore"; pattern: string };
  let filters: Filter[] = loadFilters();
  let liveFilter: Filter | null = null; // unpersisted preview from the input row
  let filterHidden = new Set<string>(); // node ids hidden by the active chain

  const visible = (n: GNode) =>
    layerVisible(n) &&
    (showPhantoms || !n.phantom) &&
    (showOrphans || degree(n) > 0) &&
    !filterHidden.has(n.id);

  const inFocus = (id: string) => !focusSet || focusSet.has(id);

  const endNode = (e: string | GNode): GNode =>
    typeof e === "object" ? e : byId.get(e)!;
  const linkShown = (l: GLink) =>
    l.weight >= minWeight &&
    visible(endNode(l.source)) &&
    visible(endNode(l.target));

  const bfs = (start: string, depth: number) => {
    const seen = new Set([start]);
    let frontier = [start];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of neighbors.get(id) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    return seen;
  };

  // --- graph ---
  // ---- graphics quality tiers (persisted; antialias applies on reload) ----
  // ===== GRAPHICS QUALITY TIERS =====
  // Allow users to trade visual fidelity for frame rate
  // Persisted via prefs; applied on boot and when changed
  type QKey = "low" | "medium" | "high";
  const QUALITY: Record<
    QKey,
    {
      nodeRes: number;
      pixelRatio: number;
      bloom: boolean;
      stars: boolean;
      labels: number;
      pc: number;
    }
  > = {
    low: {
      nodeRes: 6,
      pixelRatio: 1,
      bloom: false,
      stars: false,
      labels: 60,
      pc: 1024,
    },
    medium: {
      nodeRes: 9,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
      bloom: true,
      stars: true,
      labels: 140,
      pc: 4096,
    },
    high: {
      nodeRes: 18,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      bloom: true,
      stars: true,
      labels: 260,
      pc: 16384,
    },
  };
  let quality: QKey = prefs.getQuality();
  if (!QUALITY[quality]) quality = "medium";

  // ---- rendering: 3D scene setup ----
  // The library's generics sit on its interface, not the constructor signature.
  const Graph3D = ForceGraph3D as unknown as new (
    el: HTMLElement,
    config?: ConfigOptions,
  ) => ForceGraph3DInstance<GNode, GLink>;
  const graph = new Graph3D($("#graph"), {
    rendererConfig: {
      antialias: quality !== "low",
      powerPreference: "high-performance",
      preserveDrawingBuffer: true, // enables File > Export Image
    },
  })
    .graphData(data)
    .backgroundColor(T().bg)
    .showNavInfo(false)
    .nodeLabel(
      (n: GNode) =>
        `<div class="tip"><b>${n.title}</b><br>${n.pillar}${
          n.tags?.length ? " · #" + n.tags.slice(0, 3).join(" #") : ""
        } · ${degree(n)} links</div>`,
    )
    .nodeVal((n: GNode) => Math.max(1.2, Math.sqrt(degree(n)) * 1.6))
    .nodeColor((n: GNode) => nodeColor(n))
    .nodeOpacity(1)
    .nodeResolution(QUALITY[quality].nodeRes)
    // The library only renders *lit* links (selection/hover): full-featured,
    // with width and particles. The other ~20k live in one merged buffer below.
    .linkColor(() => T().linkLit)
    .linkWidth(0.45)
    .linkOpacity(0.55)
    .nodeVisibility(visible)
    .linkVisibility((l: GLink) => isLit(l) && linkShown(l))
    .warmupTicks(cachedPositions ? 0 : 120)
    .cooldownTicks(cachedPositions ? 0 : 220)
    .onNodeHover((n: GNode | null) => {
      hoverNode = n;
      // Scope the cursor to the canvas: pointer on a node, otherwise fall
      // back to the CSS grab/grabbing affordance (drag rotates the camera).
      // Setting it on <body> made the pointer stick app-wide after leaving
      // a node.
      ($("#graph") as HTMLElement).style.cursor = n ? "pointer" : "";
      repaint();
    })
    .onNodeClick((n: GNode) => select(n))
    .onBackgroundClick(() => clearSelection())
    // Registering onBackgroundClick makes 3d-force-graph treat the empty
    // background as "clickable" (pointer cursor) once showPointerCursor is
    // truthy — which, after the first node→background hover, left the canvas
    // stuck on the pointer cursor forever. Restrict the pointer to real
    // nodes/links so the background keeps its grab (open-hand) affordance.
    .showPointerCursor((o: GNode | GLink | null) => !!o);

  graph.d3Force("charge")!.strength(-45);

  // ---- rendering extras: bloom glow, starfield, particle flow ----
  // Half-resolution bloom: the blur is low-frequency anyway, half res is
  // visually identical and four times cheaper.
  // ===== RENDERING EXTRAS: BLOOM, STARFIELD, PARTICLES =====
  // Bloom glow: runs at half resolution (4x cheaper) for subtle halo effect
  // Starfield: two shells (faint background + optional dense immersive field)
  // Particles: flow along highlighted links to show reference direction
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2),
    0.35, // strength: subtle halo; higher washes out the dense core
    0.35, // radius
    0.3, // threshold
  );
  graph.postProcessingComposer().addPass(bloom);
  let glowOn = prefs.getGlow(); // default on
  bloom.enabled = QUALITY[quality].bloom;

  // Starfield shells far behind the graph: a faint base field for the dark
  // themes, plus a dense immersive field that only Cosmos switches on.
  function makeStars(
    count: number,
    rMin: number,
    rSpread: number,
    size: number,
  ): THREE.Points {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = rMin + Math.random() * rSpread;
      const thetaA = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(thetaA);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(thetaA);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xffffff,
        size,
        transparent: true,
        opacity: 0.5,
      }),
    );
    graph.scene().add(pts);
    return pts;
  }
  const stars = makeStars(2400, 2200, 1400, 2.2);
  const denseStars = makeStars(7000, 1400, 3200, 1.5);

  function syncBloom() {
    bloom.enabled = glowOn && QUALITY[quality].bloom && T().bloom;
  }

  function syncEnvironment() {
    const q = QUALITY[quality];
    const st = T().star;
    for (const field of [stars, denseStars]) {
      (field.material as THREE.PointsMaterial).color.set(st.color);
      (field.material as THREE.PointsMaterial).opacity = st.opacity;
    }
    stars.visible = q.stars && st.mode !== "off";
    denseStars.visible = q.stars && st.mode === "dense";
    syncBloom();
  }
  syncEnvironment();

  function applyQuality(k: QKey) {
    quality = k;
    prefs.setQuality(k);
    const q = QUALITY[k];
    graph.renderer().setPixelRatio(q.pixelRatio);
    maxLabels = q.labels;
    // particle count follows the tier unless the user pinned a value
    if (prefs.getPc() === null) particleCount = q.pc;
    rebuildNodes(); // geometry resolution follows the tier
    syncEnvironment();
  }

  // Scene intensity: a CSS filter on the WebGL container attenuates everything
  // the scene draws (nodes, links, stars, bloom, labels) without touching the
  // render pipeline. Dark themes fade toward black; light themes fade toward
  // the paper (lower contrast + slight brightness lift instead of darkening).
  let sceneIntensity = 100;
  function applyIntensity(v: number) {
    sceneIntensity = v;
    const el = $("#graph") as HTMLElement;
    if (v >= 100) {
      el.style.filter = "";
      return;
    }
    const t = v / 100;
    const c = new THREE.Color(T().bg);
    const light = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.5;
    // At 0 the geometry stays barely visible: dark themes sink almost to the
    // background, light themes fade the ink almost into the paper.
    el.style.filter = light
      ? `saturate(${t}) contrast(${0.15 + 0.85 * t}) brightness(${1 + 0.7 * (1 - t)})`
      : `saturate(${t}) brightness(${0.15 + 0.85 * t})`;
  }

  function applyTheme(k: string) {
    theme = THEMES[k] ? k : "midnight";
    prefs.setTheme(theme);
    document.documentElement.dataset.theme = theme; // lets CSS target a theme
    const t = T();
    for (const [prop, val] of Object.entries(t.css)) {
      document.documentElement.style.setProperty(prop, val);
    }
    graph.backgroundColor(t.bg);
    // Also set a color-managed scene.background. When bloom is on, the graph
    // renders through the post-processing composer, whose render target is
    // linear (colorSpace ""). backgroundColor() only sets the renderer's clear
    // color, which lands in that linear buffer un-linearized and then gets
    // sRGB-encoded on the final pass — brightening the backdrop to gray (harmless
    // on near-black themes, a full wash on anything lighter). A managed Color is
    // linearized into the buffer correctly, so the encode round-trips and the
    // backdrop stays put. This is what lets glow work on the dark-gray themes.
    graph.scene().background = new THREE.Color(t.bg);
    C_BASE.set(t.linkBase);
    C_LIT.set(t.linkLit);
    C_OUT.set(t.linkOut);
    recomputeColors();
    // restyle existing label chips: each setter regenerates the sprite's
    // texture, so skip when unchanged (boot would otherwise pay 1800×3 regens)
    for (const s of sprites.values()) {
      if (s.color !== t.labels.color) s.color = t.labels.color;
      if (s.backgroundColor !== t.labels.bg) s.backgroundColor = t.labels.bg;
      if (s.borderColor !== t.labels.border) s.borderColor = t.labels.border;
    }
    buildLegend();
    syncEnvironment();
    updateLinkColors();
    applyIntensity(sceneIntensity); // dark/light ramp depends on theme bg
    repaint();
  }

  // Directional particles flow along lit links (the only ones the library
  // renders) and show which way the references point.
  graph
    .linkDirectionalParticles(2)
    .linkDirectionalParticleWidth(1.4)
    .linkDirectionalParticleSpeed(0.008)
    .linkDirectionalParticleColor(() => "#9ecbff");

  graph.renderer().setPixelRatio(QUALITY[quality].pixelRatio);

  const isLit = (l: GLink) => {
    const s = (l.source as GNode).id ?? (l.source as unknown as string);
    const t = (l.target as GNode).id ?? (l.target as unknown as string);
    if (selected) return s === selected.id || t === selected.id;
    if (hoverNode) return s === hoverNode.id || t === hoverNode.id;
    return false;
  };

  function nodeColor(n: GNode): string {
    return nodeColorFor(n, colorDeps());
  }
  const colorDeps = (): NodeColorDeps => ({
    customColors,
    themePalette: T().palette,
    palette: PALETTE,
    fallbackColors: FALLBACK_COLORS,
    groups: colorGroups(),
    groupOf: colorGroupOf,
    theme: { selected: T().selected, dim: T().dim },
    selected,
    inFocus,
    hoverNode,
    neighbors,
  });

  // ---- merged link rendering: 20k links -> one draw call ----
  // Each link used to be its own three.js object (one draw call apiece), the
  // dominant cost at this scale. All non-highlighted links now share a single
  // LineSegments buffer; hidden links collapse to degenerate (invisible) segments.
  // Mutable so a rescan diff (applyGraphUpdate) can grow/shrink the buffer when
  // the link count changes — the arrays and L are reassigned by rebuildLinkBuffers.
  let L = data.links.length;
  let linePos = new Float32Array(L * 6);
  let lineCol = new Float32Array(L * 6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute("color", new THREE.BufferAttribute(lineCol, 3));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  const mergedLinks = new THREE.LineSegments(lineGeo, lineMat);
  mergedLinks.frustumCulled = false;
  graph.scene().add(mergedLinks);

  function updateLinkPositions() {
    for (let i = 0; i < L; i++) {
      const l = data.links[i];
      const o = i * 6;
      if (!linkShown(l)) {
        linePos.fill(0, o, o + 6);
        continue;
      }
      const s = endNode(l.source);
      const t = endNode(l.target);
      linePos[o] = s.x ?? 0;
      linePos[o + 1] = s.y ?? 0;
      linePos[o + 2] = s.z ?? 0;
      linePos[o + 3] = t.x ?? 0;
      linePos[o + 4] = t.y ?? 0;
      linePos[o + 5] = t.z ?? 0;
    }
    (lineGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    if (semLines) updateSemanticPositions();
  }

  const C_BASE = new THREE.Color(T().linkBase);
  const C_LIT = new THREE.Color(T().linkLit);
  const C_OUT = new THREE.Color(T().linkOut); // outside focus: nearly background
  function updateLinkColors() {
    for (let i = 0; i < L; i++) {
      const l = data.links[i];
      let c = C_BASE;
      if (isLit(l)) c = C_LIT;
      else if (
        selected &&
        !(inFocus(endNode(l.source).id) && inFocus(endNode(l.target).id))
      )
        c = C_OUT;
      const o = i * 6;
      lineCol[o] = lineCol[o + 3] = c.r;
      lineCol[o + 1] = lineCol[o + 4] = c.g;
      lineCol[o + 2] = lineCol[o + 5] = c.b;
    }
    (lineGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  // Reallocate the merged-link buffer to the current link count (after a rescan
  // diff adds/removes edges). The old typed arrays are dropped; callers must
  // follow with updateLinkPositions()/updateLinkColors() to fill the new buffer.
  function rebuildLinkBuffers() {
    L = data.links.length;
    linePos = new Float32Array(L * 6);
    lineCol = new Float32Array(L * 6);
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    lineGeo.setAttribute("color", new THREE.BufferAttribute(lineCol, 3));
  }

  // ---- arrangement modes (F032): links / hybrid / semantic ----
  // The force sim runs off graph.graphData().links; three arrangements feed it
  // three edge sets (structural links, semantic mutual-KNN edges, or both with
  // semantic dampened). Semantic edges render in a SEPARATE dashed buffer whose
  // visibility is independent of their physical pull, so hiding the lines keeps
  // the arrangement. Settled positions are cached per arrangement via
  // /api/layout?arrangement= so re-visiting one restores instead of re-simulating.
  const ARRANGEMENT_ORDER = ["links", "hybrid", "semantic"] as const;
  type Arrangement = (typeof ARRANGEMENT_ORDER)[number];
  const validArr = (v: string | null): Arrangement =>
    ARRANGEMENT_ORDER.includes(v as Arrangement) ? (v as Arrangement) : "links";
  let arrangement: Arrangement = "links"; // boot always simulates structural
  let semanticLinks: GLink[] = [];
  let semanticReady = false;
  let semLinesOn = prefs.getSemLines();
  let semGeo: THREE.BufferGeometry | null = null;
  let semPos: Float32Array | null = null;
  let semLines: THREE.LineSegments | null = null;
  const arrLayoutMem = new Map<Arrangement, Record<string, number[]>>();

  function updateSemanticPositions() {
    if (!semLines || !semPos || !semGeo) return;
    const SL = semanticLinks.length;
    for (let i = 0; i < SL; i++) {
      const l = semanticLinks[i];
      const o = i * 6;
      const s = endNode(l.source);
      const t = endNode(l.target);
      semPos[o] = s.x ?? 0;
      semPos[o + 1] = s.y ?? 0;
      semPos[o + 2] = s.z ?? 0;
      semPos[o + 3] = t.x ?? 0;
      semPos[o + 4] = t.y ?? 0;
      semPos[o + 5] = t.z ?? 0;
    }
    (semGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    semLines.computeLineDistances(); // needed for the dashed material
  }

  function updateSemanticVisibility() {
    if (semLines) semLines.visible = semLinesOn && arrangement !== "links";
  }

  function buildSemanticBuffer() {
    const SL = semanticLinks.length;
    semPos = new Float32Array(SL * 6);
    semGeo = new THREE.BufferGeometry();
    semGeo.setAttribute("position", new THREE.BufferAttribute(semPos, 3));
    semLines = new THREE.LineSegments(
      semGeo,
      new THREE.LineDashedMaterial({
        color: new THREE.Color(T().linkLit),
        transparent: true,
        opacity: 0.3,
        dashSize: 2.5,
        gapSize: 2.5,
        depthWrite: false,
      }),
    );
    semLines.frustumCulled = false;
    graph.scene().add(semLines);
    updateSemanticPositions();
    updateSemanticVisibility();
  }

  async function fetchSemantic(): Promise<boolean> {
    if (semanticReady) return true;
    try {
      const d = await api<{
        available: boolean;
        edges?: Array<{ source: string; target: string; score: number }>;
      }>("/api/semantic");
      if (!d.available) return false;
      semanticLinks = (
        d.edges as Array<{ source: string; target: string; score: number }>
      )
        .filter((e) => byId.has(e.source) && byId.has(e.target))
        .map((e) => ({
          source: e.source,
          target: e.target,
          weight: e.score,
          __sem: true,
        }));
      buildSemanticBuffer();
      semanticReady = true;
      return true;
    } catch {
      return false;
    }
  }

  // Deterministic label propagation over the mutual-KNN edges (F033): each node
  // seeds as its own label, then a FIXED node order + lexicographic tie-break
  // make the clusters stable across reloads with no randomness. The color axis
  // is orthogonal to the layout axis, so this works under any arrangement.
  // Each cluster is named by its most common tag (fallback pillar), deduped.
  function computeSemanticClusters() {
    clusterNameOfId.clear();
    for (const [id, name] of computeSemanticClustersPure(
      data.nodes,
      semanticLinks,
    ))
      clusterNameOfId.set(id, name);
  }

  async function loadArrangementLayout(
    mode: Arrangement,
  ): Promise<Record<string, number[]> | null> {
    if (arrLayoutMem.has(mode)) return arrLayoutMem.get(mode)!;
    try {
      const d = await api<{
        fingerprint: string;
        positions: Record<string, number[]>;
      }>(`/api/layout?arrangement=${mode}`);
      if (d.fingerprint !== data.meta.fingerprint) return null;
      arrLayoutMem.set(mode, d.positions);
      return d.positions;
    } catch {
      return null;
    }
  }

  const linkForce = graph.d3Force("link");

  async function applyArrangement(mode: Arrangement) {
    if (mode !== "links") {
      const ok = await fetchSemantic();
      if (!ok) {
        // semantic layer unavailable: stay on links
        arrangement = "links";
        ($("#arrange") as HTMLSelectElement).value = "links";
        prefs.setArrangement("links");
        return;
      }
    }
    arrangement = mode;
    prefs.setArrangement(mode);
    updateSemanticVisibility();

    // Active sim edge set: structural for links/hybrid, semantic for semantic/hybrid.
    const links: GLink[] = [];
    if (mode !== "semantic") for (const l of data.links) links.push(l);
    if (mode !== "links") for (const l of semanticLinks) links.push(l);

    // Per-link strength: d3's default (1/min degree) for structural, dampened
    // for semantic so links stay the skeleton and semantics only fill gaps.
    const deg = new Map<string, number>();
    const bump = (e: string | GNode) => {
      const id = typeof e === "object" ? e.id : e;
      deg.set(id, (deg.get(id) ?? 0) + 1);
    };
    for (const l of links) {
      bump(l.source);
      bump(l.target);
    }
    if (linkForce) {
      (
        linkForce as unknown as { strength(fn: (l: GLink) => number): void }
      ).strength((l: GLink) => {
        const a = endNode(l.source).id;
        const b = endNode(l.target).id;
        const base =
          1 / Math.max(1, Math.min(deg.get(a) ?? 1, deg.get(b) ?? 1));
        return l.__sem ? base * 0.4 : base;
      });
    }

    // Reuse cached positions if we have them; otherwise settle once.
    const cached = await loadArrangementLayout(mode);
    if (cached) {
      for (const n of data.nodes) {
        const p = cached[n.id];
        if (p) {
          n.x = p[0];
          n.y = p[1];
          n.z = p[2];
        }
      }
      // Restore the settled equilibrium EXACTLY. graph.graphData() reheats the
      // sim (alpha=1); with a short cooldown the charge force puffs the layout
      // out before it can re-settle. cooldownTicks(0) runs no ticks, so the
      // cached positions stay put — and we leave layoutSaved alone so
      // onEngineStop can't overwrite the good cache with a perturbed one.
      graph.warmupTicks(0).cooldownTicks(0);
      graph.graphData({ nodes: data.nodes, links });
      // No engine tick fires at cooldown 0: sync the link buffers by hand.
      requestAnimationFrame(() => updateLinkPositions());
    } else {
      graph.warmupTicks(60).cooldownTicks(220);
      layoutSaved = false; // a fresh settle: persist it
      graph.graphData({ nodes: data.nodes, links });
    }
  }

  graph.onEngineTick(updateLinkPositions);
  // capture/debug hook: scripts/capture.ts frames the camera through this,
  // and waits on `settled` before shooting a freshly-simulated vault.
  const dbg = { graph, settled: false };
  (window as unknown as { __sinapso: typeof dbg }).__sinapso = dbg;

  graph.onEngineStop(() => {
    updateLinkPositions();
    saveLayout();
    dbg.settled = true;
    hideLoading(); // constellation has settled
    tryHandleInitialSelection();
  });
  graph.onNodeDrag(() => updateLinkPositions());
  // Cached-layout boots never tick the engine; draw the buffer directly.
  setTimeout(() => {
    updateLinkPositions();
    updateLinkColors();
    applyNodeColors();
    if (cachedPositions) {
      hideLoading(); // instant load: nothing to settle
      tryHandleInitialSelection();
    }
  }, 0);
  // Safety net: never leave the loader or initial selection waiting forever.
  window.setTimeout(() => {
    hideLoading();
    tryHandleInitialSelection();
  }, 12000);

  // Persist the settled layout so the next load skips the physics warm-up.
  let layoutSaved = !!cachedPositions;
  function saveLayout() {
    if (layoutSaved) return;
    layoutSaved = true;
    const positions: Record<string, number[]> = {};
    for (const n of data.nodes) {
      positions[n.id] = [
        Math.round((n.x ?? 0) * 10) / 10,
        Math.round((n.y ?? 0) * 10) / 10,
        Math.round((n.z ?? 0) * 10) / 10,
      ];
    }
    arrLayoutMem.set(arrangement, positions);
    api("/api/layout", {
      json: {
        arrangement,
        fingerprint: data.meta.fingerprint,
        positions,
      },
    }).catch(() => {});
  }

  function repaint() {
    applyNodeColors(); // custom node objects: colors applied directly
    graph.linkVisibility(graph.linkVisibility()); // lit set changed
    updateLinkColors();
  }

  function refreshVisibility() {
    graph.nodeVisibility(graph.nodeVisibility());
    graph.linkVisibility(graph.linkVisibility());
    updateLinkPositions();
    updateLinkColors();
  }

  // ---- node filters ----
  function loadFilters(): Filter[] {
    return prefs.getFilters();
  }
  function saveFilters() {
    prefs.setFilters(filters);
  }

  // A node's searchable text: title, group (pillar/tag), and its #tags.
  // needle's chars appear in order within hay (loose fuzzy match).
  // Compile a pattern to a node predicate: wildcards (*, ?) glob-match a field
  // end to end (macro* = starts with macro); plain text is substring-or-fuzzy.
  // All three are imported from ./filters.

  // The active chain = persisted filters, plus the live input as a low-priority
  // preview at the end so typing shows its effect before you commit it.
  function activeChain(): Filter[] {
    return liveFilter && liveFilter.pattern.trim()
      ? [...filters, liveFilter]
      : filters;
  }
  // Recompute which nodes the chain hides, then refresh the scene. First rule to
  // match a node decides it (show -> keep, ignore -> hide). A node matched by no
  // rule is hidden when any show rule exists (show acts as a whitelist).
  function applyFilters() {
    const chain = activeChain();
    filterHidden = new Set<string>();
    if (chain.length) {
      const hasShow = chain.some((f) => f.mode === "show");
      const rules = chain.map((f) => ({
        keep: f.mode === "show",
        test: compileMatcher(f.pattern, groupOf),
      }));
      for (const n of data.nodes) {
        let keep = !hasShow;
        for (const r of rules) {
          if (r.test(n)) {
            keep = r.keep;
            break;
          }
        }
        if (!keep) filterHidden.add(n.id);
      }
    }
    refreshVisibility();
    repaint();
  }

  // ---- persistent node labels (Obsidian-style) ----
  // Every node carries a text sprite; a per-frame loop fades each label by
  // its distance to the camera, so names appear as you approach, matching
  // Obsidian's behavior in 3D. Selection/hover force labels on.
  let labelsOn = prefs.getLabels(); // default on
  let labelDist = 700; // world units at which a label has fully faded out
  let labelSize = 4;
  const sprites = new Map<string, SpriteText>();

  // SpriteText is a THREE.Sprite at runtime; its d.ts doesn't expose that.
  type SpriteRT = {
    visible: boolean;
    renderOrder: number;
    material: {
      transparent: boolean;
      opacity: number;
      depthWrite: boolean;
      depthTest: boolean;
    };
    position: { set(x: number, y: number, z: number): void };
    center: { set(x: number, y: number): void };
  };

  function spriteFor(n: GNode): SpriteText {
    let sprite = sprites.get(n.id);
    if (!sprite) {
      sprite = new SpriteText(n.title);
      sprite.color = T().labels.color;
      sprite.textHeight = labelSize;
      // contrast chip: subtle plate + hairline border against the background
      sprite.backgroundColor = T().labels.bg;
      sprite.padding = 1.6;
      sprite.borderColor = T().labels.border;
      sprite.borderWidth = 0.3;
      sprite.borderRadius = 2;
      const rt = sprite as unknown as SpriteRT;
      rt.material.transparent = true;
      rt.material.depthWrite = false;
      rt.material.depthTest = false; // never occluded by the node's own sphere
      rt.renderOrder = 2;
      // anchor at the node center, hang below it in *screen space*: the label
      // tracks the camera from any angle instead of living at a world offset
      rt.position.set(0, 0, 0);
      rt.center.set(0.5, 1.35);
      sprites.set(n.id, sprite);
    }
    return sprite;
  }

  // ---- node styles: classic / dodecahedron / starlight ----
  // Custom per-node objects replace the library's default spheres so the
  // style can change geometry, material, and glow. The label sprite rides
  // along inside each node's group.
  type NodeStyle = "classic" | "dodecahedron" | "starlight" | "particles";
  let nodeStyle = (new URLSearchParams(window.location.search).get("nodes") ||
    prefs.getNodeStyle() ||
    "classic") as NodeStyle;
  if ((nodeStyle as string) === "crystal") nodeStyle = "dodecahedron"; // pre-rename saved setting
  if (
    !["classic", "dodecahedron", "starlight", "particles"].includes(nodeStyle)
  )
    nodeStyle = "classic";

  let sizeFactor = 4; // node-size slider (matches the lib's default nodeRelSize)

  // ---- weighted node sizing: incoming links, outgoing links, words ----
  // Each factor is log-normalized against the vault max (counts are heavy-
  // tailed; raw scaling would make a few hubs flatten everything else),
  // then blended by user-adjustable weights.
  const sizeWeights = prefs.getSizeWeights();
  let maxLogIn = 1;
  let maxLogOut = 1;
  let maxLogWords = 1;
  function computeSizeNorms() {
    maxLogIn = maxLogOut = maxLogWords = 1;
    for (const n of data.nodes) {
      maxLogIn = Math.max(maxLogIn, Math.log1p(n.in));
      maxLogOut = Math.max(maxLogOut, Math.log1p(n.out));
      maxLogWords = Math.max(maxLogWords, Math.log1p(n.words));
    }
  }
  computeSizeNorms();

  const radiusOf = (n: GNode) => {
    const wSum = sizeWeights.in + sizeWeights.out + sizeWeights.words || 1;
    const score =
      (sizeWeights.in * (Math.log1p(n.in) / maxLogIn) +
        sizeWeights.out * (Math.log1p(n.out) / maxLogOut) +
        sizeWeights.words * (Math.log1p(n.words) / maxLogWords)) /
      wSum;
    // power curve (same normalization idea as the particle energy scaling):
    // contrast 1 = linear; higher pushes mid-scored notes down so hubs pop
    return (0.5 + 4.0 * Math.pow(score, sizeWeights.contrast)) * sizeFactor;
  };

  // rescale every existing node object (slider / weight changes)
  function rescaleNodes() {
    for (const [id, mesh] of meshOf) {
      const n = byId.get(id);
      if (!n) continue;
      const r = radiusOf(n);
      mesh.scale.setScalar(
        nodeStyle === "starlight"
          ? r * 0.65
          : nodeStyle === "particles"
            ? r * 1.25
            : r,
      );
      if (nodeStyle === "particles") {
        (mesh.material as THREE.PointsMaterial).size = r * 0.22 * pcSizeNorm();
        const pair = spinOf.get(id);
        if (pair) {
          pair.core.scale.setScalar(r * 1.25);
          (pair.core.material as THREE.PointsMaterial).size =
            r * 0.34 * pcSizeNorm();
        }
      }
      glowOf.get(id)?.scale.setScalar(r * 3);
    }
  }

  // shared geometries (unit-sized; scaled per node)
  const sphereGeo = () =>
    new THREE.SphereGeometry(
      1,
      QUALITY[quality].nodeRes,
      Math.max(4, QUALITY[quality].nodeRes / 2),
    );
  // detail stays 0 at every tier; subdividing would round away the 12 pentagonal faces
  const dodecaGeo = () => new THREE.DodecahedronGeometry(1, 0);

  // ---- particle clouds: volumetric, glowing, gravitationally swirling ----
  // Two shared geometries per count: a dense CORE (gravity well; density
  // rises toward the center) and an outer HALO. Each node instances both and
  // they counter-rotate at different speeds, reading as orbital motion.
  // "auto" follows the graphics tier (measured: vertex count is cheap; a modern
  // discrete GPU holds ~55fps from 256 to 16,384/node; the cost lives in
  // draw calls + close-range fill rate, so tiers map to GPU class).
  const pcExplicit =
    new URLSearchParams(window.location.search).get("pc") || prefs.getPc();
  const tierPc = () => QUALITY[quality].pc;
  let particleCount =
    pcExplicit && pcExplicit !== "auto" ? Number(pcExplicit) : tierPc();
  // ?pc= accepts any value for benchmarking/power users (clamped to keep the tab alive)
  particleCount = Math.max(16, Math.min(32768, particleCount || tierPc()));

  const particleCloud = (
    count: number,
    rPow: number,
    rMin: number,
    rMax: number,
  ) => {
    const pos = new Float32Array(count * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / Math.max(1, count - 1)) * 2;
      const rXZ = Math.sqrt(1 - y * y);
      const a = golden * i + Math.random() * 0.35;
      // radius ~ u^rPow: small exponents pull density toward the center
      const r = rMin + (rMax - rMin) * Math.pow(Math.random(), rPow);
      pos[i * 3] = Math.cos(a) * rXZ * r;
      pos[i * 3 + 1] = y * r * 0.75; // slight flattening for a disc-like swirl
      pos[i * 3 + 2] = Math.sin(a) * rXZ * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return geo;
  };
  let coreGeo = particleCloud(
    Math.round(particleCount * 0.45),
    1.8,
    0.05,
    0.55,
  );
  let haloGeo = particleCloud(Math.round(particleCount * 0.55), 0.6, 0.35, 1.0);
  const spinOf = new Map<string, { core: THREE.Points; halo: THREE.Points }>();

  // Energy conservation across particle counts: total emitted light scales
  // with count × size² × opacity, so higher counts get finer, fainter motes
  // (size ∝ f^-0.25, opacity ∝ f^-0.5): same overall glow, more depth.
  const pcF = () => particleCount / 256;
  const pcSizeNorm = () => Math.pow(pcF(), -0.25);
  const pcOpacityNorm = () => Math.pow(pcF(), -0.5);

  // soft radial glow texture for starlight halos
  const glowTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    // gentle falloff: thousands of these overlap additively at distance,
    // so the per-halo energy must stay low or the field blows out white
    grad.addColorStop(0, "rgba(255,255,255,0.5)");
    grad.addColorStop(0.3, "rgba(255,255,255,0.14)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();

  const meshOf = new Map<string, THREE.Mesh | THREE.Points>();
  const glowOf = new Map<string, THREE.Sprite>();
  let geoShared: THREE.BufferGeometry =
    nodeStyle === "dodecahedron" ? dodecaGeo() : sphereGeo();

  graph.nodeThreeObjectExtend(false).nodeThreeObject((n: GNode) => {
    const group = new THREE.Group();
    const r = radiusOf(n);
    let mesh: THREE.Mesh | THREE.Points;
    if (nodeStyle === "particles") {
      // glowing volumetric cloud: bright core + counter-rotating halo
      const glowMat = (size: number, opacity: number) =>
        new THREE.PointsMaterial({
          map: glowTex,
          size,
          transparent: true,
          opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        });
      const core = new THREE.Points(
        coreGeo,
        glowMat(r * 0.34 * pcSizeNorm(), 0.85 * pcOpacityNorm()),
      );
      const halo = new THREE.Points(
        haloGeo,
        glowMat(r * 0.22 * pcSizeNorm(), 0.5 * pcOpacityNorm()),
      );
      core.scale.setScalar(r * 1.25);
      halo.scale.setScalar(r * 1.25);
      // per-node phase + tilt so the field doesn't spin in lockstep
      const seed = (n.id.charCodeAt(0) * 31 + n.id.length * 7) % 100;
      core.rotation.set(0.3, (seed / 100) * Math.PI * 2, 0);
      halo.rotation.set(-0.2, ((seed + 37) / 100) * Math.PI * 2, 0);
      group.add(core);
      group.add(halo);
      spinOf.set(n.id, { core, halo });
      mesh = halo; // color/recolor path tracks the halo; core handled via spinOf
    } else if (nodeStyle === "dodecahedron") {
      mesh = new THREE.Mesh(
        geoShared,
        new THREE.MeshStandardMaterial({
          flatShading: true,
          metalness: 0.25,
          roughness: 0.4,
        }),
      );
      mesh.scale.setScalar(r);
    } else if (nodeStyle === "starlight") {
      mesh = new THREE.Mesh(geoShared, new THREE.MeshBasicMaterial()); // self-lit core
      mesh.scale.setScalar(r * 0.65);
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      glow.scale.setScalar(r * 3);
      group.add(glow);
      glowOf.set(n.id, glow);
    } else {
      mesh = new THREE.Mesh(geoShared, new THREE.MeshLambertMaterial());
      mesh.scale.setScalar(r);
    }
    meshOf.set(n.id, mesh);
    if (!mesh.parent) group.add(mesh); // particles already added their pair
    group.add(spriteFor(n) as unknown as THREE.Object3D);
    return group as never;
  });

  // rgba()/hex -> color + alpha (dim states use rgba strings)
  const RGBA_RE =
    /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/;
  const WHITE = new THREE.Color(1, 1, 1);
  const parseColor = (s: string): { color: THREE.Color; opacity: number } => {
    const m = s.match(RGBA_RE);
    if (m) {
      return {
        color: new THREE.Color(+m[1] / 255, +m[2] / 255, +m[3] / 255),
        opacity: m[4] !== undefined ? +m[4] : 1,
      };
    }
    return { color: new THREE.Color(s), opacity: 1 };
  };

  function applyNodeColors() {
    for (const n of data.nodes) {
      const mesh = meshOf.get(n.id);
      if (!mesh) continue;
      const { color, opacity } = parseColor(nodeColor(n));
      // Lambert/Basic/Points materials all share color/transparent/opacity
      const mat = mesh.material as THREE.MeshLambertMaterial;
      mat.color.copy(color);
      if (nodeStyle === "particles") {
        mat.opacity = 0.5 * pcOpacityNorm() * opacity;
        const pair = spinOf.get(n.id);
        if (pair) {
          // gravity-well core: white-hot center in the group's hue
          const coreMat = pair.core.material as THREE.PointsMaterial;
          coreMat.color.copy(color).lerp(WHITE, 0.45);
          coreMat.opacity = 0.85 * pcOpacityNorm() * opacity;
        }
      } else {
        mat.transparent = opacity < 1;
        mat.opacity = opacity;
      }
      const glow = glowOf.get(n.id);
      if (glow) {
        glow.material.color.copy(color);
        glow.material.opacity = 0.2 + 0.55 * opacity;
        glow.visible = opacity > 0.5; // dimmed stars lose their halo
      }
    }
  }

  function rebuildNodes() {
    // three.js frees GPU buffers only on dispose(); without it,
    // every style/quality/count switch strands the old geometries and ~1.8k
    // per-node materials in VRAM. (glowTex is shared and deliberately kept.)
    for (const mesh of meshOf.values())
      (mesh.material as THREE.Material).dispose();
    for (const { core } of spinOf.values())
      (core.material as THREE.Material).dispose();
    for (const glow of glowOf.values()) glow.material.dispose();
    geoShared.dispose();
    coreGeo.dispose();
    haloGeo.dispose();

    meshOf.clear();
    glowOf.clear();
    spinOf.clear();
    geoShared = nodeStyle === "dodecahedron" ? dodecaGeo() : sphereGeo();
    coreGeo = particleCloud(Math.round(particleCount * 0.45), 1.8, 0.05, 0.55);
    haloGeo = particleCloud(Math.round(particleCount * 0.55), 0.6, 0.35, 1.0);
    graph.nodeThreeObject(graph.nodeThreeObject()); // force object re-creation
    coloredCount = -1; // the fade loop recolors as the set repopulates
    applyNodeColors();
  }

  // ---- dynamic key light: front-view shading that follows the camera,
  // and radiates from the selected node when one is chosen ----
  const keyLight = new THREE.PointLight(0xffffff, 1.1);
  keyLight.decay = 0; // constant illumination across the graph's scale
  graph.scene().add(keyLight);

  // Label budget: at most this many ambient labels draw at once (the nearest
  // win). Selection/hover labels are always shown on top of the budget.
  let maxLabels = QUALITY[quality].labels;
  const cam = graph.camera();
  let labelFrame = 0;
  // ---- FPS instrumentation (?fps=1 overlay; ?fpsreport=1 posts to server) ----
  const qp = new URLSearchParams(window.location.search);
  let fpsDiv: HTMLElement | null = null;
  if (qp.get("fps")) {
    fpsDiv = document.createElement("div");
    fpsDiv.style.cssText =
      "position:fixed;top:54px;right:16px;z-index:99;font:600 16px Consolas,monospace;" +
      "color:#7ee787;background:rgba(0,0,0,0.6);padding:4px 10px;border-radius:6px";
    document.body.appendChild(fpsDiv);
  }
  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  const fpsReport = !!qp.get("fpsreport");
  const reportSamples: number[] = [];
  const reportStart = performance.now();
  let reported = false;

  let coloredCount = -1;
  function fadeLabels() {
    requestAnimationFrame(fadeLabels);

    // fps accounting (1s windows)
    fpsFrames++;
    const nowMs = performance.now();
    if (nowMs - fpsWindowStart >= 1000) {
      const fps = (fpsFrames * 1000) / (nowMs - fpsWindowStart);
      fpsFrames = 0;
      fpsWindowStart = nowMs;
      if (fpsDiv) fpsDiv.textContent = `${fps.toFixed(0)} fps`;
      if (fpsReport && nowMs - reportStart > 4000) reportSamples.push(fps); // skip warm-up
      if (fpsReport && !reported && reportSamples.length >= 6) {
        reported = true;
        const avg =
          reportSamples.reduce((a, b) => a + b, 0) / reportSamples.length;
        api("/api/fpslog", {
          json: {
            fps: Math.round(avg * 10) / 10,
            nodes: nodeStyle,
            pc: particleCount,
            quality,
          },
        }).catch(() => {});
      }
    }

    // gravity swirl: counter-rotating core/halo, Keplerian feel (core faster)
    if (nodeStyle === "particles") {
      for (const { core, halo } of spinOf.values()) {
        core.rotation.y += 0.012;
        halo.rotation.y -= 0.004;
      }
    }
    // dynamic key light: front-view shading from the camera, or radiating
    // outward from the selected node (every frame, so the light stays smooth)
    if (selected) {
      keyLight.position.set(selected.x ?? 0, selected.y ?? 0, selected.z ?? 0);
      keyLight.intensity = 2.4;
    } else {
      keyLight.position.copy(cam.position);
      keyLight.intensity = 1.1;
    }
    if (labelFrame++ % 2 !== 0) return; // 30Hz is plenty for opacity fades
    // node objects are created asynchronously by the library (and hidden
    // phantoms may never be); recolor whenever the created set grows
    if (meshOf.size !== coloredCount) {
      coloredCount = meshOf.size;
      applyNodeColors();
    }
    const candidates: Array<{ rt: SpriteRT; o: number }> = [];
    for (const [id, sprite] of sprites) {
      const n = byId.get(id);
      if (!n) continue;
      const rt = sprite as unknown as SpriteRT;
      const dx = (n.x ?? 0) - cam.position.x;
      const dy = (n.y ?? 0) - cam.position.y;
      const dz = (n.z ?? 0) - cam.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let o = labelsOn ? Math.max(0, 1 - dist / labelDist) : 0;
      let forced = false;
      if (selected) {
        if (id === selected.id) {
          o = 1;
          forced = true;
        } else if (neighbors.get(selected.id)?.has(id)) {
          o = Math.max(o, 0.95);
          forced = true;
        } else if (!inFocus(id)) o = 0;
      } else if (hoverNode) {
        if (id === hoverNode.id) {
          o = 1;
          forced = true;
        } else if (neighbors.get(hoverNode.id)?.has(id)) {
          o = Math.max(o, 0.85);
          forced = true;
        }
      }
      if (forced) {
        rt.visible = true;
        rt.material.opacity = o;
      } else if (o > 0.04) {
        rt.visible = false; // provisional; winners flip back on below
        candidates.push({ rt, o });
      } else {
        rt.visible = false;
      }
    }
    candidates.sort((a, b) => b.o - a.o);
    const n = Math.min(candidates.length, maxLabels);
    for (let i = 0; i < n; i++) {
      candidates[i].rt.visible = true;
      candidates[i].rt.material.opacity = candidates[i].o;
    }
  }
  requestAnimationFrame(fadeLabels);

  function flyTo(n: GNode, ms = 1200) {
    const d = 130;
    const len = Math.hypot(n.x ?? 1, n.y ?? 1, n.z ?? 1) || 1;
    const k = 1 + d / len;
    graph.cameraPosition(
      { x: (n.x ?? 0) * k, y: (n.y ?? 0) * k, z: (n.z ?? 0) * k },
      { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 },
      ms,
    );
  }

  function nodeUrl(n: GNode) {
    const url = new URL(window.location.href);
    url.searchParams.delete("node");
    url.searchParams.delete("focus");
    const hash = new URLSearchParams(url.hash.slice(1));
    hash.set("node", n.id);
    url.hash = hash.toString();
    return url;
  }

  function syncNodeUrl(n: GNode) {
    const url = nodeUrl(n);
    window.history.replaceState(null, "", url);
  }

  function select(n: GNode, highlightSnippet?: string, logReader = true) {
    selected = n;
    focusSet = bfs(n.id, focusDepth);
    syncNodeUrl(n);
    flyTo(n);
    repaint();
    openReader(n, !logReader, highlightSnippet);
  }

  function clearSelection() {
    selected = null;
    focusSet = null;
    repaint();
    destroyNoteEditor();
    $("#reader").classList.add("hidden");
    readerLeftPinned = false; // closing the panel drops the left pin
    openNoteWords = null;
    clearSelectionContext("reader");
    updateBrandStats();
    syncVoiceContext();
  }

  // The one live editor instance for the open note (plan 018 U2). Destroyed
  // on note switch and reader close; serialization only ever reads from it,
  // so footer widgets appended to #reader-body can never leak into a save.
  let noteEditor: NoteEditor | null = null;
  let noteAutosave: Autosave | null = null;
  let editorNoteId: string | null = null;
  // Hex hash of the current autosave base, kept warm so the beforeunload
  // keepalive PUT can carry the staleness guard without an async hash.
  let editorBaseHashHex: string | null = null;

  async function sha256Hex(text: string): Promise<string> {
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text),
    );
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function activeVaultPath(): string {
    return data.meta.vaultPath ?? "";
  }

  /** PUT through the guarded write path. `base` = the content whose hash the
   * server must still see on disk (KTD5 CAS); null = forced overwrite. */
  async function saveNote(
    noteId: string,
    content: string,
    base: string | null,
  ): Promise<"saved" | "conflict"> {
    try {
      const json: Record<string, string> = { id: noteId, content };
      if (base !== null) json.baseHash = await sha256Hex(base);
      await api("/api/notes", { method: "PUT", json });
      void sha256Hex(content).then((h) => (editorBaseHashHex = h));
      const m = prefs.getEditorMirror();
      if (m && m.noteId === noteId && m.vault === activeVaultPath())
        prefs.clearEditorMirror();
      return "saved";
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return "conflict";
      throw e;
    }
  }

  function renderSaveState(state: AutosaveState) {
    const el = $("#reader-save-state");
    el.classList.remove("hidden");
    el.className = `save-${state}`;
    if (state === "clean") {
      el.textContent = i18n.t("editor.saveState.saved");
      el.title = i18n.t("editor.saveState.saved");
    } else if (state === "conflict") {
      el.textContent = "";
      showConflictBanner();
    } else {
      el.textContent = i18n.t(`editor.saveState.${state}`);
      el.title = el.textContent;
    }
  }

  function hideReaderBanner() {
    $("#reader-banner").classList.add("hidden");
  }

  function readerBanner(
    text: string,
    primary: { label: string; run: () => void },
    secondary: { label: string; run: () => void },
  ) {
    $("#reader-banner-text").textContent = text;
    const p = $("#reader-banner-primary") as HTMLButtonElement;
    const s = $("#reader-banner-secondary") as HTMLButtonElement;
    p.textContent = primary.label;
    s.textContent = secondary.label;
    p.onclick = () => {
      hideReaderBanner();
      primary.run();
    };
    s.onclick = () => {
      hideReaderBanner();
      secondary.run();
    };
    $("#reader-banner").classList.remove("hidden");
  }

  // R8: non-blocking conflict banner — the editor stays live underneath.
  function showConflictBanner() {
    readerBanner(
      i18n.t("editor.conflict.message"),
      {
        label: i18n.t("editor.conflict.reload"),
        run: () => void reloadNoteFromDisk(),
      },
      {
        label: i18n.t("editor.conflict.overwrite"),
        run: () => void noteAutosave?.overwrite(),
      },
    );
  }

  async function reloadNoteFromDisk() {
    if (!editorNoteId || !noteEditor || !noteAutosave) return;
    try {
      const { markdown } = await api<{ markdown: string }>(
        `/api/note?id=${encodeURIComponent(editorNoteId)}&nolog=1`,
      );
      noteEditor.setContent(markdown);
      noteAutosave.reset(markdown);
      editorBaseHashHex = null;
      void sha256Hex(markdown).then((h) => (editorBaseHashHex = h));
    } catch {
      /* note gone or unreachable; editor keeps local content, stays dirty */
    }
  }

  /** Flush-then-teardown for note switch / reader close (KTD4/KTD4b): if a
   * save is mid-flight the tail content goes to the vault-scoped mirror; a
   * conflict left unresolved also lands in the mirror, never on disk. */
  function destroyNoteEditor() {
    if (noteEditor && noteAutosave && editorNoteId) {
      const content = noteEditor.getContent();
      const state = noteAutosave.state();
      if (content !== noteAutosave.base()) {
        const noteId = editorNoteId;
        if (state === "saving" || state === "conflict") {
          prefs.setEditorMirror({
            vault: activeVaultPath(),
            noteId,
            content,
            at: Date.now(),
          });
        } else {
          const base = noteAutosave.base();
          void saveNote(noteId, content, base).then(
            (r) => {
              if (r === "conflict")
                prefs.setEditorMirror({
                  vault: activeVaultPath(),
                  noteId,
                  content,
                  at: Date.now(),
                });
            },
            () =>
              prefs.setEditorMirror({
                vault: activeVaultPath(),
                noteId,
                content,
                at: Date.now(),
              }),
          );
        }
      }
    }
    noteAutosave?.dispose();
    noteAutosave = null;
    noteEditor?.destroy();
    noteEditor = null;
    editorNoteId = null;
    hideAssistPreview();
    hideReaderBanner();
    const stateEl = $("#reader-save-state");
    stateEl.className = "hidden";
    stateEl.textContent = "";
  }

  function navigateWikiTarget(target: string) {
    const t = target.toLowerCase();
    const node =
      byBasename.get(t.split("/").pop()!) ?? byId.get(`phantom:${t}`);
    if (node) select(node);
  }

  // ---- AI selection assist (plan 018 U7): thinker-tier instruction over
  // the selection; the reply previews in a panel and only ever lands in the
  // editor buffer (autosave persists it like any other edit).
  let pendingAssist: {
    req: AssistRequest;
    noteId: string;
    text: string;
  } | null = null;

  function llmConfigured(): boolean {
    return !!(
      integrations?.tools.openrouter.configured ||
      integrations?.tools.deepseek.configured
    );
  }

  function hideAssistPreview() {
    pendingAssist = null;
    $("#reader-ai-preview").classList.add("hidden");
    $("#reader-ai-preview-note").textContent = "";
  }

  function showAssistPreview(req: AssistRequest, text: string) {
    if (!openNodeId) return;
    pendingAssist = { req, noteId: openNodeId, text };
    $("#reader-ai-preview-text").textContent = text;
    $("#reader-ai-preview-note").textContent = "";
    $("#reader-ai-preview").classList.remove("hidden");
  }

  async function submitAssist(input: HTMLInputElement, icon: HTMLElement) {
    const node = openNodeId ? byId.get(openNodeId) : null;
    const view = noteEditor?.view;
    if (!node || !view) return;
    const req = buildAssistRequest(view.state, input.value, {
      id: node.id,
      title: node.title,
    });
    if (!req) return;
    icon.classList.add("busy");
    input.disabled = true;
    try {
      const { text } = await api<{ text: string }>("/api/selection-assist", {
        json: {
          instruction: req.instruction,
          selection: req.selection,
          surrounding: req.surrounding,
          noteId: req.noteId,
          noteTitle: req.noteTitle,
        },
      });
      showAssistPreview(req, text);
      input.value = "";
    } catch {
      $("#reader-ai-preview-text").textContent = i18n.t("editor.ai.error");
      $("#reader-ai-preview-note").textContent = "";
      pendingAssist = null;
      $("#reader-ai-preview").classList.remove("hidden");
    } finally {
      icon.classList.remove("busy");
      input.disabled = false;
    }
  }

  const aiToolbarExtras: ToolbarExtras = (dom) => {
    if (!llmConfigured()) return;
    const wrap = document.createElement("span");
    wrap.className = "cm-tb-ai";
    const icon = document.createElement("span");
    icon.className = "cm-tb-ai-icon";
    icon.innerHTML = BOT_ICON_SVG; // static lucide markup, never user content
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cm-tb-ai-input";
    input.placeholder = i18n.t("editor.ai.placeholder");
    // The input needs real focus (unlike the buttons, which preventDefault
    // to keep the selection); CM keeps the selection in state either way.
    input.onmousedown = (e) => e.stopPropagation();
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        void submitAssist(input, icon);
      } else if (e.key === "Escape") {
        noteEditor?.view.focus();
      }
    };
    wrap.append(icon, input);
    dom.appendChild(wrap);
  };

  {
    const apply = (mode: "replace" | "insert") => {
      const view = noteEditor?.view;
      if (!pendingAssist || !view || pendingAssist.noteId !== openNodeId)
        return hideAssistPreview();
      const { req, text } = pendingAssist;
      if (mode === "replace") {
        const spec = replaceSelection(view.state, req, text);
        if (!spec) {
          // Doc changed under the request: replacing would corrupt — offer
          // the insert path instead of guessing.
          $("#reader-ai-preview-note").textContent = i18n.t("editor.ai.stale");
          return;
        }
        view.dispatch(spec);
      } else {
        view.dispatch(insertBelow(view.state, req, text));
      }
      view.focus();
      hideAssistPreview();
    };
    $("#reader-ai-replace").addEventListener("click", () => apply("replace"));
    $("#reader-ai-insert").addEventListener("click", () => apply("insert"));
    $("#reader-ai-dismiss").addEventListener("click", hideAssistPreview);
  }

  // --- reader panel ---
  // F035: find a matched passage (from a semantic snippet) in the rendered note
  // and wrap it in a <mark> + scroll to it. Works over the already-sanitized DOM
  // via Range surgery (no innerHTML), so the DOMPurify guarantee is untouched.
  // Whitespace is normalized both sides; shorter needles are tried when the full
  // snippet spans element boundaries (surroundContents throws on partial nodes).
  function highlightPassage(container: HTMLElement, snippet: string): boolean {
    // Normalize to lowercase alphanumerics + single spaces on BOTH sides, so
    // markdown markers in the raw snippet (`_italics_`, `code`, punctuation)
    // that vanish once rendered don't defeat the match.
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    // Build the normalized note text with a per-kept-char origin map.
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let hay = "";
    const origin: Array<{ node: Text; offset: number }> = [];
    let lastSpace = true;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      for (let i = 0; i < t.data.length; i++) {
        const ch = t.data[i];
        if (/[a-z0-9]/i.test(ch)) {
          hay += ch.toLowerCase();
          origin.push({ node: t, offset: i });
          lastSpace = false;
        } else if (/\s/.test(ch)) {
          if (!lastSpace) {
            hay += " ";
            origin.push({ node: t, offset: i });
            lastSpace = true;
          }
        } // other chars (punctuation / markdown markers) are dropped
      }
    }
    const full = norm(snippet);
    for (const needle of [full, full.slice(0, 90), full.slice(0, 45)]) {
      if (needle.length < 12) continue;
      const idx = hay.indexOf(needle);
      if (idx < 0) continue;
      const start = origin[idx];
      const end = origin[Math.min(idx + needle.length - 1, origin.length - 1)];
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      const scrollTarget = start.node.parentElement ?? container;
      // Prefer the CSS Custom Highlight API: it paints a multi-node range with
      // no DOM surgery (surroundContents throws when a passage crosses element
      // boundaries like <em>/<code>), so the sanitized DOM is left untouched.
      const hl = (
        window as unknown as {
          Highlight?: new (r: Range) => unknown;
          CSS?: { highlights?: Map<string, unknown> };
        }
      ).Highlight;
      const store = (
        window as unknown as { CSS?: { highlights?: Map<string, unknown> } }
      ).CSS?.highlights;
      if (hl && store) {
        store.set("passage", new hl(range));
        scrollTarget.scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      }
      // Fallback: wrap when the range stays inside one element.
      try {
        const mark = document.createElement("mark");
        mark.className = "passage-hl";
        range.surroundContents(mark);
        mark.scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      } catch {
        // crossed element boundaries and no Highlight API: try a shorter needle
      }
    }
    return false;
  }

  async function openReader(
    n: GNode,
    fromHistory = false,
    highlightSnippet?: string,
  ) {
    const reader = $("#reader");
    const nextOpenNodeId = n.phantom ? null : n.id;
    if (openNodeId !== nextOpenNodeId) clearSelectionContext("reader");
    $("#reader-path").textContent = n.phantom
      ? i18n.t("reader.unwritten")
      : n.id;
    reader.classList.remove("hidden");
    // Drop any previous passage highlight (its Range points at the old note).
    (
      window as unknown as { CSS?: { highlights?: Map<string, unknown> } }
    ).CSS?.highlights?.delete("passage");
    // Reset version UI for the new note.
    const topWikiAction = $("#reader-wiki-top");
    topWikiAction.innerHTML = "";
    topWikiAction.classList.add("hidden");
    $("#reader-find").classList.remove("versions-expanded");
    ($("#reader-versions") as HTMLSelectElement).innerHTML = "";
    $("#reader-version-restore").classList.add("hidden");
    $("#reader-version-status").classList.add("hidden");
    $("#reader-version-prev").classList.add("hidden");
    $("#reader-version-next").classList.add("hidden");
    $("#reader-version-checkpoint").classList.add("hidden");
    $("#reader-versions-toggle").classList.add("hidden");
    readerVersions = [];
    readerNoteVersioned = false;
    readerNoteDirty = false;
    readerPreviewingVersion = false;
    updateVersionControls();
    openNodeId = nextOpenNodeId;
    syncVoiceContext();
    const body = $("#reader-body");
    destroyNoteEditor();
    if (n.phantom) {
      $("#reader-find").classList.add("hidden");
      body.innerHTML = `<p class="muted">This note doesn't exist yet. ${
        neighbors.get(n.id)?.size ?? 0
      } note(s) link to it.</p>`;
      openNoteWords = null;
      updateBrandStats();
      return;
    }
    // Real note: show the collapsed find affordance (just the icon) + reset (B).
    $("#reader-find").classList.remove("hidden");
    $("#reader-find").classList.remove("expanded");
    ($("#reader-find-input") as HTMLInputElement).value = "";
    clearFind();
    resetFindBar();
    body.innerHTML = '<p class="muted">loading…</p>';
    try {
      const { markdown } = await api<{ markdown: string }>(
        `/api/note?id=${encodeURIComponent(n.id)}${fromHistory ? "&nolog=1" : ""}`,
      );
      // The editor owns the note verbatim (frontmatter included, folded by
      // the editor itself). `stripped` is kept only for word count and the
      // wiki-ingest preview, which work over the body text.
      const stripped = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      body.innerHTML = "";
      // Display-only title when the note body doesn't start with a heading —
      // never inserted into the document (KTD3).
      const firstLine = stripped.split("\n").find((l) => l.trim());
      if (!(firstLine && /^#\s+/.test(firstLine))) {
        const titleEl = document.createElement("h1");
        titleEl.className = "reader-note-title";
        titleEl.textContent = n.title;
        body.appendChild(titleEl);
      }
      const editorHost = document.createElement("div");
      editorHost.id = "reader-editor";
      body.appendChild(editorHost);
      noteEditor = createNoteEditor(editorHost, {
        content: markdown,
        onWikiLinkClick: navigateWikiTarget,
        toolbarExtras: aiToolbarExtras,
        onChange: () => {
          noteAutosave?.notifyChange();
          onEditorDocChanged();
        },
      });
      editorNoteId = n.id;
      noteAutosave = createAutosave({
        baseContent: markdown,
        getContent: () => noteEditor?.getContent() ?? markdown,
        save: (content, base) => saveNote(n.id, content, base),
        onState: renderSaveState,
      });
      editorBaseHashHex = null;
      void sha256Hex(markdown).then((h) => (editorBaseHashHex = h));
      // KTD4b: offer a vault-scoped crash-recovery mirror for this note.
      const mirror = prefs.getEditorMirror();
      if (
        mirror &&
        mirror.noteId === n.id &&
        mirror.vault === activeVaultPath() &&
        mirror.content !== markdown
      ) {
        readerBanner(
          i18n.t("editor.mirror.message"),
          {
            label: i18n.t("editor.mirror.restore"),
            run: () => {
              noteEditor?.setContent(mirror.content);
              prefs.clearEditorMirror();
              noteAutosave?.notifyChange();
            },
          },
          {
            label: i18n.t("editor.mirror.discard"),
            run: () => prefs.clearEditorMirror(),
          },
        );
      } else if (mirror && mirror.vault !== activeVaultPath()) {
        // Foreign-vault mirror: never offer it here; drop it so it cannot
        // shadow a same-id note in this vault (security-lens P1).
        if (mirror.noteId === n.id) prefs.clearEditorMirror();
      }
      const wikiPreview: IngestPreview = {
        source: n.id,
        sourceLabel: n.id,
        title: n.title,
        markdown: stripped,
        via: "sinapso-vault-note",
      };
      topWikiAction.appendChild(renderReaderWikiAction(wikiPreview, "top"));
      topWikiAction.classList.remove("hidden");
      openNoteWords = countWords(stripped);
      updateBrandStats();
      // F035: on a SEMANTIC hit, land on the matched passage instead of the
      // top. The Range walk works over the editor's text nodes too (CM6
      // renders the full doc at note sizes); the highlight is dropped on the
      // first edit since its Ranges die under DOM updates.
      if (highlightSnippet) highlightPassage(body, highlightSnippet);
      // Fixed-order footer: related notes (async) above research questions.
      const showBottomWikiAction =
        openNoteWords >= 300 || stripped.length >= 2000;
      const wikiSlot = document.createElement("div");
      const relatedSlot = document.createElement("div");
      const orphanSlot = document.createElement("div");
      const questionsSlot = document.createElement("div");
      if (showBottomWikiAction)
        wikiSlot.appendChild(renderReaderWikiAction(wikiPreview, "bottom"));
      body.append(wikiSlot, relatedSlot, orphanSlot, questionsSlot);
      void appendRelated(n, relatedSlot);
      void appendOrphanLink(n, orphanSlot);
      appendNoteQuestions(n, questionsSlot);
      // A fresh open (not history nav) is logged server-side; sync the reader
      // history so the panel's prev/next and the corner button reflect it.
      if (!fromHistory) void refreshReaderHistory();
      void loadNoteVersions(n);
    } catch {
      body.innerHTML = '<p class="muted">could not load note</p>';
      openNoteWords = null;
      updateBrandStats();
    }
  }

  // ---- Git note versions: history select, old-version preview, restore ----
  function selectedVersionIndex(): number {
    const commit = ($("#reader-versions") as HTMLSelectElement).value;
    return selectableVersions().findIndex((v) => v.commit === commit);
  }

  function selectableVersions(): NoteVersion[] {
    return readerNoteVersioned ? readerVersions.slice(1) : [];
  }

  function updateVersionControls() {
    const sel = $("#reader-versions") as HTMLSelectElement;
    const status = $("#reader-version-status");
    const prev = $("#reader-version-prev") as HTMLButtonElement;
    const next = $("#reader-version-next") as HTMLButtonElement;
    const checkpoint = $("#reader-version-checkpoint") as HTMLButtonElement;
    const restore = $("#reader-version-restore") as HTMLButtonElement;
    const history = selectableVersions();
    const hasHistory = history.length > 0;
    const showSelect = hasHistory || readerNoteVersioned;
    const idx = selectedVersionIndex();
    sel.classList.toggle("hidden", !showSelect);
    prev.classList.toggle("hidden", !hasHistory);
    next.classList.toggle("hidden", !hasHistory);
    status.classList.toggle("hidden", readerPreviewingVersion);
    status.textContent = i18n.t(
      readerNoteVersioned ? "reader.versioned" : "reader.unversioned",
    );
    status.classList.toggle("versioned", readerNoteVersioned);
    status.classList.toggle("unversioned", !readerNoteVersioned);
    sel.disabled = !hasHistory;
    prev.disabled = !hasHistory || idx === history.length - 1;
    next.disabled = !hasHistory || idx < 0;
    checkpoint.disabled =
      readerPreviewingVersion || !readerNoteDirty || !openNodeId;
    restore.classList.toggle(
      "hidden",
      !readerPreviewingVersion || !sel.value || !readerNoteVersioned,
    );
  }

  async function renderVersionMarkdown(markdown: string, title: string) {
    const body = $("#reader-body");
    const stripped = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const titled = ensureReaderTitle(stripped, title);
    const prepped = titled.replace(
      /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g,
      (_m: string, target: string, alias?: string) =>
        `<a class="wiki" data-target="${target.trim().replace(/"/g, "&quot;")}">${alias ?? target}</a>`,
    );
    body.innerHTML = sanitizeRenderedMarkdown(await marked.parse(prepped));
    for (const a of body.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }

  async function loadNoteVersions(n: GNode) {
    const verSel = $("#reader-versions") as HTMLSelectElement;
    const toggle = $("#reader-versions-toggle");
    try {
      const data = await api<NoteVersionsResponse>(
        `/api/note-versions?id=${encodeURIComponent(n.id)}`,
      );
      if (!data.available) return;
      readerVersions = data.versions ?? [];
      readerNoteVersioned = !!data.versioned;
      readerNoteDirty = !!data.dirty;
      verSel.innerHTML = "";
      const cur = document.createElement("option");
      cur.value = "";
      cur.textContent = selectableVersions().length
        ? i18n.t("reader.versions")
        : i18n.t("reader.noMoreVersions");
      verSel.appendChild(cur);
      for (const v of selectableVersions()) {
        const opt = document.createElement("option");
        opt.value = v.commit;
        const d = new Date(v.committedAt).toLocaleString();
        opt.textContent = `${d} — ${v.subject || v.commit.slice(0, 7)}`;
        verSel.appendChild(opt);
      }
      const shouldShowToggle =
        readerNoteVersioned ||
        readerNoteDirty ||
        selectableVersions().length > 0;
      if (!shouldShowToggle) {
        $("#reader-find").classList.remove("versions-expanded");
        toggle.classList.add("hidden");
        $("#reader-version-status").classList.add("hidden");
        $("#reader-version-prev").classList.add("hidden");
        $("#reader-version-next").classList.add("hidden");
        $("#reader-version-checkpoint").classList.add("hidden");
        $("#reader-version-restore").classList.add("hidden");
        return;
      }
      toggle.classList.remove("hidden");
      $("#reader-version-status").classList.remove("hidden");
      $("#reader-version-prev").classList.remove("hidden");
      $("#reader-version-next").classList.remove("hidden");
      $("#reader-version-checkpoint").classList.remove("hidden");
      updateVersionControls();
    } catch {
      // No git / no history: silently hide.
    }
  }

  async function viewCurrentVersion(n: GNode) {
    const body = $("#reader-body");
    destroyNoteEditor(); // flushes pending edits before the preview takes over
    body.innerHTML = '<p class="muted">loading…</p>';
    try {
      const { markdown } = await api<{ markdown: string }>(
        `/api/note?id=${encodeURIComponent(n.id)}&nolog=1`,
      );
      await renderVersionMarkdown(markdown, selected?.title ?? "Note");
      readerPreviewingVersion = false;
      updateVersionControls();
    } catch {
      body.innerHTML = '<p class="muted">could not load note</p>';
    }
  }

  async function viewVersion(n: GNode, commit: string) {
    const body = $("#reader-body");
    destroyNoteEditor(); // flushes pending edits before the preview takes over
    body.innerHTML = '<p class="muted">loading…</p>';
    try {
      const { markdown } = await api<{ markdown: string }>(
        `/api/note-version?id=${encodeURIComponent(n.id)}&commit=${encodeURIComponent(commit)}`,
      );
      await renderVersionMarkdown(markdown, selected?.title ?? "Note");
      readerPreviewingVersion = true;
      updateVersionControls();
    } catch {
      body.innerHTML = '<p class="muted">could not load version</p>';
    }
  }

  async function checkpointVersion(n: GNode) {
    const checkpoint = $("#reader-version-checkpoint") as HTMLButtonElement;
    checkpoint.disabled = true;
    try {
      await api("/api/note-version/checkpoint", { json: { id: n.id } });
      readerPreviewingVersion = false;
      await loadNoteVersions(n);
      if (readerNoteDirty || selectableVersions().length > 0)
        $("#reader-find").classList.add("versions-expanded");
    } catch {
      alert(i18n.t("reader.checkpointFailed"));
    } finally {
      updateVersionControls();
    }
  }

  function goVersion(delta: number) {
    const history = selectableVersions();
    if (!openNodeId || !history.length) return;
    const node = byId.get(openNodeId);
    if (!node) return;
    const current = selectedVersionIndex();
    const next = current < 0 ? (delta > 0 ? 0 : -1) : current + delta;
    if (next < 0) {
      ($("#reader-versions") as HTMLSelectElement).value = "";
      void viewCurrentVersion(node);
      return;
    }
    if (next >= history.length) return;
    const sel = $("#reader-versions") as HTMLSelectElement;
    sel.value = history[next].commit;
    void viewVersion(node, history[next].commit);
  }

  async function restoreVersion(n: GNode, commit: string) {
    if (!confirm(i18n.t("reader.restoreConfirm"))) return;
    try {
      await api("/api/note-version/restore", { json: { id: n.id, commit } });
      ($("#reader-versions") as HTMLSelectElement).value = "";
      $("#reader-version-restore").classList.add("hidden");
      $("#reader-find").classList.remove("versions-expanded");
      await openReader(n, true);
    } catch {
      alert(i18n.t("reader.restoreFailed"));
    }
  }

  ($("#reader-versions") as HTMLSelectElement).addEventListener(
    "change",
    (e) => {
      const sel = e.target as HTMLSelectElement;
      const commit = sel.value;
      if (!commit || !openNodeId) {
        $("#reader-version-restore").classList.add("hidden");
        readerPreviewingVersion = false;
        const node = openNodeId ? byId.get(openNodeId) : null;
        if (node) void viewCurrentVersion(node);
        updateVersionControls();
        return;
      }
      const node = byId.get(openNodeId);
      if (node) void viewVersion(node, commit);
    },
  );
  $("#reader-versions-toggle").addEventListener("click", () => {
    const bar = $("#reader-find");
    if (bar.classList.contains("versions-expanded")) {
      bar.classList.remove("versions-expanded");
      $("#reader-version-restore").classList.add("hidden");
      ($("#reader-versions") as HTMLSelectElement).value = "";
      readerPreviewingVersion = false;
      // Reopen current note to restore live content.
      if (openNodeId) {
        const node = byId.get(openNodeId);
        if (node) void openReader(node, true);
      }
    } else {
      collapseFind();
      bar.classList.add("versions-expanded");
      showFindBar();
    }
  });
  $("#reader-version-prev").addEventListener("click", () => goVersion(1));
  $("#reader-version-next").addEventListener("click", () => goVersion(-1));
  $("#reader-version-checkpoint").addEventListener("click", () => {
    if (!openNodeId || readerPreviewingVersion) return;
    const node = byId.get(openNodeId);
    if (node) void checkpointVersion(node);
  });
  $("#reader-version-restore").addEventListener("click", () => {
    const commit = ($("#reader-versions") as HTMLSelectElement).value;
    if (!commit || !openNodeId) return;
    const node = byId.get(openNodeId);
    if (node) void restoreVersion(node, commit);
  });
  // ---- End git note versions ---- Client-side literal find over the already-loaded
  // reader body (the whole note is in the DOM, so no endpoint / no qmd): every
  // match highlighted via the CSS Highlight API, IDE-style up/down nav. ----
  let findRanges: Range[] = [];
  let findIdx = 0;
  const hlStore = () =>
    (window as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS
      ?.highlights;
  const HL = () =>
    (window as unknown as { Highlight?: new (...r: Range[]) => unknown })
      .Highlight;
  const findCount = () => $("#reader-find-count");

  function clearFind() {
    const store = hlStore();
    store?.delete("find");
    store?.delete("find-current");
    findRanges = [];
    findIdx = 0;
    findCount().textContent = "";
  }

  function focusFind() {
    const store = hlStore();
    const Ctor = HL();
    if (!store || !Ctor || !findRanges.length) return;
    const r = findRanges[findIdx];
    store.set("find-current", new Ctor(r));
    (r.startContainer.parentElement ?? $("#reader-body")).scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
    findCount().textContent = `${findIdx + 1}/${findRanges.length}`;
  }

  function runFind(term: string) {
    clearFind();
    const store = hlStore();
    const Ctor = HL();
    // Fold to lowercase + strip diacritics so the query matches with or without
    // accents (canción ↔ cancion, niño ↔ nino).
    const fold = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, ""); // strip combining diacritics
    const needle = fold(term.trim());
    if (!needle || !store || !Ctor) return;
    // Accent-folded text buffer + per-char origin over the body's text nodes.
    // Each folded char maps back to its source char, so a match's range still
    // spans whole source characters (accents included).
    const walker = document.createTreeWalker(
      $("#reader-body"),
      NodeFilter.SHOW_TEXT,
    );
    let hay = "";
    const origin: Array<{ node: Text; offset: number }> = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      for (let i = 0; i < t.data.length; i++) {
        const f = fold(t.data[i]);
        for (let k = 0; k < f.length; k++) {
          hay += f[k];
          origin.push({ node: t, offset: i });
        }
      }
    }
    const ranges: Range[] = [];
    let from = 0;
    while (ranges.length < 500) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      const s = origin[idx];
      const e = origin[idx + needle.length - 1];
      if (s && e) {
        const rg = document.createRange();
        rg.setStart(s.node, s.offset);
        rg.setEnd(e.node, e.offset + 1);
        ranges.push(rg);
      }
      from = idx + needle.length;
    }
    findRanges = ranges;
    if (!ranges.length) {
      findCount().textContent = "0";
      return;
    }
    store.set("find", new Ctor(...ranges));
    findIdx = 0;
    focusFind();
  }

  // Editor doc changed (U5): passage-highlight Ranges die under CM6 DOM
  // updates, so drop them; an active find re-runs debounced so its counts
  // and ranges track the new text.
  let findRerunTimer: ReturnType<typeof setTimeout> | null = null;
  function onEditorDocChanged() {
    hlStore()?.delete("passage");
    const term = ($("#reader-find-input") as HTMLInputElement).value;
    if (!term.trim()) return;
    if (findRerunTimer) clearTimeout(findRerunTimer);
    findRerunTimer = setTimeout(() => {
      findRerunTimer = null;
      runFind(term);
    }, 250);
  }

  // Step through matches one at a time (IDE-style), wrapping around.
  function stepFind(dir: number) {
    if (!findRanges.length) return;
    findIdx = (findIdx + dir + findRanges.length) % findRanges.length;
    focusFind();
  }

  function expandFind() {
    $("#reader-find").classList.remove("versions-expanded");
    $("#reader-version-restore").classList.add("hidden");
    ($("#reader-versions") as HTMLSelectElement).value = "";
    $("#reader-find").classList.add("expanded");
    ($("#reader-find-input") as HTMLInputElement).focus();
    showFindBar(); // searching → pin visible
  }

  function collapseFind() {
    $("#reader-find").classList.remove("expanded");
    ($("#reader-find-input") as HTMLInputElement).value = "";
    clearFind();
  }

  {
    const findInput = $("#reader-find-input") as HTMLInputElement;
    $("#reader-find-toggle").addEventListener("click", () =>
      $("#reader-find").classList.contains("expanded")
        ? collapseFind()
        : expandFind(),
    );
    findInput.addEventListener("input", () => runFind(findInput.value));
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (findRanges.length) stepFind(e.shiftKey ? -1 : 1);
        else runFind(findInput.value);
      } else if (e.key === "Escape") {
        collapseFind();
      }
    });
    $("#reader-find-prev").addEventListener("click", () => stepFind(-1));
    $("#reader-find-next").addEventListener("click", () => stepFind(1));
  }

  // Hide-on-scroll-down / reveal-on-scroll-up: the sticky find row tracks the
  // scroll delta (moves with the scroll, no self-animation), staying pinned
  // visible while searching (expanded or non-empty). `findHide` = px slid up.
  const findBarEl = $("#reader-find");
  const scrollEl = $("#reader-scroll");
  let lastFindScrollY = 0;
  let findHide = 0;
  const findSearching = () =>
    findBarEl.classList.contains("expanded") ||
    findBarEl.classList.contains("versions-expanded") ||
    ($("#reader-find-input") as HTMLInputElement).value.trim() !== "";
  function showFindBar() {
    findHide = 0;
    findBarEl.style.transform = "translateY(0)";
  }
  function resetFindBar() {
    lastFindScrollY = 0;
    showFindBar();
  }
  scrollEl.addEventListener(
    "scroll",
    () => {
      const y = scrollEl.scrollTop;
      const H = findBarEl.offsetHeight;
      if (findSearching() || y <= 0) findHide = 0;
      else
        findHide = Math.min(Math.max(findHide + (y - lastFindScrollY), 0), H);
      findBarEl.style.transform = `translateY(${-findHide}px)`;
      lastFindScrollY = y;
    },
    { passive: true },
  );

  $("#reader-body").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a.wiki") as HTMLElement | null;
    if (!a) return;
    const t = (a.dataset.target ?? "").toLowerCase();
    const node =
      byBasename.get(t.split("/").pop()!) ?? byId.get(`phantom:${t}`);
    if (node) select(node);
  });

  $("#reader-close").addEventListener("click", clearSelection);

  // KTD4: flush pending edits when focus leaves the app; KTD4b: on unload,
  // mirror the dirty buffer locally (the real recovery net) and attempt a
  // keepalive PUT with the cached staleness hash (64KB body cap applies).
  window.addEventListener("blur", () => void noteAutosave?.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void noteAutosave?.flush();
  });
  window.addEventListener("beforeunload", () => {
    if (!noteEditor || !noteAutosave || !editorNoteId) return;
    const content = noteEditor.getContent();
    if (content === noteAutosave.base()) return;
    prefs.setEditorMirror({
      vault: activeVaultPath(),
      noteId: editorNoteId,
      content,
      at: Date.now(),
    });
    if (noteAutosave.state() === "conflict") return; // never clobber on exit
    const token = peekApiToken();
    if (token && editorBaseHashHex && content.length < 60_000) {
      try {
        void fetch("/api/notes", {
          method: "PUT",
          keepalive: true,
          headers: {
            "content-type": "application/json",
            "x-sinapso-token": token,
          },
          body: JSON.stringify({
            id: editorNoteId,
            content,
            baseHash: editorBaseHashHex,
          }),
        });
      } catch {
        /* the mirror covers recovery */
      }
    }
  });

  // Click the path in the header to copy it to the clipboard.
  $("#reader-path").addEventListener("click", async () => {
    if (!selected || selected.phantom) return;
    try {
      await navigator.clipboard.writeText(selected.id);
      const tip = document.createElement("div");
      tip.className = "copy-toast";
      tip.textContent = i18n.t("reader.copied");
      const r = ($("#reader-path") as HTMLElement).getBoundingClientRect();
      tip.style.left = `${r.left + r.width / 2}px`;
      tip.style.top = `${r.bottom + 6}px`;
      document.body.append(tip);
      setTimeout(() => tip.remove(), 1200);
    } catch {
      /* clipboard unavailable (no permission / insecure context) */
    }
  });

  // ---- reader panel: draggable (header) + resizable (edge/corner) ----
  // Docked = pinned to the right edge, full height, width adjustable.
  // Dragging the header undocks it into a floating window; double-click
  // the header to re-dock. Geometry persists per browser.
  {
    const reader = $("#reader");
    interface ReaderGeom {
      floating: boolean;
      width: number;
      height: number;
      left: number;
      top: number;
    }
    const clamp = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));

    const saved: ReaderGeom | null = prefs.getReader();
    const geom: ReaderGeom = saved ?? {
      floating: false,
      width: Math.min(440, window.innerWidth * 0.42),
      height: window.innerHeight * 0.7,
      left: 80,
      top: 60,
    };
    const persist = () => prefs.setReader(geom);
    let lastReaderViewportW = window.innerWidth;

    // dock/undock icon: docked shows "float free", floating shows "dock to edge"
    const DOCK_SVG =
      '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="4" width="3.5" height="8" fill="currentColor"/></svg>';
    const UNDOCK_SVG =
      '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="5" y="5" width="6" height="6" fill="currentColor"/></svg>';
    const dockBtn = $("#reader-dock");
    let dockIconState: boolean | null = null;
    function updateDockIcon() {
      if (dockIconState === geom.floating) return;
      dockIconState = geom.floating;
      dockBtn.innerHTML = geom.floating ? DOCK_SVG : UNDOCK_SVG;
      const dockKey = geom.floating ? "dock.dock" : "dock.undock";
      dockBtn.dataset.i18nTitle = dockKey;
      dockBtn.title = i18n.t(dockKey);
    }

    function applyGeom(trackMaxed = false) {
      const viewportW = window.innerWidth;
      const maxW = Math.max(0, viewportW);
      const minW = Math.min(280, maxW);
      const wasMaxed = trackMaxed && geom.width >= lastReaderViewportW - 1;
      geom.width = wasMaxed ? maxW : clamp(geom.width, minW, maxW);
      lastReaderViewportW = viewportW;
      reader.style.setProperty("--reader-w", `${geom.width}px`);
      reader.classList.toggle("floating", geom.floating);
      if (geom.floating) {
        geom.height = clamp(geom.height, 220, window.innerHeight - 24);
        geom.left = clamp(geom.left, 0, Math.max(0, viewportW - geom.width));
        geom.top = clamp(geom.top, 0, window.innerHeight - 48);
        reader.style.width = geom.width + "px";
        reader.style.left = geom.left + "px";
        reader.style.top = geom.top + "px";
        reader.style.height = geom.height + "px";
        reader.style.right = "auto";
        reader.style.bottom = "auto";
      } else {
        // Docked: CSS owns the width via --reader-w (ctx-left clamps it so the
        // right edge — and its resize handle — can't slide under the rail).
        reader.style.width = "";
        reader.style.left = "auto";
        reader.style.top = "0";
        reader.style.right = "0";
        reader.style.bottom = "0";
        reader.style.height = "auto";
      }
      updateDockIcon();
    }
    applyGeom();

    dockBtn.addEventListener("click", () => {
      geom.floating = !geom.floating;
      applyGeom();
      persist();
    });

    // generic pointer-drag helper (pointer capture handles mouseup outside)
    const dragOp =
      (
        onMove: (dx: number, dy: number) => void,
        cls: "dragging" | "resizing",
      ) =>
      (down: PointerEvent) => {
        down.preventDefault();
        const startX = down.clientX;
        const startY = down.clientY;
        const el = down.currentTarget as HTMLElement;
        el.setPointerCapture(down.pointerId);
        reader.classList.add(cls);
        const move = (e: PointerEvent) =>
          onMove(e.clientX - startX, e.clientY - startY);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          el.removeEventListener("lostpointercapture", up);
          reader.classList.remove(cls);
          persist();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        el.addEventListener("lostpointercapture", up);
      };

    // left-edge: width resize (works docked and floating)
    {
      let w0 = 0;
      let l0 = 0;
      const handle = $("#reader-resize-w");
      handle.addEventListener("pointerdown", (e: PointerEvent) => {
        w0 = geom.width;
        l0 = geom.left;
        // Left-docked, the grip is on the right edge: dragging right grows it.
        const leftDocked =
          !geom.floating &&
          ($("#reader") as HTMLElement).classList.contains("ctx-left");
        dragOp((dx) => {
          if (geom.floating) {
            // left edge moves; right edge stays put
            geom.width = w0 - dx;
            geom.left = l0 + dx;
          } else {
            geom.width = leftDocked ? w0 + dx : w0 - dx;
          }
          applyGeom();
        }, "resizing")(e);
      });
    }

    // corner grip (floating only): both dimensions
    {
      let w0 = 0;
      let h0 = 0;
      const handle = $("#reader-resize-corner");
      handle.addEventListener("pointerdown", (e: PointerEvent) => {
        w0 = geom.width;
        h0 = geom.height;
        dragOp((dx, dy) => {
          geom.width = w0 + dx;
          geom.height = h0 + dy;
          applyGeom();
        }, "resizing")(e);
      });
    }

    // header: drag to move. Only acts when already floating; the dock
    // button is the sole way to toggle dock state, so clicking the header
    // row (incl. the path) never undocks.
    {
      let l0 = 0;
      let t0 = 0;
      const head = $("#reader-head");
      head.addEventListener("pointerdown", (e: PointerEvent) => {
        if ((e.target as HTMLElement).closest("button")) return; // buttons stay buttons
        if (!geom.floating) return; // docked: header drag is a no-op
        l0 = geom.left;
        t0 = geom.top;
        dragOp((dx, dy) => {
          geom.left = l0 + dx;
          geom.top = t0 + dy;
          applyGeom();
        }, "dragging")(e);
      });
    }

    window.addEventListener("resize", () => applyGeom(true));
  }

  // --- open in Obsidian ---
  const openInObsidian = (n: GNode) => {
    if (n.phantom) return;
    const file = n.id.replace(/\.md$/i, "");
    window.location.href = `obsidian://open?vault=${encodeURIComponent(
      data.meta.vaultName,
    )}&file=${encodeURIComponent(file)}`;
  };
  $("#open-obsidian").addEventListener(
    "click",
    () => selected && openInObsidian(selected),
  );
  $("#reader-archive").addEventListener("click", async () => {
    const id = openNodeId;
    if (!id) return;
    try {
      await api("/api/archive", { json: { id } });
      clearSelection();
      await rescan(false);
    } catch (e) {
      $("#reader-body").innerHTML =
        `<p class="muted">${escapeHtml(e instanceof Error ? e.message : i18n.t("reader.archiveFailed"))}</p>`;
    }
  });
  graph.onNodeRightClick((n: GNode) => openInObsidian(n));

  // ---- tap-to-select: a click that survives a shaky hand ----
  // The drag stack treats the tiniest mouse move (even 1px) as a drag: it both
  // nudges the node and swallows the click (clickAfterDrag=false), so a
  // slightly unsteady press never opens the note. Own the gesture instead — a
  // short, near-still press is a tap (select / double-tap → Obsidian) and its
  // accidental nudge is undone so the node never moves. Longer/farther presses
  // stay real drags and reposition as before.
  const TAP_MS = 250; // pressed shorter than this...
  const TAP_PX = 6; //   ...and moved less than this on screen = a tap
  let lastClick = 0;
  let lastClickId = "";
  function tapNode(n: GNode) {
    const now = Date.now();
    if (n.id === lastClickId && now - lastClick < 350) openInObsidian(n);
    else select(n);
    lastClick = now;
    lastClickId = n.id;
  }
  graph.onNodeClick(() => {}); // taps dispatch from the pointer handlers below
  const canvas = graph.renderer().domElement;
  let downT = 0;
  let downX = 0;
  let downY = 0;
  let downNode: GNode | null = null;
  let downPos: { x: number; y: number; z: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) {
      downNode = null;
      return;
    }
    downT = performance.now();
    downX = e.clientX;
    downY = e.clientY;
    downNode = hoverNode;
    downPos =
      hoverNode?.x !== undefined &&
      hoverNode.y !== undefined &&
      hoverNode.z !== undefined
        ? { x: hoverNode.x, y: hoverNode.y, z: hoverNode.z }
        : null;
  });
  // Release can land off-canvas (pointer capture during a drag), so listen wide.
  window.addEventListener("pointerup", (e) => {
    const n = downNode;
    downNode = null;
    if (!n) return;
    const tap =
      performance.now() - downT < TAP_MS &&
      Math.hypot(e.clientX - downX, e.clientY - downY) < TAP_PX;
    if (!tap) return; // a deliberate drag: leave the reposition alone
    if (downPos) {
      // undo DragControls' micro-nudge so a tap never shifts the note
      n.x = downPos.x;
      n.y = downPos.y;
      n.z = downPos.z;
      const obj = (n as unknown as { __threeObj?: THREE.Object3D }).__threeObj;
      obj?.position.set(downPos.x, downPos.y, downPos.z);
      updateLinkPositions();
    }
    tapNode(n);
  });

  // --- topbar stats: context-aware footer. Left mirrors content/voice, right
  // mirrors research/voice; each half reverts when its panel closes. The two
  // write sites (load + rescan) seed the counts; dynamic updates flow through
  // updateBrandStats() from the selection / research / voice hooks. Declared
  // early but NOT called here — voiceSession/researchMode/… it reads are still
  // in TDZ during initial load, so the initial render writes the spans directly.
  let lastNotes = 0,
    lastLinks = 0;
  let openNoteWords: number | null = null;
  let openNodeId: string | null = null;
  let readerVersions: NoteVersion[] = [];
  let readerNoteVersioned = false;
  let readerNoteDirty = false;
  let readerPreviewingVersion = false;
  let voiceStartedAt = 0;
  let voiceTimer: number | null = null;
  let voiceStatusTimer: number | null = null;
  const countWords = (s: string): number =>
    (s.trim().match(/\S+/g) ?? []).length;
  const fmtTimer = (start: number): string => {
    const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const isReaderOpen = () => !$("#reader").classList.contains("hidden");
  const isResearchOpen = () => !$("#research").classList.contains("hidden");
  function updateBrandStats() {
    const left = $("#bs-left");
    const right = $("#bs-right");
    if (!left || !right) return;
    if (voiceSession) {
      const v = integrations?.voice;
      left.textContent =
        `${v?.provider ?? "gemini"} · ${v?.voice ?? ""}`.trim();
      right.textContent = fmtTimer(voiceStartedAt);
      return;
    }
    left.textContent =
      isReaderOpen() && openNoteWords != null
        ? `${openNoteWords.toLocaleString()} words`
        : `${lastNotes.toLocaleString()} notes`;
    if (isResearchOpen()) {
      const entry = historyIdx >= 0 ? researchHistory[historyIdx] : null;
      if (researchMode === "ingest") {
        right.textContent = "ingest…";
      } else if (
        entry &&
        (researchMode === "article" || researchMode === "document")
      ) {
        const c = entry.article?.content ?? entry.document?.content ?? "";
        right.textContent = `${countWords(c).toLocaleString()} words`;
      } else if (entry) {
        right.textContent = `${(entry.results?.length ?? 0).toLocaleString()} results`;
      } else {
        right.textContent = `${lastLinks.toLocaleString()} links`;
      }
    } else {
      right.textContent = `${lastLinks.toLocaleString()} links`;
    }
  }
  lastNotes = data.meta.notes;
  lastLinks = data.meta.links;
  $("#bs-left").textContent = `${lastNotes.toLocaleString()} notes`;
  $("#bs-right").textContent = `${lastLinks.toLocaleString()} links`;

  // --- legend (rebuilt on theme/group/color changes) ---
  // Each swatch is a color picker: pick your own group colors, persisted.
  function buildLegend() {
    const legend = $("#legend");
    legend.innerHTML = "";
    const addHeader = (
      title: string,
      keys: string[],
      store: Record<string, boolean>,
    ) => {
      if (!keys.length) return;
      const head = document.createElement("div");
      head.className = "legend-section-head";
      const label = document.createElement("span");
      label.textContent = title;
      const toggle = document.createElement("button");
      toggle.className = "legend-section-toggle";
      const active = keys.some((key) => store[key] !== false);
      toggle.textContent = active ? "Active" : "Inactive";
      toggle.setAttribute("aria-pressed", String(active));
      const setAll = (on: boolean) => {
        for (const key of keys) {
          if (on) delete store[key];
          else store[key] = false;
        }
        buildLegend();
        refreshVisibility();
      };
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        setAll(!active);
      });
      head.append(label, toggle);
      legend.appendChild(head);
    };

    const groupKeys = groups.filter((g) => g !== "Unwritten");
    addHeader(
      groupMode === "tag"
        ? "Tags"
        : groupMode === "cluster"
          ? "Clusters"
          : "Folders",
      groupKeys,
      pillarOn,
    );
    for (const g of groupKeys) {
      if (g === "Unwritten") continue;
      const row = document.createElement("div");
      row.className = "legend-row";
      row.classList.toggle("off", pillarOn[g] === false);
      const pick = document.createElement("input");
      pick.type = "color";
      pick.className = "dot-pick";
      pick.value = colorOf[g];
      pick.title = `Pick a color for ${g}`;
      const name = document.createElement("span");
      name.className = "legend-name";
      name.textContent = g;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(groupCounts.get(g) ?? 0);
      row.append(pick, name, count);
      pick.addEventListener("click", (e) => e.stopPropagation());
      pick.addEventListener("input", () => {
        customColors[g] = pick.value;
        prefs.setColors(customColors);
        recomputeColors();
        repaint();
      });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        pillarOn[g] = pillarOn[g] === false;
        row.classList.toggle("off", pillarOn[g] === false);
        refreshVisibility();
      });
      legend.appendChild(row);
    }

    if (enabledWikis.length) {
      const keys = enabledWikis.map((w) => w.id);
      const counts = new Map<string, number>(keys.map((id) => [id, 0]));
      for (const n of data.nodes) {
        const wiki = wikiForId(n.id);
        if (wiki) counts.set(wiki.id, (counts.get(wiki.id) ?? 0) + 1);
      }
      addHeader("Wikis", keys, wikiOn);
      for (const wiki of enabledWikis) {
        const row = document.createElement("div");
        row.className = "legend-row";
        row.classList.toggle("off", wikiOn[wiki.id] === false);
        const key = wikiColorKey(wiki);
        const pick = document.createElement("input");
        pick.type = "color";
        pick.className = "dot-pick";
        pick.value = colorOf[key];
        pick.title = `Pick a color for ${wikiDisplayName(wiki)}`;
        const name = document.createElement("span");
        name.className = "legend-name";
        name.textContent = wikiDisplayName(wiki);
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = String(counts.get(wiki.id) ?? 0);
        row.append(pick, name, count);
        pick.addEventListener("click", (e) => e.stopPropagation());
        pick.addEventListener("input", () => {
          customColors[key] = pick.value;
          prefs.setColors(customColors);
          recomputeColors();
          repaint();
        });
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          wikiOn[wiki.id] = wikiOn[wiki.id] === false;
          row.classList.toggle("off", wikiOn[wiki.id] === false);
          refreshVisibility();
        });
        legend.appendChild(row);
      }
    }
  }
  buildLegend();

  // --- group-by mode (folder structure vs #tags) ---
  const groupSelect = $("#group") as HTMLSelectElement;
  function syncGroupSelectOptions() {
    const existingWikiOption = groupSelect.querySelector<HTMLOptionElement>(
      'option[value="wiki"]',
    );
    if (enabledWikis.length && !existingWikiOption) {
      const option = document.createElement("option");
      option.value = "wiki";
      option.textContent = "wiki";
      groupSelect.appendChild(option);
    } else if (!enabledWikis.length && existingWikiOption) {
      existingWikiOption.remove();
    }
    groupSelect.value = groupMode;
  }
  syncGroupSelectOptions();
  groupSelect.addEventListener("change", async (e) => {
    const sel = e.target as HTMLSelectElement;
    const mode = sel.value as GroupMode;
    if (mode === "wiki" && !enabledWikis.length) {
      sel.value = groupMode;
      return;
    }
    if (mode === "cluster") {
      sel.disabled = true;
      const ok = await fetchSemantic();
      sel.disabled = false;
      if (!ok) {
        sel.value = groupMode; // semantic unavailable: keep current grouping
        return;
      }
      computeSemanticClusters();
    }
    groupMode = mode;
    prefs.setGroup(groupMode);
    for (const k of Object.keys(pillarOn)) delete pillarOn[k]; // all visible again
    computeGroups();
    recomputeColors();
    buildLegend();
    refreshVisibility();
    repaint();
  });
  $("#reset-colors").addEventListener("click", () => {
    for (const k of Object.keys(customColors)) delete customColors[k];
    prefs.removeColors();
    recomputeColors();
    buildLegend();
    repaint();
  });

  // --- arrangement mode (links / hybrid / semantic) ---
  const arrangementPref = validArr(prefs.getArrangement());
  const arrSel = $("#arrange") as HTMLSelectElement;
  arrSel.value = arrangementPref;
  arrSel.addEventListener("change", (e) => {
    const mode = validArr((e.target as HTMLSelectElement).value);
    arrSel.disabled = true;
    applyArrangement(mode).finally(() => {
      arrSel.disabled = false;
    });
  });
  const semLinesToggle = $("#toggle-sem-lines") as HTMLInputElement;
  semLinesToggle.checked = semLinesOn;
  semLinesToggle.addEventListener("change", () => {
    semLinesOn = semLinesToggle.checked;
    prefs.setSemLines(semLinesOn);
    updateSemanticVisibility();
    repaint();
  });
  // Apply a persisted non-default arrangement once the structural boot layout
  // has had a chance to settle and cache (so /api/layout?arrangement=links exists).
  if (arrangementPref !== "links") {
    window.setTimeout(
      () => applyArrangement(arrangementPref),
      cachedPositions ? 400 : 2600,
    );
  }
  // If semantic-cluster grouping was persisted, compute it once the edges load.
  if (groupMode === "cluster") {
    window.setTimeout(
      async () => {
        if (await fetchSemantic()) {
          computeSemanticClusters();
          computeGroups();
          recomputeColors();
          buildLegend();
          refreshVisibility();
          repaint();
        }
      },
      cachedPositions ? 500 : 2700,
    );
  }

  // --- controls ---
  // Each toggle reflects its persisted state on boot (the state vars are read
  // from prefs above) and writes back on change, so preferences stick.
  const phantomsToggle = $("#toggle-phantoms") as HTMLInputElement;
  phantomsToggle.checked = showPhantoms;
  phantomsToggle.addEventListener("change", () => {
    showPhantoms = phantomsToggle.checked;
    prefs.setPhantoms(showPhantoms);
    refreshVisibility();
  });
  const orphansToggle = $("#toggle-orphans") as HTMLInputElement;
  orphansToggle.checked = showOrphans;
  orphansToggle.addEventListener("change", () => {
    showOrphans = orphansToggle.checked;
    prefs.setOrphans(showOrphans);
    refreshVisibility();
  });
  const glowToggle = $("#toggle-glow") as HTMLInputElement;
  glowToggle.checked = glowOn;
  glowToggle.addEventListener("change", () => {
    glowOn = glowToggle.checked;
    prefs.setGlow(glowOn);
    bloom.enabled = glowOn && QUALITY[quality].bloom;
  });
  const gfxSel = $("#gfx") as HTMLSelectElement;
  gfxSel.value = quality;
  gfxSel.addEventListener("change", () => applyQuality(gfxSel.value as QKey));

  const themeSel = $("#theme") as HTMLSelectElement;
  themeSel.value = theme;
  themeSel.addEventListener("change", () => applyTheme(themeSel.value));
  applyTheme(theme); // sync CSS vars + scene for the persisted choice

  const nodesSel = $("#nodes") as HTMLSelectElement;
  nodesSel.value = nodeStyle;
  nodesSel.addEventListener("change", () => {
    nodeStyle = nodesSel.value as NodeStyle;
    prefs.setNodeStyle(nodeStyle);
    rebuildNodes();
  });
  const labelsToggle = $("#toggle-labels") as HTMLInputElement;
  labelsToggle.checked = labelsOn;
  labelsToggle.addEventListener("change", () => {
    labelsOn = labelsToggle.checked;
    prefs.setLabels(labelsOn);
  });

  // ---- filters panel ----
  $("#filters-btn").addEventListener("click", () =>
    $("#filters").classList.toggle("hidden"),
  );
  document.addEventListener("click", (e) => {
    const target = e.target as Node;
    const filtersPanel = $("#filters");
    const settingsPanel = $("#settings");
    const insideFloatingPanel =
      filtersPanel.contains(target) || settingsPanel.contains(target);
    const fromPanelButton = [
      "#filters-btn",
      "#settings-btn",
      "#mi-filters",
      "#mi-settings",
    ].some((id) => $(id).contains(target));
    if (insideFloatingPanel || fromPanelButton) return;
    filtersPanel.classList.add("hidden");
    settingsPanel.classList.add("hidden");
  });
  {
    const modeBtn = $("#filter-mode") as HTMLButtonElement;
    const input = $("#filter-input") as HTMLInputElement;
    const list = $("#filter-list");
    let liveMode: "show" | "ignore" = "show";
    let dragFrom = -1;
    let debounce = 0;

    function renderFilters() {
      list.innerHTML = "";
      filters.forEach((f, i) => {
        const row = document.createElement("div");
        row.className = "filter-row";
        row.draggable = true;

        const handle = document.createElement("span");
        handle.className = "filter-drag";
        handle.textContent = "⠿";
        handle.title = "Drag to reorder";

        const mode = document.createElement("button");
        mode.className = "filter-mode";
        mode.dataset.mode = f.mode;
        mode.textContent = f.mode;
        mode.title = "Toggle show / ignore";
        mode.addEventListener("click", () => {
          f.mode = f.mode === "show" ? "ignore" : "show";
          mode.dataset.mode = f.mode;
          mode.textContent = f.mode;
          saveFilters();
          applyFilters();
        });

        const rm = document.createElement("button");
        rm.className = "filter-pm";
        rm.textContent = "−";
        rm.title = "Remove filter";
        rm.addEventListener("click", () => {
          filters.splice(i, 1);
          saveFilters();
          renderFilters();
          applyFilters();
        });

        const pat = document.createElement("span");
        pat.className = "filter-pattern";
        pat.textContent = f.pattern;
        pat.title = f.pattern;

        row.append(handle, mode, rm, pat);

        row.addEventListener("dragstart", () => {
          dragFrom = i;
          row.classList.add("dragging");
        });
        row.addEventListener("dragend", () => {
          dragFrom = -1;
          list
            .querySelectorAll(".filter-row")
            .forEach((e) => e.classList.remove("dragging", "drop-target"));
        });
        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          row.classList.add("drop-target");
        });
        row.addEventListener("dragleave", () =>
          row.classList.remove("drop-target"),
        );
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          row.classList.remove("drop-target");
          if (dragFrom < 0 || dragFrom === i) return;
          const [moved] = filters.splice(dragFrom, 1);
          filters.splice(i, 0, moved);
          saveFilters();
          renderFilters();
          applyFilters();
        });

        list.appendChild(row);
      });
    }

    const setLive = () => {
      liveFilter = input.value.trim()
        ? { mode: liveMode, pattern: input.value }
        : null;
      clearTimeout(debounce);
      debounce = window.setTimeout(applyFilters, 70);
    };
    const commit = () => {
      if (!input.value.trim()) return;
      filters.unshift({ mode: liveMode, pattern: input.value });
      input.value = "";
      liveFilter = null;
      saveFilters();
      renderFilters();
      applyFilters();
      input.focus();
    };

    modeBtn.addEventListener("click", () => {
      liveMode = liveMode === "show" ? "ignore" : "show";
      modeBtn.dataset.mode = liveMode;
      modeBtn.textContent = liveMode;
      if (input.value.trim()) setLive();
    });
    input.addEventListener("input", setLive);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
    $("#filter-add").addEventListener("click", commit);

    renderFilters();
    applyFilters(); // honor persisted filters on load
  }

  // ---- display settings panel ----
  $("#settings-btn").addEventListener("click", () =>
    $("#settings").classList.toggle("hidden"),
  );
  const bindRange = (
    id: string,
    fmt: (v: number) => string,
    apply: (v: number) => void,
    rw: { read: () => number | null; write: (v: number) => void },
  ) => {
    const el = $(`#${id}`) as HTMLInputElement;
    // Restore a persisted value on boot (apply it so the graph reflects it).
    const saved = rw.read();
    if (saved !== null) el.value = String(saved);
    const v0 = Number(el.value);
    $(`#${id}-val`).textContent = fmt(v0);
    apply(v0);
    el.addEventListener("input", () => {
      const v = Number(el.value);
      $(`#${id}-val`).textContent = fmt(v);
      apply(v);
      rw.write(v);
    });
  };
  bindRange("label-distance", String, (v) => (labelDist = v), {
    read: prefs.getLabelDistance,
    write: prefs.setLabelDistance,
  });
  bindRange(
    "label-size",
    String,
    (v) => {
      labelSize = v;
      for (const s of sprites.values()) s.textHeight = v;
    },
    { read: prefs.getLabelSize, write: prefs.setLabelSize },
  );
  bindRange(
    "node-size",
    String,
    (v) => {
      sizeFactor = v;
      rescaleNodes();
    },
    { read: prefs.getNodeSize, write: prefs.setNodeSize },
  );
  const bindWeight = (id: string, key: "in" | "out" | "words" | "contrast") => {
    const el = $(`#${id}`) as HTMLInputElement;
    el.value = String(sizeWeights[key]);
    $(`#${id}-val`).textContent = sizeWeights[key].toFixed(1);
    el.addEventListener("input", () => {
      sizeWeights[key] = Number(el.value);
      $(`#${id}-val`).textContent = sizeWeights[key].toFixed(1);
      prefs.setSizeWeights(sizeWeights);
      rescaleNodes();
    });
  };
  bindWeight("w-in", "in");
  bindWeight("w-out", "out");
  bindWeight("w-words", "words");
  bindWeight("w-contrast", "contrast");

  const pcSel = $("#pc") as HTMLSelectElement;
  pcSel.value =
    pcExplicit && pcExplicit !== "auto" ? String(particleCount) : "auto";
  if (pcSel.value === "") pcSel.value = "auto"; // value not among presets
  pcSel.addEventListener("change", () => {
    if (pcSel.value === "auto") {
      prefs.removePc();
      particleCount = tierPc();
    } else {
      particleCount = Number(pcSel.value);
      prefs.setPc(particleCount);
    }
    if (nodeStyle === "particles") rebuildNodes();
  });
  bindRange("scene-intensity", (v) => `${v}%`, applyIntensity, {
    read: prefs.getIntensity,
    write: prefs.setIntensity,
  });
  bindRange(
    "link-opacity",
    (v) => `${v}%`,
    (v) => (lineMat.opacity = v / 100),
    { read: prefs.getLinkOpacity, write: prefs.setLinkOpacity },
  );
  bindRange(
    "min-weight",
    String,
    (v) => {
      minWeight = v;
      refreshVisibility();
    },
    { read: prefs.getMinWeight, write: prefs.setMinWeight },
  );
  const depthSel = $("#depth") as HTMLSelectElement;
  depthSel.value = String(focusDepth); // reflect the persisted choice on boot
  depthSel.addEventListener("change", (e) => {
    focusDepth = Number((e.target as HTMLSelectElement).value);
    prefs.setDepth(focusDepth);
    if (selected) {
      focusSet = bfs(selected.id, focusDepth);
      repaint();
    }
  });

  // --- search: instant title matches + indexed full-text content matches ---
  const searchBox = $("#search") as HTMLInputElement;
  const results = $("#search-results");
  const selectionStrip = $("#selection-context-strip");
  const selectionToggle = $("#selection-context-toggle") as HTMLInputElement;
  let selectionContextState: SelectionContextState = emptySelectionState();
  let includeSelectionContext = true;

  function currentSelectionSnapshot(): SelectionSnapshot {
    return buildSelectionSnapshot(selectionContextState);
  }

  function setSelectionContext(slot: SelectionContext | null) {
    if (!slot) return;
    selectionContextState = updateSelectionSlot(selectionContextState, slot);
    includeSelectionContext = true;
    selectionToggle.checked = true;
    renderSelectionContextStrip();
    syncVoiceContext();
  }

  function clearSelectionContext(source: SelectionSource) {
    selectionContextState = clearSelectionSlot(selectionContextState, source);
    renderSelectionContextStrip();
    syncVoiceContext();
  }

  function selectedSearchSnapshot(): SelectionSnapshot | null {
    if (!activeModeCanUseSelection()) return null;
    if (!includeSelectionContext) return null;
    const snap = currentSelectionSnapshot();
    return hasSelectionContext(snap) ? snap : null;
  }

  function activeModeCanUseSelection(): boolean {
    return selectionContextAppliesToMode(activeMode);
  }

  function renderSelectionContextStrip() {
    const snap = currentSelectionSnapshot();
    selectionStrip.dataset.tip = i18n.t("selection.include");
    const show =
      activeModeCanUseSelection() &&
      hasSelectionContext(snap) &&
      document.activeElement === searchBox;
    selectionStrip.classList.toggle("hidden", !show);
    selectionToggle.checked = includeSelectionContext;
  }

  selectionToggle.addEventListener("change", () => {
    includeSelectionContext = selectionToggle.checked;
  });
  searchBox.addEventListener("focus", renderSelectionContextStrip);
  searchBox.addEventListener("blur", () => {
    setTimeout(renderSelectionContextStrip, 120);
  });

  function sendSearch() {
    const q = searchBox.value.trim();
    const context = selectedSearchSnapshot();
    if (activeMode && (q || (context && activeModeCanUseSelection()))) {
      searchBox.value = "";
      results.innerHTML = "";
      searchBox.blur();
      runModeQuery(activeMode, q, context ?? undefined);
      return;
    }
    if (!activeMode && q)
      (results.firstElementChild as HTMLElement | null)?.click();
  }

  const addResult = (n: GNode, snippetText?: string) => {
    const row = document.createElement("div");
    row.className = "result";
    row.innerHTML =
      `<span class="dot" style="background:${colorOf[colorGroupOf(n)]}"></span>` +
      `<span class="result-main"><span>${n.title}</span>` +
      (snippetText ? `<span class="snippet"></span>` : "") +
      `</span><span class="count">${n.pillar}</span>`;
    if (snippetText)
      (row.querySelector(".snippet") as HTMLElement).textContent = snippetText;
    row.addEventListener("click", () => {
      select(n, snippetText); // snippet present only for semantic hits (F035)
      results.innerHTML = "";
      searchBox.value = "";
    });
    results.appendChild(row);
    return row;
  };

  let searchToken = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const renderResults = (q: string) => {
    const token = ++searchToken;
    results.innerHTML = "";
    clearTimeout(searchTimer);
    // With a mode active the field is a query box (Enter-driven, F018):
    // no live dropdown, and web queries must never auto-run while typing.
    if (!q || activeMode) return;

    // 1) Title matches: local, instant.
    const ql = q.toLowerCase();
    const shown = new Set<string>();
    const titleHits = data.nodes
      .filter((n) => !n.phantom && n.title.toLowerCase().includes(ql))
      .sort((a, b) => {
        const aStarts = a.title.toLowerCase().startsWith(ql) ? 0 : 1;
        const bStarts = b.title.toLowerCase().startsWith(ql) ? 0 : 1;
        return aStarts - bStarts || degree(b) - degree(a);
      })
      .slice(0, 8);
    for (const n of titleHits) {
      addResult(n);
      shown.add(n.id);
    }

    // 2) Content matches: debounced hit on the server's full-text index.
    searchTimer = setTimeout(async () => {
      try {
        const hits = await api<Array<{ id: string; snippet: string }>>(
          `/api/search?q=${encodeURIComponent(q)}`,
        );
        if (token !== searchToken) return; // stale response
        for (const h of hits) {
          if (shown.has(h.id) || shown.size >= 16) continue;
          const n = byId.get(h.id);
          if (!n) continue;
          addResult(n, h.snippet);
          shown.add(h.id);
        }
      } catch {
        // index unavailable; title results already shown
      }
    }, 220);
  };
  searchBox.addEventListener("input", () => {
    if (activeMode === "ingest") return; // search box is the ingest input
    renderResults(searchBox.value.trim());
  });
  searchBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      sendSearch();
      return;
    } else if (e.key === "Escape") {
      searchBox.value = "";
      results.innerHTML = "";
      searchBox.blur();
    }
  });

  function sourceFromHost(host: HTMLElement): SelectionSource | null {
    if (host.id === "reader-body") return "reader";
    if (host.id === "research-body") return "research";
    return null;
  }

  function selectionHostForRange(range: Range): HTMLElement | null {
    const reader = $("#reader-body");
    const research = $("#research-body");
    const start = range.startContainer;
    const end = range.endContainer;
    if (reader.contains(start) && reader.contains(end)) return reader;
    if (research.contains(start) && research.contains(end)) return research;
    return null;
  }

  function pointInSelection(sel: Selection, x: number, y: number): boolean {
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const r of Array.from(sel.getRangeAt(i).getClientRects())) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
          return true;
      }
    }
    return false;
  }

  function currentResearchEntry(): ResearchEntry | null {
    return currentEntryId
      ? (researchHistory.find((r) => r.id === currentEntryId) ?? null)
      : historyIdx >= 0
        ? (researchHistory[historyIdx] ?? null)
        : null;
  }

  function elementForNode(node: Node): Element | null {
    return node instanceof Element ? node : node.parentElement;
  }

  function selectedResearchUrl(
    sel: Selection,
    entry: ResearchEntry | null,
  ): string | undefined {
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      for (const node of [
        range.commonAncestorContainer,
        range.startContainer,
        range.endContainer,
      ]) {
        const el = elementForNode(node);
        if (!el) continue;
        const link =
          el.closest<HTMLAnchorElement>('a[href^="http"]') ??
          el
            .closest(".web-result")
            ?.querySelector<HTMLAnchorElement>(
              'a.web-result-title[href^="http"]',
            );
        if (link?.href) return link.href;
      }
    }
    return entry?.article?.url;
  }

  function readDomSelection(): SelectionContext | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const target = document.activeElement as HTMLElement | null;
    if (target?.closest("input, textarea, select, button, .dropdown"))
      return null;
    let host: HTMLElement | null = null;
    for (let i = 0; i < sel.rangeCount; i++) {
      const h = selectionHostForRange(sel.getRangeAt(i));
      if (!h || (host && h !== host)) return null;
      host = h;
    }
    if (!host) return null;
    const source = sourceFromHost(host);
    if (!source) return null;
    const text = sel.toString();
    if (source === "reader") {
      const note = openNodeId ? byId.get(openNodeId) : null;
      return selectionSlot({
        source,
        text,
        noteId: openNodeId ?? undefined,
        noteTitle: note?.title,
      });
    }
    const entry = currentResearchEntry();
    const article = entry?.article;
    const url = selectedResearchUrl(sel, entry);
    return selectionSlot({
      source,
      text,
      entryId: entry?.id,
      mode: entry?.mode,
      title: article?.title ?? entry?.query,
      query: entry?.query,
      url,
    });
  }

  function captureDomSelection() {
    const slot = readDomSelection();
    if (slot) setSelectionContext(slot);
  }

  document.addEventListener("selectionchange", captureDomSelection);
  document.addEventListener("mouseup", captureDomSelection);
  document.addEventListener("keyup", captureDomSelection);

  const selectionMenu = document.createElement("div");
  selectionMenu.id = "selection-context-menu";
  selectionMenu.className = "hidden";
  document.body.appendChild(selectionMenu);
  function hideSelectionMenu() {
    selectionMenu.classList.add("hidden");
  }
  function showSelectionMenu(x: number, y: number, slot: SelectionContext) {
    setSelectionContext(slot);
    const actions: Array<[string, () => void]> = [
      [
        "Semantic search",
        () => runSemanticQuery("", currentSelectionSnapshot(), "Selected text"),
      ],
      [
        "Keyword search",
        () => runKeywordQuery("", currentSelectionSnapshot(), "Selected text"),
      ],
      [
        "Web search",
        () =>
          runWebQuery("", currentSelectionSnapshot(), "Selected text", false),
      ],
      [
        "Deep research",
        () =>
          runWebQuery("", currentSelectionSnapshot(), "Selected text", true),
      ],
      [
        "Copy",
        () => {
          if (navigator.clipboard)
            void navigator.clipboard.writeText(slot.text).catch(() => {});
        },
      ],
    ];
    selectionMenu.innerHTML = "";
    for (const [label, run] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        hideSelectionMenu();
        run();
      });
      selectionMenu.appendChild(button);
    }
    selectionMenu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
    selectionMenu.style.top = `${Math.min(y, window.innerHeight - 180)}px`;
    selectionMenu.classList.remove("hidden");
  }
  document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest("#reader-body, #research-body")) return;
    const sel = window.getSelection();
    const slot = readDomSelection();
    if (!sel || !slot || !pointInSelection(sel, e.clientX, e.clientY)) return;
    e.preventDefault();
    showSelectionMenu(e.clientX, e.clientY, slot);
  });
  document.addEventListener("click", hideSelectionMenu);

  // ---- integrations: mode buttons (Vault / Web / Ingest) + settings ----
  // At most one mode active at a time; buttons light up only when their tool
  // is detected (GET /api/integrations). Persisted as sinapso-mode.
  type ModeName = "vault" | "web" | "ingest";
  type VaultScope = "semantic" | "keyword";
  type ResearchMode =
    | "web"
    | "semantic"
    | "keyword"
    | "ingest"
    | "article"
    | "document";
  interface IntegrationsStatus {
    tools: {
      qmd: { installed: boolean; version: string | null };
      markitdown: { installed: boolean; version: string | null };
      exa: { configured: boolean };
      openrouter: { configured: boolean };
      deepseek: { configured: boolean };
    };
    consents: { web: boolean };
    defaultModel: string | null;
    llm?: {
      workerProvider: string | null;
      workerModel: string | null;
      thinkerProvider: string | null;
      thinkerModel: string | null;
    };
    writeDestination: string;
    archiveDestination: string;
    imagesDestination: string;
    admin?: {
      activeVaultPath: string | null;
      excludes: string[];
      vaults: Record<
        string,
        {
          path: string;
          excludes?: string[];
          excludesInitialized?: boolean;
          wikis: AdminWikiConfig[];
        }
      >;
      promptDefaults: Record<string, string>;
      prompts: Record<string, string>;
      promptOverrides: Record<string, string | null>;
    };
    voice?: {
      provider: string | null;
      voice: string | null;
      model: string | null;
      keys: { gemini: boolean; openai: boolean; xai: boolean };
    };
  }
  const MODE_LIST = ["vault", "web", "ingest"] as const;
  interface AdminWikiConfig {
    id: string;
    label: string;
    path: string;
    enabled: boolean;
    contractFiles: string[];
    rawDestination: string | null;
    discovered: boolean;
    confidence: "high" | "medium" | "low";
  }
  interface GitStatus {
    available: boolean;
    branch?: string;
    upstream?: string | null;
    clean?: boolean;
    ahead?: number;
    behind?: number;
    files?: Array<{ path: string; status: string }>;
  }
  type GitActionResult = { ok: boolean; output?: string; error?: string };
  interface NoteVersion {
    commit: string;
    committedAt: string;
    subject?: string;
  }
  interface NoteVersionsResponse {
    available: boolean;
    versions?: NoteVersion[];
    versioned?: boolean;
    dirty?: boolean;
  }
  const PROMPT_KEYS = [
    "wikiIngest",
    "noteQuestions",
    "voiceAssistant",
    "webResearch",
  ] as const;
  const PROMPT_LABELS: Record<(typeof PROMPT_KEYS)[number], string> = {
    wikiIngest: "Wiki ingest",
    noteQuestions: "Note questions",
    voiceAssistant: "Voice assistant",
    webResearch: "Web research",
  };
  let integrations: IntegrationsStatus | null = null;
  let activeMode = prefs.getMode();
  let webScope: "deep" | "web" = prefs.getWebScope();
  let vaultScope: VaultScope = prefs.getVaultScope();

  const postConfig = async (patch: object) => {
    const result = await api("/api/integrations/config", { json: patch });
    enabledWikisLoaded = false;
    return result;
  };

  const modeReady = (m: ModeName): boolean => {
    const t = integrations?.tools;
    if (!t) return false;
    return m === "vault"
      ? true
      : m === "web"
        ? t.exa.configured
        : t.markitdown.installed;
  };

  function renderModes() {
    for (const m of MODE_LIST) {
      const b = $(`#mode-${m}`) as HTMLButtonElement;
      b.disabled = !modeReady(m);
      b.title = b.disabled
        ? i18n.t(`mode.${m}.missing`)
        : i18n.t(`mode.${m}.name`);
      b.classList.toggle("active", activeMode === m && !b.disabled);
    }
  }

  // The mode changes what the SEARCH FIELD does (F018) — visible via
  // placeholder + accent. Results open in the research column on Enter.
  function updateSearchField() {
    searchBox.placeholder = i18n.t(`search.ph.${activeMode ?? "none"}`);
    searchBox.classList.toggle("mode-active", !!activeMode);
    const ingest = activeMode === "ingest";
    ($("#ingest-browse") as HTMLElement).classList.toggle("hidden", !ingest);
    searchBox.classList.toggle("with-browse", ingest);
    const web = activeMode === "web";
    ($("#web-scope") as HTMLElement).classList.toggle("hidden", !web);
    const vault = activeMode === "vault";
    ($("#vault-scope") as HTMLElement).classList.toggle("hidden", !vault);
    searchBox.classList.toggle("with-scope", web || vault);
    renderSelectionContextStrip();
  }

  // Fetch enabled wikis for the ingest choice card. Returns [] on failure.
  async function loadEnabledWikis(): Promise<AdminWikiConfig[]> {
    if (enabledWikisLoaded) return enabledWikis;
    if (enabledWikisRequest) return enabledWikisRequest;
    enabledWikisRequest = (async () => {
      try {
        const { wikis } = await api<{ wikis: AdminWikiConfig[] }>("/api/wikis");
        enabledWikis = wikis.filter((w) => w.enabled);
        enabledWikisLoaded = true;
        return enabledWikis;
      } catch {
        enabledWikis = [];
        enabledWikisLoaded = false;
        return [];
      } finally {
        enabledWikisRequest = null;
      }
    })();
    return enabledWikisRequest;
  }

  async function refreshEnabledWikiLayers() {
    enabledWikisLoaded = false;
    enabledWikisRequest = null;
    await loadEnabledWikis();
    if (!enabledWikis.length && groupMode === "wiki") {
      groupMode = "folder";
      prefs.setGroup(groupMode);
    }
    syncGroupSelectOptions();
    computeGroups();
    recomputeColors();
    buildLegend();
    refreshVisibility();
    repaint();
  }

  void refreshEnabledWikiLayers();

  function setMode(m: ModeName | null) {
    // Web mode is gated behind one-time egress consent (R18/AE8).
    if (m === "web" && integrations && !integrations.consents.web) {
      promptWebConsent();
      return;
    }
    activeMode = m && modeReady(m) ? m : null;
    if (activeMode) prefs.setMode(activeMode);
    else prefs.removeMode();
    renderModes();
    updateSearchField();
    // Mode only retargets the search field; it never hides a panel. Each query
    // adds a page to the research column (history nav), and pages survive
    // mode switches. Closing research is the close button's job, not setMode's.
  }
  for (const m of MODE_LIST)
    $(`#mode-${m}`).addEventListener("click", () =>
      setMode(activeMode === m ? null : m),
    );

  // Web-mode scope: Deep research (synthesized answer) vs Web results (a raw
  // result list, like a precise search engine). Shown only in web mode; the
  // choice drives the `deep` flag on the query. Persisted like the other modes.
  function renderWebScope() {
    $("#scope-deep").classList.toggle("active", webScope === "deep");
    $("#scope-web").classList.toggle("active", webScope === "web");
  }
  function setWebScope(s: "deep" | "web") {
    webScope = s;
    prefs.setWebScope(s);
    renderWebScope();
  }
  $("#scope-deep").addEventListener("click", () => setWebScope("deep"));
  $("#scope-web").addEventListener("click", () => setWebScope("web"));
  renderWebScope();

  function renderVaultScope() {
    $("#scope-semantic").classList.toggle("active", vaultScope === "semantic");
    $("#scope-keyword").classList.toggle("active", vaultScope === "keyword");
  }
  function setVaultScope(s: VaultScope) {
    vaultScope = s;
    prefs.setVaultScope(s);
    renderVaultScope();
  }
  $("#scope-semantic").addEventListener("click", () =>
    setVaultScope("semantic"),
  );
  $("#scope-keyword").addEventListener("click", () => setVaultScope("keyword"));
  renderVaultScope();

  // Custom tooltips: one floating element, delegated hover. Hijacks any native
  // `title` (stashes it to data-tip + aria-label, then removes title to kill the
  // slow native bubble) so every titled control gets the same instant tooltip,
  // shown centered below by default. Bottom mobile search controls open upward
  // so the tooltip stays on-screen. --arrow-dx re-aims the arrow when clamped.
  (function initTooltips() {
    const tip = document.createElement("div");
    tip.id = "tooltip";
    document.body.appendChild(tip);
    let cur: HTMLElement | null = null;
    const hide = () => {
      cur = null;
      tip.classList.remove("show");
    };
    const show = (el: HTMLElement, text: string) => {
      cur = el;
      tip.textContent = text;
      tip.classList.add("show");
      const r = el.getBoundingClientRect();
      const topbar = document.getElementById("topbar");
      const above =
        !!el.closest(
          "#topbar.topbar-rail #search-wrap, #selection-context-strip",
        ) ||
        (!!el.closest("#topbar-rail") &&
          !!topbar?.classList.contains("topbar-bottom-rail"));
      tip.classList.toggle("above", above);
      const half = tip.offsetWidth / 2;
      const cx = r.left + r.width / 2;
      const clamped = Math.max(8 + half, Math.min(cx, innerWidth - 8 - half));
      tip.style.left = `${clamped}px`;
      tip.style.top = `${above ? Math.max(8, r.top - tip.offsetHeight - 8) : r.bottom + 8}px`;
      tip.style.setProperty("--arrow-dx", `${cx - clamped}px`);
    };
    document.addEventListener("mouseover", (e) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>(
        "[title], [data-tip]",
      );
      if (!el || el === cur) return;
      const live = el.getAttribute("title");
      if (live) {
        el.dataset.tip = live;
        el.setAttribute("aria-label", live);
        el.removeAttribute("title");
      }
      const text = el.dataset.tip;
      if (text) show(el, text);
    });
    document.addEventListener("mouseout", (e) => {
      if (cur && !cur.contains(e.relatedTarget as Node)) hide();
    });
    for (const ev of ["click", "keydown", "scroll", "wheel"])
      document.addEventListener(ev, () => cur && hide(), true);
  })();

  function renderIntegrationsPanel() {
    const t = integrations?.tools;
    const st = (id: string, txt: string, ok: boolean) => {
      const el = $(`#integ-${id} .integ-status`);
      el.textContent = txt;
      el.classList.toggle("ok", ok);
      // per-tool install button appears only while the tool is missing
      const install = document.querySelector<HTMLButtonElement>(
        `#integ-${id} .integ-install`,
      );
      install?.classList.toggle("hidden", !t || ok);
    };
    // The row label now names only the function (Semantic, Web, …); the engine
    // and its state live here on the right, accent-colored when active. A CLI
    // tool's version line already leads with the engine name ("qmd 0.5.0").
    const cliStatus = (
      engine: string,
      s: { installed: boolean; version: string | null } | undefined,
    ) =>
      !s
        ? "status unavailable"
        : s.installed
          ? (s.version ?? engine)
          : `${engine} · not installed`;
    const keyStatus = (
      engine: string,
      s: { configured: boolean } | undefined,
    ) =>
      !s
        ? "status unavailable"
        : s.configured
          ? `${engine} · key set`
          : `${engine} · no key`;
    st("qmd", cliStatus("qmd", t?.qmd), !!t?.qmd.installed);
    st("exa", keyStatus("Exa", t?.exa), !!t?.exa.configured);
    st(
      "markitdown",
      cliStatus("markitdown", t?.markitdown),
      !!t?.markitdown.installed,
    );
    st(
      "openrouter",
      keyStatus("OpenRouter", t?.openrouter),
      !!t?.openrouter.configured,
    );
    st(
      "deepseek",
      keyStatus("DeepSeek", t?.deepseek),
      !!t?.deepseek.configured,
    );
    if (integrations) {
      // Keys are stored server-side and never echoed back, so the fields
      // are always empty — make the placeholders say a key IS configured.
      const exaKey = $("#exa-key") as HTMLInputElement;
      if (!exaKey.value) {
        exaKey.placeholder = t?.exa.configured
          ? "key configured ✓ — paste + Enter to replace"
          : "Exa API key — paste + Enter";
      }
      const orKey = $("#openrouter-key") as HTMLInputElement;
      if (!orKey.value) {
        orKey.placeholder = t?.openrouter.configured
          ? "key configured ✓ — paste + Enter to replace"
          : "OpenRouter API key — paste + Enter";
      }
      const dsKey = $("#deepseek-key") as HTMLInputElement;
      if (!dsKey.value) {
        dsKey.placeholder = t?.deepseek.configured
          ? "key configured ✓ — paste + Enter to replace"
          : "DeepSeek API key — paste + Enter";
      }
      renderTierSlots();
      const sel = $("#llm-model-select") as HTMLSelectElement;
      const model = integrations.defaultModel ?? "";
      if ([...sel.options].some((o) => o.value === model)) {
        sel.value = model;
        ($("#llm-model") as HTMLInputElement).classList.add("hidden");
      } else if (model) {
        sel.value = "__custom";
        const custom = $("#llm-model") as HTMLInputElement;
        custom.classList.remove("hidden");
        custom.value = model;
      } else {
        sel.value = "";
        ($("#llm-model") as HTMLInputElement).classList.add("hidden");
      }
      // "browse models" link shows only while the custom option is active
      $("#llm-model-help").classList.toggle("hidden", sel.value !== "__custom");
    }
    // Live-validate the OpenRouter key for free (GET /key); Exa has no free
    // check, so it stays at "key set" until Web mode actually runs.
    if (t?.openrouter.configured) void testOpenRouter();
    if (t?.deepseek.configured) void testDeepseek();
  }

  // Free DeepSeek key validation via the models-list endpoint.
  async function testDeepseek() {
    const el = $("#integ-deepseek .integ-status");
    el.textContent = "DeepSeek · testing…";
    el.classList.remove("ok", "warn");
    try {
      const r = await api<{
        configured: boolean;
        ok?: boolean;
        unreachable?: boolean;
      }>("/api/integrations/test/deepseek");
      if (!r.configured) el.textContent = "DeepSeek · no key";
      else if (r.unreachable) el.textContent = "DeepSeek · unreachable";
      else if (!r.ok) el.textContent = "DeepSeek · invalid key";
      else {
        el.textContent = "DeepSeek · ready";
        el.classList.add("ok");
      }
    } catch {
      el.textContent = "DeepSeek · unreachable";
    }
  }

  // Free OpenRouter key validation → real status + remaining credit.
  async function testOpenRouter() {
    const el = $("#integ-openrouter .integ-status");
    el.textContent = "OpenRouter · testing…";
    el.classList.remove("ok", "warn");
    try {
      const r = await api<{
        configured: boolean;
        ok?: boolean;
        usage?: number;
        limit?: number | null;
        unreachable?: boolean;
      }>("/api/integrations/test/openrouter");
      if (!r.configured) {
        el.textContent = "OpenRouter · no key";
        return;
      }
      if (r.unreachable) {
        el.textContent = "OpenRouter · unreachable";
        return;
      }
      if (!r.ok) {
        el.textContent = "OpenRouter · invalid key";
        return;
      }
      const left =
        r.limit == null ? null : Math.max(0, r.limit - (r.usage ?? 0));
      if (left != null && left <= 0) {
        // Valid key but no credit — the "Add credits ↗" link sits right below.
        el.textContent = "OpenRouter · out of credits";
        el.classList.add("warn");
        return;
      }
      el.textContent =
        left == null
          ? "OpenRouter · ready"
          : `OpenRouter · $${left.toFixed(2)} left`;
      el.classList.add("ok");
    } catch {
      el.textContent = "OpenRouter · unreachable";
    }
  }

  async function refreshIntegrations(recheck = false) {
    try {
      integrations = await api<IntegrationsStatus>(
        `/api/integrations${recheck ? "?refresh=1" : ""}`,
      );
    } catch {
      integrations = null; // server unreachable; buttons stay disabled
    }
    renderModes();
    renderIntegrationsPanel();
    renderVoiceConfig();
  }

  const exaKeyInput = $("#exa-key") as HTMLInputElement;
  exaKeyInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const v = exaKeyInput.value.trim();
    if (!v) return;
    exaKeyInput.disabled = true;
    try {
      await postConfig({ exaKey: v });
      exaKeyInput.value = "";
      exaKeyInput.placeholder = "key saved ✓";
      await refreshIntegrations();
    } catch {
      exaKeyInput.placeholder = "save failed — retry";
    } finally {
      exaKeyInput.disabled = false;
    }
  });
  // OpenRouter key (BYO) + curated follow-up model picker. The key powers
  // LLM-generated note questions; the model is saved as defaultModel.
  const openrouterKeyInput = $("#openrouter-key") as HTMLInputElement;
  openrouterKeyInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const v = openrouterKeyInput.value.trim();
    if (!v) return;
    openrouterKeyInput.disabled = true;
    try {
      await postConfig({ openrouterKey: v });
      openrouterKeyInput.value = "";
      openrouterKeyInput.placeholder = "key saved ✓";
      await refreshIntegrations();
    } catch {
      openrouterKeyInput.placeholder = "save failed — retry";
    } finally {
      openrouterKeyInput.disabled = false;
    }
  });
  const llmModelSelect = $("#llm-model-select") as HTMLSelectElement;
  const llmModelInput = $("#llm-model") as HTMLInputElement;
  llmModelSelect.addEventListener("change", () => {
    const custom = llmModelSelect.value === "__custom";
    $("#llm-model-help").classList.toggle("hidden", !custom);
    if (custom) {
      llmModelInput.classList.remove("hidden");
      llmModelInput.focus();
      return;
    }
    llmModelInput.classList.add("hidden");
    postConfig({ defaultModel: llmModelSelect.value || null }).catch(() =>
      refreshIntegrations(),
    );
  });
  llmModelInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const v = llmModelInput.value.trim();
    try {
      await postConfig({ defaultModel: v || null });
      if ([...llmModelSelect.options].some((o) => o.value === v)) {
        llmModelSelect.value = v;
        llmModelInput.classList.add("hidden");
      }
      llmModelInput.placeholder = "model saved ✓";
    } catch {
      llmModelInput.placeholder = "save failed — retry";
    }
  });
  // DeepSeek key (BYO), mirroring the OpenRouter block. Powers the fixed
  // v4 pair when a tier slot selects the DeepSeek provider.
  const deepseekKeyInput = $("#deepseek-key") as HTMLInputElement;
  deepseekKeyInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const v = deepseekKeyInput.value.trim();
    if (!v) return;
    deepseekKeyInput.disabled = true;
    try {
      await postConfig({ deepseekKey: v });
      deepseekKeyInput.value = "";
      deepseekKeyInput.placeholder = "key saved ✓";
      await refreshIntegrations();
    } catch {
      deepseekKeyInput.placeholder = "save failed — retry";
    } finally {
      deepseekKeyInput.disabled = false;
    }
  });
  // ---- Model tiers (worker/thinker): per-slot provider select plus a
  // parameterized model picker (KTD8). Option state is computed by the pure
  // pickerState() helper; DeepSeek slots show the fixed model label (AE1).
  function wireModelPicker(tier: "worker" | "thinker"): () => void {
    const provider = $(`#${tier}-provider`) as HTMLSelectElement;
    const modelCol = $(`#${tier}-model-col`);
    const model = $(`#${tier}-model`) as HTMLSelectElement;
    const custom = $(`#${tier}-model-custom`) as HTMLInputElement;
    const fixed = $(`#${tier}-fixed`);
    // Clone the curated options from the legacy picker: one list, no drift.
    for (const o of [...llmModelSelect.options]) {
      const opt = o.cloneNode(true) as HTMLOptionElement;
      if (opt.value === "") opt.textContent = "default";
      model.add(opt);
    }
    const curated = [...model.options]
      .map((o) => o.value)
      .filter((v) => v && v !== "__custom");
    const render = () => {
      const cfg = integrations?.llm;
      const p = tier === "worker" ? cfg?.workerProvider : cfg?.thinkerProvider;
      const m = tier === "worker" ? cfg?.workerModel : cfg?.thinkerModel;
      const st = pickerState(tier, p ?? null, m ?? null, curated);
      provider.value = st.providerValue;
      modelCol.classList.toggle("hidden", !st.modelSelectVisible);
      model.value = st.modelSelectValue;
      custom.classList.toggle("hidden", !st.customVisible);
      if (st.customVisible) custom.value = st.customValue;
      fixed.classList.toggle("hidden", !st.fixedLabel);
      fixed.textContent = st.fixedLabel ?? "";
    };
    const save = (patch: object) =>
      postConfig(patch)
        .then(() => refreshIntegrations())
        .catch(() => refreshIntegrations());
    provider.addEventListener("change", () => {
      void save(
        tier === "worker"
          ? { workerProvider: provider.value || null }
          : { thinkerProvider: provider.value || null },
      );
    });
    model.addEventListener("change", () => {
      if (model.value === "__custom") {
        custom.classList.remove("hidden");
        custom.focus();
        return;
      }
      void save(
        tier === "worker"
          ? { workerModel: model.value || null }
          : { thinkerModel: model.value || null },
      );
    });
    custom.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const v = custom.value.trim();
      void save(
        tier === "worker"
          ? { workerModel: v || null }
          : { thinkerModel: v || null },
      );
    });
    return render;
  }
  const renderWorkerSlot = wireModelPicker("worker");
  const renderThinkerSlot = wireModelPicker("thinker");
  function renderTierSlots() {
    renderWorkerSlot();
    renderThinkerSlot();
  }
  // ---- Voice Assistant config (Tools menu): provider → voice + per-provider
  // key. Keys post to the same 0600 config the local voice relay reads; the
  // browser only ever learns whether a key is present (booleans), never the key.
  // Voice lists verified from each provider's official docs (Jul 2026).
  const VOICE_PROVIDERS: Record<
    string,
    { label: string; keyUrl: string; voices: string[] }
  > = {
    gemini: {
      label: "Gemini Live",
      keyUrl: "https://aistudio.google.com/api-keys",
      // native-audio voices (common 8 first, then the rest of the 30)
      voices: [
        "Aoede",
        "Charon",
        "Fenrir",
        "Kore",
        "Leda",
        "Orus",
        "Puck",
        "Zephyr",
        "Achernar",
        "Achird",
        "Algenib",
        "Algieba",
        "Alnilam",
        "Autonoe",
        "Callirrhoe",
        "Despina",
        "Enceladus",
        "Erinome",
        "Gacrux",
        "Iapetus",
        "Laomedeia",
        "Pulcherrima",
        "Rasalgethi",
        "Sadachbia",
        "Sadaltager",
        "Schedar",
        "Sulafat",
        "Umbriel",
        "Vindemiatrix",
        "Zubenelgenubi",
      ],
    },
    openai: {
      label: "OpenAI Realtime",
      keyUrl: "https://platform.openai.com/settings/organization/api-keys",
      voices: [
        "marin",
        "cedar",
        "alloy",
        "ash",
        "ballad",
        "coral",
        "echo",
        "sage",
        "shimmer",
        "verse",
      ],
    },
    xai: {
      label: "xAI Grok",
      keyUrl: "https://console.x.ai/",
      voices: ["eve", "ara", "rex", "sal", "leo"],
    },
  };
  const voiceProviderSel = $("#voice-provider") as HTMLSelectElement;
  const voiceNameSel = $("#voice-name") as HTMLSelectElement;
  const voiceModelSel = $("#voice-model") as HTMLSelectElement;
  const voiceKeyInput = $("#voice-key") as HTMLInputElement;
  const voiceToggle = $("#voice-toggle") as HTMLButtonElement;
  let voiceSession: VoiceSession | null = null;
  let restartVoiceAfterClose = false;

  function syncVoiceContext(displayAcknowledgment?: ResearchDisplayAcknowledgment & {
    requestId?: string;
  }) {
    voiceSession?.sendContext({
      ...currentSelectionSnapshot(),
      view: {
        readerNoteId: $("#reader").classList.contains("hidden") ? null : openNodeId,
        researchPanelOpen: !$("#research").classList.contains("hidden"),
        visibleResearchId: currentVisibleResearchId(),
        pinnedResearchId: pinnedResearchEntryId,
      },
      ...(displayAcknowledgment ? { displayAcknowledgment } : {}),
    });
  }

  function renderVoiceConfig() {
    const v = integrations?.voice;
    // Provider always resolves to a real backend (Gemini default); the assistant
    // is turned on/off by the search-bar toggle, not by an "off" provider.
    const provider = (v?.provider ?? "gemini") as keyof typeof VOICE_PROVIDERS;
    const spec = VOICE_PROVIDERS[provider];
    voiceProviderSel.value = provider;
    voiceNameSel.innerHTML = "";
    for (const name of spec.voices) {
      const o = document.createElement("option");
      o.value = o.textContent = name;
      voiceNameSel.appendChild(o);
    }
    voiceNameSel.value =
      v?.voice && spec.voices.includes(v.voice) ? v.voice : spec.voices[0];
    // Gemini live model selector (KTD5): only Gemini sessions have one.
    $("#voice-model-row").classList.toggle("hidden", provider !== "gemini");
    voiceModelSel.value =
      v?.model && [...voiceModelSel.options].some((o) => o.value === v.model)
        ? v.model
        : "";
    const keyed = !!v?.keys[provider as "gemini" | "openai" | "xai"];
    voiceKeyInput.placeholder = i18n.t(
      keyed ? "ph.voiceKeySaved" : "ph.voiceKey",
      { provider: spec.label },
    );
    ($("#voice-key-link") as HTMLAnchorElement).href = spec.keyUrl;
    const status = $("#integ-voice .integ-status");
    status.textContent = i18n.t(keyed ? "voice.ready" : "voice.needsKey");
    status.classList.toggle("ok", keyed);
    // The search-bar toggle is enabled only once a key exists (mirrors the mode
    // buttons); don't touch it while a session is live.
    if (!voiceSession) {
      voiceToggle.disabled = !keyed;
      voiceToggle.title = i18n.t(keyed ? "voice.toggle" : "voice.configure");
    }
  }

  // ---- search-bar Connect button: start/stop a realtime voice session ----
  function setVoiceActive(on: boolean) {
    voiceToggle.classList.toggle("active", on);
    voiceToggle.setAttribute("aria-pressed", String(on));
    voiceToggle.title = i18n.t(on ? "voice.stop" : "voice.toggle");
    const dot = $("#voice-dot");
    const status = $("#voice-status");
    if (on && voiceSession) {
      voiceStartedAt = Date.now();
      mountVoiceSpectrum(voiceSession);
      if (voiceTimer == null)
        voiceTimer = window.setInterval(updateBrandStats, 1000);
      if (dot) dot.classList.add("pulse");
      if (status) status.classList.add("show");
    } else {
      unmountVoiceSpectrum();
      if (voiceTimer != null) {
        clearInterval(voiceTimer);
        voiceTimer = null;
      }
      if (dot) dot.classList.remove("pulse");
      if (status) {
        status.textContent = "";
        status.classList.remove("show");
      }
      if (voiceStatusTimer != null) {
        clearTimeout(voiceStatusTimer);
        voiceStatusTimer = null;
      }
    }
    updateBrandStats();
  }

  // ---- voice waveform spectrum: a subtle line above #brand-stats that reads
  // the live mic (human) and agent-playback analysers exposed by voice.ts.
  // One color at a time (turn-taking is strict); idle renders a flat dim line.
  let spectrumRaf = 0;
  let speakingState: "idle" | "human" | "agent" = "idle";
  function mountVoiceSpectrum(session: VoiceSession) {
    const canvas = $("#voice-spectrum") as HTMLCanvasElement | null;
    if (!canvas) return;
    const mic = session.micAnalyser;
    const agent = session.agentAnalyser;
    if (!mic || !agent) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.classList.add("live");
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = rect.width || 180;
    const h = rect.height || 32;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const micBuf = new Uint8Array(mic.fftSize);
    const agentBuf = new Uint8Array(agent.fftSize);
    const { accent, complement } = spectrumThemeColors();
    const ON = 0.045,
      OFF = 0.02; // speaking thresholds with hysteresis (tunable at impl)
    const rms = (b: Uint8Array) => {
      let s = 0;
      for (let i = 0; i < b.length; i++) {
        const v = (b[i] - 128) / 128;
        s += v * v;
      }
      return Math.sqrt(s / b.length);
    };
    const draw = () => {
      spectrumRaf = requestAnimationFrame(draw);
      mic.getByteTimeDomainData(micBuf);
      agent.getByteTimeDomainData(agentBuf);
      const mA = rms(micBuf);
      const aA = rms(agentBuf);
      if (speakingState === "idle") {
        if (mA > ON) speakingState = "human";
        else if (aA > ON) speakingState = "agent";
      } else {
        const cur = speakingState === "human" ? mA : aA;
        if (cur < OFF) {
          if (mA > ON) speakingState = "human";
          else if (aA > ON) speakingState = "agent";
          else speakingState = "idle";
        }
      }
      let color: string, alpha: number, buf: Uint8Array;
      if (speakingState === "human") {
        color = complement;
        alpha = 0.9;
        buf = micBuf;
      } else if (speakingState === "agent") {
        color = accent;
        alpha = 0.9;
        buf = agentBuf;
      } else {
        color = accent;
        alpha = 0.16;
        buf = micBuf; // flat dim trace at rest
      }
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const n = buf.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const v = (buf[i] - 128) / 128;
        const y = h / 2 + v * (h / 2 - 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    draw();
  }
  function unmountVoiceSpectrum() {
    if (spectrumRaf) cancelAnimationFrame(spectrumRaf);
    spectrumRaf = 0;
    speakingState = "idle";
    const canvas = $("#voice-spectrum");
    if (canvas) canvas.classList.remove("live");
  }
  function spectrumThemeColors(): { accent: string; complement: string } {
    const accent =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim() || "#58a6ff";
    return { accent, complement: spectrumComplement(accent) };
  }
  async function startVoiceSession() {
    voiceToggle.disabled = true;
    voiceToggle.title = i18n.t("voice.connecting");
    try {
      const session = await startVoice(await getApiToken(), {
        onReady: () => {
          voiceToggle.disabled = false;
          setVoiceActive(true);
          syncVoiceContext();
        },
        onClose: () => {
          const shouldRestart = restartVoiceAfterClose;
          restartVoiceAfterClose = false;
          voiceSession = null;
          setVoiceActive(false);
          renderVoiceConfig(); // restore enabled/title from config
          if (shouldRestart) void startVoiceSession();
        },
        onError: (msg) => {
          console.warn("[voice]", msg);
          voiceToggle.title = msg;
        },
        onStatus: (payload) => {
          const el = $("#voice-status");
          if (!el) return;
          const key = String(payload.key ?? "");
          const vars: Record<string, string | number> = {};
          for (const [k, v] of Object.entries(payload)) {
            if (
              k !== "key" &&
              k !== "type" &&
              (typeof v === "string" || typeof v === "number")
            )
              vars[k] = v;
          }
          el.textContent = i18n.t(key, vars);
          if (voiceStatusTimer != null) clearTimeout(voiceStatusTimer);
          voiceStatusTimer = window.setTimeout(() => {
            el.textContent = "";
            voiceStatusTimer = null;
          }, 4000);
        },
        onAction: async (action, p) => {
          // the agent drives the panels: open a note in the reader, or reopen
          // a stored research entry, then reports the browser's actual outcome.
          if (action === "open_note") {
            const n = byId.get(String(p.note ?? ""));
            if (n) select(n);
          } else if (
            action === "open_research" ||
            action === "show_document"
          ) {
            // History creation is independent from display. Reload first so a
            // newly-created agent entry remains reachable even when pinning
            // prevents it from replacing the user's current view.
            const acknowledgment = await showAgentResearch(String(p.id ?? ""));
            syncVoiceContext({
              ...acknowledgment,
              requestId: String(p.requestId ?? ""),
            });
          } else if (action === "open_saved_note") {
            const note = String(p.note ?? "");
            if (note) void openAfterIngest(note).then(loadHistory);
          } else if (action === "archived_note") {
            clearSelection();
            void rescan(false);
          }
        },
      });
      voiceSession = session;
    } catch {
      voiceSession = null;
      setVoiceActive(false);
      voiceToggle.disabled = false;
    }
  }

  function restartLiveVoiceIfKeyed(provider: string) {
    if (!voiceSession) return;
    const keyed =
      !!integrations?.voice?.keys[provider as "gemini" | "openai" | "xai"];
    restartVoiceAfterClose = keyed;
    voiceSession.stop(); // provider voices are fixed at session setup
  }

  voiceToggle.addEventListener("click", async () => {
    if (voiceSession) {
      voiceSession.stop(); // onClose resets the button + config-driven state
      return;
    }
    await startVoiceSession();
  });

  voiceProviderSel.addEventListener("change", async () => {
    const provider = voiceProviderSel.value;
    const voice = VOICE_PROVIDERS[provider].voices[0];
    try {
      await postConfig({ voice: { provider, voice } });
      await refreshIntegrations();
      restartLiveVoiceIfKeyed(provider);
    } catch {
      await refreshIntegrations();
    }
  });
  voiceNameSel.addEventListener("change", async () => {
    // commit the provider alongside the voice so config never lags the UI
    const provider = voiceProviderSel.value;
    try {
      await postConfig({
        voice: { provider, voice: voiceNameSel.value },
      });
      await refreshIntegrations();
      restartLiveVoiceIfKeyed(provider);
    } catch {
      await refreshIntegrations();
    }
  });
  voiceModelSel.addEventListener("change", async () => {
    try {
      await postConfig({ voice: { model: voiceModelSel.value || null } });
      await refreshIntegrations();
      restartLiveVoiceIfKeyed("gemini");
    } catch {
      await refreshIntegrations();
    }
  });
  voiceKeyInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const provider = voiceProviderSel.value;
    const val = voiceKeyInput.value.trim();
    if (!val) return;
    voiceKeyInput.disabled = true;
    try {
      await postConfig({ voice: { provider, keys: { [provider]: val } } });
      voiceKeyInput.value = "";
      await refreshIntegrations();
    } catch {
      voiceKeyInput.placeholder = i18n.t("ph.voiceKeyFail");
    } finally {
      voiceKeyInput.disabled = false;
    }
  });

  $("#integ-recheck").addEventListener("click", () =>
    refreshIntegrations(true).then(() => refreshQmdStatus()),
  );
  // Per-tool installs (KTD8): each missing integration offers its own
  // install button; existing installs are never touched. Extensible: new
  // integrations (e.g. markitdown) just add a row + data-tool.
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    ".integ-install",
  )) {
    btn.addEventListener("click", async () => {
      const tool = btn.dataset.tool!;
      btn.disabled = true;
      btn.textContent = "installing…";
      try {
        const data = await api<{
          error?: string;
          results?: Array<{
            tool: string;
            status: string;
            detail: string;
          }>;
        }>("/api/integrations/install", { json: { tools: [tool] } });
        const r = data.results?.[0];
        if (r?.status === "instructions" || r?.status === "failed") {
          showModal(
            `Install ${tool}`,
            `<p><b>${r.status}</b></p><p class="muted"></p>`,
          );
          ($("#modal-body .muted") as HTMLElement).textContent = r.detail;
        }
        await refreshIntegrations(true).then(() => refreshQmdStatus());
      } catch {
        showModal(
          "Install failed",
          `<p>Could not install ${tool}. Check the server log.</p>`,
        );
      } finally {
        btn.disabled = false;
        btn.textContent = "install";
      }
    });
  }
  const integrationsLoaded = refreshIntegrations().then(() =>
    refreshQmdStatus(),
  );

  // ---- semantic surfaces: related notes, setup prompt, collection toggles (U4) ----
  type QmdState = "missing" | "uncovered" | "indexing" | "error" | "ready";
  let qmdStatus: { state: QmdState; collections?: string[] } = {
    state: "missing",
  };
  let autoMaintFired = false;
  async function refreshQmdStatus(skipAutoMaint = false) {
    if (!integrations?.tools.qmd.installed) {
      qmdStatus = { state: "missing" };
    } else {
      try {
        qmdStatus = await api<{ state: QmdState; collections?: string[] }>(
          "/api/qmd/status",
        );
      } catch {
        qmdStatus = { state: "error" };
      }
    }
    renderQmdSettings();
    maybePromptSetup();
    void refreshMaint();
    if (!skipAutoMaint && !autoMaintFired && qmdStatus.state === "ready") {
      autoMaintFired = true;
      const update = prefs.getAutoUpdate();
      const embed = prefs.getAutoEmbed();
      if (update || embed) void startMaint(update, embed);
    }
  }

  function renderQmdSettings() {
    const btn = $("#qmd-enable") as HTMLButtonElement;
    const show =
      qmdStatus.state === "uncovered" || qmdStatus.state === "indexing";
    btn.classList.toggle("hidden", !show);
    btn.disabled = qmdStatus.state === "indexing";
    btn.textContent =
      qmdStatus.state === "indexing"
        ? "semantic indexing…"
        : "enable semantic search";
  }

  async function startQmdSetup() {
    try {
      await api("/api/qmd/setup", { method: "POST" });
      qmdStatus = { state: "indexing" };
      renderQmdSettings();
      showModal(
        "Semantic indexing started",
        "<p>qmd is indexing this vault in the background. Related notes and semantic search will show an “indexing” state until embeddings are ready.</p>",
      );
    } catch {
      showModal(
        "Setup failed",
        "<p>Could not start qmd setup. Check the server log.</p>",
      );
    }
  }
  $("#qmd-enable").addEventListener("click", startQmdSetup);

  // ---- qmd index maintenance (A): user-controlled update/embed + progress ----
  interface MaintStatus {
    available: boolean;
    running?: boolean;
    op?: "update" | "embed";
    error?: string;
    index?: {
      total: number;
      vectors: number;
      pending: number;
      updatedAgo: string;
    } | null;
  }
  let maintPoll: number | null = null;
  let maintMaxPending = 0;
  let maintForceRunning = false;
  async function refreshMaint() {
    let m: MaintStatus;
    try {
      m = await api<MaintStatus>("/api/qmd/maintenance");
    } catch {
      return;
    }
    const wrap = $("#qmd-maint");
    // Only meaningful once the vault is actually covered by qmd.
    if (!m.available || qmdStatus.state !== "ready") {
      wrap.classList.add("hidden");
      if (!rescanRunning) setOpsStatus(null);
      return;
    }
    wrap.classList.remove("hidden");
    const running = !!m.running;
    ($("#qmd-update") as HTMLButtonElement).disabled = running;
    ($("#qmd-embed") as HTMLButtonElement).disabled = running;
    const bar = $("#qmd-maint-bar");
    const fill = bar.querySelector("span") as HTMLElement;
    const pending = m.index?.pending ?? 0;
    const stale = m.index?.updatedAgo ? ` · updated ${m.index.updatedAgo}` : "";
    if (running) {
      bar.classList.remove("hidden");
      // embed shrinks Pending from its peak to 0; update has no such signal, so
      // it just shows a small "working" sliver.
      maintMaxPending = Math.max(maintMaxPending, pending, 1);
      const pct =
        m.op === "embed"
          ? Math.round((1 - pending / maintMaxPending) * 100)
          : 8;
      fill.style.width = Math.max(6, pct) + "%";
      $("#qmd-maint-status").textContent =
        `${m.op === "embed" ? "embedding" : "updating"}… ${pending} pending`;
      if (!rescanRunning) {
        setOpsStatus({
          label: i18n.t(
            m.op === "embed"
              ? maintForceRunning
                ? "ops.qmdReembed"
                : "ops.qmdEmbed"
              : "ops.qmdUpdate",
          ),
          detail: i18n.t("ops.pending", { count: pending }),
          pct: m.op === "embed" ? Math.max(6, pct) : undefined,
          indeterminate: m.op !== "embed",
        });
      }
      if (maintPoll == null) maintPoll = window.setInterval(refreshMaint, 2000);
    } else {
      if (maintPoll != null) {
        clearInterval(maintPoll);
        maintPoll = null;
      }
      maintMaxPending = 0;
      maintForceRunning = false;
      bar.classList.add("hidden");
      fill.style.width = "0";
      $("#qmd-maint-status").textContent = m.error
        ? `error: ${m.error}`
        : pending
          ? `${pending} pending${stale}`
          : `index up to date${stale}`;
      if (!rescanRunning) setOpsStatus(null);
    }
  }
  async function startMaint(update: boolean, embed: boolean, force = false) {
    try {
      const q = new URLSearchParams();
      if (update) q.set("update", "1");
      if (embed) q.set("embed", "1");
      if (force) q.set("force", "1");
      try {
        await api(`/api/qmd/maintenance?${q}`, { method: "POST" });
      } catch (e) {
        // Incremental maintenance can piggyback on an existing job; forced
        // re-embed must not pretend it started if another job is already busy.
        if (force && e instanceof ApiError && e.status === 409) {
          await refreshMaint();
          return false;
        }
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
      }
      maintForceRunning = force && embed;
      maintMaxPending = 0;
      await refreshMaint();
      return true;
    } catch {
      maintForceRunning = false;
      if (!rescanRunning) setOpsStatus(null);
      $("#qmd-maint-status").textContent =
        "could not start — check the server log";
      return false;
    }
  }
  // update: re-index changed notes (BM25). embed: new/changed chunks only.
  $("#qmd-update").addEventListener("click", () => startMaint(true, false));
  $("#qmd-embed").addEventListener("click", () => startMaint(false, true));
  const cbUpd = $("#qmd-auto-update") as HTMLInputElement;
  const cbEmb = $("#qmd-auto-embed") as HTMLInputElement;
  cbUpd.checked = prefs.getAutoUpdate();
  cbEmb.checked = prefs.getAutoEmbed();
  cbUpd.addEventListener("change", () => prefs.setAutoUpdate(cbUpd.checked));
  cbEmb.addEventListener("change", () => prefs.setAutoEmbed(cbEmb.checked));

  // One-time prompt (R6): qmd installed but nothing covers this vault.
  function maybePromptSetup() {
    if (qmdStatus.state !== "uncovered" || prefs.wasQmdPrompted()) return;
    prefs.markQmdPrompted();
    showModal(
      "Enable semantic search?",
      `<p>qmd is installed, but no collection covers this vault yet. Sinapso can create one and index it in the background to power related notes and semantic search.</p>
       <p style="display:flex;gap:8px"><button id="qmd-setup-yes">Enable</button><button id="qmd-setup-no">Not now</button></p>
       <p class="muted">You can enable it later in Tools → Integrations.</p>`,
    );
    $("#qmd-setup-yes").addEventListener("click", () => {
      void hideModal();
      void startQmdSetup();
    });
    $("#qmd-setup-no").addEventListener("click", hideModal);
  }

  // "Related notes (semantic)" section at the end of every note (R4/R5).
  // Loads async and never blocks reading; error is distinct from empty so a
  // qmd failure does not read as "no related notes".
  let relatedToken = 0;
  function refreshRelated(n: GNode) {
    const existing = $("#reader-body").querySelector("#related");
    const slot =
      (existing?.parentElement as HTMLElement | null) ?? $("#reader-body");
    existing?.remove();
    void appendRelated(n, slot);
  }

  async function appendRelated(n: GNode, body: HTMLElement) {
    if (integrations === null) await integrationsLoaded; // first open can beat the status fetch
    if (!integrations?.tools.qmd.installed) return; // AE1: no dead chrome without qmd
    const token = ++relatedToken;
    const box = document.createElement("section");
    box.id = "related";
    box.innerHTML =
      '<h3>Related notes <span class="rel-tag">semantic</span></h3><p class="rel-info muted">finding related notes…</p>';
    body.appendChild(box);
    try {
      const data = await api<{
        state: string;
        results?: Array<{ id: string; title: string; snippet: string }>;
      }>(`/api/related?id=${encodeURIComponent(n.id)}`);
      if (token !== relatedToken) return;
      const info = box.querySelector(".rel-info") as HTMLElement;
      if (data.state === "indexing") {
        info.textContent = "index building — results will appear when ready";
        return;
      }
      if (data.state === "uncovered") {
        info.textContent =
          "semantic search is not set up for this vault (Tools → Integrations)";
        return;
      }
      const results = data.results ?? [];
      if (!results.length) {
        info.textContent = "no related notes found";
        return;
      }
      info.remove();
      for (const res of results) {
        const node = byId.get(res.id);
        if (!node) continue;
        const row = document.createElement("div");
        row.className = "rel-row";
        const title = document.createElement("span");
        title.className = "rel-title";
        title.textContent = node.title;
        const snip = document.createElement("span");
        snip.className = "rel-snippet";
        snip.textContent = res.snippet;
        row.append(title, snip);
        row.addEventListener("click", () => select(node, res.snippet));
        box.appendChild(row);
      }
    } catch {
      if (token !== relatedToken) return;
      const info = box.querySelector(".rel-info") as HTMLElement | null;
      if (info)
        info.textContent = "related notes unavailable (semantic search error)";
    }
  }

  // ---- Web mode: consent gate, gap suggestions, research panel (U8) ----
  function promptWebConsent() {
    showModal(
      "Enable Web research?",
      `<p>Web mode sends your queries to <b>Exa</b>, a web search API, using your own key. Queries can include note titles and topics from this vault, so <b>content derived from your vault leaves this machine</b> when you run a search.</p>
       <p>Nothing is sent until you run a query, and saving results back into the vault is always an explicit action.</p>
       <p style="display:flex;gap:8px"><button id="web-consent-yes">Enable Web mode</button><button id="web-consent-no">Cancel</button></p>`,
    );
    $("#web-consent-yes").addEventListener("click", async () => {
      void hideModal();
      try {
        await postConfig({ consents: { web: true } });
        await refreshIntegrations();
        setMode("web");
      } catch {
        showModal(
          "Could not save consent",
          "<p>The server rejected the consent update. Try again.</p>",
        );
      }
    });
    $("#web-consent-no").addEventListener("click", hideModal); // declining sends nothing (AE8)
  }

  // ---- research column (F018): one shared right-side column for
  // semantic/web results. The search field is the entry point; the
  // column owns follow-ups via its own input.
  let researchMode: ResearchMode | null = null;

  // Research history (app-local): every web/vault result is persisted; the
  // column pages back through them and can trash/curate. See server
  // research-history.ts + /api/research/history.
  type ArticleData = {
    url: string;
    title: string;
    content: string;
    publishedDate: string | null;
    author: string | null;
  };
  type ResearchEntry = {
    id: string;
    ts: string;
    mode: "web" | "semantic" | "keyword" | "article" | "document";
    query: string;
    answer?: {
      content: string;
      citations: Array<{ url: string; title: string }>;
    } | null;
    results?: unknown[];
    article?: ArticleData;
    document?: { title: string; content: string; revision: string };
  };
  let researchHistory: ResearchEntry[] = [];
  let historyIdx = -1; // position in researchHistory (0 = newest); -1 = none
  let currentEntryId: string | null = null; // id of the shown entry (for move/trash)
  let researchDocumentEditor: NoteEditor | null = null;
  let researchDocumentController: ResearchDocumentController | null = null;
  let pinnedResearchEntryId: string | null = null;

  function currentVisibleResearchId(): string | null {
    return $("#research").classList.contains("hidden") ? null : currentEntryId;
  }

  function announceResearch(message: string) {
    $("#research-status").textContent = "";
    requestAnimationFrame(() => {
      $("#research-status").textContent = message;
    });
  }

  function syncResearchPinUi() {
    const pin = $("#research-pin") as HTMLButtonElement;
    const on = pinnedResearchEntryId !== null;
    pin.setAttribute("aria-pressed", String(on));
    const key = on ? "research.unpin" : "research.pin";
    pin.title = i18n.t(key);
    pin.setAttribute("aria-label", i18n.t(key));
  }

  function setResearchPinned(on: boolean, announce = true) {
    pinnedResearchEntryId = on ? currentVisibleResearchId() : null;
    syncResearchPinUi();
    if (announce)
      announceResearch(
        i18n.t(pinnedResearchEntryId ? "research.pinned" : "research.unpinned"),
      );
    syncVoiceContext();
  }

  function hasUnsavedResearchDocumentEdits(): boolean {
    return researchDocumentController?.autosave.isDirty() ?? false;
  }

  function emitResearchDisplayAcknowledgment(
    decision: ResearchDisplayAcknowledgment["decision"],
  ) {
    const detail: ResearchDisplayAcknowledgment = {
      decision,
      visibleId: currentVisibleResearchId(),
      pinnedId: pinnedResearchEntryId,
    };
    window.dispatchEvent(
      new CustomEvent("sinapso:research-display-ack", { detail }),
    );
    return detail;
  }

  function agentMayShowResearch(id: string, targetExists: boolean) {
    return decideAgentResearchDisplay({
      targetId: id,
      visibleId: currentVisibleResearchId(),
      pinnedId: pinnedResearchEntryId,
      hasUnsavedLocalEdits: hasUnsavedResearchDocumentEdits(),
      targetExists,
    });
  }

  async function showAgentResearch(id: string) {
    await loadHistory();
    const i = researchHistory.findIndex((entry) => entry.id === id);
    const decision = agentMayShowResearch(id, i >= 0);
    if (decision === "shown") {
      historyIdx = i;
      showHistoryEntry(researchHistory[i]);
      if (pinnedResearchEntryId === id)
        announceResearch(i18n.t("research.refreshed"));
    } else if (decision === "blocked-dirty") {
      researchError(i18n.t("research.refreshConflict"));
      announceResearch(i18n.t("research.refreshConflict"));
    }
    return emitResearchDisplayAcknowledgment(decision);
  }
  // Reflow the topbar around docked panels (they overlay it: panel z-index 20 >
  // topbar 10). The menu centers on screen only while the LEFT (content) panel
  // is docked; the search bar drops to a centered second row when the right side
  // is covered by a panel or it would collide with the menu, and returns to the
  // right when there is room. Re-run by a MutationObserver on the two panels'
  // class attributes + window resize (see the topbar-reflow wiring below).
  function layoutTopbar() {
    const reader = $("#reader");
    const research = $("#research");
    const readerDocked =
      !reader.classList.contains("hidden") &&
      !reader.classList.contains("floating");
    const researchDocked =
      !research.classList.contains("hidden") &&
      !research.classList.contains("floating");
    const leftDocked = readerDocked && reader.classList.contains("ctx-left");
    const rightPanelW = researchDocked
      ? research.offsetWidth
      : readerDocked && !reader.classList.contains("ctx-left")
        ? reader.offsetWidth
        : 0;
    const leftPanelW = leftDocked ? reader.offsetWidth : 0;

    const topbar = $("#topbar");
    const root = document.documentElement;
    // Corner buttons follow the panel inner edges (the one chrome element that
    // "drags" with the panels).
    root.style.setProperty("--btn-left-inset", `${leftPanelW}px`);

    // Chrome layout per panel state:
    //  - right panel only: search slides with the panel's left edge
    //    (--right-inset); on collision with the menu it wraps to row 2, left-
    //    aligned (.search-stacked). Menu stays at the left.
    //  - left panel only, not crossing center: menu centers (.menu-centered).
    //  - left panel crossing center: menu+search snap to a right-side column,
    //    stacked (menu row 1, search row 2, right-aligned) (.slot-right .stacked).
    //  - both panels open and balanced: centered cluster (.slot-center).
    //  - center gap too small for either: vertical rail (.topbar-rail).
    const PAD = 18,
      GAP = 18;
    const vw = window.innerWidth;
    const groupW = $("#nav-group").offsetWidth;
    const wasRail = topbar.classList.contains("topbar-rail");
    if (wasRail) topbar.classList.remove("topbar-rail");
    const searchWrapW = $("#search-wrap").offsetWidth;
    if (wasRail) topbar.classList.add("topbar-rail");
    // Measure the center gap against the panels' NATURAL widths (the --dock-w /
    // --reader-w CSS vars set by applyRGeom / applyGeom), not the rendered
    // rail-shrunk offsetWidth — otherwise the rail sees its own shrink and
    // flickers. Inline-style reads are cheap (no layout recalc).
    const readerWNat =
      parseInt(reader.style.getPropertyValue("--reader-w")) || 0;
    const dockWNat = parseInt(research.style.getPropertyValue("--dock-w")) || 0;
    const natLeft = leftDocked ? readerWNat || leftPanelW : leftPanelW;
    const natRight = researchDocked
      ? dockWNat || rightPanelW
      : readerDocked && !leftDocked
        ? readerWNat || rightPanelW
        : rightPanelW;
    // Menu column: left = default (no left panel). Center while the left
    // panel hasn't reached the centered menu's left edge; right the moment it
    // does — measured to the menu's actual left edge (vw/2 − groupW/2 − PAD),
    // not the viewport center, so the snap happens on contact instead of
    // after overlapping the menu. But the right column is only available when
    // no right panel is open; if one is, the left panel crossing the centered
    // menu triggers the rail directly (the menu has nowhere else to go).
    const rightPanelOpen = rightPanelW > 0;
    let menuCol: "left" | "center" | "right" = "left";
    if (leftPanelW > 0)
      menuCol =
        !rightPanelOpen && natLeft > vw / 2 - groupW / 2 - PAD
          ? "right"
          : "center";
    // Rail: chrome doesn't fit in its column. When the menu is centered, each
    // panel must independently clear the center half-width — the total gap
    // isn't enough (a lopsided pair can overlap the centered menu while the
    // gap still reads "big enough"). When the right panel is open and the
    // left panel crosses the centered menu, the rail fires directly (menu
    // can't go right). In left/right columns the chrome lives inside the gap,
    // so the total gap must fit it.
    const chromeW = Math.max(groupW, searchWrapW);
    const rail =
      menuCol === "center"
        ? rightPanelOpen
          ? natLeft > vw / 2 - groupW / 2 - PAD ||
            natRight > vw / 2 - chromeW / 2 - PAD
          : natLeft > vw / 2 - chromeW / 2 - PAD ||
            natRight > vw / 2 - chromeW / 2 - PAD
        : vw - natLeft - natRight < chromeW + 2 * PAD;
    // Rail offset: a docked right panel shrinks by the rail width (CSS subtracts
    // --rail-w from --dock-w), and the corner buttons clear panel + rail.
    const bottomRail =
      rail && (vw < 482 || window.matchMedia("(pointer: coarse)").matches);
    const railW = rail && !bottomRail ? 40 : 0;
    root.style.setProperty("--rail-w", `${railW}px`);
    root.style.setProperty("--mobile-search-h", `${rail ? 64 : 0}px`);
    root.style.setProperty("--mobile-nav-h", `${bottomRail ? 48 : 0}px`);
    root.style.setProperty("--btn-right-inset", `${rightPanelW + railW}px`);
    // Search slides with the right panel's left edge (--right-inset).
    topbar.style.setProperty("--right-inset", `${rightPanelW}px`);
    // Search collides with the menu (in its column) → wraps to row 2, aligned
    // under the menu's column.
    const menuRightX =
      menuCol === "center"
        ? vw / 2 + groupW / 2
        : menuCol === "right"
          ? vw - PAD
          : PAD + groupW;
    const searchLeftX = vw - rightPanelW - PAD - searchWrapW;
    const searchStacked = !rail && searchLeftX < menuRightX + GAP;
    topbar.classList.toggle("topbar-rail", rail);
    topbar.classList.toggle("topbar-bottom-rail", bottomRail);
    topbar.classList.toggle("menu-center", menuCol === "center");
    topbar.classList.toggle("menu-right", menuCol === "right");
    topbar.classList.toggle("search-stacked", searchStacked);
  }

  // Flip the reader's left dock. When the reader is HIDDEN, suppress the
  // transition so changing the hidden transform (translateX ±120%) doesn't
  // animate the panel across the visible screen (it would pass through 0%).
  function setReaderCtxLeft(on: boolean) {
    const reader = $("#reader");
    if (reader.classList.contains("hidden")) {
      reader.classList.add("no-anim");
      reader.classList.toggle("ctx-left", on);
      void reader.offsetWidth; // commit before re-enabling transitions
      reader.classList.remove("no-anim");
    } else {
      reader.classList.toggle("ctx-left", on);
    }
  }

  function researchBanner(
    text: string,
    primary: { label: string; run: () => void },
    secondary: { label: string; run: () => void },
  ) {
    $("#research-banner-text").textContent = text;
    const first = $("#research-banner-primary") as HTMLButtonElement;
    const second = $("#research-banner-secondary") as HTMLButtonElement;
    first.textContent = primary.label;
    second.textContent = secondary.label;
    first.onclick = () => {
      $("#research-banner").classList.add("hidden");
      primary.run();
    };
    second.onclick = () => {
      $("#research-banner").classList.add("hidden");
      secondary.run();
    };
    $("#research-banner").classList.remove("hidden");
  }
  function openResearch(mode: ResearchMode) {
    researchMode = mode;
    clearSelectionContext("research");
    $("#research").classList.remove("hidden");
    setReaderCtxLeft(true); // open note = working context on the left
    $("#research-title").textContent = i18n.t(`research.${mode}`);
    researchError(null);
    updateBrandStats();
    syncVoiceContext();
  }

  function closeResearch() {
    researchMode = null;
    $("#research").classList.add("hidden");
    clearSelectionContext("research");
    // reader returns to the right unless the user pinned it left
    if (!readerLeftPinned) setReaderCtxLeft(false);
    updateBrandStats();
    syncVoiceContext();
  }
  $("#research-close").addEventListener("click", closeResearch);
  $("#research-create-document").addEventListener("click", async () => {
    const created = await createResearchDocument(
      {
        async create(title, content) {
          const result = await api<{ id: string; revision: string }>("/api/document", {
            json: { title, content },
          });
          return { id: result.id, title, content, revision: result.revision };
        },
        read: async () => { throw new Error("unused"); },
        save: async () => { throw new Error("unused"); },
        promote: async () => { throw new Error("unused"); },
      },
      i18n.t("research.newDocument"),
    );
    await loadHistory();
    const entry = researchHistory.find((item) => item.id === created.id);
    if (entry) {
      historyIdx = researchHistory.indexOf(entry);
      showHistoryEntry(entry);
    }
  });

  // Research panel: attach (docked right) / detach (floating, draggable window).
  {
    const research = $("#research");
    const rGeom = (prefs.getResearch() as {
      floating: boolean;
      left: number;
      top: number;
      width: number;
      height: number;
      dockW: number;
    } | null) ?? {
      floating: false,
      left: 90,
      top: 80,
      width: 420,
      height: 0,
      dockW: 400,
    };
    const cl = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));
    const DOCK =
      '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="4" width="3.5" height="8" fill="currentColor"/></svg>';
    const UNDOCK =
      '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="5" y="5" width="6" height="6" fill="currentColor"/></svg>';
    const dockBtn = $("#research-dock");
    const persistR = () => prefs.setResearch(rGeom);
    let lastResearchViewportW = window.innerWidth;
    function applyRGeom(trackMaxed = false) {
      const viewportW = window.innerWidth;
      const maxW = Math.max(0, viewportW);
      const floatingWasMaxed =
        trackMaxed && rGeom.width >= lastResearchViewportW - 1;
      const dockWasMaxed =
        trackMaxed && (rGeom.dockW || 400) >= lastResearchViewportW - 1;
      research.classList.toggle("floating", rGeom.floating);
      dockBtn.innerHTML = rGeom.floating ? DOCK : UNDOCK;
      const rDockKey = rGeom.floating ? "dock.dock" : "dock.undock";
      dockBtn.dataset.i18nTitle = rDockKey;
      dockBtn.title = i18n.t(rDockKey);
      if (rGeom.floating) {
        const minW = Math.min(300, maxW);
        rGeom.width = floatingWasMaxed ? maxW : cl(rGeom.width, minW, maxW);
        rGeom.height = cl(
          rGeom.height || Math.round(window.innerHeight * 0.72),
          240,
          window.innerHeight - 24,
        );
        rGeom.left = cl(rGeom.left, 0, Math.max(0, viewportW - rGeom.width));
        rGeom.top = cl(rGeom.top, 0, window.innerHeight - 48);
        Object.assign(research.style, {
          left: rGeom.left + "px",
          top: rGeom.top + "px",
          width: rGeom.width + "px",
          height: rGeom.height + "px",
          right: "auto",
          bottom: "auto",
        });
      } else {
        // Docked: store the user width in --dock-w; CSS computes the effective
        // width (minus --rail-w when the rail is showing) and the right offset.
        const minW = Math.min(300, maxW);
        rGeom.dockW = dockWasMaxed ? maxW : cl(rGeom.dockW || 400, minW, maxW);
        research.style.setProperty("--dock-w", `${rGeom.dockW}px`);
        Object.assign(research.style, {
          left: "",
          top: "",
          width: "",
          height: "",
          right: "",
          bottom: "",
        });
      }
      lastResearchViewportW = viewportW;
    }
    applyRGeom();
    dockBtn.addEventListener("click", () => {
      rGeom.floating = !rGeom.floating;
      applyRGeom();
      persistR();
    });
    $("#research-head").addEventListener("pointerdown", (e: PointerEvent) => {
      if (!rGeom.floating || (e.target as HTMLElement).closest("button"))
        return;
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      const l0 = rGeom.left;
      const t0 = rGeom.top;
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      research.classList.add("dragging");
      const move = (ev: PointerEvent) => {
        rGeom.left = l0 + (ev.clientX - sx);
        rGeom.top = t0 + (ev.clientY - sy);
        applyRGeom();
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.removeEventListener("lostpointercapture", up);
        research.classList.remove("dragging");
        persistR();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      el.addEventListener("lostpointercapture", up);
    });

    // west edge grip: resize width (docked shrinks the docked width; floating
    // moves the left edge while the right side stays put).
    $("#research-resize-w").addEventListener(
      "pointerdown",
      (e: PointerEvent) => {
        e.preventDefault();
        const sx = e.clientX;
        const w0 = rGeom.floating ? rGeom.width : rGeom.dockW || 400;
        const l0 = rGeom.left;
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        research.classList.add("dragging");
        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - sx;
          if (rGeom.floating) {
            rGeom.width = w0 - dx;
            rGeom.left = l0 + dx;
          } else {
            rGeom.dockW = cl(
              w0 - dx,
              Math.min(300, window.innerWidth),
              window.innerWidth,
            );
          }
          applyRGeom();
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          el.removeEventListener("lostpointercapture", up);
          research.classList.remove("dragging");
          persistR();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        el.addEventListener("lostpointercapture", up);
      },
    );

    // corner grip (floating only): both dimensions
    $("#research-resize-corner").addEventListener(
      "pointerdown",
      (e: PointerEvent) => {
        e.preventDefault();
        const sx = e.clientX;
        const sy = e.clientY;
        const w0 = rGeom.width;
        const h0 = rGeom.height;
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        research.classList.add("dragging");
        const move = (ev: PointerEvent) => {
          rGeom.width = w0 + (ev.clientX - sx);
          rGeom.height = h0 + (ev.clientY - sy);
          applyRGeom();
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          el.removeEventListener("lostpointercapture", up);
          research.classList.remove("dragging");
          persistR();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        el.addEventListener("lostpointercapture", up);
      },
    );
    window.addEventListener("resize", () => applyRGeom(true));
  }

  function researchError(msg: string | null) {
    const el = $("#research-error");
    el.classList.toggle("hidden", !msg);
    el.textContent = msg ?? "";
  }

  function runModeQuery(
    mode: ModeName,
    query: string,
    context?: SelectionSnapshot,
  ) {
    if (mode === "vault") void runVaultQuery(query, context);
    else if (mode === "web") void runWebQuery(query, context);
    else if (mode === "ingest") void runIngest(query);
  }

  function runVaultQuery(query: string, context?: SelectionSnapshot) {
    if (vaultScope === "keyword") void runKeywordQuery(query, context);
    else void runSemanticQuery(query, context);
  }

  function appendContextNotices(
    body: HTMLElement,
    context?: SelectionSnapshot,
  ) {
    if (!context) return;
    for (const text of [
      contextUseNotice(context),
      contextTrimNotice(context),
    ]) {
      if (!text) continue;
      const p = document.createElement("p");
      p.className = "research-notice";
      p.textContent = text;
      body.appendChild(p);
    }
  }

  // ---- research history: shared renderers + navigation ----
  // Renders passage results (from /api/passages) grouped under their note, so
  // a long note's several hits read as one block. Also handles legacy history
  // entries shaped {id,title,snippet} (no file/line) via the id ?? file fallback.
  // A small relevance-score pill (0–100%). Null/NaN scores render nothing.
  function scoreBadge(score: number | undefined | null): HTMLElement | null {
    if (score == null || !isFinite(score)) return null;
    const b = document.createElement("span");
    b.className = "score-badge";
    b.textContent = `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
    return b;
  }

  // Clamp a text block to ~7 lines; when it actually overflows, insert an
  // expand/collapse toggle right after it. stopPropagation so the toggle never
  // triggers an enclosing row click (e.g. opening the note).
  function attachExpand(snip: HTMLElement) {
    snip.classList.add("clampable");
    requestAnimationFrame(() => {
      if (snip.scrollHeight - snip.clientHeight < 4) return; // fits already
      const btn = document.createElement("button");
      btn.className = "expand-btn";
      btn.textContent = i18n.t("research.expand");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const on = snip.classList.toggle("expanded");
        btn.textContent = i18n.t(on ? "research.collapse" : "research.expand");
      });
      snip.insertAdjacentElement("afterend", btn);
    });
  }

  function renderSemanticInto(
    body: HTMLElement,
    results: Array<{
      file?: string;
      id?: string;
      title: string;
      line?: number;
      score?: number;
      snippet: string;
    }>,
    query?: string,
  ) {
    // The query/question is the first thing on the page so a saved semantic
    // result reads as "this is what I asked" before the matching passages.
    if (query) {
      const q = document.createElement("h2");
      q.className = "research-query";
      q.textContent = query;
      body.appendChild(q);
    }
    if (!results.length) {
      body.insertAdjacentHTML(
        "beforeend",
        '<p class="muted">no matching passages</p>',
      );
      return;
    }
    // Bucket passages by note id, preserving first-seen (score) order.
    const groups = new Map<string, typeof results>();
    for (const r of results) {
      const id = r.file ?? r.id;
      if (!id || !byId.get(id)) continue;
      let arr = groups.get(id);
      if (!arr) {
        arr = [];
        groups.set(id, arr);
      }
      arr.push(r);
    }
    for (const [id, passages] of groups) {
      const node = byId.get(id)!;
      const group = document.createElement("div");
      group.className = "sem-group";
      const title = document.createElement("div");
      title.className = "rel-title sem-note";
      title.textContent = node.title;
      title.addEventListener("click", () => select(node, passages[0].snippet));
      group.appendChild(title);
      for (const p of passages) {
        const row = document.createElement("div");
        row.className = "rel-row sem-passage";
        // meta line: line number + relevance score
        const badge = scoreBadge(p.score);
        if (p.line || badge) {
          const meta = document.createElement("div");
          meta.className = "sem-passage-meta";
          if (p.line) {
            const ln = document.createElement("span");
            ln.className = "sem-line";
            ln.textContent = `L${p.line}`;
            meta.appendChild(ln);
          }
          if (badge) meta.appendChild(badge);
          row.appendChild(meta);
        }
        const snip = document.createElement("span");
        snip.className = "rel-snippet";
        snip.textContent = p.snippet;
        row.appendChild(snip);
        attachExpand(snip);
        row.addEventListener("click", () => select(node, p.snippet));
        group.appendChild(row);
      }
      body.appendChild(group);
    }
  }

  function renderKeywordInto(
    body: HTMLElement,
    results: Array<{
      id: string;
      title: string;
      score?: number;
      snippet: string;
    }>,
    query?: string,
  ) {
    if (query) {
      const q = document.createElement("h2");
      q.className = "research-query";
      q.textContent = query;
      body.appendChild(q);
    }
    if (!results.length) {
      body.insertAdjacentHTML(
        "beforeend",
        '<p class="muted">no keyword matches</p>',
      );
      return;
    }
    for (const r of results) {
      const node = byId.get(r.id);
      if (!node) continue;
      const row = document.createElement("div");
      row.className = "rel-row sem-passage";
      const title = document.createElement("span");
      title.className = "rel-title";
      title.textContent = r.title || node.title;
      const snip = document.createElement("span");
      snip.className = "rel-snippet";
      snip.textContent = r.snippet;
      const badge = scoreBadge(r.score);
      row.append(title, snip);
      if (badge) row.appendChild(badge);
      attachExpand(snip);
      row.addEventListener("click", () => select(node, r.snippet));
      body.appendChild(row);
    }
  }

  function renderWebInto(
    body: HTMLElement,
    data: {
      answer: ResearchEntry["answer"];
      results: Array<{
        title: string;
        url: string;
        snippet: string;
        publishedDate: string | null;
      }>;
    },
    query: string,
  ) {
    // The query/question leads the page, same as semantic results.
    if (query) {
      const q = document.createElement("h2");
      q.className = "research-query";
      q.textContent = query;
      body.appendChild(q);
    }
    if (data.answer) body.appendChild(renderAnswer(data.answer, query));
    if (!data.results.length && !data.answer) {
      body.insertAdjacentHTML("beforeend", '<p class="muted">no results</p>');
      return;
    }
    if (data.results.length && data.answer) {
      const h = document.createElement("div");
      h.className = "sources-head";
      h.textContent = i18n.t("research.results");
      body.appendChild(h);
    }
    for (const r of data.results) body.appendChild(renderWebResult(r));
  }

  // The "article" category: a full-text page fetched from a web result (Exa
  // /contents), living only in the research history until the user saves it as
  // a note. Content is sanitized (untrusted web HTML) before innerHTML.
  function renderArticleInto(
    body: HTMLElement,
    art: ArticleData | undefined,
    query: string,
  ) {
    if (!art) {
      body.innerHTML = '<p class="muted">no article</p>';
      return;
    }
    const cleanContent = stripLeadingTitle(art.content, art.title);
    const h = document.createElement("h2");
    h.className = "research-query";
    h.textContent = art.title || query;
    body.appendChild(h);

    const src = document.createElement("a");
    src.href = art.url;
    src.target = "_blank";
    src.rel = "noopener noreferrer";
    src.className = "answer-source article-source";
    let host = art.url;
    try {
      host = new URL(art.url).hostname;
    } catch {
      /* keep the raw url */
    }
    src.textContent = host;
    src.insertAdjacentHTML("beforeend", EXT_ICON);
    body.appendChild(src);

    const content = document.createElement("div");
    content.className = "article-body";
    body.appendChild(content);
    void Promise.resolve(marked.parse(cleanContent)).then((html) => {
      content.innerHTML = DOMPurify.sanitize(html);
    });

    const save = document.createElement("button");
    save.className = "web-save";
    save.textContent = i18n.t("research.saveNote");
    save.addEventListener("click", async () => {
      save.disabled = true;
      save.textContent = i18n.t("research.saving");
      try {
        const noteBody = [
          "---",
          `source: ${art.url}`,
          `saved: ${new Date().toISOString().slice(0, 10)}`,
          ...(art.author ? [`author: "${art.author.replace(/"/g, "'")}"`] : []),
          "via: sinapso-web-article",
          "---",
          "",
          `# ${art.title}`,
          "",
          cleanContent,
          "",
          `[Source](${art.url})`,
          "",
        ].join("\n");
        const data = await api<{ id: string }>("/api/notes", {
          json: { title: art.title, content: noteBody },
        });
        save.textContent = i18n.t("research.saved");
        // Move-on-save: once curated into the vault, drop it from history.
        if (currentEntryId) {
          await apiDelete(
            `/api/research/history/${encodeURIComponent(currentEntryId)}`,
          );
          currentEntryId = null;
          await loadHistory();
          updateHistoryNav();
        }
        await openAfterIngest(String(data.id));
      } catch {
        save.disabled = false;
        save.textContent = i18n.t("research.saveFail");
      }
    });
    body.appendChild(save);
  }

  // The "document" category: the voice agent's working note, edited in place
  // across turns. Same shape as an article minus the source link. Content is
  // sanitized (agent markdown) before innerHTML.
  function renderDocumentInto(
    body: HTMLElement,
    doc: { title: string; content: string; revision: string } | undefined,
    query: string,
  ) {
    researchDocumentController?.dispose();
    researchDocumentEditor?.destroy();
    researchDocumentController = null;
    researchDocumentEditor = null;
    if (!doc || !currentEntryId) {
      body.innerHTML = '<p class="muted">no document</p>';
      return;
    }
    const id = currentEntryId;
    const title = document.createElement("input");
    title.className = "research-document-title";
    title.value = doc.title || query;
    title.setAttribute("aria-label", "Document title");
    body.appendChild(title);
    const state = document.createElement("span");
    state.className = "research-document-save-state";
    body.appendChild(state);
    const editorHost = document.createElement("div");
    editorHost.className = "research-document-editor";
    body.appendChild(editorHost);
    const preview = document.createElement("div");
    preview.className = "research-document-ai-preview hidden";
    const previewText = document.createElement("div");
    const replace = document.createElement("button");
    replace.textContent = i18n.t("editor.ai.replace");
    const insert = document.createElement("button");
    insert.textContent = i18n.t("editor.ai.insert");
    const dismiss = document.createElement("button");
    dismiss.textContent = "×";
    preview.append(previewText, replace, insert, dismiss);
    body.appendChild(preview);
    let pending: { req: AssistRequest; text: string } | null = null;
    const hidePreview = () => {
      pending = null;
      preview.classList.add("hidden");
    };
    const extras: ToolbarExtras = (toolbar) => {
      if (!llmConfigured()) return;
      const wrap = document.createElement("span");
      wrap.className = "cm-tb-ai";
      const icon = document.createElement("span");
      icon.className = "cm-tb-ai-icon";
      icon.innerHTML = BOT_ICON_SVG;
      const input = document.createElement("input");
      input.className = "cm-tb-ai-input";
      input.placeholder = i18n.t("editor.ai.placeholder");
      input.onmousedown = (event) => event.stopPropagation();
      input.onkeydown = async (event) => {
        event.stopPropagation();
        if (event.key !== "Enter") return;
        event.preventDefault();
        const view = researchDocumentEditor?.view;
        if (!view) return;
        const req = buildAssistRequest(view.state, input.value, { id, title: title.value });
        if (!req) return;
        input.disabled = true;
        icon.classList.add("busy");
        try {
          const result = await api<{ text: string }>("/api/selection-assist", {
            json: {
              instruction: req.instruction,
              selection: req.selection,
              surrounding: req.surrounding,
              noteId: req.noteId,
              noteTitle: req.noteTitle,
            },
          });
          pending = { req, text: result.text };
          previewText.textContent = result.text;
          preview.classList.remove("hidden");
          input.value = "";
        } catch {
          previewText.textContent = i18n.t("editor.ai.error");
          preview.classList.remove("hidden");
        } finally {
          input.disabled = false;
          icon.classList.remove("busy");
        }
      };
      wrap.append(icon, input);
      toolbar.appendChild(wrap);
    };
    researchDocumentEditor = createNoteEditor(editorHost, {
      content: doc.content,
      onWikiLinkClick: navigateWikiTarget,
      toolbarExtras: extras,
      onChange: () => {
        researchDocumentController?.autosave.notifyChange();
        updateBrandStats();
        syncVoiceContext();
      },
    });
    const transport: ResearchDocumentTransport = {
      async create(nextTitle, content) {
        const result = await api<{ id: string; revision: string }>("/api/document", {
          json: { title: nextTitle, content },
        });
        return { id: result.id, title: nextTitle, content, revision: result.revision };
      },
      async read(documentId) {
        return api<ResearchDocument>(`/api/document/${encodeURIComponent(documentId)}`);
      },
      async save(candidate) {
        return api<{ revision: string }>("/api/document", {
          json: {
            id: candidate.id,
            revision: candidate.revision,
            title: candidate.title,
            content: candidate.content,
          },
        });
      },
      async promote(candidate) {
        const noteBody = [
          "---",
          `saved: ${new Date().toISOString().slice(0, 10)}`,
          "via: sinapso-agent-document",
          "---",
          "",
          candidate.content,
          "",
        ].join("\n");
        const saved = await api<{ id: string }>("/api/notes", {
          json: { title: candidate.title, content: noteBody },
        });
        await apiDelete(`/api/research/history/${encodeURIComponent(candidate.id)}`);
        return { noteId: String(saved.id) };
      },
    };
    const showDocumentConflict = () => {
      researchBanner(
        i18n.t("research.documentConflict"),
        { label: i18n.t("editor.conflict.reload"), run: () => void researchDocumentController?.reload() },
        { label: i18n.t("editor.conflict.overwrite"), run: () => void researchDocumentController?.overwrite() },
      );
    };
    researchDocumentController = createResearchDocumentController({
      document: { id, ...doc },
      getContent: () => researchDocumentEditor?.getContent() ?? doc.content,
      getTitle: () => title.value,
      setDocument: (fresh) => {
        title.value = fresh.title;
        researchDocumentEditor?.setContent(fresh.content);
        void loadHistory().then(() => syncVoiceContext());
      },
      transport,
      onState: (next) => {
        state.textContent = i18n.t(`editor.saveState.${next}`);
        state.className = `research-document-save-state save-${next}`;
        if (next === "conflict") showDocumentConflict();
        if (next === "clean") void loadHistory().then(() => syncVoiceContext());
      },
    });
    title.addEventListener("input", () => researchDocumentController?.autosave.notifyChange());
    const apply = (mode: "replace" | "insert") => {
      const view = researchDocumentEditor?.view;
      if (!pending || !view) return;
      const spec = mode === "replace"
        ? replaceSelection(view.state, pending.req, pending.text)
        : insertBelow(view.state, pending.req, pending.text);
      if (!spec) return;
      view.dispatch(spec);
      hidePreview();
    };
    replace.addEventListener("click", () => apply("replace"));
    insert.addEventListener("click", () => apply("insert"));
    dismiss.addEventListener("click", hidePreview);
    const save = document.createElement("button");
    save.className = "web-save";
    save.textContent = i18n.t("research.saveNote");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const { noteId } = await researchDocumentController!.promote();
        researchDocumentController?.dispose();
        researchDocumentController = null;
        researchDocumentEditor?.destroy();
        researchDocumentEditor = null;
        currentEntryId = null;
        await loadHistory();
        updateHistoryNav();
        await openAfterIngest(noteId);
      } catch {
        save.disabled = false;
        save.textContent = i18n.t("research.saveFail");
      }
    });
    body.appendChild(save);
  }

  async function apiDelete(url: string) {
    await api(url, { method: "DELETE" }).catch(() => {});
  }

  async function loadHistory() {
    try {
      researchHistory =
        (
          await api<{ entries?: typeof researchHistory }>(
            "/api/research/history",
          )
        ).entries ?? [];
      const retainedPin = clearStaleResearchPin(
        pinnedResearchEntryId,
        researchHistory.map((entry) => entry.id),
      );
      if (pinnedResearchEntryId !== null && retainedPin === null) {
        pinnedResearchEntryId = null;
        syncResearchPinUi();
        announceResearch(i18n.t("research.pinCleared"));
      }
      syncVoiceContext();
    } catch {
      researchHistory = [];
    }
  }

  function updateHistoryNav() {
    const empty = researchHistory.length === 0;
    $("#research-nav").classList.toggle("hidden", empty);
    // Trash now lives in the right-hand group, outside #research-nav, so hide it
    // on its own when there's nothing to delete.
    $("#research-trash").classList.toggle("hidden", empty);
    if (empty) return;
    historyIdx = Math.max(0, Math.min(historyIdx, researchHistory.length - 1));
    ($("#research-prev") as HTMLButtonElement).disabled =
      historyIdx >= researchHistory.length - 1;
    ($("#research-next") as HTMLButtonElement).disabled = historyIdx <= 0;
    $("#research-pos").textContent =
      `${historyIdx + 1}/${researchHistory.length}`;
  }

  // Re-render a stored entry (no network query, no spend).
  function showHistoryEntry(entry: ResearchEntry) {
    openResearch(entry.mode);
    currentEntryId = entry.id;
    researchError(null);
    if (entry.mode !== "document") {
      researchDocumentController?.dispose();
      researchDocumentController = null;
      researchDocumentEditor?.destroy();
      researchDocumentEditor = null;
    }
    const body = $("#research-body");
    body.innerHTML = "";
    if (entry.mode === "web")
      renderWebInto(
        body,
        {
          answer: entry.answer ?? null,
          results: (entry.results ?? []) as never,
        },
        entry.query,
      );
    else if (entry.mode === "article")
      renderArticleInto(body, entry.article, entry.query);
    else if (entry.mode === "document")
      renderDocumentInto(body, entry.document, entry.query);
    else if (entry.mode === "keyword")
      renderKeywordInto(body, (entry.results ?? []) as never, entry.query);
    else renderSemanticInto(body, (entry.results ?? []) as never, entry.query);
    updateHistoryNav();
    updateBrandStats();
    syncVoiceContext();
  }

  // After a fresh query the new entry is newest (index 0).
  async function noteQueryPersisted(id: string | undefined) {
    currentEntryId = id ?? null;
    await loadHistory();
    historyIdx = 0;
    updateHistoryNav();
  }

  async function clearResearchHistory() {
    await apiDelete("/api/research/history");
    researchHistory = [];
    historyIdx = -1;
    currentEntryId = null;
    if (pinnedResearchEntryId !== null) {
      pinnedResearchEntryId = null;
      syncResearchPinUi();
      announceResearch(i18n.t("research.pinCleared"));
    }
    updateHistoryNav();
    if (!$("#research").classList.contains("hidden")) closeResearch();
  }

  async function clearNoteHistory() {
    await apiDelete("/api/reader-history");
    readerHistory = [];
    readerIdx = -1;
    updateReaderNav();
  }

  $("#research-pin").addEventListener("click", () => {
    setResearchPinned(pinnedResearchEntryId === null);
  });
  syncResearchPinUi();
  $("#research-prev").addEventListener("click", () => {
    if (historyIdx < researchHistory.length - 1)
      showHistoryEntry(researchHistory[++historyIdx]);
  });
  $("#research-next").addEventListener("click", () => {
    if (historyIdx > 0) showHistoryEntry(researchHistory[--historyIdx]);
  });
  $("#research-trash").addEventListener("click", async () => {
    const entry = researchHistory[historyIdx];
    if (!entry) return;
    await apiDelete(`/api/research/history/${encodeURIComponent(entry.id)}`);
    await loadHistory();
    if (!researchHistory.length) {
      updateHistoryNav();
      closeResearch();
      return;
    }
    historyIdx = Math.min(historyIdx, researchHistory.length - 1);
    showHistoryEntry(researchHistory[historyIdx]);
  });
  void loadHistory();

  // ---- reader (content-panel) history: paging + reopen ----
  let readerHistory: Array<{ id: string; ts: string }> = [];
  let readerIdx = -1;
  async function loadReaderHistory() {
    try {
      readerHistory =
        (await api<{ entries?: typeof readerHistory }>("/api/reader-history"))
          .entries ?? [];
    } catch {
      readerHistory = [];
    }
  }
  async function refreshReaderHistory() {
    await loadReaderHistory();
    readerIdx = 0;
    updateReaderNav();
  }
  function updateReaderNav() {
    // Only worth showing once there's something to page back to.
    $("#reader-nav").classList.toggle("hidden", readerHistory.length <= 1);
    if (readerHistory.length <= 1) return;
    readerIdx = Math.max(0, Math.min(readerIdx, readerHistory.length - 1));
    ($("#reader-prev") as HTMLButtonElement).disabled =
      readerIdx >= readerHistory.length - 1;
    ($("#reader-next") as HTMLButtonElement).disabled = readerIdx <= 0;
  }
  function openReaderHistoryAt(idx: number) {
    const entry = readerHistory[idx];
    const node = entry && byId.get(entry.id);
    if (!node) return;
    readerIdx = idx;
    // Select the node in the graph and fly the camera to it, so paging through
    // history moves the constellation the same way a click would.
    selected = node;
    focusSet = bfs(node.id, focusDepth);
    flyTo(node);
    repaint();
    void openReader(node, true); // fromHistory: navigation, not a new open
    updateReaderNav();
  }
  $("#reader-prev").addEventListener("click", () => {
    if (readerIdx < readerHistory.length - 1)
      openReaderHistoryAt(readerIdx + 1);
  });
  $("#reader-next").addEventListener("click", () => {
    if (readerIdx > 0) openReaderHistoryAt(readerIdx - 1);
  });
  // Corner buttons: reopen the last content note / the last research result.
  $("#reopen-content").addEventListener("click", async () => {
    const reader = $("#reader");
    const dockedLeft =
      !reader.classList.contains("hidden") &&
      reader.classList.contains("ctx-left") &&
      !reader.classList.contains("floating");
    // Already docked on the left → close it (clearSelection deselects the node).
    if (dockedLeft) {
      clearSelection();
      return;
    }
    // Otherwise dock the content panel on the LEFT edge and keep it there
    // (persists even if research later opens/closes on the right): reopen it
    // there if closed, or slide it over from the right if it's open.
    const wasHidden = reader.classList.contains("hidden");
    if (wasHidden) {
      if (!readerHistory.length) await loadReaderHistory();
      if (!readerHistory.length) return;
    }
    readerLeftPinned = true;
    setReaderCtxLeft(true);
    if (wasHidden) openReaderHistoryAt(0);
  });
  $("#reopen-research").addEventListener("click", async () => {
    // Toggle: close the right panel if it's open, otherwise reopen last research.
    if (!$("#research").classList.contains("hidden")) {
      closeResearch();
      return;
    }
    if (!researchHistory.length) await loadHistory();
    if (!researchHistory.length) return;
    historyIdx = 0;
    showHistoryEntry(researchHistory[0]);
  });
  void loadReaderHistory();

  async function runSemanticQuery(
    query: string,
    context?: SelectionSnapshot,
    label?: string,
  ) {
    const effective = buildSemanticQuery(
      query,
      context ?? emptySelectionState(),
    );
    const shownQuery = displayQuery(query, label ?? "Selected text", context);
    openResearch("semantic");
    const body = $("#research-body");
    body.innerHTML = '<p class="muted">searching semantically…</p>';
    try {
      const data = await api<{
        state: string;
        historyId?: string;
        results?: Array<{
          file: string;
          title: string;
          line: number;
          score?: number;
          snippet: string;
        }>;
      }>(
        `/api/passages?q=${encodeURIComponent(effective)}&displayQuery=${encodeURIComponent(shownQuery)}`,
      );
      body.innerHTML = "";
      appendContextNotices(body, context);
      if (data.state === "indexing") {
        body.innerHTML =
          '<p class="muted">semantic index building — try again shortly</p>';
        return;
      }
      if (data.state === "uncovered") {
        body.innerHTML =
          '<p class="muted">semantic search is not set up for this vault (Tools → Integrations)</p>';
        return;
      }
      renderSemanticInto(body, data.results ?? [], shownQuery);
      if (data.historyId) await noteQueryPersisted(data.historyId);
    } catch {
      body.innerHTML = "";
      researchError("semantic search failed — is the server running?");
    }
  }

  async function runKeywordQuery(
    query: string,
    context?: SelectionSnapshot,
    label?: string,
  ) {
    const effective = context
      ? buildKeywordQuery(query, context)
      : query.trim();
    if (!effective) return;
    const shownQuery = displayQuery(query, label ?? "Selected text", context);
    openResearch("keyword");
    const body = $("#research-body");
    body.innerHTML = '<p class="muted">searching keywords…</p>';
    try {
      const data = await api<{
        results: Array<{
          id: string;
          title: string;
          score?: number;
          snippet: string;
        }>;
        historyId?: string;
      }>(
        `/api/search?q=${encodeURIComponent(effective)}&history=1&displayQuery=${encodeURIComponent(shownQuery)}`,
        { token: true },
      );
      body.innerHTML = "";
      appendContextNotices(body, context);
      renderKeywordInto(body, data.results ?? [], shownQuery);
      if (data.historyId) await noteQueryPersisted(data.historyId);
    } catch (e) {
      body.innerHTML = "";
      const msg =
        e instanceof ApiError
          ? ((e.body as { message?: string; error?: string } | null)?.message ??
            (e.body as { message?: string; error?: string } | null)?.error)
          : null;
      researchError(msg ?? "keyword search failed — is the server running?");
    }
  }

  async function runWebQuery(
    query: string,
    context?: SelectionSnapshot,
    label?: string,
    deepOverride?: boolean,
  ) {
    if (integrations && !integrations.consents.web) {
      promptWebConsent();
      return;
    }
    const requestQuery = query.trim() || (context ? selectedText(context) : "");
    if (!requestQuery) return;
    const shownQuery = displayQuery(query, label ?? "Selected text", context);
    const deep = deepOverride ?? webScope === "deep";
    openResearch("web");
    const body = $("#research-body");
    body.innerHTML = `<p class="muted">${i18n.t(
      deep ? "research.deepBusy" : "research.webBusy",
    )}</p>`;
    try {
      const data = await api<{
        answer: ResearchEntry["answer"];
        results: Array<{
          title: string;
          url: string;
          snippet: string;
          publishedDate: string | null;
        }>;
        historyId?: string;
        contextWarning?: string | null;
      }>("/api/research", {
        json: {
          query: requestQuery,
          deep,
          contexts: context,
          displayQuery: shownQuery,
        },
      });
      body.innerHTML = "";
      appendContextNotices(body, context);
      if (data.contextWarning) {
        const p = document.createElement("p");
        p.className = "research-notice";
        p.textContent = data.contextWarning;
        body.appendChild(p);
      }
      renderWebInto(body, data, shownQuery);
      if (data.historyId) await noteQueryPersisted(data.historyId);
    } catch (e) {
      body.innerHTML = "";
      if (e instanceof ApiError) {
        const msg = (e.body as { message?: string } | null | undefined)
          ?.message;
        researchError(msg ?? "research failed");
      } else {
        researchError("research failed — is the server running?");
      }
    }
  }

  // Fetch a web result's full text (Exa /contents) and open it as an "article"
  // page in the research column. Spend-bearing, so it walks the web consent gate
  // first, exactly like a web query.
  async function runArticleFetch(url: string, title: string) {
    if (integrations && !integrations.consents.web) {
      promptWebConsent();
      return;
    }
    openResearch("article");
    const body = $("#research-body");
    body.innerHTML = `<p class="muted">${i18n.t("research.fetching")}</p>`;
    try {
      const data = await api<ArticleData & { historyId?: string }>(
        "/api/article",
        { json: { url } },
      );
      body.innerHTML = "";
      renderArticleInto(body, data, title);
      if (data.historyId) await noteQueryPersisted(data.historyId);
    } catch (e) {
      body.innerHTML = "";
      if (e instanceof ApiError) {
        const msg = (e.body as { message?: string } | null | undefined)
          ?.message;
        researchError(msg ?? "article fetch failed");
      } else {
        researchError("article fetch failed — is the server running?");
      }
    }
  }

  // After saving an ingested note, rescan so the new note joins the graph.
  // Create a note, then rescan-diff the vault (no reload) and fly to the new
  // note once it joins the live graph with its resolved links.
  async function openAfterIngest(id: string, logReader = false) {
    sessionStorage.setItem("sinapso-pending-select", id); // survives a fallback reload
    if (!logReader) sessionStorage.setItem("sinapso-pending-select-nolog", "1");
    await rescan(false);
    const n = byId.get(id);
    if (n) {
      sessionStorage.removeItem("sinapso-pending-select");
      sessionStorage.removeItem("sinapso-pending-select-nolog");
      select(n, undefined, logReader);
    }
  }

  interface WikiIngestOperation {
    type: "create" | "edit";
    path: string;
    content: string;
    title?: string;
    raw?: boolean;
  }
  interface WikiIngestProposal {
    wiki: { id: string; label: string; path: string };
    source: string;
    title: string;
    operations: WikiIngestOperation[];
  }
  interface IngestPreview {
    source: string;
    sourceLabel: string;
    title: string;
    markdown: string;
    via?: string;
  }

  function renderWikiProposal(body: HTMLElement, proposal: WikiIngestProposal) {
    body.innerHTML = "";
    const h = document.createElement("h2");
    h.className = "research-query";
    h.textContent = `${proposal.title} → ${proposal.wiki.label || proposal.wiki.path}`;
    body.appendChild(h);
    const meta = document.createElement("p");
    meta.className = "muted wiki-proposal-meta";
    const visible = proposal.operations.filter((op) => !op.raw);
    const hidden = proposal.operations.length - visible.length;
    meta.textContent = visible.length
      ? `${visible.length} content page proposal(s).${hidden ? " Source copy will also be stored." : ""}`
      : "Source copy only. No content pages were proposed.";
    body.appendChild(meta);
    for (const op of visible) {
      const row = document.createElement("div");
      row.className = "wiki-proposal-op";
      const title = document.createElement("div");
      title.className = "wiki-proposal-title";
      title.textContent = `${op.type}${op.raw ? " raw" : ""}: ${op.path}`;
      const pre = document.createElement("pre");
      pre.textContent = op.content;
      row.append(title, pre);
      body.appendChild(row);
    }
    const actions = document.createElement("div");
    actions.className = "wiki-proposal-actions";
    const approve = document.createElement("button");
    approve.className = "web-save";
    approve.textContent = "approve writes";
    const reject = document.createElement("button");
    reject.className = "web-save";
    reject.textContent = "reject";
    reject.addEventListener("click", () => {
      body.innerHTML = '<p class="muted">rejected — no files written</p>';
    });
    approve.addEventListener("click", async () => {
      approve.disabled = true;
      approve.textContent = "applying…";
      try {
        const data = await api<{ ids?: string[]; error?: string }>(
          "/api/wiki-ingest/apply",
          {
            json: {
              wikiId: proposal.wiki.id,
              operations: proposal.operations,
            },
          },
        );
        if (!data.ids?.length) throw new Error(data.error ?? "apply failed");
        const preferred = proposal.operations.findIndex((op) => !op.raw);
        const id = data.ids[preferred >= 0 ? preferred : 0] ?? data.ids[0];
        body.innerHTML = '<p class="muted">applied — opening the note…</p>';
        await openAfterIngest(id);
      } catch (e) {
        approve.disabled = false;
        approve.textContent = "apply failed — retry";
        researchError(e instanceof Error ? e.message : "apply failed");
      }
    });
    actions.append(approve, reject);
    body.appendChild(actions);
  }

  async function showWikiProposal(preview: IngestPreview, wikiId?: string) {
    openResearch("ingest");
    const body = $("#research-body");
    body.innerHTML = '<p class="muted">building wiki proposal…</p>';
    try {
      const proposal = await api<WikiIngestProposal>(
        "/api/wiki-ingest/propose",
        {
          json: { converted: preview, wikiId },
        },
      );
      renderWikiProposal(body, proposal);
    } catch (e) {
      body.innerHTML = "";
      if (e instanceof ApiError) {
        const msg = (
          e.body as { message?: string; error?: string } | null | undefined
        )?.message;
        researchError(msg ?? "ingest failed");
      } else {
        researchError(e instanceof Error ? e.message : "ingest failed");
      }
    }
  }

  function renderReaderWikiAction(
    preview: IngestPreview,
    placement: "top" | "bottom",
  ): HTMLElement {
    const actions = document.createElement("div");
    actions.className = `reader-wiki-action reader-wiki-action-${placement}`;
    const select = document.createElement("select");
    select.className = "hidden";
    const btn = document.createElement("button");
    btn.className = "web-save";
    btn.textContent = i18n.t("ingest.actionWiki");
    btn.disabled = true;
    actions.append(select, btn);

    void loadEnabledWikis().then((wikis) => {
      const currentWiki = wikiForId(preview.source);
      if (currentWiki) {
        btn.disabled = true;
        btn.textContent = i18n.t("ingest.alreadyWiki");
        return;
      }
      if (!wikis.length) {
        btn.disabled = true;
        btn.textContent = i18n.t("ingest.noWiki");
        return;
      }
      if (wikis.length > 1) {
        select.classList.remove("hidden");
        for (const wiki of wikis) {
          const o = document.createElement("option");
          o.value = wiki.id;
          o.textContent = wikiDisplayName(wiki);
          select.appendChild(o);
        }
      }
      btn.disabled = false;
      btn.addEventListener("click", () => {
        btn.disabled = true;
        void showWikiProposal(
          preview,
          wikis.length > 1 ? select.value : wikis[0].id,
        ).finally(() => {
          btn.disabled = false;
        });
      });
    });

    return actions;
  }

  async function savePreviewToInbox(preview: IngestPreview) {
    const data = await api<{ id: string }>("/api/ingest/save", {
      json: { converted: preview },
    });
    await openAfterIngest(String(data.id));
    readerLeftPinned = true;
    setReaderCtxLeft(true);
    closeResearch();
  }

  // Hot-swap a rescanned graph into the LIVE scene: diff against the current
  // graph and splice adds / removes / edge changes in place, then re-register
  // without reheating the layout — no full page reload. Existing nodes keep
  // their positions; new nodes land at the centroid of their resolved neighbors
  // (so they sit among their links). Phantom→real reconciliation falls out of
  // the by-id diff: the phantom id disappears, the real id appears, and the
  // inbound edges in next.links already point at the real id.
  function applyGraphUpdate(next: Graph) {
    const nextById = new Map(next.nodes.map((n) => [n.id, n] as const));
    const endId = (e: string | GNode) => (typeof e === "object" ? e.id : e);

    // 1. Remove gone nodes: dispose their three.js material + drop from every
    //    lookup so applyNodeColors/saveLayout never touch a stale id.
    for (const n of data.nodes) {
      if (nextById.has(n.id)) continue;
      const mesh = meshOf.get(n.id);
      (mesh?.material as THREE.Material | undefined)?.dispose?.();
      meshOf.delete(n.id);
      glowOf.delete(n.id);
      spinOf.delete(n.id);
      byBasename.delete(n.title.toLowerCase());
      byId.delete(n.id);
    }

    // 2. Update kept nodes' metadata in place, keeping the SAME object reference
    //    so 3d-force-graph reuses its mesh + position (degree drives size/orphan).
    let titleChanged = false;
    for (const n of data.nodes) {
      const nn = nextById.get(n.id);
      if (!nn) continue;
      if (n.title !== nn.title) {
        byBasename.delete(n.title.toLowerCase());
        titleChanged = true;
      }
      n.title = nn.title;
      n.pillar = nn.pillar;
      n.tags = nn.tags;
      n.words = nn.words;
      n.in = nn.in;
      n.out = nn.out;
      n.phantom = nn.phantom;
      byBasename.set(n.title.toLowerCase(), n);
    }

    // 3. Rebuild neighbor adjacency from the new edges (centroid seed + focus).
    neighbors.clear();
    for (const l of next.links) {
      addNb(endId(l.source), endId(l.target));
      addNb(endId(l.target), endId(l.source));
    }

    // 4. Add new nodes at the centroid of their already-positioned neighbors.
    const jitter = () => (Math.random() - 0.5) * 24;
    const kept = data.nodes.filter((n) => nextById.has(n.id));
    for (const nn of next.nodes) {
      if (byId.has(nn.id)) continue;
      const node: GNode = { ...nn };
      let sx = 0,
        sy = 0,
        sz = 0,
        c = 0;
      for (const nbId of neighbors.get(node.id) ?? []) {
        const nb = byId.get(nbId);
        if (nb && nb.x != null) {
          sx += nb.x;
          sy += nb.y ?? 0;
          sz += nb.z ?? 0;
          c++;
        }
      }
      node.x = (c ? sx / c : 0) + jitter();
      node.y = (c ? sy / c : 0) + jitter();
      node.z = (c ? sz / c : 0) + jitter();
      byId.set(node.id, node);
      byBasename.set(node.title.toLowerCase(), node);
      kept.push(node);
    }

    // 5. Commit the new node / link / meta sets.
    data.nodes = kept;
    data.links = next.links;
    data.meta = next.meta;

    // 6. Drop semantic edges whose endpoints no longer exist (stale post-rescan).
    semanticLinks = semanticLinks.filter(
      (l) => byId.has(endId(l.source)) && byId.has(endId(l.target)),
    );

    // 7. Recompute derived views + grow/shrink the link buffer.
    computeGroups();
    recomputeColors();
    buildLegend();
    rebuildLinkBuffers();

    // 8. Active sim edge set for the current arrangement (mirror applyArrangement).
    const links: GLink[] = [];
    if (arrangement !== "semantic") for (const l of data.links) links.push(l);
    if (arrangement !== "links") for (const l of semanticLinks) links.push(l);

    // 9. Re-register without reheating: existing nodes hold x/y/z, new nodes hold
    //    their centroid seed, cooldownTicks(0) runs no ticks → nothing reflows.
    graph.warmupTicks(0).cooldownTicks(0);
    graph.graphData({ nodes: data.nodes, links });
    if (titleChanged) graph.nodeThreeObject(graph.nodeThreeObject()); // refresh labels

    // 10. Persist the updated layout under the new fingerprint.
    layoutSaved = false;
    saveLayout();

    // 11. Paint the new meshes/links once their objects exist.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        updateLinkPositions();
        updateLinkColors();
        applyNodeColors();
      }),
    );

    // 12. Footer counts.
    lastNotes = data.meta.notes;
    lastLinks = data.meta.links;
    updateBrandStats();
  }

  async function runIngest(source: string) {
    openResearch("ingest");
    const body = $("#research-body");
    body.innerHTML = '<p class="muted">converting preview…</p>';
    try {
      const preview = await api<IngestPreview>("/api/ingest/preview", {
        json: { source },
      });
      body.innerHTML = '<p class="muted">saving to Inbox…</p>';
      await savePreviewToInbox(preview);
    } catch (e) {
      body.innerHTML = "";
      if (e instanceof ApiError) {
        const msg = (
          e.body as { message?: string; error?: string } | null | undefined
        )?.message;
        researchError(msg ?? "ingest failed");
      } else {
        researchError(e instanceof Error ? e.message : "ingest failed");
      }
    }
  }

  // Browse button (shown in ingest mode): click the hidden file input, convert
  // it to a preview, then let the user choose Inbox or wiki ingest.
  $("#ingest-browse").addEventListener("click", () =>
    ($("#ingest-file") as HTMLInputElement).click(),
  );
  ($("#ingest-file") as HTMLInputElement).addEventListener(
    "change",
    async () => {
      const input = $("#ingest-file") as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      input.value = ""; // allow re-picking the same file
      openResearch("ingest");
      const body = $("#research-body");
      body.innerHTML = `<p class="muted">converting ${file.name} via markitdown…</p>`;
      try {
        const buf = await file.arrayBuffer();
        const params = new URLSearchParams({ name: file.name });
        const res = await apiRaw(
          `/api/ingest/preview-upload?${params.toString()}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: buf,
            token: true,
          },
        );
        const preview = (await res.json()) as IngestPreview & {
          message?: string;
          error?: string;
        };
        if (!res.ok) throw new Error(preview.message ?? preview.error);
        body.innerHTML = '<p class="muted">saving to Inbox…</p>';
        await savePreviewToInbox(preview);
      } catch (e) {
        body.innerHTML = "";
        researchError(e instanceof Error ? e.message : "ingest failed");
      }
    },
  );

  // Synthesized deep-research answer with cited sources (F020).
  function renderAnswer(
    a: { content: string; citations: Array<{ url: string; title: string }> },
    query: string,
  ): HTMLElement {
    const box = document.createElement("div");
    box.className = "answer";
    const text = document.createElement("div");
    text.className = "answer-text";
    text.textContent = a.content;
    box.appendChild(text);
    if (a.citations.length) {
      const h = document.createElement("div");
      h.className = "sources-head";
      h.textContent = i18n.t("research.sources");
      box.appendChild(h);
      a.citations.forEach((c, i) => {
        const link = document.createElement("a");
        link.href = c.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "answer-source";
        // Prefix each source with its [N] so it lines up with the numbered
        // references Exa embeds in the answer text (no more counting), then
        // append the open-in-new-tab icon so it reads as an external link.
        link.textContent = `[${i + 1}] ${c.title}`;
        link.insertAdjacentHTML("beforeend", EXT_ICON);
        box.appendChild(link);
      });
    }
    const save = document.createElement("button");
    save.className = "web-save";
    save.textContent = i18n.t("research.saveResearch");
    save.addEventListener("click", async () => {
      save.disabled = true;
      save.textContent = "saving…";
      try {
        const originNode = selected && !selected.phantom ? selected : null;
        const origin = originNode
          ? originNode.title.replace(/[\r\n]/g, " ")
          : null;
        const content = [
          "---",
          `saved: ${new Date().toISOString().slice(0, 10)}`,
          `query: "${query.replace(/"/g, "'")}"`,
          ...(origin ? [`researched-from: "[[${origin}]]"`] : []),
          "via: sinapso-deep-research",
          "---",
          "",
          `# ${query}`,
          "",
          ...(origin ? [`> Researching from: [[${origin}]]`, ""] : []),
          a.content,
          "",
          "## Sources",
          "",
          ...a.citations.map((c, i) => `${i + 1}. [${c.title}](${c.url})`),
          "",
        ].join("\n");
        const data = await api<{ id: string }>("/api/notes", {
          json: { title: query, content },
        });
        save.textContent = "saved ✓";
        // Move-on-save: once curated into the vault, drop it from history.
        if (currentEntryId) {
          await apiDelete(
            `/api/research/history/${encodeURIComponent(currentEntryId)}`,
          );
          currentEntryId = null;
          await loadHistory();
          updateHistoryNav();
        }
        // Rescan-diff the vault in place (no reload) and fly to the new note —
        // it joins the graph with its resolved [[links]] to the origin note.
        await openAfterIngest(String(data.id));
      } catch {
        save.disabled = false;
        save.textContent = "save failed — retry";
      }
    });
    box.appendChild(save);
    return box;
  }

  // Web research entry shared by the search field and the per-note
  // research questions (F019): consent-gated before any egress.
  function startWebResearch(query: string) {
    if (integrations && !integrations.consents.web) {
      promptWebConsent();
      return;
    }
    void runWebQuery(query);
  }

  // Orphan link suggestion (F034): for a note with no links in or out, offer
  // its top semantic neighbor as a one-click [[wiki]] link. PREVIEW-THEN-CONFIRM
  // — nothing is written until the user clicks; the insert goes through the
  // guarded writer (POST /api/gaps/link -> write.ts) and is journaled.
  async function appendOrphanLink(n: GNode, slot: HTMLElement) {
    if (n.phantom || n.in + n.out > 0) return; // orphans only
    if (!(await fetchSemantic())) return; // needs the semantic edges
    let best: { id: string; score: number } | null = null;
    for (const l of semanticLinks) {
      const s = endNode(l.source).id;
      const t = endNode(l.target).id;
      const other = s === n.id ? t : t === n.id ? s : null;
      if (other && (!best || l.weight > best.score))
        best = { id: other, score: l.weight };
    }
    if (!best) return;
    const neighbor = byId.get(best.id);
    if (!neighbor) return;
    const targetBase = best.id.split("/").pop()!.replace(/\.md$/i, "");

    const box = document.createElement("section");
    box.id = "orphan-link";
    const h = document.createElement("h3");
    h.textContent = "Link suggestion";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent =
      "This note has no links. Connect it to its closest note in the vault?";
    const preview = document.createElement("div");
    preview.className = "gap-query";
    preview.textContent = `[[${neighbor.title}]] · ${Math.round(best.score * 100)}% similar`;
    const btn = document.createElement("button");
    btn.className = "q-btn q-semantic";
    btn.textContent = "add this link";
    btn.title = `Append [[${targetBase}]] to this note`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "adding…";
      try {
        const d = await api<{ added: boolean; error?: string }>(
          "/api/gaps/link",
          { json: { id: n.id, target: targetBase } },
        );
        btn.textContent = d.added
          ? "linked ✓ — rescan to see it"
          : "already linked";
        btn.disabled = false;
        btn.onclick = () => rescan(false);
      } catch {
        btn.disabled = false;
        btn.textContent = "add failed — retry";
      }
    });
    box.append(h, p, preview, btn);
    slot.appendChild(box);
  }

  // Per-note research questions (F019): a button at the end of each note
  // generates 3-5 template questions from THAT note (its unresolved links
  // first). Generation is local and free; executing one runs consent-gated
  // web research in the column. Independent of which mode button is lit.
  function appendNoteQuestions(n: GNode, slot: HTMLElement) {
    if (n.phantom) return;
    const box = document.createElement("section");
    box.id = "note-questions";
    const btn = document.createElement("button");
    btn.id = "note-questions-btn";
    btn.textContent = `✦ ${i18n.t("q.button")}`;
    btn.title = i18n.t("q.buttonTitle");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.classList.add("generating");
      btn.innerHTML = `<span class="q-star">✦</span> ${i18n.t("q.generating")}`; // LLM path takes a few seconds (F021)
      try {
        const data = await api<{ questions: string[] }>(
          `/api/note-questions?id=${encodeURIComponent(n.id)}`,
        );
        btn.remove();
        const h = document.createElement("h3");
        h.textContent = "Research questions";
        box.appendChild(h);
        if (!data.questions.length) {
          const p = document.createElement("p");
          p.className = "muted";
          p.textContent = "no questions for this note";
          box.appendChild(p);
          return;
        }
        // Each question can be answered two ways: semantically over the vault
        // (qmd, local, free) or on the web (Exa deep research). Many questions
        // are project/internal and only the vault has the answer, so the user
        // picks the source per question (F036).
        for (const q of data.questions) {
          const row = document.createElement("div");
          row.className = "gap-row question-row";
          const text = document.createElement("div");
          text.className = "gap-query";
          text.textContent = q;
          row.appendChild(text);
          const actions = document.createElement("div");
          actions.className = "question-actions";
          const semBtn = document.createElement("button");
          semBtn.className = "q-btn q-semantic";
          semBtn.textContent = i18n.t("q.vault");
          semBtn.title = i18n.t("q.vaultTitle");
          semBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void runSemanticQuery(q);
          });
          const webBtn = document.createElement("button");
          webBtn.className = "q-btn q-web";
          webBtn.textContent = i18n.t("q.web");
          webBtn.title = i18n.t("q.webTitle");
          webBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            startWebResearch(q);
          });
          actions.append(semBtn, webBtn);
          row.appendChild(actions);
          box.appendChild(row);
        }
      } catch {
        btn.disabled = false;
        btn.classList.remove("generating");
        btn.textContent = `✦ ${i18n.t("q.button")}`;
      }
    });
    box.appendChild(btn);
    slot.appendChild(box);
  }

  function renderWebResult(r: {
    title: string;
    url: string;
    snippet: string;
    publishedDate: string | null;
    score?: number | null;
  }): HTMLElement {
    const row = document.createElement("div");
    row.className = "web-result";
    // The title opens the FULL article (Exa fetch) as its own history page; a
    // ctrl/cmd/middle-click still opens the original site in a new tab.
    const link = document.createElement("a");
    link.href = r.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "web-result-title";
    link.textContent = r.title;
    link.title = i18n.t("research.openArticle");
    link.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      void runArticleFetch(r.url, r.title);
    });
    const snip = document.createElement("div");
    snip.className = "web-snippet";
    snip.textContent = r.snippet;
    const meta = document.createElement("div");
    meta.className = "web-meta";
    const date = document.createElement("span");
    date.textContent = r.publishedDate?.slice(0, 10) ?? "";
    meta.append(date);
    const badge = scoreBadge(r.score);
    if (badge) meta.append(badge);
    row.append(link, snip, meta);
    attachExpand(snip);
    return row;
  }

  // Restore a persisted mode on boot (consent already recorded): the
  // search field reflects it; the column only opens on the first query.
  updateSearchField();
  void integrationsLoaded.then(updateSearchField);

  // ---- menubar (File / View / Tools / Help) ----
  const menus = [...document.querySelectorAll<HTMLElement>(".menu")];
  const closeMenus = () => menus.forEach((m) => m.classList.remove("open"));
  for (const m of menus) {
    const label = m.querySelector(".menu-label") as HTMLElement;
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains("open");
      closeMenus();
      if (!wasOpen) m.classList.add("open");
    });
    // standard menubar behavior: once one menu is open, hover switches
    label.addEventListener("mouseenter", () => {
      if (
        menus.some((x) => x.classList.contains("open")) &&
        !m.classList.contains("open")
      ) {
        closeMenus();
        m.classList.add("open");
      }
    });
  }
  // close menus only when the click lands outside any menu, so interacting
  // with controls inside a dropdown (checkbox, select, layer row) keeps it open
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".menu")) closeMenus();
  });

  // ---- rail (rail mode): the right-edge icon rail drives the existing
  // menubar menus and panel reopen buttons. See #topbar-rail markup
  // and the .topbar-rail state class toggled by layoutTopbar. ----
  const rail = $("#topbar-rail");
  if (rail) {
    rail.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".rail-icon");
      if (!btn) return;
      e.stopPropagation();
      const kind = btn.dataset.rail;
      if (kind === "menu") {
        const m = menus[Number(btn.dataset.idx ?? "-1")];
        if (!m) return;
        const wasOpen = m.classList.contains("open");
        closeMenus();
        if (!wasOpen) m.classList.add("open");
      } else if (kind === "reopen-content") {
        $("#reopen-content")?.click();
      } else if (kind === "reopen-research") {
        $("#reopen-research")?.click();
      }
    });
  }

  // ---- interface language (EN/ES) ----
  // hydrate() (in i18n) covers the static [data-i18n] tags; this re-applies the
  // chrome strings JS writes at runtime, so a live switch updates them too.
  const refreshDynamicChrome = () => {
    updateSearchField();
    renderModes();
    renderVoiceConfig(); // voice placeholder + status are JS-written too
    if (researchMode)
      $("#research-title").textContent = i18n.t(`research.${researchMode}`);
  };
  syncLangUI();
  for (const chip of document.querySelectorAll<HTMLElement>(".lang-chip")) {
    chip.addEventListener("click", () => {
      i18n.setLang(chip.dataset.lang as i18n.Lang); // persists + re-hydrates static
      syncLangUI();
      refreshDynamicChrome();
      closeMenus();
    });
  }

  // ---- topbar reflow around docked panels ----
  // Any dock/undock/open/close flips a class on #reader or #research, and a
  // width resize changes their inline style — observe both so the topbar inset
  // AND the bottom corner buttons follow. A trailing pass re-measures once the
  // dock/slide transition (~0.25s) has settled the width.
  let relayoutT = 0;
  const relayout = () => {
    layoutTopbar();
    clearTimeout(relayoutT);
    relayoutT = window.setTimeout(layoutTopbar, 300);
  };
  const topbarObs = new MutationObserver(relayout);
  for (const id of ["#reader", "#research"])
    topbarObs.observe($(id), {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  window.addEventListener("resize", layoutTopbar);
  relayout();

  // ---- modal ----
  const showModal = (title: string, html: string) => {
    $("#modal").classList.remove("admin-modal");
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal-backdrop").classList.remove("hidden");
  };
  let adminDirty = false;
  let adminSaving = false;
  const hideModal = async (): Promise<boolean> => {
    if (
      $("#modal").classList.contains("admin-modal") &&
      adminDirty &&
      !adminSaving
    ) {
      if (confirm(i18n.t("admin.unsavedSave"))) {
        adminSaving = true;
        const saved = await saveAdmin();
        adminSaving = false;
        if (!saved) return false;
      } else if (!confirm(i18n.t("admin.unsavedDiscard"))) return false;
    }
    adminDirty = false;
    $("#modal-backdrop").classList.add("hidden");
    return true;
  };
  $("#modal-close").addEventListener("click", () => void hideModal());
  $("#modal-backdrop").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) void hideModal();
  });

  type OpsStatus = {
    label: string;
    detail?: string;
    pct?: number;
    indeterminate?: boolean;
  } | null;
  let rescanRunning = false;
  function setOpsStatus(status: OpsStatus): void {
    const wrap = $("#ops-status");
    const bar = $("#ops-bar");
    const fill = bar.querySelector("span") as HTMLElement;
    if (!status) {
      wrap.classList.add("hidden");
      wrap.classList.remove("indeterminate");
      fill.style.width = "0";
      bar.removeAttribute("aria-valuenow");
      return;
    }
    wrap.classList.remove("hidden");
    wrap.classList.toggle("indeterminate", !!status.indeterminate);
    $("#ops-label").textContent = status.label;
    $("#ops-detail").textContent = status.detail ?? "";
    if (status.indeterminate) {
      fill.style.width = "";
      bar.removeAttribute("aria-valuenow");
      return;
    }
    const pct = Math.max(0, Math.min(100, status.pct ?? 0));
    fill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
  }

  // ---- File ----
  async function rescan(full: boolean) {
    closeMenus();
    rescanRunning = true;
    setOpsStatus({
      label: i18n.t(full ? "ops.fullRescan" : "ops.rescan"),
      indeterminate: true,
    });
    showModal(
      full ? "Full rescan…" : "Rescanning vault…",
      '<p class="muted">Re-reading the vault and rebuilding the graph…</p>',
    );
    try {
      // When enabled, refresh qmd alongside the Sinapso graph rescan. This also
      // covers notes created inside Sinapso because those paths call rescan().
      const autoUpdate = prefs.getAutoUpdate();
      const autoEmbed = prefs.getAutoEmbed();
      if (qmdStatus.state === "ready" && (autoUpdate || autoEmbed)) {
        const q = new URLSearchParams();
        if (autoUpdate) q.set("update", "1");
        if (autoEmbed) q.set("embed", "1");
        await api(`/api/qmd/maintenance?${q}`, {
          method: "POST",
        }).catch(() => {});
      }
      const r = await api<{ ok: boolean; error?: string; graph?: Graph }>(
        `/api/rescan${full ? "?full=true" : ""}`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(r.error);
      // Hot-swap the new graph in place — no reload, no reflow. Fall back to a
      // full reload only if the server didn't return the graph (older build).
      if (r.graph) {
        applyGraphUpdate(r.graph as Graph);
        void hideModal();
      } else {
        window.location.reload();
      }
    } catch {
      showModal(
        "Rescan failed",
        "<p>Could not rescan. The server needs access to the original vault path.</p>",
      );
    } finally {
      rescanRunning = false;
      setOpsStatus(null);
      if (qmdStatus.state === "ready") void refreshMaint();
    }
  }
  $("#mi-rescan").addEventListener("click", () => rescan(false));
  $("#mi-reload").addEventListener("click", () => window.location.reload());
  $("#mi-export").addEventListener("click", () => {
    closeMenus();
    const a = document.createElement("a");
    a.download = `sinapso-${data.meta.vaultName ?? "vault"}-${new Date().toISOString().slice(0, 10)}.png`;
    a.href = graph.renderer().domElement.toDataURL("image/png");
    a.click();
  });
  $("#mi-clear-research-history").addEventListener("click", () => {
    closeMenus();
    void clearResearchHistory();
  });
  $("#mi-clear-note-history").addEventListener("click", () => {
    closeMenus();
    void clearNoteHistory();
  });

  // ---- View ----
  $("#mi-fullscreen").addEventListener("click", () => {
    closeMenus();
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });
  $("#mi-resetcam").addEventListener("click", () => {
    closeMenus();
    clearSelection();
    graph.zoomToFit(1000, 60);
  });
  // ---- Tools ----
  $("#mi-filters").addEventListener("click", () => {
    closeMenus();
    $("#filters").classList.remove("hidden");
  });
  $("#mi-settings").addEventListener("click", () => {
    closeMenus();
    $("#settings").classList.remove("hidden");
  });
  $("#mi-copyfocus").addEventListener("click", () => {
    closeMenus();
    if (!selected) {
      showModal(
        "No note selected",
        "<p>Click a node first, then copy a link to it.</p>",
      );
      return;
    }
    navigator.clipboard.writeText(nodeUrl(selected).toString());
  });
  $("#mi-obsidian").addEventListener("click", () => {
    closeMenus();
    if (selected) openInObsidian(selected);
    else showModal("No note selected", "<p>Click a node first.</p>");
  });

  // ---- Admin (F045): vault path, wiki checkboxes, per-wiki raw folder,
  // prompt overrides. Reuses showModal() + postConfig(); read-only fetch of
  // discovered wikis via /api/wikis (which already merges with saved state).
  async function openAdmin() {
    const T = (k: string) => i18n.t(k);
    const vaultPath =
      integrations?.admin?.activeVaultPath ?? data.meta.vaultPath ?? "";
    const inboxFolder = integrations?.writeDestination ?? "inbox";
    const archiveFolder = integrations?.archiveDestination ?? "archive";
    const imagesFolder = integrations?.imagesDestination ?? "images";
    const currentExcludes =
      integrations?.admin?.excludes ?? data.meta.excludes ?? [];
    const body = $("#modal-body");
    showModal(T("admin.title"), "");
    $("#modal").classList.add("admin-modal");
    body.innerHTML = `
      <section class="admin-section">
        <h3>${T("admin.vault")} <span class="muted admin-section-hint">${T("admin.foldersHint")}</span></h3>
        <div class="admin-vault">
          <label class="admin-vault-picker"><span>${T("admin.vaultPath")}</span><input id="admin-vault-input" type="text" value="${escapeHtml(vaultPath)}" placeholder="${T("admin.vaultPathPlaceholder")}"></label>
          <div class="admin-folder-row">
            <label class="admin-folder-field"><span>${T("admin.inboxFolder")}</span><input id="admin-inbox-input" type="text" value="${escapeHtml(inboxFolder)}"></label>
            <label class="admin-folder-field"><span>${T("admin.archiveFolder")}</span><input id="admin-archive-input" type="text" value="${escapeHtml(archiveFolder)}"></label>
            <label class="admin-folder-field"><span>${T("admin.imagesFolder")}</span><input id="admin-images-input" type="text" value="${escapeHtml(imagesFolder)}"></label>
          </div>
          <label class="admin-folder-field admin-excludes-field"><span>${T("admin.excludeFolders")}</span><textarea id="admin-excludes-input" rows="2" placeholder="${T("admin.excludePlaceholder")}">${escapeHtml(currentExcludes.join(", "))}</textarea><small>${T("admin.excludeHint")}</small></label>
        </div>
      </section>
      <section class="admin-section">
        <h3>${T("admin.wikis")} <span class="muted admin-section-hint">${T("admin.wikisHint")}</span></h3>
        <div id="admin-wikis"><p class="muted">${T("admin.loading")}</p></div>
        <div class="admin-wiki-actions">
          <button id="admin-add-manual" class="ghost">${T("admin.addManual")}</button>
          <button id="admin-rediscover" class="ghost">${T("admin.rediscover")}</button>
        </div>
      </section>
      <section class="admin-section">
        <h3>${T("admin.prompts")} <span class="muted admin-section-hint">${T("admin.promptsHint")}</span></h3>
        <div id="admin-prompts"></div>
      </section>
      <section class="admin-section" id="admin-git" style="display:none"></section>
      <div class="admin-save-row">
        <div class="admin-maint-actions">
          <button id="admin-rescan-full">${T("admin.rescanFull")}</button>
          ${qmdStatus.state === "ready" ? `<button id="admin-reembed-full">${T("admin.reembedFull")}</button>` : ""}
        </div>
        <span id="admin-status" class="muted"></span>
        <button id="admin-save">${T("admin.save")}</button>
      </div>`;
    await renderAdminGit();
    await renderAdminWikis();
    renderAdminPrompts();
    body.oninput = () => (adminDirty = true);
    body.onchange = () => (adminDirty = true);
    $("#admin-add-manual").addEventListener("click", () => {
      adminDirty = true;
      appendAdminWikiRow({
        id: "manual-" + Math.random().toString(36).slice(2, 8),
        label: "",
        path: "",
        enabled: true,
        contractFiles: [],
        rawDestination: "../raw/",
        discovered: false,
        confidence: "low",
      });
    });
    $("#admin-rediscover").addEventListener("click", renderAdminWikis);
    $("#admin-save").addEventListener("click", saveAdmin);
    $("#admin-rescan-full").addEventListener("click", async () => {
      if (await hideModal()) void rescan(true);
    });
    const reembed = document.querySelector("#admin-reembed-full");
    reembed?.addEventListener("click", async () => {
      if (!(await hideModal())) return;
      await refreshQmdStatus(true);
      if (qmdStatus.state !== "ready") {
        showModal(
          i18n.t("qmd.notReadyTitle"),
          `<p>${i18n.t("qmd.notReadyBody")}</p>`,
        );
        return;
      }
      if (!(await startMaint(false, true, true))) {
        showModal(i18n.t("qmd.busyTitle"), `<p>${i18n.t("qmd.busyBody")}</p>`);
      }
    });
  }

  async function renderAdminGit(notice = "", outputText = "") {
    const box = document.querySelector<HTMLElement>("#admin-git");
    if (!box) return;
    const T = (k: string) => i18n.t(k);
    try {
      const status = await api<GitStatus>("/api/git/status");
      if (!status.available) {
        box.style.display = "none";
        box.innerHTML = "";
        return;
      }
      const files = status.files ?? [];
      const clean = status.clean !== false;
      const created = files.filter(
        (f) => f.status === "??" || f.status.includes("A"),
      ).length;
      const modified = files.filter((f) => /[MR]/.test(f.status)).length;
      const deleted = files.filter((f) => f.status.includes("D")).length;
      const other = Math.max(0, files.length - created - modified - deleted);
      const aheadBehind = [
        status.ahead ? `+${status.ahead}` : "",
        status.behind ? `-${status.behind}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const changeSummary = files.length
        ? `
          <span class="admin-git-change created">+${created} ${T("admin.gitCreated")}</span>
          <span class="admin-git-change modified">${modified} ${T("admin.gitModified")}</span>
          <span class="admin-git-change deleted">-${deleted} ${T("admin.gitDeleted")}</span>
          ${other ? `<span class="admin-git-change">${other} ${T("admin.gitOther")}</span>` : ""}`
        : `<strong class="admin-git-nochanges">${T("admin.gitNoChanges")}</strong>`;
      box.style.display = "";
      box.innerHTML = `
        <h3>${T("admin.git")} <span class="muted admin-section-hint">${escapeHtml(status.upstream || T("admin.gitNoUpstream"))}</span></h3>
        <div class="admin-git-toolbar">
          <div class="admin-git-summary">
            <span class="admin-badge">${escapeHtml(status.branch ?? "HEAD")}${aheadBehind ? ` ${aheadBehind}` : ""}</span>
            <span class="admin-git-state ${clean ? "clean" : "dirty"}">${T(clean ? "admin.gitClean" : "admin.gitDirty")}</span>
          </div>
        </div>
        <div class="admin-git-action-row">
          <span class="admin-git-change-summary">${changeSummary}</span>
          <div class="admin-git-actions">
            <button id="admin-git-commit" type="button">${T("admin.gitCommit")}</button>
            <button id="admin-git-sync" type="button" ${clean ? "" : "disabled"}>${T("admin.gitSync")}</button>
          </div>
        </div>
        <div id="admin-git-status" class="muted">${escapeHtml(notice)}</div>
        <pre id="admin-git-output" class="admin-git-output ${outputText ? "" : "hidden"}">${escapeHtml(outputText)}</pre>`;

      const commit = $("#admin-git-commit") as HTMLButtonElement;
      const sync = $("#admin-git-sync") as HTMLButtonElement;
      const opStatus = $("#admin-git-status");
      const output = $("#admin-git-output");
      const updateCommit = () => (commit.disabled = clean);
      updateCommit();
      commit.addEventListener("click", async () => {
        commit.disabled = true;
        sync.disabled = true;
        opStatus.textContent = T("admin.gitCommitting");
        try {
          const result = await api<GitActionResult>("/api/git/commit", {
            json: {},
          });
          opStatus.textContent = result.output || T("admin.gitCommitted");
          await renderAdminGit(T("admin.gitCommitted"));
        } catch (e) {
          opStatus.textContent = gitErrorText(e);
          updateCommit();
          sync.disabled = !clean;
        }
      });
      sync.addEventListener("click", async () => {
        sync.disabled = true;
        commit.disabled = true;
        opStatus.textContent = T("admin.gitSyncing");
        output.classList.add("hidden");
        try {
          const result = await api<GitActionResult>("/api/git/sync", {
            method: "POST",
          });
          opStatus.textContent = T("admin.gitSynced");
          if (result.output) {
            output.textContent = result.output;
            output.classList.remove("hidden");
          }
          await renderAdminGit(T("admin.gitSynced"), result.output ?? "");
        } catch (e) {
          opStatus.textContent = gitErrorText(e);
          updateCommit();
          sync.disabled = !clean;
        }
      });
    } catch {
      box.style.display = "none";
      box.innerHTML = "";
    }
  }

  function gitErrorText(e: unknown): string {
    if (e instanceof ApiError) {
      const b = e.body as { error?: string; message?: string } | null;
      return b?.message ?? b?.error ?? i18n.t("admin.gitError");
    }
    return i18n.t("admin.gitError");
  }

  async function renderAdminWikis() {
    const box = $("#admin-wikis");
    try {
      const { wikis } = await api<{ wikis: AdminWikiConfig[] }>("/api/wikis");
      box.innerHTML = "";
      if (!wikis.length) {
        box.innerHTML = `<p class="muted">${i18n.t("admin.empty")}</p>`;
        return;
      }
      for (const w of wikis) appendAdminWikiRow(w, box);
    } catch {
      box.innerHTML = `<p class="muted">${i18n.t("admin.saveFail")}</p>`;
    }
  }

  function appendAdminWikiRow(w: AdminWikiConfig, container?: HTMLElement) {
    const box = container ?? $("#admin-wikis");
    const row = document.createElement("div");
    row.className = "admin-wiki-row";
    const contracts = w.contractFiles
      .map((f) => `<span class="admin-badge">${escapeHtml(f)}</span>`)
      .join("");
    row.innerHTML = `
      <div class="admin-wiki-grid">
        <label class="admin-field admin-field-path"><span><input type="checkbox" ${w.enabled ? "checked" : ""}> ${i18n.t("admin.wikiPath")}</span><input class="admin-path" type="text" value="${escapeHtml(w.path)}" placeholder="${i18n.t("admin.manualPlaceholder")}"></label>
        <label class="admin-field"><span>${i18n.t("admin.wikiRaw")}</span><input class="admin-raw" type="text" value="${escapeHtml(w.rawDestination ?? "")}" placeholder="${i18n.t("admin.wikiRawHint")}"></label>
        <span class="admin-conf admin-conf-${w.confidence}">${i18n.t("admin.wikiConf")}: ${w.confidence}</span>
        <span class="admin-contracts">${contracts || '<span class="muted">no contract files</span>'}</span>
      </div>
      `;
    box.appendChild(row);
  }

  function renderAdminPrompts() {
    const box = $("#admin-prompts");
    const admin = integrations?.admin;
    if (!admin) return;
    box.innerHTML = "";
    const shell = document.createElement("div");
    shell.className = "admin-prompts-layout";
    const list = document.createElement("div");
    list.className = "admin-prompt-list";
    const editor = document.createElement("div");
    editor.className = "admin-prompt-editor";
    shell.append(list, editor);
    box.appendChild(shell);
    for (const key of PROMPT_KEYS) {
      const effective = admin.prompts[key] ?? admin.promptDefaults[key] ?? "";
      const tab = document.createElement("button");
      tab.className = "admin-prompt-tab";
      tab.type = "button";
      tab.dataset.key = key;
      tab.textContent = PROMPT_LABELS[key];
      list.appendChild(tab);
      const row = document.createElement("div");
      row.className = "admin-prompt-row hidden";
      row.dataset.key = key;
      row.innerHTML = `
        <div class="admin-prompt-head"><span>${PROMPT_LABELS[key]}</span><button class="ghost admin-reset" data-i18n="admin.reset">${i18n.t("admin.reset")}</button></div>
        <textarea class="admin-prompt-text" rows="3">${escapeHtml(effective)}</textarea>`;
      editor.appendChild(row);
    }
    const activate = (key: string) => {
      list
        .querySelectorAll(".admin-prompt-tab")
        .forEach((b) =>
          b.classList.toggle("active", (b as HTMLElement).dataset.key === key),
        );
      editor
        .querySelectorAll(".admin-prompt-row")
        .forEach((r) =>
          r.classList.toggle("hidden", (r as HTMLElement).dataset.key !== key),
        );
    };
    list
      .querySelectorAll(".admin-prompt-tab")
      .forEach((b) =>
        b.addEventListener("click", () =>
          activate((b as HTMLElement).dataset.key!),
        ),
      );
    activate(PROMPT_KEYS[0]);
    box.querySelectorAll(".admin-reset").forEach((b) =>
      b.addEventListener("click", async () => {
        const row = b.closest(".admin-prompt-row") as HTMLElement | null;
        const key = row?.dataset.key;
        if (!key) return;
        try {
          await postConfig({ prompts: { [key]: null } });
          await refreshIntegrations();
          renderAdminPrompts();
          flashAdmin(i18n.t("admin.saved"));
        } catch {
          flashAdmin(i18n.t("admin.saveFail"));
        }
      }),
    );
  }

  async function saveAdmin(): Promise<boolean> {
    const status = $("#admin-status");
    status.textContent = i18n.t("admin.saving");
    const vaultPath =
      integrations?.admin?.activeVaultPath ?? data.meta.vaultPath ?? "";
    const requestedVaultPath = (
      $("#admin-vault-input") as HTMLInputElement
    ).value.trim();
    const inboxFolder =
      ($("#admin-inbox-input") as HTMLInputElement).value.trim() || "inbox";
    const archiveFolder =
      ($("#admin-archive-input") as HTMLInputElement).value.trim() || "archive";
    const previousArchiveFolder = integrations?.archiveDestination ?? "archive";
    const previousImagesFolder = integrations?.imagesDestination ?? "images";
    const imagesFolder =
      ($("#admin-images-input") as HTMLInputElement).value.trim() || "images";
    let excludes = parseAdminExcludes(
      ($("#admin-excludes-input") as HTMLTextAreaElement).value,
    );
    const currentGraphExcludes =
      integrations?.admin?.excludes ?? data.meta.excludes ?? [];
    const savedVault = integrations?.admin?.vaults[vaultPath];
    if (
      !savedVault?.excludesInitialized &&
      !excludesChanged(excludes, currentGraphExcludes)
    ) {
      excludes = replaceExcludes(
        excludes,
        previousArchiveFolder,
        archiveFolder,
      );
      excludes = replaceExcludes(excludes, previousImagesFolder, imagesFolder);
    }
    const prompts: Record<string, string | null> = {};
    const defaults = integrations?.admin?.promptDefaults ?? {};
    for (const row of document.querySelectorAll(
      ".admin-prompt-row",
    ) as NodeListOf<HTMLElement>) {
      const key = row.dataset.key!;
      const val = (
        row.querySelector(".admin-prompt-text") as HTMLTextAreaElement
      ).value.trim();
      prompts[key] = val && val !== defaults[key] ? val : null;
    }

    try {
      if (requestedVaultPath !== vaultPath) {
        const body = await api<{ error?: string; graph?: Graph }>(
          "/api/vault",
          { json: { path: requestedVaultPath } },
        );
        if (!body.graph)
          throw new Error(body.error ?? i18n.t("admin.saveFail"));
        applyGraphUpdate(body.graph);
        await postConfig({
          prompts,
          writeDestination: inboxFolder,
          archiveDestination: archiveFolder,
          imagesDestination: imagesFolder,
        });
        await refreshIntegrations();
        await refreshEnabledWikiLayers();
        if (
          archiveFolder !== previousArchiveFolder ||
          imagesFolder !== previousImagesFolder
        ) {
          adminDirty = false;
          await rescan(true);
          return true;
        }
        ($("#admin-vault-input") as HTMLInputElement).value =
          body.graph.meta.vaultPath;
        await renderAdminGit();
        await renderAdminWikis();
        adminDirty = false;
        flashAdmin(i18n.t("admin.saved"));
        return true;
      }

      const wikis: AdminWikiConfig[] = [];
      for (const row of document.querySelectorAll(
        ".admin-wiki-row",
      ) as NodeListOf<HTMLElement>) {
        const path = (
          row.querySelector(".admin-path") as HTMLInputElement
        ).value.trim();
        const enabled = (
          row.querySelector("input[type='checkbox']") as HTMLInputElement
        ).checked;
        const rawDestination = (
          row.querySelector(".admin-raw") as HTMLInputElement
        ).value.trim();
        const finalPath = path;
        if (!finalPath) continue;
        wikis.push({
          id: finalPath,
          label: finalPath,
          path: finalPath,
          enabled,
          contractFiles: [],
          rawDestination: rawDestination || null,
          discovered: false,
          confidence: "low",
        });
      }
      await postConfig({
        vaults: vaultPath
          ? {
              [vaultPath]: {
                path: vaultPath,
                excludes,
                excludesInitialized: true,
                wikis,
              },
            }
          : {},
        prompts,
        writeDestination: inboxFolder,
        archiveDestination: archiveFolder,
        imagesDestination: imagesFolder,
      });
      await refreshIntegrations();
      await refreshEnabledWikiLayers();
      if (excludesChanged(excludes, data.meta.excludes ?? [])) {
        adminDirty = false;
        await rescan(true);
        return true;
      }
      adminDirty = false;
      flashAdmin(i18n.t("admin.saved"));
      return true;
    } catch (e) {
      flashAdmin(e instanceof Error ? e.message : i18n.t("admin.saveFail"));
      return false;
    }
  }

  function parseAdminExcludes(value: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of value.split(/[,\n]+/)) {
      const clean = part
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .trim();
      if (
        !clean ||
        clean === "." ||
        clean.includes("..") ||
        seen.has(clean.toLowerCase())
      )
        continue;
      seen.add(clean.toLowerCase());
      out.push(clean);
    }
    return out;
  }

  function replaceExcludes(
    excludes: string[],
    oldPath: string,
    newPath: string,
  ): string[] {
    const oldKey = oldPath
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();
    const cleanNew = newPath
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .trim();
    if (!oldKey || !cleanNew) return excludes;
    return excludes.map((e) =>
      e
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase() === oldKey
        ? cleanNew
        : e,
    );
  }

  function excludesChanged(a: string[], b: string[]): boolean {
    return a.join("\n") !== b.join("\n");
  }

  function flashAdmin(msg: string) {
    const status = $("#admin-status");
    status.textContent = msg;
    setTimeout(() => (status.textContent = ""), 2500);
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  $("#mi-admin").addEventListener("click", () => {
    closeMenus();
    void openAdmin();
  });

  // ---- Help ----
  $("#mi-shortcuts").addEventListener("click", () => {
    closeMenus();
    showModal(
      "Keyboard & mouse controls",
      `<table>
        <tr><td>Rotate</td><td>left-drag</td></tr>
        <tr><td>Fly</td><td><kbd>↑</kbd> forward, <kbd>↓</kbd> back, <kbd>←</kbd><kbd>→</kbd> strafe</td></tr>
        <tr><td>Zoom (map)</td><td>scroll</td></tr>
        <tr><td>Zoom (interface)</td><td><kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>−</kbd>, <kbd>Ctrl</kbd>+<kbd>0</kbd> resets</td></tr>
        <tr><td>Pan</td><td>right-drag, or <kbd>Shift</kbd>+arrows</td></tr>
        <tr><td>Search</td><td><kbd>/</kbd>, then <kbd>Enter</kbd> to fly to the top hit</td></tr>
        <tr><td>Select / read note</td><td>click a node</td></tr>
        <tr><td>Open in Obsidian</td><td>double-click or right-click a node</td></tr>
        <tr><td>Show / hide panels</td><td><kbd>A</kbd> content (left) · <kbd>D</kbd> research (right)</td></tr>
        <tr><td>Cycle arrangement</td><td><kbd>S</kbd> links → hybrid → semantic</td></tr>
        <tr><td>Clear selection</td><td><kbd>Esc</kbd></td></tr>
        <tr><td>Focus depth</td><td>1–3 in the bottom bar (local-graph radius)</td></tr>
      </table>`,
    );
  });
  $("#mi-about").addEventListener("click", () => {
    closeMenus();
    const m = data.meta;
    showModal(
      "About Sinapso",
      `<p><b>Sinapso</b> — your vault as a navigable 3D universe.</p>
       <table>
        <tr><td>Vault</td><td>${m.vaultName ?? "—"}</td></tr>
        <tr><td>Notes</td><td>${m.notes.toLocaleString()}</td></tr>
        <tr><td>Links</td><td>${m.links.toLocaleString()}</td></tr>
        <tr><td>Unwritten targets</td><td>${m.phantoms.toLocaleString()}</td></tr>
        <tr><td>Last scanned</td><td>${new Date(m.scannedAt).toLocaleString()}</td></tr>
       </table>
       <p class="muted" style="margin-bottom:0">MIT licensed · built with three.js</p>`,
    );
  });

  // --- global keys: search, clear, and keyboard camera control ---
  // Arrows fly the camera through space (↑ forward, ↓ back, ←/→ strafe),
  // shift+arrows pan; scroll zooms the map. Rotation stays on mouse left-drag.
  // Held arrows drive a per-frame loop (smooth, frame-rate independent)
  // that accelerates from base speed to FLY_RAMP× over FLY_RAMP_S seconds.
  const FLY_BASE = 1.5; // distance-to-target multiples per second
  const FLY_RAMP = 6; // top speed multiplier once fully ramped
  const FLY_RAMP_S = 5; // seconds of continuous flight to reach top speed
  const heldArrows = new Set<string>();
  let shiftHeld = false;
  let flyStart = 0;

  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") shiftHeld = false;
    heldArrows.delete(e.key);
  });
  window.addEventListener("blur", () => {
    heldArrows.clear();
    shiftHeld = false;
  });

  let lastFlyFrame = performance.now();
  (function flyTick(now: number) {
    requestAnimationFrame(flyTick);
    const dt = Math.min((now - lastFlyFrame) / 1000, 0.1);
    lastFlyFrame = now;
    if (!heldArrows.size) return;

    const controls = graph.controls() as unknown as { target: THREE.Vector3 };
    const camera = graph.camera();
    const target = controls.target ?? new THREE.Vector3();
    const dist = camera.position.distanceTo(target);
    const ramp = Math.min((now - flyStart) / 1000 / FLY_RAMP_S, 1);
    const step = dist * FLY_BASE * (1 + (FLY_RAMP - 1) * ramp) * dt;

    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const delta = new THREE.Vector3();
    if (shiftHeld) {
      // pan: slide camera + target along the screen axes
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      if (heldArrows.has("ArrowLeft")) delta.addScaledVector(right, -step);
      if (heldArrows.has("ArrowRight")) delta.addScaledVector(right, step);
      if (heldArrows.has("ArrowUp")) delta.addScaledVector(up, step);
      if (heldArrows.has("ArrowDown")) delta.addScaledVector(up, -step);
    } else {
      // fly: ↑/↓ move along the view direction, ←/→ strafe. Camera and
      // target move together so orientation (and mouse orbit) is preserved.
      const forward = camera.getWorldDirection(new THREE.Vector3());
      if (heldArrows.has("ArrowUp")) delta.addScaledVector(forward, step);
      if (heldArrows.has("ArrowDown")) delta.addScaledVector(forward, -step);
      if (heldArrows.has("ArrowLeft")) delta.addScaledVector(right, -step);
      if (heldArrows.has("ArrowRight")) delta.addScaledVector(right, step);
    }
    camera.position.add(delta);
    target.add(delta);
  })(lastFlyFrame);

  // Toggle a bottom-bar checkbox by selector, running its wired change handler
  // so all side effects (refreshVisibility, bloom.enabled, persistence) apply.
  const flipCheck = (sel: string) => {
    const cb = $(sel) as HTMLInputElement;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  };

  // ---- interface zoom (Ctrl +/-/0): scales the UI chrome + panels via CSS
  // zoom (see style.css `body > :not(#graph)`), never the 3D canvas. Persisted
  // like a browser's zoom level. ----
  let uiZoom = prefs.getUiZoom();
  function setUiZoom(z: number) {
    uiZoom = Math.min(2, Math.max(0.6, Math.round(z * 20) / 20));
    document.documentElement.style.setProperty("--ui-zoom", String(uiZoom));
    prefs.setUiZoom(uiZoom);
  }
  const bumpUiZoom = (d: number) => setUiZoom(uiZoom + d);
  setUiZoom(uiZoom); // restore on boot

  window.addEventListener("keydown", (e) => {
    // Typing in ANY text field (search, web query, Exa key,
    // filters, model entry…) must never trigger app shortcuts.
    const el = document.activeElement as HTMLElement | null;
    const typing =
      !!el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable);
    if (e.key === "/" && !typing) {
      e.preventDefault();
      searchBox.focus();
      return;
    }
    if (e.key === "Escape" && typing && el !== searchBox) {
      el.blur(); // step out of the field; next Escape works on the app
      return;
    }
    if (e.key === "Escape" && !typing) {
      // standard escape order: modal, menus, research column, selection
      if (!$("#modal-backdrop").classList.contains("hidden")) void hideModal();
      else if (menus.some((m) => m.classList.contains("open"))) closeMenus();
      else if (!$("#research").classList.contains("hidden")) closeResearch();
      else clearSelection();
      return;
    }
    if (e.key === "f" && !typing) {
      // toggle the Fullscreen API (same path as View -> Toggle Fullscreen).
      // F11 is browser-reserved and can't be reliably intercepted from JS,
      // so the app uses "f" (the web convention); desktop also keeps native F11.
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
      return;
    }
    // Ctrl/Cmd +/-/0: zoom the interface like any web app (works while typing).
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        bumpUiZoom(0.1);
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        bumpUiZoom(-0.1);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        setUiZoom(1);
        return;
      }
    }

    const k = e.key.toLowerCase();
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
    // bare-letter shortcuts (no modifiers), ignored while typing in search.
    // Each triggers the same control the menu/bottom-bar uses, so behavior
    // (and persistence) stays identical to clicking it.
    if (bare && !typing) {
      if (k === "r") {
        $("#mi-resetcam").click();
        return;
      }
      if (k === "g") {
        flipCheck("#toggle-glow");
        return;
      }
      if (k === "l") {
        flipCheck("#toggle-labels");
        return;
      }
      if (k === "u") {
        flipCheck("#toggle-phantoms");
        return;
      }
      if (k === "o") {
        flipCheck("#toggle-orphans");
        return;
      }
      // s cycles the arrangement links -> hybrid -> semantic, reusing the
      // View-menu dropdown so applyArrangement + persistence stay identical.
      if (k === "s") {
        const sel = $("#arrange") as HTMLSelectElement;
        sel.value =
          ARRANGEMENT_ORDER[
            (ARRANGEMENT_ORDER.indexOf(validArr(sel.value)) + 1) %
              ARRANGEMENT_ORDER.length
          ];
        sel.dispatchEvent(new Event("change"));
        return;
      }
      // a / d toggle the left (content) and right (research) panels, reusing
      // the same corner buttons so state + persistence stay identical.
      if (k === "a") {
        if (!$("#reader").classList.contains("hidden"))
          $("#reader-close").click();
        else $("#reopen-content").click();
        return;
      }
      if (k === "d") {
        if (!$("#research").classList.contains("hidden"))
          $("#research-close").click();
        else $("#reopen-research").click();
        return;
      }
    }
    // Ctrl/Cmd+C copies a link to the selected note — unless the user has a
    // text selection, in which case the native copy wins.
    if ((e.ctrlKey || e.metaKey) && !typing && k === "c") {
      const s = window.getSelection?.();
      if (s && s.toString().length) return;
      e.preventDefault();
      $("#mi-copyfocus").click();
      return;
    }
    // Ctrl/Cmd+O opens the selected note in Obsidian (works in browser and
    // desktop; Open Vault uses Cmd/Ctrl+Shift+O to keep this free).
    if ((e.ctrlKey || e.metaKey) && !typing && k === "o") {
      e.preventDefault();
      $("#mi-obsidian").click();
      return;
    }

    if (typing) return;

    shiftHeld = e.shiftKey;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (e.repeat) return; // the fly loop handles held keys
      if (!heldArrows.size) flyStart = performance.now(); // (re)start the ramp
      heldArrows.add(e.key);
      return;
    }
  });

  window.addEventListener("resize", () => {
    graph.width(window.innerWidth).height(window.innerHeight);
  });

  window.addEventListener("hashchange", () => {
    const nodeId = hashNodeId();
    if (nodeId === null) return;
    const target = byId.get(nodeId);
    if (target) select(target);
  });
}

// Translate the static chrome before boot() awaits the graph, so the menubar
// never flashes English when the persisted / browser language is Spanish.
document.documentElement.lang = i18n.getLang();
i18n.hydrate();
syncLangUI();
boot();
