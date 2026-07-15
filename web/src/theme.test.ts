import { describe, it, expect } from "vitest";
import {
  THEMES,
  PALETTE,
  FALLBACK_COLORS,
  resolveBaseColor,
  nodeColorFor,
  type NodeColorDeps,
} from "./theme";

const CSS_KEYS = ["--bg", "--panel", "--border", "--fg", "--muted", "--accent"];

describe("THEMES", () => {
  it("contains the expected built-in themes", () => {
    expect(Object.keys(THEMES).sort()).toEqual(
      [
        "cosmos",
        "dracula",
        "gilded",
        "gruvbox",
        "manuscript",
        "midnight",
        "monokai",
        "nord",
        "notebook",
        "tokyonight",
      ].sort(),
    );
  });

  it("every theme carries the full CSS-variable key set", () => {
    for (const [name, def] of Object.entries(THEMES)) {
      for (const key of CSS_KEYS) {
        expect(def.css, `theme ${name} missing ${key}`).toHaveProperty(key);
        expect(
          typeof def.css[key],
          `theme ${name} css.${key} should be a string`,
        ).toBe("string");
        expect(
          def.css[key]!.length,
          `theme ${name} css.${key} should be non-empty`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("every theme defines the required scene fields", () => {
    const sceneKeys = [
      "bloom",
      "bg",
      "linkBase",
      "linkOut",
      "linkLit",
      "dim",
      "selected",
    ] as const;
    for (const [name, def] of Object.entries(THEMES)) {
      for (const k of sceneKeys) {
        expect(def, `theme ${name} missing ${k}`).toHaveProperty(k);
      }
      expect(def.star, `theme ${name} missing star`).toBeDefined();
      expect(def.labels, `theme ${name} missing labels`).toBeDefined();
    }
  });
});

describe("PALETTE and FALLBACK_COLORS", () => {
  it("PALETTE contains the expected pillar/root entries", () => {
    expect(PALETTE.Biology).toBe("#51cf66");
    expect(PALETTE.Root).toBe("#adb5bd");
    expect(PALETTE.Unwritten).toBe("#5c636a");
  });

  it("FALLBACK_COLORS is a non-empty cycle of hex strings", () => {
    expect(FALLBACK_COLORS.length).toBeGreaterThan(0);
    for (const c of FALLBACK_COLORS) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("resolveBaseColor precedence", () => {
  const baseDeps = (over: Partial<NodeColorDeps> = {}): NodeColorDeps => ({
    customColors: {},
    themePalette: undefined,
    palette: {},
    fallbackColors: ["#aa", "#bb", "#cc", "#dd"],
    groups: ["A"],
    groupOf: (n) => (n as { id: string }).id,
    theme: { selected: "#sel", dim: "#dim" },
    selected: null,
    inFocus: () => false,
    hoverNode: null,
    neighbors: new Map(),
    ...over,
  });

  it("explicit custom color wins over theme palette and PALETTE", () => {
    const c = resolveBaseColor(
      "Biology",
      baseDeps({
        customColors: { Biology: "#111111" },
        themePalette: { Biology: "#222222" },
        palette: { Biology: "#333333" },
        groups: ["Biology"],
      }),
    );
    expect(c).toBe("#111111");
  });

  it("theme palette beats PALETTE and fallback", () => {
    const c = resolveBaseColor(
      "Biology",
      baseDeps({
        customColors: {},
        themePalette: { Biology: "#222222" },
        palette: { Biology: "#333333" },
        groups: ["Biology"],
      }),
    );
    expect(c).toBe("#222222");
  });

  it("PALETTE beats the fallback cycle", () => {
    const c = resolveBaseColor(
      "Biology",
      baseDeps({
        customColors: {},
        themePalette: undefined,
        palette: { Biology: "#333333" },
        groups: ["Biology"],
      }),
    );
    expect(c).toBe("#333333");
  });

  it("unknown group falls back deterministically using its position in groups", () => {
    const groups = ["A", "B", "C", "D"];
    expect(resolveBaseColor("A", baseDeps({ groups }))).toBe("#aa");
    expect(resolveBaseColor("B", baseDeps({ groups }))).toBe("#bb");
    expect(resolveBaseColor("C", baseDeps({ groups }))).toBe("#cc");
    expect(resolveBaseColor("D", baseDeps({ groups }))).toBe("#dd");
  });

  it("the cycle wraps when more unknown groups exist than fallback colors", () => {
    const groups = ["A", "B", "C", "D", "E"];
    expect(resolveBaseColor("E", baseDeps({ groups }))).toBe("#aa");
  });

  it("the cycle index for an unknown group is its position in groups, regardless of earlier overrides", () => {
    const groups = ["Custom", "Hit", "Unknown"];
    const c = resolveBaseColor(
      "Unknown",
      baseDeps({
        groups,
        customColors: { Custom: "#cust" },
        palette: { Hit: "#pal" },
      }),
    );
    expect(c).toBe("#cc");
  });

  it("Unwritten never falls back to the FALLBACK_COLORS cycle", () => {
    const c = resolveBaseColor(
      "Unwritten",
      baseDeps({
        palette: { Unwritten: "#5c636a" },
        groups: ["Unwritten", "Other"],
      }),
    );
    expect(c).toBe("#5c636a");
  });

  it("Unwritten custom color wins over PALETTE.Unwritten", () => {
    const c = resolveBaseColor(
      "Unwritten",
      baseDeps({
        customColors: { Unwritten: "#abcabc" },
        palette: { Unwritten: "#5c636a" },
        groups: ["Unwritten"],
      }),
    );
    expect(c).toBe("#abcabc");
  });

  it("Unwritten theme-palette override beats PALETTE.Unwritten", () => {
    const c = resolveBaseColor(
      "Unwritten",
      baseDeps({
        themePalette: { Unwritten: "#d0d0d0" },
        palette: { Unwritten: "#5c636a" },
        groups: ["Unwritten"],
      }),
    );
    expect(c).toBe("#d0d0d0");
  });
});

describe("nodeColorFor overlay", () => {
  const baseDeps = (over: Partial<NodeColorDeps> = {}): NodeColorDeps => ({
    customColors: {},
    themePalette: undefined,
    palette: { A: "#base" },
    fallbackColors: ["#fb"],
    groups: ["A"],
    groupOf: () => "A",
    theme: { selected: "#sel", dim: "#dim" },
    selected: null,
    inFocus: () => false,
    hoverNode: null,
    neighbors: new Map(),
    ...over,
  });

  it("returns the base color when no selection or hover is active", () => {
    expect(nodeColorFor({ id: "x" }, baseDeps())).toBe("#base");
  });

  it("returns theme.selected when the node itself is selected", () => {
    expect(
      nodeColorFor({ id: "sel" }, baseDeps({ selected: { id: "sel" } })),
    ).toBe("#sel");
  });

  it("returns the base color for in-focus neighbors of the selection", () => {
    expect(
      nodeColorFor(
        { id: "n1" },
        baseDeps({ selected: { id: "sel" }, inFocus: (id) => id === "n1" }),
      ),
    ).toBe("#base");
  });

  it("returns theme.dim for out-of-focus nodes when something is selected", () => {
    expect(
      nodeColorFor(
        { id: "n1" },
        baseDeps({ selected: { id: "sel" }, inFocus: () => false }),
      ),
    ).toBe("#dim");
  });

  it("returns theme.selected when the node itself is hovered", () => {
    expect(
      nodeColorFor({ id: "h" }, baseDeps({ hoverNode: { id: "h" } })),
    ).toBe("#sel");
  });

  it("returns the base color for nodes adjacent to the hovered node", () => {
    const neighbors = new Map<string, Set<string>>();
    neighbors.set("h", new Set(["n1"]));
    expect(
      nodeColorFor(
        { id: "n1" },
        baseDeps({ hoverNode: { id: "h" }, neighbors }),
      ),
    ).toBe("#base");
  });

  it("returns theme.dim for non-neighbors of the hovered node", () => {
    expect(
      nodeColorFor(
        { id: "n1" },
        baseDeps({ hoverNode: { id: "h" }, neighbors: new Map() }),
      ),
    ).toBe("#dim");
  });

  it("selection takes precedence over hover (sel node stays selected-styled)", () => {
    expect(
      nodeColorFor(
        { id: "sel" },
        baseDeps({ selected: { id: "sel" }, hoverNode: { id: "h" } }),
      ),
    ).toBe("#sel");
  });

  it("selection branch checks neighbors before hover branch", () => {
    const neighbors = new Map<string, Set<string>>();
    neighbors.set("h", new Set(["n1"]));
    expect(
      nodeColorFor(
        { id: "n1" },
        baseDeps({
          selected: { id: "sel" },
          inFocus: () => false,
          hoverNode: { id: "h" },
          neighbors,
        }),
      ),
    ).toBe("#dim");
  });
});
