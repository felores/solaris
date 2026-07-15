import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createPrefs,
  type ModeName,
  type PrefsStorage,
  type Filter,
  type SizeWeights,
  type ReaderGeom,
  type ResearchGeom,
  type GroupMode,
  type QualityKey,
  type NodeStyle,
  type Arrangement,
  type VaultScope,
} from "./prefs";

function makeStorage(): PrefsStorage & {
  written: Set<string>;
  entries(): Record<string, string>;
} {
  const map = new Map<string, string>();
  const written = new Set<string>();
  const storage: PrefsStorage = {
    getItem(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key, value) {
      map.set(key, value);
      written.add(key);
    },
    removeItem(key) {
      map.delete(key);
      written.add(key);
    },
  };
  return Object.assign(storage, {
    written,
    entries: () => Object.fromEntries(map),
  });
}

let storage: ReturnType<typeof makeStorage>;
let prefs: ReturnType<typeof createPrefs>;

beforeEach(() => {
  storage = makeStorage();
  prefs = createPrefs(storage);
});

const ALL_KEYS = [
  "sinapso-theme",
  "sinapso-group",
  "sinapso-colors",
  "sinapso-phantoms",
  "sinapso-orphans",
  "sinapso-depth",
  "sinapso-quality",
  "sinapso-glow",
  "sinapso-arrangement",
  "sinapso-sem-lines",
  "sinapso-filters",
  "sinapso-labels",
  "sinapso-nodes",
  "sinapso-size-weights",
  "sinapso-pc",
  "sinapso-reader",
  "sinapso-research",
  "sinapso-mode",
  "sinapso-web-scope",
  "sinapso-vault-scope",
  "sinapso-qmd-prompted",
  "sinapso-qmd-auto-update",
  "sinapso-qmd-auto-embed",
  "sinapso-ui-zoom",
  "sinapso-label-distance",
  "sinapso-label-size",
  "sinapso-node-size",
  "sinapso-link-opacity",
  "sinapso-min-weight",
];

describe("prefs: namespace guard", () => {
  it("writes only sinapso-* keys (covers every accessor)", () => {
    prefs.setTheme("cosmos");
    prefs.setGroup("tag");
    prefs.setColors({ foo: "#fff" });
    prefs.setPhantoms(true);
    prefs.setOrphans(false);
    prefs.setDepth(3);
    prefs.setQuality("high");
    prefs.setGlow(false);
    prefs.setArrangement("hybrid");
    prefs.setSemLines(false);
    prefs.setFilters([{ mode: "show", pattern: "x" }]);
    prefs.setLabels(false);
    prefs.setNodeStyle("dodecahedron");
    prefs.setSizeWeights({ in: 2, out: 1, words: 0.5, contrast: 1 });
    prefs.setPc(2048);
    prefs.setReader({
      floating: true,
      width: 400,
      height: 300,
      left: 10,
      top: 20,
    });
    prefs.setResearch({
      floating: true,
      left: 10,
      top: 20,
      width: 400,
      height: 300,
      dockW: 400,
    });
    prefs.setMode("web");
    prefs.setWebScope("web");
    prefs.setVaultScope("keyword");
    prefs.markQmdPrompted();
    prefs.setAutoUpdate(false);
    prefs.setAutoEmbed(false);
    prefs.setUiZoom(1.4);
    prefs.setLabelDistance(500);
    prefs.setLabelSize(6);
    prefs.setNodeSize(5);
    prefs.setLinkOpacity(75);
    prefs.setMinWeight(2);

    for (const k of Object.keys(storage.entries())) {
      expect(k.startsWith("sinapso-")).toBe(true);
    }
    // every sinapso-* key in the inventory was written
    for (const k of ALL_KEYS) {
      expect(storage.written.has(k), `expected write to ${k}`).toBe(true);
    }
  });

  it("remove operations stay inside sinapso-*", () => {
    prefs.removeColors();
    prefs.removePc();
    prefs.removeMode();
    for (const k of storage.written) {
      expect(k.startsWith("sinapso-")).toBe(true);
    }
  });

  it("migrates legacy akasha prefs on first read", () => {
    const reader: ReaderGeom = {
      floating: false,
      width: 520,
      height: 400,
      left: 0,
      top: 0,
    };
    const research: ResearchGeom = {
      floating: false,
      left: 0,
      top: 0,
      width: 520,
      height: 400,
      dockW: 520,
    };
    storage.setItem("akasha-mode", "web");
    storage.setItem("akasha-web-scope", "web");
    storage.setItem("akasha-reader", JSON.stringify(reader));
    storage.setItem("akasha-research", JSON.stringify(research));
    storage.written.clear();

    expect(prefs.getMode()).toBe("web");
    expect(prefs.getWebScope()).toBe("web");
    expect(prefs.getReader()).toEqual(reader);
    expect(prefs.getResearch()).toEqual(research);
    expect(storage.entries()["sinapso-mode"]).toBe("web");
    expect(storage.entries()["sinapso-web-scope"]).toBe("web");
    expect(storage.entries()["sinapso-reader"]).toBe(JSON.stringify(reader));
    expect(storage.entries()["sinapso-research"]).toBe(
      JSON.stringify(research),
    );
  });

  it("keeps existing sinapso prefs ahead of legacy values", () => {
    storage.setItem("sinapso-mode", "vault");
    storage.setItem("akasha-mode", "web");
    storage.written.clear();

    expect(prefs.getMode()).toBe("vault");
    expect(storage.entries()["sinapso-mode"]).toBe("vault");
    expect(storage.written.size).toBe(0);
  });

  it("clears legacy aliases when removing migrated prefs", () => {
    storage.setItem("akasha-mode", "web");
    storage.written.clear();

    prefs.removeMode();

    expect(storage.entries()["akasha-mode"]).toBeUndefined();
    expect(prefs.getMode()).toBeNull();
  });
});

describe("prefs: raw string keys (theme / group / quality / nodes / arrangement)", () => {
  it("theme: default is 'midnight', set then get round-trips", () => {
    expect(prefs.getTheme()).toBe("midnight");
    prefs.setTheme("cosmos");
    expect(prefs.getTheme()).toBe("cosmos");
    expect(storage.getItem("sinapso-theme")).toBe("cosmos");
  });

  it("group: default 'folder', set 'wiki' round-trips", () => {
    expect(prefs.getGroup()).toBe<GroupMode>("folder");
    prefs.setGroup("wiki");
    expect(prefs.getGroup()).toBe<GroupMode>("wiki");
  });

  it("quality: default 'medium', set 'high' round-trips", () => {
    expect(prefs.getQuality()).toBe<QualityKey>("medium");
    prefs.setQuality("high");
    expect(prefs.getQuality()).toBe<QualityKey>("high");
  });

  it("nodes: default 'classic', set 'starlight' round-trips", () => {
    expect(prefs.getNodeStyle()).toBe<NodeStyle>("classic");
    prefs.setNodeStyle("starlight");
    expect(prefs.getNodeStyle()).toBe<NodeStyle>("starlight");
  });

  it("arrangement: default 'links', set 'hybrid' round-trips", () => {
    expect(prefs.getArrangement()).toBe<Arrangement>("links");
    prefs.setArrangement("hybrid");
    expect(prefs.getArrangement()).toBe<Arrangement>("hybrid");
  });
});

describe("prefs: boolean flag keys (off by default / on by default)", () => {
  it("phantoms: default false, writes '1' on, '0' off", () => {
    expect(prefs.getPhantoms()).toBe(false);
    prefs.setPhantoms(true);
    expect(storage.getItem("sinapso-phantoms")).toBe("1");
    expect(prefs.getPhantoms()).toBe(true);
    prefs.setPhantoms(false);
    expect(storage.getItem("sinapso-phantoms")).toBe("0");
  });

  it("orphans: default true, writes '0' off, '1' on", () => {
    expect(prefs.getOrphans()).toBe(true);
    prefs.setOrphans(false);
    expect(storage.getItem("sinapso-orphans")).toBe("0");
    expect(prefs.getOrphans()).toBe(false);
    prefs.setOrphans(true);
    expect(storage.getItem("sinapso-orphans")).toBe("1");
  });

  it("glow / semLines / labels default on", () => {
    expect(prefs.getGlow()).toBe(true);
    expect(prefs.getSemLines()).toBe(true);
    expect(prefs.getLabels()).toBe(true);
    prefs.setGlow(false);
    prefs.setSemLines(false);
    prefs.setLabels(false);
    expect(prefs.getGlow()).toBe(false);
    expect(prefs.getSemLines()).toBe(false);
    expect(prefs.getLabels()).toBe(false);
  });
});

describe("prefs: numeric keys", () => {
  it("depth: default 2, round-trips as string", () => {
    expect(prefs.getDepth()).toBe(2);
    prefs.setDepth(3);
    expect(prefs.getDepth()).toBe(3);
    expect(storage.getItem("sinapso-depth")).toBe("3");
  });

  it("depth: non-numeric stored value falls through to default (NaN→2)", () => {
    storage.setItem("sinapso-depth", "garbage");
    expect(prefs.getDepth()).toBe(2);
  });

  it("ui-zoom: default 1, round-trips", () => {
    expect(prefs.getUiZoom()).toBe(1);
    prefs.setUiZoom(1.4);
    expect(prefs.getUiZoom()).toBe(1.4);
    expect(storage.getItem("sinapso-ui-zoom")).toBe("1.4");
  });

  it("ui-zoom: missing or NaN falls back to 1", () => {
    expect(prefs.getUiZoom()).toBe(1);
    storage.setItem("sinapso-ui-zoom", "not-a-number");
    expect(prefs.getUiZoom()).toBe(1);
  });
});

describe("prefs: pc (particle count) — nullable", () => {
  it("default null when key is missing", () => {
    expect(prefs.getPc()).toBeNull();
  });

  it("setPc stores a number string; removePc deletes the key", () => {
    prefs.setPc(2048);
    expect(storage.getItem("sinapso-pc")).toBe("2048");
    expect(prefs.getPc()).toBe("2048");
    prefs.removePc();
    expect(prefs.getPc()).toBeNull();
    expect(storage.getItem("sinapso-pc")).toBeNull();
  });
});

describe("prefs: mode (vault|web|ingest|null)", () => {
  it("default null when key is missing", () => {
    expect(prefs.getMode()).toBeNull();
  });

  it("setMode writes a value, removeMode clears it", () => {
    prefs.setMode("web");
    expect(storage.getItem("sinapso-mode")).toBe("web");
    expect(prefs.getMode()).toBe<ModeName>("web");
    prefs.removeMode();
    expect(prefs.getMode()).toBeNull();
  });

  it("migrates the old semantic mode to vault", () => {
    storage.setItem("sinapso-mode", "semantic");
    expect(prefs.getMode()).toBe<ModeName>("vault");
  });
});

describe("prefs: web-scope (deep|web)", () => {
  it("default 'deep'; non-'web' stored values still read as 'deep'", () => {
    expect(prefs.getWebScope()).toBe("deep");
    storage.setItem("sinapso-web-scope", "garbage");
    expect(prefs.getWebScope()).toBe("deep");
    prefs.setWebScope("web");
    expect(prefs.getWebScope()).toBe("web");
    expect(storage.getItem("sinapso-web-scope")).toBe("web");
  });
});

describe("prefs: vault-scope (semantic|keyword)", () => {
  it("defaults to semantic, writes and reads keyword", () => {
    expect(prefs.getVaultScope()).toBe<VaultScope>("semantic");
    prefs.setVaultScope("keyword");
    expect(storage.getItem("sinapso-vault-scope")).toBe("keyword");
    expect(prefs.getVaultScope()).toBe<VaultScope>("keyword");
  });
});

describe("prefs: qmd-prompted one-shot flag", () => {
  it("default false; markQmdPrompted sets to '1'", () => {
    expect(prefs.wasQmdPrompted()).toBe(false);
    prefs.markQmdPrompted();
    expect(prefs.wasQmdPrompted()).toBe(true);
    expect(storage.getItem("sinapso-qmd-prompted")).toBe("1");
  });
});

describe("prefs: qmd auto maintenance flags", () => {
  it("auto update defaults on and round-trips", () => {
    expect(prefs.getAutoUpdate()).toBe(true);
    prefs.setAutoUpdate(false);
    expect(storage.getItem("sinapso-qmd-auto-update")).toBe("0");
    expect(prefs.getAutoUpdate()).toBe(false);
    prefs.setAutoUpdate(true);
    expect(storage.getItem("sinapso-qmd-auto-update")).toBe("1");
    expect(prefs.getAutoUpdate()).toBe(true);
  });

  it("auto embed defaults on and round-trips", () => {
    expect(prefs.getAutoEmbed()).toBe(true);
    prefs.setAutoEmbed(false);
    expect(storage.getItem("sinapso-qmd-auto-embed")).toBe("0");
    expect(prefs.getAutoEmbed()).toBe(false);
    prefs.setAutoEmbed(true);
    expect(storage.getItem("sinapso-qmd-auto-embed")).toBe("1");
    expect(prefs.getAutoEmbed()).toBe(true);
  });
});

describe("prefs: JSON keys — colors", () => {
  it("default {} when key missing", () => {
    expect(prefs.getColors()).toEqual({});
  });

  it("set then get preserves parse/stringify identity", () => {
    const c: Record<string, string> = { foo: "#fff", bar: "#000" };
    prefs.setColors(c);
    expect(prefs.getColors()).toEqual(c);
    expect(JSON.parse(storage.getItem("sinapso-colors") as string)).toEqual(c);
  });

  it("removeColors deletes the key", () => {
    prefs.setColors({ x: "#aaa" });
    prefs.removeColors();
    expect(prefs.getColors()).toEqual({});
    expect(storage.getItem("sinapso-colors")).toBeNull();
  });
});

describe("prefs: JSON keys — filters (try/catch → [] on corrupt)", () => {
  it("default [] when key missing", () => {
    expect(prefs.getFilters()).toEqual([]);
  });

  it("set then get preserves parse/stringify identity", () => {
    const f: Filter[] = [
      { mode: "show", pattern: "alpha" },
      { mode: "ignore", pattern: "beta" },
    ];
    prefs.setFilters(f);
    expect(prefs.getFilters()).toEqual(f);
    expect(JSON.parse(storage.getItem("sinapso-filters") as string)).toEqual(f);
  });

  it("corrupt JSON falls back to [] exactly like the inline try/catch", () => {
    storage.setItem("sinapso-filters", "{not valid");
    expect(prefs.getFilters()).toEqual([]);
  });

  it("non-array JSON falls back to [] exactly like the inline isArray check", () => {
    storage.setItem("sinapso-filters", JSON.stringify({ a: 1 }));
    expect(prefs.getFilters()).toEqual([]);
  });
});

describe("prefs: JSON keys — sizeWeights (no try/catch, spread of {})", () => {
  const DEFAULT_WEIGHTS: SizeWeights = {
    in: 1,
    out: 0.5,
    words: 0.5,
    contrast: 1.5,
  };

  it("default boot values when key missing", () => {
    expect(prefs.getSizeWeights()).toEqual(DEFAULT_WEIGHTS);
  });

  it("set then get preserves parse/stringify identity", () => {
    const w: SizeWeights = { in: 2, out: 1, words: 0.25, contrast: 1.75 };
    prefs.setSizeWeights(w);
    expect(prefs.getSizeWeights()).toEqual(w);
    expect(
      JSON.parse(storage.getItem("sinapso-size-weights") as string),
    ).toEqual(w);
  });

  it("partially-populated stored object merges onto the boot defaults", () => {
    storage.setItem("sinapso-size-weights", JSON.stringify({ contrast: 2.5 }));
    expect(prefs.getSizeWeights()).toEqual({
      in: 1,
      out: 0.5,
      words: 0.5,
      contrast: 2.5,
    });
  });
});

describe("prefs: JSON keys — reader geometry (sinapso-reader)", () => {
  it("default null when key missing; corrupt JSON throws (no try/catch today)", () => {
    expect(prefs.getReader()).toBeNull();
    storage.setItem("sinapso-reader", "{not valid");
    expect(() => prefs.getReader()).toThrow();
  });

  it("'null' sentinel parses to null and the default kicks in", () => {
    storage.setItem("sinapso-reader", "null");
    expect(prefs.getReader()).toBeNull();
  });

  it("setReader round-trips and stores JSON.stringify", () => {
    const g: ReaderGeom = {
      floating: true,
      width: 420,
      height: 500,
      left: 12,
      top: 20,
    };
    prefs.setReader(g);
    expect(prefs.getReader()).toEqual(g);
    expect(JSON.parse(storage.getItem("sinapso-reader") as string)).toEqual(g);
  });
});

describe("prefs: JSON keys — research geometry (sinapso-research)", () => {
  it("default null when key missing; corrupt JSON throws", () => {
    expect(prefs.getResearch()).toBeNull();
    storage.setItem("sinapso-research", "{not valid");
    expect(() => prefs.getResearch()).toThrow();
  });

  it("'null' sentinel parses to null and the default kicks in", () => {
    storage.setItem("sinapso-research", "null");
    expect(prefs.getResearch()).toBeNull();
  });

  it("setResearch round-trips and stores JSON.stringify", () => {
    const g: ResearchGeom = {
      floating: true,
      left: 50,
      top: 60,
      width: 420,
      height: 400,
      dockW: 400,
    };
    prefs.setResearch(g);
    expect(prefs.getResearch()).toEqual(g);
    expect(JSON.parse(storage.getItem("sinapso-research") as string)).toEqual(
      g,
    );
  });
});

describe("prefs: dynamic slider keys (6 numeric ranges)", () => {
  it("getNumber: default null when key missing", () => {
    expect(prefs.getLabelDistance()).toBeNull();
    expect(prefs.getLabelSize()).toBeNull();
    expect(prefs.getNodeSize()).toBeNull();
    expect(prefs.getLinkOpacity()).toBeNull();
    expect(prefs.getMinWeight()).toBeNull();
    expect(prefs.getIntensity()).toBeNull();
  });

  it("each slider writes its own sinapso-* key and round-trips", () => {
    prefs.setLabelDistance(500);
    prefs.setLabelSize(6);
    prefs.setNodeSize(5);
    prefs.setLinkOpacity(75);
    prefs.setMinWeight(2);
    prefs.setIntensity(40);
    expect(storage.getItem("sinapso-label-distance")).toBe("500");
    expect(storage.getItem("sinapso-label-size")).toBe("6");
    expect(storage.getItem("sinapso-node-size")).toBe("5");
    expect(storage.getItem("sinapso-link-opacity")).toBe("75");
    expect(storage.getItem("sinapso-min-weight")).toBe("2");
    expect(storage.getItem("sinapso-intensity")).toBe("40");
    expect(prefs.getLabelDistance()).toBe(500);
    expect(prefs.getLabelSize()).toBe(6);
    expect(prefs.getNodeSize()).toBe(5);
    expect(prefs.getLinkOpacity()).toBe(75);
    expect(prefs.getMinWeight()).toBe(2);
    expect(prefs.getIntensity()).toBe(40);
  });
});

describe("prefs: default storage", () => {
  it("createPrefs() with no args uses window.localStorage", () => {
    const localMock = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const g = globalThis as unknown as {
      window?: { localStorage: PrefsStorage };
    };
    const prev = g.window;
    g.window = { localStorage: localMock } as unknown as {
      localStorage: PrefsStorage;
    };
    try {
      const p = createPrefs();
      p.setTheme("cosmos");
      expect(localMock.setItem).toHaveBeenCalledWith("sinapso-theme", "cosmos");
      p.getTheme();
      expect(localMock.getItem).toHaveBeenCalled();
    } finally {
      if (prev) g.window = prev;
      else delete g.window;
    }
  });
});

describe("prefs: bytes-on-the-wire identity (catch regressions vs current storage)", () => {
  it("writes the exact strings current main.ts writes", () => {
    prefs.setTheme("cosmos");
    prefs.setGroup("tag");
    prefs.setPhantoms(true);
    prefs.setOrphans(false);
    prefs.setGlow(false);
    prefs.setSemLines(false);
    prefs.setLabels(false);
    prefs.setArrangement("semantic");
    prefs.setQuality("low");
    prefs.setNodeStyle("starlight");
    prefs.setDepth(1);
    prefs.setUiZoom(0.8);
    prefs.setMode("ingest");
    prefs.setWebScope("web");
    prefs.markQmdPrompted();
    prefs.setAutoUpdate(false);
    prefs.setAutoEmbed(false);
    prefs.setLabelDistance(700);
    expect(storage.getItem("sinapso-theme")).toBe("cosmos");
    expect(storage.getItem("sinapso-group")).toBe("tag");
    expect(storage.getItem("sinapso-phantoms")).toBe("1");
    expect(storage.getItem("sinapso-orphans")).toBe("0");
    expect(storage.getItem("sinapso-glow")).toBe("0");
    expect(storage.getItem("sinapso-sem-lines")).toBe("0");
    expect(storage.getItem("sinapso-labels")).toBe("0");
    expect(storage.getItem("sinapso-arrangement")).toBe("semantic");
    expect(storage.getItem("sinapso-quality")).toBe("low");
    expect(storage.getItem("sinapso-nodes")).toBe("starlight");
    expect(storage.getItem("sinapso-depth")).toBe("1");
    expect(storage.getItem("sinapso-ui-zoom")).toBe("0.8");
    expect(storage.getItem("sinapso-mode")).toBe("ingest");
    expect(storage.getItem("sinapso-web-scope")).toBe("web");
    expect(storage.getItem("sinapso-qmd-prompted")).toBe("1");
    expect(storage.getItem("sinapso-qmd-auto-update")).toBe("0");
    expect(storage.getItem("sinapso-qmd-auto-embed")).toBe("0");
    expect(storage.getItem("sinapso-label-distance")).toBe("700");
  });
});
