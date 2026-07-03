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
import { coveringCollections, hitsToNodes } from "./qmd";
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
      state.collections["solaris"] = a2;
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

// --- routes with a covered vault ---

const VAULT = mkdtempSync(join(tmpdir(), "solaris-qmd-test-"));
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
beforeEach(() => {
  covered.fake.calls.length = 0;
  // The related cache is keyed by note mtime (F015); bump it so each test
  // exercises a fresh query instead of the previous test's cached result.
  const t = new Date(Date.now() + ++mtimeBump * 1000);
  utimesSync(join(VAULT, "self.md"), t, t);
});

describe("GET /api/related", () => {
  it("returns in-graph related notes only, excluding the note itself (AE3, R5)", async () => {
    state.vsearchOut = JSON.stringify([
      { docid: "#1", score: 0.9, file: "qmd://vaultcol/a.md", snippet: "s" },
      { docid: "#2", score: 0.8, file: "qmd://vaultcol/excluded.md" },
      { docid: "#3", score: 0.7, file: "qmd://far/elsewhere.md" },
      { docid: "#4", score: 0.6, file: "qmd://vaultcol/self.md" },
    ]);
    const res = await request(covered.app).get("/api/related?id=self.md");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("ready");
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual(["a.md"]);
  });

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
    expect(done.body.collections).toEqual(["solaris"]);

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

  it("passes QMD_EMBED_MODEL + -f when embedding with a model and force", async () => {
    const spawns: { args: string[]; env?: Record<string, string> }[] = [];
    const run: Runner = async (_cmd, args, _t, env) => {
      spawns.push({ args, env });
      return { ok: true, stdout: "", stderr: "" };
    };
    const m = createQmdMaintenance(run);
    m.start(
      "/qmd",
      { embed: true },
      { embedModel: "hf:x/y/z.gguf", force: true },
    );
    await new Promise((r) => setTimeout(r, 10));
    const embed = spawns.find((s) => s.args[0] === "embed")!;
    expect(embed.args).toEqual(["embed", "-f"]);
    expect(embed.env).toEqual({ QMD_EMBED_MODEL: "hf:x/y/z.gguf" });
  });

  it("embeds incrementally with no model/force (no env, no -f)", async () => {
    const spawns: { args: string[]; env?: Record<string, string> }[] = [];
    const run: Runner = async (_cmd, args, _t, env) => {
      spawns.push({ args, env });
      return { ok: true, stdout: "", stderr: "" };
    };
    const m = createQmdMaintenance(run);
    m.start("/qmd", { embed: true });
    await new Promise((r) => setTimeout(r, 10));
    const embed = spawns.find((s) => s.args[0] === "embed")!;
    expect(embed.args).toEqual(["embed"]);
    expect(embed.env).toBeUndefined();
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
      { collections: { solaris: VAULT }, vsearchOut: "[]" },
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

describe("qmd embed-model wiring (F025)", () => {
  const freshVault = () => mkdtempSync(join(tmpdir(), "solaris-embed-"));
  const MODEL =
    "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

  it("persists embedModel via the guarded config endpoint and reflects it in status", async () => {
    const v = freshVault();
    const app = makeApp(
      { collections: { solaris: v }, vsearchOut: "[]" },
      v,
    ).app;
    // unguarded config write is rejected
    expect(
      (
        await request(app)
          .post("/api/integrations/config")
          .send({ embedModel: MODEL })
      ).status,
    ).toBe(403);
    const token = (await request(app).get("/api/session")).body.token;
    await request(app)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, token)
      .send({ embedModel: MODEL });
    const st = await request(app).get("/api/integrations");
    expect(st.body.embedModel).toBe(MODEL);
    rmSync(v, { recursive: true, force: true });
  });

  it("passes the configured model + -f to the embed spawn on force", async () => {
    const v = freshVault();
    const inst = makeApp({ collections: { solaris: v }, vsearchOut: "[]" }, v);
    const token = (await request(inst.app).get("/api/session")).body.token;
    await request(inst.app)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, token)
      .send({ embedModel: MODEL });
    await request(inst.app)
      .post("/api/qmd/maintenance?embed=1&force=1")
      .set(TOKEN_HEADER, token);
    await new Promise((r) => setTimeout(r, 10));
    const embed = inst.fake.spawns.find((s) => s.args[0] === "embed")!;
    expect(embed.args).toEqual(["embed", "-f"]);
    expect(embed.env).toEqual({ QMD_EMBED_MODEL: MODEL });
    rmSync(v, { recursive: true, force: true });
  });
});
