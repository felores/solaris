import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../app";
import { TOKEN_HEADER } from "./security";
import {
  discoverWikis,
  discoverAndMerge,
  mergeWikis,
  DEFAULT_RAW_DESTINATION,
} from "./wiki";
import { updateConfig, type WikiConfig } from "./config";

const VAULT = mkdtempSync(join(tmpdir(), "sinapso-wiki-test-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "sinapso-wiki-outside-"));
afterAll(() => rmSync(VAULT, { recursive: true, force: true }));
afterAll(() => rmSync(OUTSIDE, { recursive: true, force: true }));

// Fixture builder: create wiki folders with given contract files.
function makeWiki(relPath: string, contracts: string[] = []) {
  const dir = join(VAULT, relPath);
  mkdirSync(dir, { recursive: true });
  for (const c of contracts) writeFileSync(join(dir, c), `# ${c}\n`);
}

beforeAll(() => {
  // Root wiki with both high-confidence contracts.
  makeWiki("wiki", ["AGENTS.md", "CLAUDE.md"]);
  // Nested wiki with index only (medium).
  mkdirSync(join(VAULT, "agencia", "research"), { recursive: true });
  makeWiki("agencia/wiki", ["index.md"]);
  // Nested wiki with README only (medium).
  mkdirSync(join(VAULT, "saas", "climatia", "docs"), { recursive: true });
  makeWiki("saas/climatia/wiki", ["README.md"]);
  // Folder-only wiki (low confidence).
  mkdirSync(join(VAULT, "scratch", "wiki", "raw"), { recursive: true });
  makeWiki("scratch/wiki", []);
  mkdirSync(join(VAULT, "fallback", "wiki"), { recursive: true });
  // Wiki under an excluded folder — must be skipped.
  makeWiki("excluded/wiki", ["AGENTS.md"]);
  // Wiki under the default archive folder — must be skipped by /api/wikis.
  makeWiki("archive/wiki", ["AGENTS.md"]);
  // Non-wiki directory named differently — must NOT be discovered.
  mkdirSync(join(VAULT, "wikis"), { recursive: true });
  writeFileSync(join(VAULT, "wikis", "note.md"), "# not a wiki\n");
  // A `wiki` file (not a dir) at the root — must be ignored.
  writeFileSync(join(VAULT, "wiki-file"), "not a dir");
  makeWiki("wiki", []);
  mkdirSync(join(OUTSIDE, "wiki"), { recursive: true });
  writeFileSync(join(OUTSIDE, "wiki", "AGENTS.md"), "# outside\n");
  symlinkSync(OUTSIDE, join(VAULT, "linked-outside"));
});

describe("discoverWikis", () => {
  it("finds the root wiki and assigns high confidence for AGENTS/CLAUDE", () => {
    const found = discoverWikis(VAULT, []);
    const root = found.find((w) => w.path === "wiki");
    expect(root).toBeDefined();
    expect(root!.confidence).toBe("high");
    expect(root!.contractFiles).toContain("AGENTS.md");
    expect(root!.contractFiles).toContain("CLAUDE.md");
    expect(root!.enabled).toBe(true);
    expect(root!.discovered).toBe(true);
    expect(root!.rawDestination).toBe(DEFAULT_RAW_DESTINATION);
    expect(root!.id).toBe("wiki");
    expect(root!.label).toBe("wiki");
  });

  it("finds nested wikis and assigns medium confidence for index/README", () => {
    const found = discoverWikis(VAULT, []);
    const agencia = found.find((w) => w.path === "agencia/wiki");
    const climatia = found.find((w) => w.path === "saas/climatia/wiki");
    expect(agencia).toBeDefined();
    expect(agencia!.confidence).toBe("medium");
    expect(agencia!.contractFiles).toEqual(["index.md"]);
    expect(agencia!.rawDestination).toBe("../research/");
    expect(climatia).toBeDefined();
    expect(climatia!.confidence).toBe("medium");
    expect(climatia!.contractFiles).toEqual(["README.md"]);
    expect(climatia!.rawDestination).toBe("../docs/");
  });

  it("assigns low confidence to folder-only wikis", () => {
    const found = discoverWikis(VAULT, []);
    const scratch = found.find((w) => w.path === "scratch/wiki");
    expect(scratch).toBeDefined();
    expect(scratch!.confidence).toBe("low");
    expect(scratch!.contractFiles).toEqual([]);
    expect(scratch!.rawDestination).toBe("raw/");
  });

  it("falls back to a sibling raw folder when no raw/research/docs folder exists", () => {
    const found = discoverWikis(VAULT, []);
    const fallback = found.find((w) => w.path === "fallback/wiki");
    expect(fallback).toBeDefined();
    expect(fallback!.rawDestination).toBe(DEFAULT_RAW_DESTINATION);
  });

  it("skips directories whose vault-relative path is excluded", () => {
    const found = discoverWikis(VAULT, ["excluded"]);
    expect(found.find((w) => w.path === "excluded/wiki")).toBeUndefined();
  });

  it("skips directories whose nested exclude matches (case-insensitive)", () => {
    const found = discoverWikis(VAULT, ["EXCLUDED"]);
    expect(found.find((w) => w.path === "excluded/wiki")).toBeUndefined();
  });

  it("does not discover non-wiki folders or files named wiki", () => {
    const found = discoverWikis(VAULT, []);
    expect(found.find((w) => w.path === "wikis")).toBeUndefined();
    expect(found.find((w) => w.path === "wiki-file")).toBeUndefined();
  });

  it("does not follow symlinked directories outside the vault", () => {
    const found = discoverWikis(VAULT, []);
    expect(found.find((w) => w.path === "linked-outside/wiki")).toBeUndefined();
  });

  it("returns empty for a missing vault root", () => {
    expect(discoverWikis("/does/not/exist", [])).toEqual([]);
  });

  it("returns a stable, path-sorted order", () => {
    const found = discoverWikis(VAULT, []);
    const paths = found.map((w) => w.path);
    expect([...paths].sort()).toEqual(paths);
  });
});

describe("mergeWikis", () => {
  const discovered: WikiConfig[] = [
    {
      id: "wiki",
      label: "wiki",
      path: "wiki",
      enabled: true,
      contractFiles: ["AGENTS.md", "CLAUDE.md"],
      rawDestination: DEFAULT_RAW_DESTINATION,
      discovered: true,
      confidence: "high",
    },
    {
      id: "agencia/wiki",
      label: "agencia/wiki",
      path: "agencia/wiki",
      enabled: true,
      contractFiles: ["index.md"],
      rawDestination: DEFAULT_RAW_DESTINATION,
      discovered: true,
      confidence: "medium",
    },
  ];

  it("preserves saved disabled state across rediscovery", () => {
    const saved: WikiConfig[] = [
      {
        id: "wiki",
        label: "Main Wiki",
        path: "wiki",
        enabled: false, // user disabled
        contractFiles: [],
        rawDestination: "research/",
        discovered: true,
        confidence: "low", // stale — should be refreshed from discovery
      },
    ];
    const merged = mergeWikis(discovered, saved);
    const wiki = merged.find((w) => w.path === "wiki")!;
    expect(wiki.enabled).toBe(false); // disabled preserved
    expect(wiki.label).toBe("Main Wiki"); // label preserved
    expect(wiki.rawDestination).toBe("research/"); // custom raw preserved
    expect(wiki.confidence).toBe("high"); // refreshed from discovery
    expect(wiki.contractFiles).toEqual(["AGENTS.md", "CLAUDE.md"]); // refreshed
    expect(wiki.discovered).toBe(true);
  });

  it("keeps saved manual wikis not present on disk (discovered: false)", () => {
    const saved: WikiConfig[] = [
      {
        id: "manual",
        label: "Manual",
        path: "manual/wiki",
        enabled: true,
        contractFiles: [],
        rawDestination: null,
        discovered: true,
        confidence: "low",
      },
    ];
    const merged = mergeWikis(discovered, saved);
    const manual = merged.find((w) => w.path === "manual/wiki")!;
    expect(manual.discovered).toBe(false);
    expect(manual.enabled).toBe(true);
  });

  it("new discoveries default to enabled true and inferred rawDestination", () => {
    const merged = mergeWikis(discovered, []);
    const agencia = merged.find((w) => w.path === "agencia/wiki")!;
    expect(agencia.enabled).toBe(true);
    expect(agencia.rawDestination).toBe(DEFAULT_RAW_DESTINATION);
  });

  it("replaces stale legacy raw/ defaults with rediscovered destinations", () => {
    const discoveredWithResearch: WikiConfig[] = [
      { ...discovered[0], rawDestination: "../research/" },
    ];
    const saved: WikiConfig[] = [{ ...discovered[0], rawDestination: "raw/" }];
    expect(mergeWikis(discoveredWithResearch, saved)[0].rawDestination).toBe(
      "../research/",
    );
  });

  it("normalizes path separators and case so saved edits are not forked", () => {
    const saved: WikiConfig[] = [
      {
        id: "wiki",
        label: "Main",
        path: "Wiki", // different case
        enabled: false,
        contractFiles: [],
        rawDestination: "raw/",
        discovered: true,
        confidence: "low",
      },
    ];
    const merged = mergeWikis(discovered, saved);
    expect(merged.filter((w) => w.path.toLowerCase() === "wiki").length).toBe(
      1,
    );
  });
});

describe("discoverAndMerge (integration)", () => {
  it("merges real fs discovery with saved state end-to-end", () => {
    const saved: WikiConfig[] = [
      {
        id: "wiki",
        label: "FeloVault Wiki",
        path: "wiki",
        enabled: false,
        contractFiles: [],
        rawDestination: "../research/",
        discovered: true,
        confidence: "low",
      },
    ];
    const merged = discoverAndMerge(VAULT, [], saved);
    const wiki = merged.find((w) => w.path === "wiki")!;
    expect(wiki.label).toBe("FeloVault Wiki");
    expect(wiki.enabled).toBe(false);
    expect(wiki.rawDestination).toBe("../research/");
    expect(wiki.confidence).toBe("high");
    expect(wiki.contractFiles).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("omits saved wiki paths under excluded folders", () => {
    const saved: WikiConfig[] = [
      {
        id: "excluded/wiki",
        label: "Excluded Wiki",
        path: "excluded/wiki",
        enabled: true,
        contractFiles: [],
        rawDestination: "../raw/",
        discovered: false,
        confidence: "low",
      },
    ];
    const merged = discoverAndMerge(VAULT, ["excluded"], saved);
    expect(merged.find((w) => w.path === "excluded/wiki")).toBeUndefined();
  });

  it("omits saved wiki paths whose folders no longer exist", () => {
    const saved: WikiConfig[] = [
      {
        id: "deleted/wiki",
        label: "Deleted Wiki",
        path: "deleted/wiki",
        enabled: true,
        contractFiles: [],
        rawDestination: "../raw/",
        discovered: false,
        confidence: "low",
      },
    ];
    const merged = discoverAndMerge(VAULT, [], saved);
    expect(merged.find((w) => w.path === "deleted/wiki")).toBeUndefined();
  });
});

// --- Route: GET /api/wikis (F044) -----------------------------------------

const graphPath = join(VAULT, "graph.json");
writeFileSync(
  graphPath,
  JSON.stringify({
    meta: {
      vaultName: "test",
      vaultPath: VAULT,
      notes: 1,
      excludes: ["excluded"],
    },
    nodes: [{ id: "real.md", title: "Real", phantom: false }],
    links: [],
  }),
);
const { app } = createApp(graphPath, undefined, {
  configPath: join(VAULT, "config.json"),
});

async function sessionToken(): Promise<string> {
  const res = await request(app).get("/api/session");
  return res.body.token as string;
}

describe("GET /api/wikis", () => {
  it("returns discovered wikis for the active vault, excluding excluded folders", async () => {
    const res = await request(app).get("/api/wikis");
    expect(res.status).toBe(200);
    const paths = (res.body.wikis as WikiConfig[]).map((w) => w.path);
    expect(paths).toContain("wiki");
    expect(paths).toContain("agencia/wiki");
    expect(paths).toContain("saas/climatia/wiki");
    expect(paths).toContain("scratch/wiki");
    expect(paths).not.toContain("excluded/wiki");
    expect(paths).not.toContain("archive/wiki");
  });

  it("uses saved config excludes for wiki discovery even when graph metadata is stale", async () => {
    const staleGraph = join(VAULT, "stale-graph.json");
    const configPath = join(VAULT, "stale-config.json");
    writeFileSync(
      staleGraph,
      JSON.stringify({
        meta: { vaultName: "test", vaultPath: VAULT, notes: 1, excludes: [] },
        nodes: [{ id: "real.md", title: "Real", phantom: false }],
        links: [],
      }),
    );
    updateConfig(
      {
        vaults: { [VAULT]: { path: VAULT, excludes: ["agencia"], wikis: [] } },
      },
      configPath,
    );
    const { app: staleApp } = createApp(staleGraph, undefined, { configPath });

    const res = await request(staleApp).get("/api/wikis");
    const paths = (res.body.wikis as WikiConfig[]).map((w) => w.path);

    expect(res.status).toBe(200);
    expect(paths).toContain("wiki");
    expect(paths).not.toContain("agencia/wiki");
  });

  it("marks the root wiki with high confidence and AGENTS/CLAUDE contracts", async () => {
    const res = await request(app).get("/api/wikis");
    const root = (res.body.wikis as WikiConfig[]).find(
      (w) => w.path === "wiki",
    )!;
    expect(root.confidence).toBe("high");
    expect(root.contractFiles).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("marks the index-only wiki with medium confidence", async () => {
    const res = await request(app).get("/api/wikis");
    const agencia = (res.body.wikis as WikiConfig[]).find(
      (w) => w.path === "agencia/wiki",
    )!;
    expect(agencia.confidence).toBe("medium");
    expect(agencia.contractFiles).toEqual(["index.md"]);
  });

  it("returns 503 when the vault root is missing", async () => {
    const badGraph = join(VAULT, "bad-graph.json");
    writeFileSync(
      badGraph,
      JSON.stringify({
        meta: {
          vaultName: "bad",
          vaultPath: "/does/not/exist",
          notes: 0,
          excludes: [],
        },
        nodes: [],
        links: [],
      }),
    );
    const { app: badApp } = createApp(badGraph, undefined, {
      configPath: join(VAULT, "config2.json"),
    });
    const res = await request(badApp).get("/api/wikis");
    expect(res.status).toBe(503);
  });
});
