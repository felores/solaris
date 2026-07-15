import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { updateConfig } from "./config";
import { TOKEN_HEADER } from "./security";
import { ingestBytes, ingestDocument } from "./ingest";
import { readChangeLog } from "./write";
import type { RunResult, Runner } from "./detect";

const ROOT = mkdtempSync(join(tmpdir(), "sinapso-ingest-test-"));
const VAULT = join(ROOT, "vault");
const DATA = join(ROOT, "data");
mkdirSync(VAULT, { recursive: true });
mkdirSync(DATA, { recursive: true });
const DOC = join(ROOT, "report.pdf");
writeFileSync(DOC, "fake pdf bytes");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const MD_BIN = "/fake/bin/markitdown";
const ok = (stdout: string): RunResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ ok: false, stdout: "", stderr });
let appSeq = 0;

function recorder(behavior: (cmd: string, args: string[]) => RunResult) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return behavior(cmd, args);
  };
  return { calls, run };
}

const writeDeps = { vaultRoot: VAULT, dataDir: DATA };

describe("ingestDocument", () => {
  it("converts a file and saves it through the guarded write with frontmatter", async () => {
    const { calls, run } = recorder(() => ok("# Report\n\nConverted body.\n"));
    const r = await ingestDocument(run, MD_BIN, writeDeps, { source: DOC });
    expect(r.id).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}_report\.md$/);
    const text = readFileSync(join(VAULT, r.id), "utf-8");
    expect(text).toContain("via: markitdown");
    expect(text).toContain(`source: ${DOC}`);
    expect(text).toContain("Converted body.");
    expect(calls[0]).toEqual([MD_BIN, DOC]);
    expect(readChangeLog(DATA).at(-1)).toMatchObject({
      actor: "user",
      action: "create",
      path: r.id,
    });
  });

  it("names the note after the content's H1, overriding the source filename", async () => {
    const { run } = recorder(() =>
      ok("# Quarterly Earnings Deep Dive\n\nbody text"),
    );
    const r = await ingestDocument(run, MD_BIN, writeDeps, { source: DOC });
    expect(r.id).toMatch(
      /^inbox\/\d{4}-\d{2}-\d{2}_quarterly-earnings-deep-dive\.md$/,
    );
  });

  it("falls back to a derived title when the content has no H1", async () => {
    const { calls, run } = recorder(() => ok("plain web content, no heading"));
    const r = await ingestDocument(run, MD_BIN, writeDeps, {
      source: "https://example.com/articles/deep-work.html",
    });
    expect(r.id).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}_deep-work\.md$/);
    expect(calls[0][1]).toBe("https://example.com/articles/deep-work.html");
  });

  it("404s on a missing file without running markitdown", async () => {
    const { calls, run } = recorder(() => ok("x"));
    await expect(
      ingestDocument(run, MD_BIN, writeDeps, {
        source: join(ROOT, "nope.docx"),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(0);
  });

  it("surfaces markitdown stderr cleanly and rejects empty output", async () => {
    const { run } = recorder(() => fail("unsupported format: .xyz"));
    await expect(
      ingestDocument(run, MD_BIN, writeDeps, { source: DOC }),
    ).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("unsupported format"),
    });
    const empty = recorder(() => ok("   "));
    await expect(
      ingestDocument(empty.run, MD_BIN, writeDeps, { source: DOC }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("ingestBytes", () => {
  it("converts uploaded bytes and labels the note with the original name", async () => {
    const { calls, run } = recorder(() => ok("# Bytes\n\nconverted body"));
    const r = await ingestBytes(run, MD_BIN, writeDeps, {
      name: "Report.pdf",
      bytes: Buffer.from("raw pdf bytes"),
    });
    expect(r.id.startsWith("inbox/")).toBe(true);
    const text = readFileSync(join(VAULT, r.id), "utf-8");
    expect(text).toContain("source: Report.pdf");
    expect(text).toContain("converted body");
    expect(calls[0][0]).toBe(MD_BIN);
    expect(calls[0][1]).toContain("Report.pdf"); // sanitized temp filename
    expect(existsSync(calls[0][1])).toBe(false); // temp cleaned up
  });
});

describe("POST /api/ingest", () => {
  const graphPath = join(DATA, "graph.json");
  writeFileSync(
    graphPath,
    JSON.stringify({
      meta: { vaultName: "t", vaultPath: VAULT, notes: 0, excludes: [] },
      nodes: [],
      links: [],
    }),
  );
  function makeApp(
    markitdownInstalled: boolean,
    patch?: Parameters<typeof updateConfig>[0],
  ) {
    const { run } = recorder((cmd) =>
      cmd === MD_BIN ? ok("# Converted\n\nbody") : fail(""),
    );
    const configPath = join(
      DATA,
      `config-${markitdownInstalled}-${appSeq++}.json`,
    );
    if (patch) updateConfig(patch, configPath);
    return createApp(graphPath, undefined, {
      configPath,
      detectDeps: {
        home: "/h",
        env: { PATH: "/fake/bin" },
        fileExists: (p) => markitdownInstalled && p === MD_BIN,
        run,
      },
    }).app;
  }

  const wiki = (
    id: string,
    path = id,
    rawDestination: string | null = "raw/",
  ) => ({
    id,
    label: id,
    path,
    enabled: true,
    contractFiles: [],
    rawDestination,
    discovered: true,
    confidence: "low" as const,
  });

  const ensureWiki = (path: string) => {
    mkdirSync(join(VAULT, path), { recursive: true });
    mkdirSync(join(VAULT, path, "raw"), { recursive: true });
  };

  it("requires the session token", async () => {
    const app = makeApp(true);
    expect(
      (await request(app).post("/api/ingest").send({ source: DOC })).status,
    ).toBe(403);
  });

  it("503s with guidance when markitdown is missing", async () => {
    const app = makeApp(false);
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest")
      .set(TOKEN_HEADER, t)
      .send({ source: DOC });
    expect(res.status).toBe(503);
    expect(res.body.message).toContain("Tools");
  });

  it("ingests end to end and lands in inbox/", async () => {
    const app = makeApp(true);
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest")
      .set(TOKEN_HEADER, t)
      .send({ source: DOC });
    expect(res.status).toBe(200);
    expect(res.body.id.startsWith("inbox/")).toBe(true);
    expect(existsSync(join(VAULT, res.body.id))).toBe(true);
  });

  it("previews converted content without writing a note", async () => {
    const app = makeApp(true);
    const t = (await request(app).get("/api/session")).body.token;
    const before = readChangeLog(DATA).length;
    const res = await request(app)
      .post("/api/ingest/preview")
      .set(TOKEN_HEADER, t)
      .send({ source: DOC });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "Converted" });
    expect(res.body.markdown).toContain("body");
    expect(readChangeLog(DATA)).toHaveLength(before);
  });

  it("saves a converted preview with the ingest date prefix", async () => {
    const app = makeApp(true);
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest/save")
      .set(TOKEN_HEADER, t)
      .send({
        converted: {
          source: DOC,
          sourceLabel: DOC,
          title: "Converted",
          markdown: "# Converted\n\nbody",
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(
      /^inbox\/\d{4}-\d{2}-\d{2}_converted(?:-\d+)?\.md$/,
    );
    expect(readFileSync(join(VAULT, res.body.id), "utf-8")).toContain(
      "via: markitdown",
    );
  });

  it("POST /api/ingest-upload ingests uploaded bytes end to end", async () => {
    const app = makeApp(true);
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest-upload?name=notes.docx")
      .set(TOKEN_HEADER, t)
      .set("content-type", "application/octet-stream")
      .send("raw bytes here");
    expect(res.status).toBe(200);
    expect(res.body.id.startsWith("inbox/")).toBe(true);
    expect(existsSync(join(VAULT, res.body.id))).toBe(true);
    expect(readFileSync(join(VAULT, res.body.id), "utf-8")).toContain(
      "source: notes.docx",
    );
  });

  it("POST /api/ingest-upload honors configured capture destination", async () => {
    const app = makeApp(true, { writeDestination: "captures" });
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest-upload?name=notes.docx&captureOnly=1")
      .set(TOKEN_HEADER, t)
      .set("content-type", "application/octet-stream")
      .send("raw bytes here");
    expect(res.status).toBe(200);
    expect(res.body.id.startsWith("captures/")).toBe(true);
  });

  it("implicitly routes to one enabled wiki raw folder", async () => {
    ensureWiki("wiki");
    const app = makeApp(true, {
      vaults: { [VAULT]: { path: VAULT, wikis: [wiki("wiki")] } },
    });
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest")
      .set(TOKEN_HEADER, t)
      .send({ source: DOC });
    expect(res.status).toBe(200);
    expect(res.body.id.startsWith("wiki/raw/")).toBe(true);
    expect(existsSync(join(VAULT, res.body.id))).toBe(true);
  });

  it("requires a target when multiple wikis are enabled", async () => {
    ensureWiki("wiki");
    ensureWiki("other/wiki");
    const app = makeApp(true, {
      vaults: {
        [VAULT]: {
          path: VAULT,
          wikis: [wiki("wiki"), wiki("other", "other/wiki")],
        },
      },
    });
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest")
      .set(TOKEN_HEADER, t)
      .send({ source: DOC });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("choose a wiki target");
  });

  it("routes upload to a selected wiki with custom ../research destination", async () => {
    ensureWiki("wiki");
    ensureWiki("other/wiki");
    const app = makeApp(true, {
      vaults: {
        [VAULT]: {
          path: VAULT,
          wikis: [wiki("wiki"), wiki("other", "other/wiki", "../research/")],
        },
      },
    });
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest-upload?name=notes.docx&wikiId=other")
      .set(TOKEN_HEADER, t)
      .set("content-type", "application/octet-stream")
      .send("raw bytes here");
    expect(res.status).toBe(200);
    expect(res.body.id.startsWith("other/research/")).toBe(true);
  });

  it("keeps capture-only available when wikis exist", async () => {
    ensureWiki("wiki");
    const app = makeApp(true, {
      writeDestination: "captures",
      vaults: { [VAULT]: { path: VAULT, wikis: [wiki("wiki")] } },
    });
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest")
      .set(TOKEN_HEADER, t)
      .send({ source: DOC, captureOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.id.startsWith("captures/")).toBe(true);
  });

  it("rejects an invalid wiki id", async () => {
    ensureWiki("wiki");
    const app = makeApp(true, {
      vaults: { [VAULT]: { path: VAULT, wikis: [wiki("wiki")] } },
    });
    const t = (await request(app).get("/api/session")).body.token;
    const res = await request(app)
      .post("/api/ingest")
      .set(TOKEN_HEADER, t)
      .send({ source: DOC, wikiId: "missing" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid wiki target");
  });
});
