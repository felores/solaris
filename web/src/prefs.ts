/**
 * Typed `sinapso-*` localStorage facade.
 *
 * One accessor per existing key. Per the plan: key names and stored
 * formats are byte-identical to the previous inline `localStorage`
 * call sites in main.ts; per-key defaults match the boot values the
 * inline code used. Corrupt-JSON behavior matches today's inline
 * `try/catch` (or lack thereof) for each key.
 */

export type ModeName = "vault" | "web" | "ingest";
export type GroupMode = "folder" | "tag" | "cluster" | "wiki";
export type QualityKey = "low" | "medium" | "high";
export type NodeStyle = "classic" | "dodecahedron" | "starlight" | "particles";
export type Arrangement = "links" | "semantic" | "hybrid";
export type WebScope = "deep" | "web";
export type VaultScope = "semantic" | "keyword";
export type Filter = { mode: "show" | "ignore"; pattern: string };
export type SizeWeights = {
  in: number;
  out: number;
  words: number;
  contrast: number;
};
export type ReaderGeom = {
  floating: boolean;
  width: number;
  height: number;
  left: number;
  top: number;
};
export type ResearchGeom = {
  floating: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  dockW: number;
};

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "sinapso-";
const LEGACY_PREFIXES = ["akasha-", "solaris-"] as const;

const KEY = {
  theme: `${PREFIX}theme`,
  group: `${PREFIX}group`,
  colors: `${PREFIX}colors`,
  phantoms: `${PREFIX}phantoms`,
  orphans: `${PREFIX}orphans`,
  depth: `${PREFIX}depth`,
  quality: `${PREFIX}quality`,
  glow: `${PREFIX}glow`,
  arrangement: `${PREFIX}arrangement`,
  semLines: `${PREFIX}sem-lines`,
  filters: `${PREFIX}filters`,
  labels: `${PREFIX}labels`,
  nodes: `${PREFIX}nodes`,
  sizeWeights: `${PREFIX}size-weights`,
  pc: `${PREFIX}pc`,
  reader: `${PREFIX}reader`,
  research: `${PREFIX}research`,
  mode: `${PREFIX}mode`,
  webScope: `${PREFIX}web-scope`,
  vaultScope: `${PREFIX}vault-scope`,
  qmdPrompted: `${PREFIX}qmd-prompted`,
  autoUpdate: `${PREFIX}qmd-auto-update`,
  autoEmbed: `${PREFIX}qmd-auto-embed`,
  uiZoom: `${PREFIX}ui-zoom`,
  labelDistance: `${PREFIX}label-distance`,
  labelSize: `${PREFIX}label-size`,
  nodeSize: `${PREFIX}node-size`,
  linkOpacity: `${PREFIX}link-opacity`,
  minWeight: `${PREFIX}min-weight`,
  intensity: `${PREFIX}intensity`,
  colorBlend: `${PREFIX}color-blend`,
  editorMirror: `${PREFIX}editor-mirror`,
} as const;

const DEFAULT_SIZE_WEIGHTS: SizeWeights = {
  in: 1,
  out: 0.5,
  words: 0.5,
  contrast: 1.5,
};

const onFlag = (v: string | null) => v === "1";
const notOffFlag = (v: string | null) => v !== "0";

/** Unload-safety dirty mirror (plan 018 KTD4b): the last dirty note's
 * content, vault-scoped so a same-id note in another vault is never
 * offered a foreign restore. */
export type EditorMirror = {
  vault: string;
  noteId: string;
  content: string;
  at: number;
};

export interface Prefs {
  getTheme(): string;
  setTheme(v: string): void;

  getEditorMirror(): EditorMirror | null;
  setEditorMirror(v: EditorMirror): void;
  clearEditorMirror(): void;

  getGroup(): GroupMode;
  setGroup(v: GroupMode): void;

  getColors(): Record<string, string>;
  setColors(v: Record<string, string>): void;
  removeColors(): void;

  getPhantoms(): boolean;
  setPhantoms(v: boolean): void;

  getOrphans(): boolean;
  setOrphans(v: boolean): void;

  getDepth(): number;
  setDepth(v: number): void;

  getQuality(): QualityKey;
  setQuality(v: QualityKey): void;

  getGlow(): boolean;
  setGlow(v: boolean): void;

  getArrangement(): Arrangement;
  setArrangement(v: Arrangement): void;

  getSemLines(): boolean;
  setSemLines(v: boolean): void;

  getFilters(): Filter[];
  setFilters(v: Filter[]): void;

  getLabels(): boolean;
  setLabels(v: boolean): void;

  getNodeStyle(): NodeStyle;
  setNodeStyle(v: NodeStyle): void;

  getSizeWeights(): SizeWeights;
  setSizeWeights(v: SizeWeights): void;

  getPc(): string | null;
  setPc(v: number): void;
  removePc(): void;

  getReader(): ReaderGeom | null;
  setReader(v: ReaderGeom): void;

  getResearch(): ResearchGeom | null;
  setResearch(v: ResearchGeom): void;

  getMode(): ModeName | null;
  setMode(v: ModeName): void;
  removeMode(): void;

  getWebScope(): WebScope;
  setWebScope(v: WebScope): void;

  getVaultScope(): VaultScope;
  setVaultScope(v: VaultScope): void;

  wasQmdPrompted(): boolean;
  markQmdPrompted(): void;

  getAutoUpdate(): boolean;
  setAutoUpdate(v: boolean): void;

  getAutoEmbed(): boolean;
  setAutoEmbed(v: boolean): void;

  getUiZoom(): number;
  setUiZoom(v: number): void;

  getLabelDistance(): number | null;
  setLabelDistance(v: number): void;

  getLabelSize(): number | null;
  setLabelSize(v: number): void;

  getNodeSize(): number | null;
  setNodeSize(v: number): void;

  getLinkOpacity(): number | null;
  setLinkOpacity(v: number): void;

  getMinWeight(): number | null;
  setMinWeight(v: number): void;

  getIntensity(): number | null;
  setIntensity(v: number): void;

  getColorBlend(): number | null;
  setColorBlend(v: number): void;
}

function defaultStorage(): PrefsStorage {
  // ponytail: window is typed as possibly-undefined; we want a runtime fallback
  // so the module is importable in node test runs that don't inject storage.
  // The createPrefs() overload lets tests inject a Map-backed fake.
  const w = (globalThis as { window?: { localStorage?: PrefsStorage } }).window;
  const ls = w?.localStorage;
  if (!ls) {
    throw new Error(
      "prefs: no storage injected and window.localStorage is unavailable",
    );
  }
  return ls;
}

export function createPrefs(storage: PrefsStorage = defaultStorage()): Prefs {
  const legacyKeys = (k: string) => {
    if (!k.startsWith(PREFIX)) return [];
    const suffix = k.slice(PREFIX.length);
    return LEGACY_PREFIXES.map((p) => `${p}${suffix}`);
  };
  const get = (k: string) => {
    const current = storage.getItem(k);
    if (current !== null) return current;
    for (const oldKey of legacyKeys(k)) {
      const legacy = storage.getItem(oldKey);
      if (legacy !== null) {
        storage.setItem(k, legacy);
        return legacy;
      }
    }
    return null;
  };
  const set = (k: string, v: string) => storage.setItem(k, v);
  const del = (k: string) => {
    storage.removeItem(k);
    for (const oldKey of legacyKeys(k)) {
      if (storage.getItem(oldKey) !== null) storage.removeItem(oldKey);
    }
  };

  // raw number slider helper (6 keys share this shape)
  const numPref = (k: string) => {
    const read = (): number | null => {
      const v = get(k);
      return v === null ? null : Number(v);
    };
    const write = (v: number) => set(k, String(v));
    return [read, write] as const;
  };

  const [getLabelDistance, setLabelDistance] = numPref(KEY.labelDistance);
  const [getLabelSize, setLabelSize] = numPref(KEY.labelSize);
  const [getNodeSize, setNodeSize] = numPref(KEY.nodeSize);
  const [getLinkOpacity, setLinkOpacity] = numPref(KEY.linkOpacity);
  const [getMinWeight, setMinWeight] = numPref(KEY.minWeight);
  const [getIntensity, setIntensity] = numPref(KEY.intensity);
  const [getColorBlend, setColorBlend] = numPref(KEY.colorBlend);

  return {
    getTheme() {
      return get(KEY.theme) ?? "midnight";
    },
    setTheme(v) {
      set(KEY.theme, v);
    },

    getEditorMirror() {
      const raw = get(KEY.editorMirror);
      if (raw === null) return null;
      try {
        const v = JSON.parse(raw) as EditorMirror;
        return typeof v?.vault === "string" &&
          typeof v?.noteId === "string" &&
          typeof v?.content === "string"
          ? v
          : null;
      } catch {
        return null;
      }
    },
    setEditorMirror(v) {
      set(KEY.editorMirror, JSON.stringify(v));
    },
    clearEditorMirror() {
      del(KEY.editorMirror);
    },

    getGroup() {
      const v = get(KEY.group);
      return v === "folder" || v === "tag" || v === "cluster" || v === "wiki"
        ? v
        : "folder";
    },
    setGroup(v) {
      set(KEY.group, v);
    },

    getColors() {
      return JSON.parse(get(KEY.colors) ?? "{}");
    },
    setColors(v) {
      set(KEY.colors, JSON.stringify(v));
    },
    removeColors() {
      del(KEY.colors);
    },

    getPhantoms() {
      return onFlag(get(KEY.phantoms));
    },
    setPhantoms(v) {
      set(KEY.phantoms, v ? "1" : "0");
    },

    getOrphans() {
      return notOffFlag(get(KEY.orphans));
    },
    setOrphans(v) {
      set(KEY.orphans, v ? "1" : "0");
    },

    getDepth() {
      const n = Number(get(KEY.depth));
      return n === 1 || n === 2 || n === 3 ? n : 2;
    },
    setDepth(v) {
      set(KEY.depth, String(v));
    },

    getQuality() {
      const v = get(KEY.quality);
      return v === "low" || v === "medium" || v === "high" ? v : "medium";
    },
    setQuality(v) {
      set(KEY.quality, v);
    },

    getGlow() {
      return notOffFlag(get(KEY.glow));
    },
    setGlow(v) {
      set(KEY.glow, v ? "1" : "0");
    },

    getArrangement() {
      const v = get(KEY.arrangement);
      return v === "semantic" || v === "hybrid" ? v : "links";
    },
    setArrangement(v) {
      set(KEY.arrangement, v);
    },

    getSemLines() {
      return notOffFlag(get(KEY.semLines));
    },
    setSemLines(v) {
      set(KEY.semLines, v ? "1" : "0");
    },

    getFilters() {
      try {
        const raw = JSON.parse(get(KEY.filters) || "[]");
        if (Array.isArray(raw))
          return raw.filter(
            (f: unknown) =>
              !!f &&
              typeof f === "object" &&
              ((f as { mode?: unknown }).mode === "show" ||
                (f as { mode?: unknown }).mode === "ignore") &&
              typeof (f as { pattern?: unknown }).pattern === "string",
          ) as Filter[];
      } catch {
        /* ignore corrupt value */
      }
      return [];
    },
    setFilters(v) {
      set(KEY.filters, JSON.stringify(v));
    },

    getLabels() {
      return notOffFlag(get(KEY.labels));
    },
    setLabels(v) {
      set(KEY.labels, v ? "1" : "0");
    },

    getNodeStyle() {
      const v = get(KEY.nodes);
      return v === "classic" ||
        v === "dodecahedron" ||
        v === "starlight" ||
        v === "particles"
        ? v
        : "classic";
    },
    setNodeStyle(v) {
      set(KEY.nodes, v);
    },

    getSizeWeights() {
      return {
        ...DEFAULT_SIZE_WEIGHTS,
        ...JSON.parse(get(KEY.sizeWeights) ?? "{}"),
      };
    },
    setSizeWeights(v) {
      set(KEY.sizeWeights, JSON.stringify(v));
    },

    getPc() {
      return get(KEY.pc);
    },
    setPc(v) {
      set(KEY.pc, String(v));
    },
    removePc() {
      del(KEY.pc);
    },

    getReader() {
      return JSON.parse(get(KEY.reader) ?? "null");
    },
    setReader(v) {
      set(KEY.reader, JSON.stringify(v));
    },

    getResearch() {
      return JSON.parse(get(KEY.research) ?? "null");
    },
    setResearch(v) {
      set(KEY.research, JSON.stringify(v));
    },

    getMode() {
      const v = get(KEY.mode);
      return v === "semantic" ? "vault" : (v as ModeName | null);
    },
    setMode(v) {
      set(KEY.mode, v);
    },
    removeMode() {
      del(KEY.mode);
    },

    getWebScope() {
      return get(KEY.webScope) === "web" ? "web" : "deep";
    },
    setWebScope(v) {
      set(KEY.webScope, v);
    },

    getVaultScope() {
      return get(KEY.vaultScope) === "keyword" ? "keyword" : "semantic";
    },
    setVaultScope(v) {
      set(KEY.vaultScope, v);
    },

    wasQmdPrompted() {
      return !!get(KEY.qmdPrompted);
    },
    markQmdPrompted() {
      set(KEY.qmdPrompted, "1");
    },

    getAutoUpdate() {
      return notOffFlag(get(KEY.autoUpdate));
    },
    setAutoUpdate(v) {
      set(KEY.autoUpdate, v ? "1" : "0");
    },

    getAutoEmbed() {
      return notOffFlag(get(KEY.autoEmbed));
    },
    setAutoEmbed(v) {
      set(KEY.autoEmbed, v ? "1" : "0");
    },

    getUiZoom() {
      const n = Number(get(KEY.uiZoom));
      return Number.isFinite(n) && n > 0 ? n : 1;
    },
    setUiZoom(v) {
      set(KEY.uiZoom, String(v));
    },

    getLabelDistance,
    setLabelDistance,
    getLabelSize,
    setLabelSize,
    getNodeSize,
    setNodeSize,
    getLinkOpacity,
    setLinkOpacity,
    getMinWeight,
    setMinWeight,
    getIntensity,
    setIntensity,
    getColorBlend,
    setColorBlend,
  };
}
