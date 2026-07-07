export interface ThemeDef {
  label: string;
  bloom: boolean;
  bg: string;
  linkBase: string;
  linkOut: string;
  linkLit: string;
  dim: string;
  selected: string;
  star: { color: number; opacity: number; mode: "off" | "normal" | "dense" };
  labels: { color: string; bg: string; border: string };
  palette?: Record<string, string>;
  css: Record<string, string>;
}

export const PALETTE: Record<string, string> = {
  Biology: "#51cf66",
  Chemistry: "#fcc419",
  Physics: "#339af0",
  Mathematics: "#845ef7",
  History: "#d9a36a",
  Metaphysics: "#b197fc",
  Books: "#ffa94d",
  Root: "#adb5bd",
  Unwritten: "#5c636a",
};

export const FALLBACK_COLORS: readonly string[] = [
  "#e64980",
  "#15aabf",
  "#82c91e",
  "#fd7e14",
  "#4c6ef5",
  "#f06595",
  "#12b886",
  "#fab005",
  "#7950f2",
  "#fa5252",
  "#40c057",
  "#228be6",
  "#e8590c",
  "#0ca678",
  "#cc5de8",
  "#94d82d",
];

export const THEMES: Record<string, ThemeDef> = {
  midnight: {
    label: "Midnight",
    bloom: true,
    bg: "#070a10",
    linkBase: "#6b7687",
    linkOut: "#161b26",
    linkLit: "#7fb4e8",
    dim: "rgba(70,75,85,0.18)",
    selected: "#ffffff",
    star: { color: 0x46506a, opacity: 0.55, mode: "normal" },
    labels: {
      color: "#e2e8f0",
      bg: "rgba(7,10,16,0.72)",
      border: "rgba(120,150,190,0.35)",
    },
    css: {
      "--bg": "#070a10",
      "--panel": "rgba(13,17,23,0.88)",
      "--border": "#30363d",
      "--fg": "#e6edf3",
      "--muted": "#8b949e",
      "--accent": "#58a6ff",
    },
  },
  gilded: {
    label: "Gilded",
    bloom: true,
    bg: "#040403",
    linkBase: "#8a6f2f",
    linkOut: "#171204",
    linkLit: "#f3cd6b",
    dim: "rgba(90,78,48,0.18)",
    selected: "#fff3d0",
    star: { color: 0x6b5a2a, opacity: 0.4, mode: "normal" },
    labels: {
      color: "#f0e6c8",
      bg: "rgba(10,8,2,0.78)",
      border: "rgba(212,175,55,0.45)",
    },
    css: {
      "--bg": "#040403",
      "--panel": "rgba(14,12,6,0.9)",
      "--border": "#3a3320",
      "--fg": "#ece4cc",
      "--muted": "#8a8064",
      "--accent": "#d4af37",
    },
  },
  manuscript: {
    label: "Manuscript",
    bloom: false,
    bg: "#f2ecdf",
    linkBase: "#5a5443",
    linkOut: "#e3dbc7",
    linkLit: "#1c1a14",
    dim: "rgba(187,178,154,0.5)",
    selected: "#16140e",
    star: { color: 0x000000, opacity: 0, mode: "off" },
    labels: {
      color: "#23201a",
      bg: "rgba(249,245,235,0.85)",
      border: "rgba(90,80,55,0.4)",
    },
    palette: {
      Biology: "#1e7d32",
      Chemistry: "#9a7d0a",
      Physics: "#1a5fb4",
      Mathematics: "#5e35b1",
      History: "#795548",
      Metaphysics: "#6a4c93",
      Books: "#b35c00",
      Root: "#5f6368",
      Unwritten: "#9e9e9e",
    },
    css: {
      "--bg": "#f2ecdf",
      "--panel": "rgba(250,246,237,0.92)",
      "--border": "#d6cdb6",
      "--fg": "#23201a",
      "--muted": "#6b6353",
      "--accent": "#8a6d1f",
    },
  },
  notebook: {
    label: "Notebook",
    bloom: false,
    bg: "#f4ecd8",
    linkBase: "#8a7a5c",
    linkOut: "#e6dcc2",
    linkLit: "#2b2417",
    dim: "rgba(170,155,120,0.5)",
    selected: "#1a1508",
    star: { color: 0x000000, opacity: 0, mode: "off" },
    labels: {
      color: "#2b2417",
      bg: "rgba(248,242,228,0.85)",
      border: "rgba(140,120,80,0.4)",
    },
    palette: {
      Biology: "#1e7d32",
      Chemistry: "#9a7d0a",
      Physics: "#1a5fb4",
      Mathematics: "#5e35b1",
      History: "#795548",
      Metaphysics: "#6a4c93",
      Books: "#b35c00",
      Root: "#5f6368",
      Unwritten: "#9e9e9e",
    },
    css: {
      "--bg": "#f4ecd8",
      "--panel": "rgba(247,240,224,0.94)",
      "--border": "#d8ccae",
      "--fg": "#2b2417",
      "--muted": "#6f6448",
      "--accent": "#a06a1f",
    },
  },
  cosmos: {
    label: "Cosmos",
    bloom: true,
    bg: "#020308",
    linkBase: "#56648a",
    linkOut: "#0a0d18",
    linkLit: "#9ecbff",
    dim: "rgba(60,70,95,0.16)",
    selected: "#ffffff",
    star: { color: 0x9aa8d8, opacity: 0.85, mode: "dense" },
    labels: {
      color: "#e2e8f0",
      bg: "rgba(4,6,14,0.7)",
      border: "rgba(140,165,215,0.4)",
    },
    css: {
      "--bg": "#020308",
      "--panel": "rgba(8,11,22,0.88)",
      "--border": "#252c42",
      "--fg": "#e6edf3",
      "--muted": "#828cab",
      "--accent": "#9ecbff",
    },
  },
  dracula: {
    label: "Dracula",
    bloom: true,
    bg: "#282a36",
    linkBase: "#6272a4",
    linkOut: "#21222c",
    linkLit: "#bd93f9",
    dim: "rgba(98,114,164,0.18)",
    selected: "#f8f8f2",
    star: { color: 0x6272a4, opacity: 0.4, mode: "normal" },
    labels: {
      color: "#f8f8f2",
      bg: "rgba(40,42,54,0.78)",
      border: "rgba(189,147,249,0.4)",
    },
    css: {
      "--bg": "#282a36",
      "--panel": "rgba(40,42,54,0.9)",
      "--border": "#44475a",
      "--fg": "#f8f8f2",
      "--muted": "#6272a4",
      "--accent": "#bd93f9",
    },
  },
  nord: {
    label: "Nord",
    bloom: true,
    bg: "#2e3440",
    linkBase: "#4c566a",
    linkOut: "#2b303b",
    linkLit: "#88c0d0",
    dim: "rgba(76,86,106,0.2)",
    selected: "#eceff4",
    star: { color: 0x4c566a, opacity: 0.45, mode: "normal" },
    labels: {
      color: "#e5e9f0",
      bg: "rgba(46,52,64,0.78)",
      border: "rgba(136,192,208,0.4)",
    },
    css: {
      "--bg": "#2e3440",
      "--panel": "rgba(59,66,82,0.9)",
      "--border": "#434c5e",
      "--fg": "#eceff4",
      "--muted": "#81a1c1",
      "--accent": "#88c0d0",
    },
  },
  tokyonight: {
    label: "Tokyo Night",
    bloom: true,
    bg: "#1a1b26",
    linkBase: "#565f89",
    linkOut: "#16161e",
    linkLit: "#7aa2f7",
    dim: "rgba(86,95,137,0.2)",
    selected: "#c0caf5",
    star: { color: 0x565f89, opacity: 0.6, mode: "dense" },
    labels: {
      color: "#c0caf5",
      bg: "rgba(26,27,38,0.78)",
      border: "rgba(122,162,247,0.4)",
    },
    css: {
      "--bg": "#1a1b26",
      "--panel": "rgba(22,22,30,0.9)",
      "--border": "#2a2e42",
      "--fg": "#c0caf5",
      "--muted": "#565f89",
      "--accent": "#7aa2f7",
    },
  },
  gruvbox: {
    label: "Gruvbox",
    bloom: true,
    bg: "#282828",
    linkBase: "#665c54",
    linkOut: "#1d2021",
    linkLit: "#fabd2f",
    dim: "rgba(146,131,116,0.2)",
    selected: "#fbf1c7",
    star: { color: 0x665c54, opacity: 0.4, mode: "normal" },
    labels: {
      color: "#ebdbb2",
      bg: "rgba(40,40,40,0.8)",
      border: "rgba(250,189,47,0.4)",
    },
    css: {
      "--bg": "#282828",
      "--panel": "rgba(40,40,40,0.92)",
      "--border": "#3c3836",
      "--fg": "#ebdbb2",
      "--muted": "#928374",
      "--accent": "#fabd2f",
    },
  },
  monokai: {
    label: "Monokai",
    bloom: true,
    bg: "#272822",
    linkBase: "#75715e",
    linkOut: "#1d1e19",
    linkLit: "#66d9ef",
    dim: "rgba(117,113,94,0.2)",
    selected: "#f8f8f2",
    star: { color: 0x75715e, opacity: 0.4, mode: "normal" },
    labels: {
      color: "#f8f8f2",
      bg: "rgba(39,40,34,0.8)",
      border: "rgba(249,38,114,0.4)",
    },
    css: {
      "--bg": "#272822",
      "--panel": "rgba(39,40,34,0.92)",
      "--border": "#3e3d32",
      "--fg": "#f8f8f2",
      "--muted": "#75715e",
      "--accent": "#f92672",
    },
  },
};

export interface GNodeLike {
  id: string;
}

export interface NodeColorDeps {
  customColors: Record<string, string>;
  themePalette: Record<string, string> | undefined;
  palette: Record<string, string>;
  fallbackColors: readonly string[];
  groups: readonly string[];
  groupOf: (n: GNodeLike) => string;
  theme: { selected: string; dim: string };
  selected: GNodeLike | null;
  inFocus: (id: string) => boolean;
  hoverNode: GNodeLike | null;
  neighbors: Map<string, Set<string>>;
}

export function resolveBaseColor(g: string, deps: NodeColorDeps): string {
  if (g === "Unwritten") {
    return (
      deps.customColors.Unwritten ??
      deps.themePalette?.Unwritten ??
      deps.palette.Unwritten ??
      ""
    );
  }
  const idx = deps.groups.indexOf(g);
  return (
    deps.customColors[g] ??
    deps.themePalette?.[g] ??
    deps.palette[g] ??
    deps.fallbackColors[(idx < 0 ? 0 : idx) % deps.fallbackColors.length]
  );
}

export function nodeColorFor(n: GNodeLike, deps: NodeColorDeps): string {
  const base = resolveBaseColor(deps.groupOf(n), deps);
  if (deps.selected) {
    if (n.id === deps.selected.id) return deps.theme.selected;
    return deps.inFocus(n.id) ? base : deps.theme.dim;
  }
  if (deps.hoverNode) {
    if (n.id === deps.hoverNode.id) return deps.theme.selected;
    return deps.neighbors.get(deps.hoverNode.id)?.has(n.id)
      ? base
      : deps.theme.dim;
  }
  return base;
}
