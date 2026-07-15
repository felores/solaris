import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { TOKEN_HEADER } from "./security";
import {
  coveringCollections,
  hitsToNodes,
  hitsToPassages,
  runQmdQuery,
  vsearch,
  type QmdQueryDeps,
  type QmdQueryOpts,
} from "./qmd";
import { createQmdMaintenance, parseQmdStatus } from "./qmd-maintenance";
import type { Runner } from "./detect";

const QMD_BIN = "/fake/bin/qmd";
const ok = (stdout: string) => ({ ok: true, stdout, stderr: "" });
const fail = () => ({ ok: false, stdout: "", stderr: "boom" });

interface FakeState {
  collections: Record<string, string>; // name -> root path
  vsearchOut: string;
  embedGate?: Promise<void>;
  statusOut?: string;
}

/** Fake qmd CLI keyed on subcommand; records every spawn. */
function fakeQmd(state: FakeState) {
  const calls: string[][] = [];
  const spawns: { args: string[]; env?: Record<string, string> }[] = [];
  const run: Runner = async (cmd, args, _t, env) => {
    calls.push([cmd, ...args]);
    if (cmd === QMD_BIN) spawns.push({ args, env });
    if (cmd !== QMD_BIN) return fail(); // login-shell probes etc.
    const [sub, a1, a2] = args;
    if (sub === "--version") return ok("qmd 1.0.0");
    if (sub === "collection" && a1 === "list")
      return ok(
        Object.keys(state.collections)
          .map((n) => `${n} (qmd://${n}/)\n  Pattern:  **/*.md`)
          .join("\n\n"),
      );
    if (sub === "collection" && a1 === "show") {
      const p = state.collections[a2];
      return p
        ? ok(`Collection: ${a2}\n  Path:     ${p}\n  Pattern:  **/*.md`)
        : fail();
    }
    if (sub === "collection" && a1 === "add") {
      state.collections["sinapso"] = a2;
      return ok("created");
    }
    if (sub === "status")
      return ok(
        state.statusOut ??
          "Documents\n  Total:    2 files indexed\n  Vectors:  5 embedded\n  Pending:  0 need embedding\n  Updated:  1h ago",
      );
    if (sub === "update") return ok("indexed");
    if (sub === "embed") {
      if (state.embedGate) await state.embedGate;
      return ok("embedded");
    }
    if (sub === "vsearch") return ok(state.vsearchOut);
    return fail();
  };
  return { run, calls, spawns };
}

function makeApp(state: FakeState, vault: string, qmdInstalled = true) {
  const fake = fakeQmd(state);
  const graphPath = join(vault, "graph.json");
  writeFileSync(
    graphPath,
    JSON.stringify({
      meta: { vaultName: "t", vaultPath: vault, notes: 4, excludes: [] },
      nodes: [
        { id: "self.md", title: "Self", phantom: false },
        { id: "a.md", title: "Note A", phantom: false },
        { id: "notas/n1.md", title: "N1", phantom: false },
        { id: "docs/d1.md", title: "D1", phantom: false },
        { id: "phantom:ghost", title: "ghost", phantom: true },
      ],
      links: [],
    }),
  );
  const { app } = createApp(graphPath, undefined, {
    configPath: join(vault, "config.json"),
    detectDeps: {
      home: "/home/tester",
      env: { PATH: "/fake/bin", SHELL: "/bin/zsh" },
      fileExists: (p) => qmdInstalled && p === QMD_BIN,
      run: fake.run,
    },
  });
  return { app, fake };
}

// --- pure helpers ---

describe("coveringCollections", () => {
  const cols = [
    { name: "exact", path: "/v/vault" },
    { name: "parent", path: "/v" },
    { name: "child", path: "/v/vault/notas" },
    { name: "other", path: "/elsewhere" },
    { name: "prefix-trap", path: "/v/vault-other" },
  ];
  it("keeps equal, parent, and child roots; drops unrelated and prefix traps", () => {
    const names = coveringCollections(cols, "/v/vault").map((c) => c.name);
    expect(names.sort()).toEqual(["child", "exact", "parent"]);
  });
});

describe("hitsToNodes", () => {
  const cols = [{ name: "c", path: "/v/vault" }];
  const titles = new Map([
    ["a.md", "A"],
    ["sub/b.md", "B"],
  ]);
  it("maps qmd:// files to node ids, drops non-graph files (AE3) and dedupes", () => {
    const out = hitsToNodes(
      [
        {
          file: "qmd://c/a.md",
          score: 0.9,
          snippet: "10: @@ -1,3 @@ (0 before, 2 after)\n11: hello  world",
        },
        { file: "qmd://c/excluded.md", score: 0.8 },
        { file: "qmd://c/sub/b.md", score: 0.7 },
        { file: "qmd://c/a.md", score: 0.6 },
        { file: "qmd://unknown/x.md", score: 0.5 },
      ],
      cols,
      "/v/vault",
      titles,
    );
    expect(out.map((r) => r.id)).toEqual(["a.md", "sub/b.md"]);
    expect(out[0].snippet).toBe("hello world"); // @@ header stripped, whitespace squashed
    expect(out[0].title).toBe("A");
  });
  it("drops files resolving outside the vault", () => {
    const out = hitsToNodes(
      [{ file: "qmd://c/../escape.md", score: 1 }],
      cols,
      "/v/vault",
      titles,
    );
    expect(out).toEqual([]);
  });
  it("honors the enabled-collections filter (R8)", () => {
    const two = [
      { name: "c", path: "/v/vault" },
      { name: "d", path: "/v/vault/sub" },
    ];
    const out = hitsToNodes(
      [
        { file: "qmd://c/a.md", score: 0.9 },
        { file: "qmd://d/b.md", score: 0.8 },
      ],
      two,
      "/v/vault",
      titles,
      new Set(["d"]),
    );
    expect(out.map((r) => r.id)).toEqual(["sub/b.md"]);
  });
});

describe("hitsToPassages", () => {
  const cols = [{ name: "c", path: "/v/vault" }];
  it("keeps every passage (no dedup) and preserves line positions", () => {
    const out = hitsToPassages(
      [
        { file: "qmd://c/book.md", score: 0.9, line: 12, snippet: "12: alpha" },
        { file: "qmd://c/book.md", score: 0.8, line: 40, snippet: "40: beta" },
        { file: "qmd://c/other.md", score: 0.7, line: 3, snippet: "gamma" },
      ],
      cols,
      "/v/vault",
    );
    expect(out.map((r) => [r.file, r.line])).toEqual([
      ["book.md", 12],
      ["book.md", 40],
      ["other.md", 3],
    ]);
    expect(out[0].snippet).toBe("alpha"); // line-number prefix stripped
  });
  it("defaults line to 0 when qmd omits it, and does not require a graph node", () => {
    const out = hitsToPassages(
      [{ file: "qmd://c/loose.md", score: 0.5 }],
      cols,
      "/v/vault",
    );
    expect(out).toEqual([
      { file: "loose.md", title: "loose.md", line: 0, score: 0.5, snippet: "" },
    ]);
  });
  it("scopes to a single note when `note` is given", () => {
    const out = hitsToPassages(
      [
        { file: "qmd://c/book.md", score: 0.9, line: 1 },
        { file: "qmd://c/other.md", score: 0.8, line: 1 },
      ],
      cols,
      "/v/vault",
      undefined,
      "book.md",
    );
    expect(out.map((r) => r.file)).toEqual(["book.md"]);
  });
  it("drops files outside the vault and non-covering collections", () => {
    const out = hitsToPassages(
      [
        { file: "qmd://c/../escape.md", score: 1 },
        { file: "qmd://unknown/x.md", score: 1 },
      ],
      cols,
      "/v/vault",
    );
    expect(out).toEqual([]);
  });
});

// --- vsearch() direct unit tests (U4) ---

describe("vsearch", () => {
  it("issues a vec:-typed query and parses hits (F030, KTD7)", async () => {
    const spawns: string[][] = [];
    const stdout = JSON.stringify([
      { file: "qmd://c/a.md", score: 0.9, title: "A", snippet: "hi" },
    ]);
    const run: Runner = async (cmd, args) => {
      spawns.push([cmd, ...args]);
      return { ok: true, stdout, stderr: "" };
    };
    const hits = await vsearch(run, "/qmd", "hello world", 5);
    expect(hits).toEqual([
      { file: "qmd://c/a.md", score: 0.9, title: "A", snippet: "hi" },
    ]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toEqual([
      "/qmd",
      "vsearch",
      "vec: hello world",
      "-n",
      "5",
      "--format",
      "json",
    ]);
  });

  it("parses JSON from the first [ when output carries progress noise", async () => {
    const stdout =
      "qmd: loading model...\n" +
      "  embedding 1/3...\n" +
      '[{"file":"qmd://c/a.md","score":0.5}]';
    const run: Runner = async () => ({ ok: true, stdout, stderr: "" });
    const hits = await vsearch(run, "/qmd", "x", 3);
    expect(hits.map((h) => h.file)).toEqual(["qmd://c/a.md"]);
  });

  it("returns [] on malformed JSON instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run: Runner = async () => ({
      ok: true,
      stdout: "garbage [broken",
      stderr: "",
    });
    const hits = await vsearch(run, "/qmd", "x", 3);
    expect(hits).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] when the runner reports failure (preserves fallback path)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run: Runner = async () => ({
      ok: false,
      stdout: "",
      stderr: "boom",
    });
    const hits = await vsearch(run, "/qmd", "x", 3);
    expect(hits).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// --- runQmdQuery (U4) ---

const COVERING = [{ name: "vaultcol", path: "/v/vault" }];

function makeQmdDeps(
  overrides: {
    bin?: string | null;
    setupState?: () => "idle" | "indexing" | "ready" | "error";
    getCollections?: (bin: string) => Promise<typeof COVERING>;
    search?: QmdQueryDeps["search"];
    graphNodes?: QmdQueryDeps["graphNodes"];
  } = {},
): {
  deps: QmdQueryDeps;
  invalidate: ReturnType<typeof vi.fn>;
  getCollections: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
} {
  const invalidate = vi.fn();
  const getCollections = vi.fn(
    overrides.getCollections ?? (async () => COVERING),
  );
  const search = vi.fn(overrides.search ?? (async () => []));
  return {
    deps: {
      bin: overrides.bin === undefined ? "/qmd" : overrides.bin,
      setupState: overrides.setupState ?? (() => "ready" as const),
      invalidateCollectionsCache: invalidate,
      getCollections,
      search,
      vaultRoot: "/v/vault",
      graphNodes: overrides.graphNodes ?? [
        { id: "a.md", title: "A" },
        { id: "sub/b.md", title: "B" },
        { id: "phantom:ghost", title: "ghost", phantom: true },
      ],
    },
    invalidate,
    getCollections,
    search,
  };
}

const NODES_OPTS: QmdQueryOpts = {
  collectionsParam: undefined,
  mode: "nodes",
  limit: 20,
};

describe("runQmdQuery (mode=nodes)", () => {
  it("returns 503 when qmd is not installed", async () => {
    const { deps } = makeQmdDeps({ bin: null });
    const r = await runQmdQuery(deps, "anything", NODES_OPTS);
    expect(r).toEqual({ status: 503, body: { error: "qmd not installed" } });
  });

  it("returns 200+indexing when setup is indexing (no vsearch issued)", async () => {
    const { deps, search } = makeQmdDeps({
      setupState: () => "indexing",
    });
    const r = await runQmdQuery(deps, "anything", NODES_OPTS);
    expect(r).toEqual({
      status: 200,
      body: { state: "indexing", results: [] },
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("returns 200+uncovered when no covering collections (no vsearch issued)", async () => {
    const { deps, search } = makeQmdDeps({
      getCollections: async () => [],
    });
    const r = await runQmdQuery(deps, "anything", NODES_OPTS);
    expect(r).toEqual({
      status: 200,
      body: { state: "uncovered", results: [] },
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("invalidates the collection cache on the ready transition", async () => {
    const { deps, invalidate, search } = makeQmdDeps({
      setupState: () => "ready",
    });
    await runQmdQuery(deps, "anything", NODES_OPTS);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("does NOT invalidate when setup is not in ready (idle/error)", async () => {
    for (const s of ["idle", "error"] as const) {
      const { deps, invalidate, search } = makeQmdDeps({ setupState: () => s });
      await runQmdQuery(deps, "anything", NODES_OPTS);
      expect(invalidate).not.toHaveBeenCalled();
      expect(search).toHaveBeenCalledTimes(1);
    }
  });

  it("maps qmd hits to graph nodes (excludes phantom, dedupes, uses graph titles)", async () => {
    const { deps, search } = makeQmdDeps({
      search: async () => [
        { file: "qmd://vaultcol/a.md", score: 0.9, snippet: "hit" },
        { file: "qmd://vaultcol/sub/b.md", score: 0.7, snippet: "x" },
        { file: "qmd://vaultcol/missing.md", score: 0.6 },
        { file: "qmd://vaultcol/phantom:ghost", score: 0.5 },
      ],
    });
    const r = await runQmdQuery(deps, "q", NODES_OPTS);
    expect(r.status).toBe(200);
    const body = r.body as {
      state: string;
      results: Array<{ id: string; title: string }>;
    };
    expect(body.state).toBe("ready");
    expect(body.results.map((n) => n.id)).toEqual(["a.md", "sub/b.md"]);
    expect(body.results.map((n) => n.title)).toEqual(["A", "B"]);
  });

  it("narrows scopeNames by the enabled-collections filter (R8)", async () => {
    const { deps, search } = makeQmdDeps({
      getCollections: async () => [
        { name: "vaultcol", path: "/v/vault" },
        { name: "colB", path: "/v/vault/sub" },
      ],
      search: async () => [],
    });
    await runQmdQuery(deps, "q", {
      ...NODES_OPTS,
      collectionsParam: "colB",
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][3]).toEqual(["colB"]);
  });

  it("scopes to all covering collections when no filter is given", async () => {
    const { deps, search } = makeQmdDeps({
      getCollections: async () => [
        { name: "vaultcol", path: "/v/vault" },
        { name: "colB", path: "/v/vault/sub" },
      ],
      search: async () => [],
    });
    await runQmdQuery(deps, "q", NODES_OPTS);
    expect(search.mock.calls[0][3]?.sort()).toEqual(["colB", "vaultcol"]);
  });

  it("ignores empty-string collectionsParam (treated as no filter)", async () => {
    const { deps, search } = makeQmdDeps({
      getCollections: async () => [
        { name: "vaultcol", path: "/v/vault" },
        { name: "colB", path: "/v/vault/sub" },
      ],
      search: async () => [],
    });
    await runQmdQuery(deps, "q", { ...NODES_OPTS, collectionsParam: "" });
    expect(search.mock.calls[0][3]?.sort()).toEqual(["colB", "vaultcol"]);
  });
});

describe("runQmdQuery (mode=passages)", () => {
  const PASSAGES_OPTS: QmdQueryOpts = {
    collectionsParam: undefined,
    mode: "passages",
    limit: 8,
  };

  it("returns 503 / indexing / uncovered with the same shape as nodes", async () => {
    expect(
      (await runQmdQuery(makeQmdDeps({ bin: null }).deps, "q", PASSAGES_OPTS))
        .body,
    ).toEqual({ error: "qmd not installed" });
    expect(
      (
        await runQmdQuery(
          makeQmdDeps({ setupState: () => "indexing" }).deps,
          "q",
          PASSAGES_OPTS,
        )
      ).body,
    ).toEqual({ state: "indexing", results: [] });
    expect(
      (
        await runQmdQuery(
          makeQmdDeps({ getCollections: async () => [] }).deps,
          "q",
          PASSAGES_OPTS,
        )
      ).body,
    ).toEqual({ state: "uncovered", results: [] });
  });

  it("over-fetches (pool = max(limit*6, 30)) when note is set", async () => {
    const { deps, search } = makeQmdDeps({
      search: async () => [],
    });
    await runQmdQuery(deps, "q", { ...PASSAGES_OPTS, limit: 5, note: "x.md" });
    // pool = max(5*6, 30) = 30
    expect(search.mock.calls[0][2]).toBe(30);
  });

  it("uses `limit` directly as the pool when no note is given", async () => {
    const { deps, search } = makeQmdDeps({
      search: async () => [],
    });
    await runQmdQuery(deps, "q", { ...PASSAGES_OPTS, limit: 7 });
    expect(search.mock.calls[0][2]).toBe(7);
  });

  it("caps the response at `limit` after mapping", async () => {
    const { deps } = makeQmdDeps({
      search: async () =>
        Array.from({ length: 50 }, (_, i) => ({
          file: `qmd://vaultcol/p${i}.md`,
          score: 1 - i / 100,
          line: i + 1,
          snippet: `s${i}`,
        })),
    });
    const r = await runQmdQuery(deps, "q", { ...PASSAGES_OPTS, limit: 3 });
    const body = r.body as { results: unknown[] };
    expect(body.results).toHaveLength(3);
  });

  it("maps qmd hits to passages (file/title/line/score/snippet, no title lookup)", async () => {
    const { deps, search } = makeQmdDeps({
      graphNodes: [{ id: "book.md", title: "NoteBook" }], // not used in passages mode
      search: async () => [
        {
          file: "qmd://vaultcol/book.md",
          score: 0.9,
          line: 12,
          title: "Book Title From Qmd",
          snippet: "12: passage",
        },
        { file: "qmd://vaultcol/other.md", score: 0.5, line: 1 },
      ],
    });
    const r = await runQmdQuery(deps, "q", PASSAGES_OPTS);
    const body = r.body as {
      results: Array<{
        file: string;
        title: string;
        line: number;
        score: number;
        snippet: string;
      }>;
    };
    expect(body.results).toEqual([
      {
        file: "book.md",
        title: "Book Title From Qmd",
        line: 12,
        score: 0.9,
        snippet: "passage",
      },
      {
        file: "other.md",
        title: "other.md",
        line: 1,
        score: 0.5,
        snippet: "",
      },
    ]);
  });

  it("scopes the response to one note when `note` is set", async () => {
    const { deps } = makeQmdDeps({
      search: async () => [
        { file: "qmd://vaultcol/book.md", score: 0.9, line: 1 },
        { file: "qmd://vaultcol/other.md", score: 0.8, line: 1 },
      ],
    });
    const r = await runQmdQuery(deps, "q", {
      ...PASSAGES_OPTS,
      note: "book.md",
    });
    const body = r.body as { results: Array<{ file: string }> };
    expect(body.results.map((p) => p.file)).toEqual(["book.md"]);
  });
});

describe("runQmdQuery <-> vsearch end-to-end (U4)", () => {
  it("issues a vec:-typed query through vsearch() and maps nodes", async () => {
    // exercise the real wiring: the merged function delegates to a runner
    // that calls vsearch(); assert the runner sees vec: typing and the
    // merged function returns the expected node shape.
    const spawns: string[][] = [];
    const stdout = JSON.stringify([
      { file: "qmd://vaultcol/a.md", score: 0.9, title: "A", snippet: "hi" },
    ]);
    const run: Runner = async (cmd, args) => {
      spawns.push([cmd, ...args]);
      return { ok: true, stdout, stderr: "" };
    };
    const { deps } = makeQmdDeps({
      search: (b, q, l) => vsearch(run, b, q, l),
    });
    const r = await runQmdQuery(deps, "hello world", NODES_OPTS);
    expect(spawns).toEqual([
      ["/qmd", "vsearch", "vec: hello world", "-n", "20", "--format", "json"],
    ]);
    const body = r.body as { results: Array<{ id: string }> };
    expect(body.results.map((n) => n.id)).toEqual(["a.md"]);
  });

  it("tolerates malformed JSON with progress noise via vsearch() (parses from first [)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run: Runner = async () => ({
      ok: true,
      stdout: "[qmd] loading model...\n  embedding 1/3...\n  garbage [broken",
      stderr: "",
    });
    const { deps } = makeQmdDeps({
      search: (b, q, l) => vsearch(run, b, q, l),
    });
    const r = await runQmdQuery(deps, "q", NODES_OPTS);
    expect(r.status).toBe(200);
    expect((r.body as { results: unknown[] }).results).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// --- routes with a covered vault ---

const VAULT = mkdtempSync(join(tmpdir(), "sinapso-qmd-test-"));
mkdirSync(join(VAULT, "notas"), { recursive: true });
mkdirSync(join(VAULT, "docs"), { recursive: true });
writeFileSync(
  join(VAULT, "self.md"),
  "---\ntitle: Self\n---\n# Self\n\nBody text here.\n",
);
writeFileSync(join(VAULT, "excluded.md"), "# Excluded from scan\n");
afterAll(() => rmSync(VAULT, { recursive: true, force: true }));

const state: FakeState = {
  collections: {
    vaultcol: VAULT,
    colA: join(VAULT, "notas"),
    colB: join(VAULT, "docs"),
    far: "/elsewhere",
  },
  vsearchOut: "[]",
};
const covered = makeApp(state, VAULT);

let mtimeBump = 0;
const QMD_ROUTE_TIMEOUT = 10_000;
beforeEach(() => {
  covered.fake.calls.length = 0;
  // The related cache is keyed by note mtime (F015); bump it so each test
  // exercises a fresh query instead of the previous test's cached result.
  const t = new Date(Date.now() + ++mtimeBump * 1000);
  utimesSync(join(VAULT, "self.md"), t, t);
});

describe("GET /api/related", () => {
  it(
    "returns in-graph related notes only, excluding the note itself (AE3, R5)",
    async () => {
      state.vsearchOut = JSON.stringify([
        { docid: "#1", score: 0.9, file: "qmd://vaultcol/a.md", snippet: "s" },
        { docid: "#2", score: 0.8, file: "qmd://vaultcol/excluded.md" },
        { docid: "#3", score: 0.7, file: "qmd://far/elsewhere.md" },
        { docid: "#4", score: 0.6, file: "qmd://vaultcol/self.md" },
      ]);
      const res = await request(covered.app).get("/api/related?id=self.md");
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("ready");
      expect(res.body.results.map((r: { id: string }) => r.id)).toEqual([
        "a.md",
      ]);
    },
    QMD_ROUTE_TIMEOUT,
  );

  it("queries via vsearch, never qmd query or search", async () => {
    await request(covered.app).get("/api/related?id=self.md");
    const subs = covered.fake.calls
      .filter(([c]) => c === QMD_BIN)
      .map(([, s]) => s);
    expect(subs).toContain("vsearch");
    expect(subs).not.toContain("query");
    expect(subs).not.toContain("search");
    // query text is a pre-typed vec: line (no LLM expansion) carrying the
    // note's title + body excerpt
    const vs = covered.fake.calls.find(([, s]) => s === "vsearch")!;
    expect(vs[2].startsWith("vec: ")).toBe(true);
    expect(vs[2]).toContain("Self");
    expect(vs[2]).toContain("Body text here");
  });

  it("narrows results with the collections filter (R8)", async () => {
    state.vsearchOut = JSON.stringify([
      { score: 0.9, file: "qmd://colA/n1.md" },
      { score: 0.8, file: "qmd://colB/d1.md" },
    ]);
    const all = await request(covered.app).get("/api/related?id=self.md");
    expect(all.body.results.map((r: { id: string }) => r.id)).toEqual([
      "notas/n1.md",
      "docs/d1.md",
    ]);
    const only = await request(covered.app).get(
      "/api/related?id=self.md&collections=colA",
    );
    expect(only.body.results.map((r: { id: string }) => r.id)).toEqual([
      "notas/n1.md",
    ]);
  });

  it("yields empty results plus a warning on malformed qmd JSON", async () => {
    state.vsearchOut = "this is not json [broken";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(covered.app).get("/api/related?id=self.md");
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    state.vsearchOut = "[]";
  });

  it("serves repeat opens from the per-note cache until the note changes (F015)", async () => {
    state.vsearchOut = JSON.stringify([
      { score: 0.9, file: "qmd://vaultcol/a.md" },
    ]);
    const first = await request(covered.app).get("/api/related?id=self.md");
    expect(first.body.results.map((r: { id: string }) => r.id)).toEqual([
      "a.md",
    ]);
    const searches = () =>
      covered.fake.calls.filter(([, s]) => s === "vsearch").length;
    const after = searches();
    const second = await request(covered.app).get("/api/related?id=self.md");
    expect(second.body.results.map((r: { id: string }) => r.id)).toEqual([
      "a.md",
    ]);
    expect(searches()).toBe(after); // cache hit: no new query
    // touching the note invalidates its cache entry
    const t = new Date(Date.now() + 10_000);
    utimesSync(join(VAULT, "self.md"), t, t);
    await request(covered.app).get("/api/related?id=self.md");
    expect(searches()).toBe(after + 1);
  });

  it("guards note ids like /api/note does", async () => {
    expect(
      (await request(covered.app).get("/api/related?id=../../etc/passwd"))
        .status,
    ).toBe(400);
    expect(
      (await request(covered.app).get("/api/related?id=phantom:x")).status,
    ).toBe(404);
    expect(
      (await request(covered.app).get("/api/related?id=missing.md")).status,
    ).toBe(404);
  });
});

describe("GET /api/semantic-search", () => {
  it("maps qmd hits to graph nodes through the same pipeline (R9)", async () => {
    state.vsearchOut = JSON.stringify([
      { score: 0.9, file: "qmd://vaultcol/a.md", snippet: "x" },
      { score: 0.8, file: "qmd://vaultcol/excluded.md" },
    ]);
    const res = await request(covered.app).get(
      "/api/semantic-search?q=anything",
    );
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual(["a.md"]);
    const subs = covered.fake.calls
      .filter(([c]) => c === QMD_BIN)
      .map(([, s]) => s);
    expect(subs).toContain("vsearch");
  });
});

describe("GET /api/passages", () => {
  it("returns passages with line + snippet, dropping out-of-vault hits (U4)", async () => {
    state.vsearchOut = JSON.stringify([
      {
        score: 0.9,
        file: "qmd://vaultcol/a.md",
        line: 12,
        snippet: "12: hit one",
      },
      { score: 0.8, file: "qmd://far/elsewhere.md", line: 3, snippet: "x" },
    ]);
    const res = await request(covered.app).get("/api/passages?q=anything");
    expect(res.status).toBe(200);
    // chunk-level: every passage inside the vault survives (no graph-node filter)
    expect(res.body.results).toEqual([
      { file: "a.md", title: "a.md", line: 12, score: 0.9, snippet: "hit one" },
    ]);
    const subs = covered.fake.calls
      .filter(([c]) => c === QMD_BIN)
      .map(([, s]) => s);
    expect(subs).toContain("vsearch");
  });

  it("over-fetches when scoped to a single note (U4)", async () => {
    state.vsearchOut = JSON.stringify([
      { score: 0.9, file: "qmd://vaultcol/a.md", line: 1, snippet: "x" },
    ]);
    await request(covered.app).get(
      "/api/passages?q=anything&note=a.md&limit=2",
    );
    const vs = covered.fake.calls.find(([, s]) => s === "vsearch")!;
    // calls layout: [qmd, "vsearch", "vec: ...", "-n", "30", "--format", "json"]
    expect(vs[4]).toBe("30");
  });

  it("stores displayQuery in passage research history", async () => {
    state.vsearchOut = JSON.stringify([
      { score: 0.9, file: "qmd://vaultcol/a.md", line: 1, snippet: "x" },
    ]);
    const res = await request(covered.app).get(
      "/api/passages?q=vec%3Ainternal&displayQuery=Readable%20query",
    );
    expect(res.status).toBe(200);
    expect(res.body.historyId).toBeTruthy();

    const history = await request(covered.app).get("/api/research/history");
    const entry = history.body.entries.find(
      (e: { id: string }) => e.id === res.body.historyId,
    );
    expect(entry.query).toBe("Readable query");
  });
});

describe("GET /api/search history mode", () => {
  it("keeps the default array shape and writes history only when requested", async () => {
    writeFileSync(join(VAULT, "a.md"), "# Note A\n\nalpha keyword body\n");

    const plain = await request(covered.app).get("/api/search?q=alpha");
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(Array.isArray(plain.body)).toBe(true);

    const denied = await request(covered.app).get(
      "/api/search?q=alpha&history=1",
    );
    expect(denied.status).toBe(403);

    const token = (await request(covered.app).get("/api/session")).body.token;
    const hist = await request(covered.app)
      .get("/api/search?q=alpha&history=1&displayQuery=Readable%20keyword")
      .set(TOKEN_HEADER, token);
    expect(hist.body.results.length).toBeGreaterThan(0);
    expect(hist.body.historyId).toBeTruthy();

    const history = await request(covered.app).get("/api/research/history");
    const entry = history.body.entries.find(
      (e: { id: string }) => e.id === hist.body.historyId,
    );
    expect(entry).toMatchObject({ mode: "keyword", query: "Readable keyword" });
  });
});

describe("qmd setup and status", () => {
  it("reports ready with existing covering collections and skips setup (R7, AE2, AE7)", async () => {
    const st = await request(covered.app).get("/api/qmd/status");
    expect(st.body.state).toBe("ready");
    expect(st.body.collections.sort()).toEqual(["colA", "colB", "vaultcol"]);

    const token = (await request(covered.app).get("/api/session")).body.token;
    const setup = await request(covered.app)
      .post("/api/qmd/setup")
      .set(TOKEN_HEADER, token);
    expect(setup.body.state).toBe("ready");
    expect(setup.body.reused.sort()).toEqual(["colA", "colB", "vaultcol"]);
    const adds = covered.fake.calls.filter(
      ([, s, a1]) => s === "collection" && a1 === "add",
    );
    expect(adds).toEqual([]); // never re-creates or duplicates
  });

  it("walks uncovered -> indexing -> ready only after embed completes (R6, AE4)", async () => {
    let releaseEmbed!: () => void;
    const gated: FakeState = {
      collections: { far: "/elsewhere" },
      vsearchOut: "[]",
      embedGate: new Promise((r) => {
        releaseEmbed = r;
      }),
    };
    const fresh = makeApp(gated, VAULT);

    expect((await request(fresh.app).get("/api/qmd/status")).body.state).toBe(
      "uncovered",
    );

    const token = (await request(fresh.app).get("/api/session")).body.token;
    const setup = await request(fresh.app)
      .post("/api/qmd/setup")
      .set(TOKEN_HEADER, token);
    expect(setup.body.state).toBe("indexing");

    // still indexing while embeddings are being generated
    expect((await request(fresh.app).get("/api/qmd/status")).body.state).toBe(
      "indexing",
    );
    const rel = await request(fresh.app).get("/api/related?id=self.md");
    expect(rel.body.state).toBe("indexing");

    releaseEmbed();
    await new Promise((r) => setTimeout(r, 20));
    const done = await request(fresh.app).get("/api/qmd/status");
    expect(done.body.state).toBe("ready");
    expect(done.body.collections).toEqual(["sinapso"]);

    // setup ran collection add with the explicit vault path, then update, then embed
    const subs = fresh.fake.calls
      .filter(([c]) => c === QMD_BIN)
      .map(([, s, a1, a2]) =>
        s === "collection" ? `${s} ${a1}${a1 === "add" ? " " + a2 : ""}` : s,
      );
    const addIdx = subs.indexOf(`collection add ${VAULT}`);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(subs.indexOf("update")).toBeGreaterThan(addIdx);
    expect(subs.indexOf("embed")).toBeGreaterThan(subs.indexOf("update"));
  });

  it("rejects setup without the session token", async () => {
    expect((await request(covered.app).post("/api/qmd/setup")).status).toBe(
      403,
    );
  });
});

describe("GET /api/gaps/enrich (F016)", () => {
  it("returns the nearest in-graph note as context for a gap query", async () => {
    state.vsearchOut = JSON.stringify([
      { score: 0.9, file: "qmd://vaultcol/a.md", snippet: "closest context" },
      { score: 0.8, file: "qmd://vaultcol/excluded.md" },
    ]);
    const res = await request(covered.app).get(
      "/api/gaps/enrich?q=missing+concept",
    );
    expect(res.status).toBe(200);
    expect(res.body.from).toBe("Note A");
    expect(res.body.snippet).toBe("closest context");
    expect(res.body.id).toBe("a.md");
  });

  it("requires a query and degrades to null without one/qmd", async () => {
    expect((await request(covered.app).get("/api/gaps/enrich")).status).toBe(
      400,
    );
  });
});

describe("qmd not installed", () => {
  const bare = makeApp({ collections: {}, vsearchOut: "[]" }, VAULT, false);
  it("degrades gap enrichment to snippet:null instead of failing", async () => {
    const res = await request(bare.app).get("/api/gaps/enrich?q=anything");
    expect(res.status).toBe(200);
    expect(res.body.snippet).toBeNull();
  });

  it("returns a clean 503 for search surfaces and missing for status", async () => {
    expect(
      (await request(bare.app).get("/api/related?id=self.md")).status,
    ).toBe(503);
    expect(
      (await request(bare.app).get("/api/semantic-search?q=x")).status,
    ).toBe(503);
    expect((await request(bare.app).get("/api/qmd/status")).body.state).toBe(
      "missing",
    );
    const token = (await request(bare.app).get("/api/session")).body.token;
    expect(
      (await request(bare.app).post("/api/qmd/setup").set(TOKEN_HEADER, token))
        .status,
    ).toBe(503);
    expect(
      (await request(bare.app).get("/api/qmd/maintenance")).body.available,
    ).toBe(false);
  });
});

describe("parseQmdStatus", () => {
  it("parses total/vectors/pending/updated from the status text", () => {
    expect(
      parseQmdStatus(
        "QMD Status\n\nDocuments\n  Total:    8747 files indexed\n  Vectors:  102704 embedded\n  Pending:  21 need embedding\n  Updated:  10h ago\n",
      ),
    ).toEqual({
      total: 8747,
      vectors: 102704,
      pending: 21,
      updatedAgo: "10h ago",
    });
  });
  it("returns null when nothing parses", () => {
    expect(parseQmdStatus("not a status")).toBeNull();
  });
});

describe("createQmdMaintenance", () => {
  it("runs update then embed, single-flight while running", async () => {
    const calls: string[] = [];
    let releaseEmbed!: () => void;
    const gate = new Promise<void>((r) => (releaseEmbed = r));
    const run: Runner = async (_cmd, args) => {
      calls.push(args[0]);
      if (args[0] === "embed") await gate;
      return { ok: true, stdout: "", stderr: "" };
    };
    const m = createQmdMaintenance(run);
    expect(m.start("/qmd", { update: true, embed: true })).toBe(true);
    expect(m.start("/qmd", { embed: true })).toBe(false); // rejected while running
    expect(m.running()).toBe(true);
    releaseEmbed();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.running()).toBe(false);
    expect(m.op()).toBeNull();
    expect(calls).toEqual(["update", "embed"]);
  });

  it("stops and records the error when a step fails", async () => {
    const run: Runner = async (_c, args) =>
      args[0] === "update"
        ? { ok: false, stdout: "", stderr: "boom" }
        : { ok: true, stdout: "", stderr: "" };
    const m = createQmdMaintenance(run);
    m.start("/qmd", { update: true, embed: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(m.running()).toBe(false);
    expect(m.error()).toContain("boom");
  });

  it("does nothing with no steps requested", () => {
    const m = createQmdMaintenance(async () => ({
      ok: true,
      stdout: "",
      stderr: "",
    }));
    expect(m.start("/qmd", {})).toBe(false);
  });

  it("passes -f when force is set (full re-embed)", async () => {
    const spawns: { args: string[] }[] = [];
    const run: Runner = async (_cmd, args) => {
      spawns.push({ args });
      return { ok: true, stdout: "", stderr: "" };
    };
    const m = createQmdMaintenance(run);
    m.start("/qmd", { embed: true }, { force: true });
    await new Promise((r) => setTimeout(r, 10));
    const embed = spawns.find((s) => s.args[0] === "embed")!;
    expect(embed.args).toEqual(["embed", "-f"]);
  });

  it("embeds incrementally with no force (no -f)", async () => {
    const spawns: { args: string[] }[] = [];
    const run: Runner = async (_cmd, args) => {
      spawns.push({ args });
      return { ok: true, stdout: "", stderr: "" };
    };
    const m = createQmdMaintenance(run);
    m.start("/qmd", { embed: true });
    await new Promise((r) => setTimeout(r, 10));
    const embed = spawns.find((s) => s.args[0] === "embed")!;
    expect(embed.args).toEqual(["embed"]);
  });
});

describe("qmd maintenance endpoints", () => {
  it("reports index status and rejects an unguarded start", async () => {
    const st = await request(covered.app).get("/api/qmd/maintenance");
    expect(st.body.available).toBe(true);
    expect(st.body.running).toBe(false);
    expect(st.body.index.pending).toBe(0);
    expect(
      (await request(covered.app).post("/api/qmd/maintenance?update=1")).status,
    ).toBe(403);
  });

  it("starts an update+embed job with the session token", async () => {
    const fresh = makeApp(
      { collections: { sinapso: VAULT }, vsearchOut: "[]" },
      VAULT,
    );
    const token = (await request(fresh.app).get("/api/session")).body.token;
    const res = await request(fresh.app)
      .post("/api/qmd/maintenance?update=1&embed=1")
      .set(TOKEN_HEADER, token);
    expect(res.body.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    const subs = fresh.fake.calls
      .filter(([c]) => c === QMD_BIN)
      .map(([, s]) => s);
    expect(subs).toContain("update");
    expect(subs).toContain("embed");
  });
});

describe("qmd force re-embed wiring", () => {
  const freshVault = () => mkdtempSync(join(tmpdir(), "sinapso-embed-"));

  it("passes -f to the embed spawn when force=1", async () => {
    const v = freshVault();
    const inst = makeApp({ collections: { sinapso: v }, vsearchOut: "[]" }, v);
    const token = (await request(inst.app).get("/api/session")).body.token;
    await request(inst.app)
      .post("/api/qmd/maintenance?embed=1&force=1")
      .set(TOKEN_HEADER, token);
    await new Promise((r) => setTimeout(r, 10));
    const embed = inst.fake.spawns.find((s) => s.args[0] === "embed")!;
    expect(embed.args).toEqual(["embed", "-f"]);
    rmSync(v, { recursive: true, force: true });
  });
});
