import { afterAll, describe, expect, it } from "vitest";
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
import { readChangeLog } from "./write";

const ROOTS: string[] = [];
afterAll(() => ROOTS.forEach((r) => rmSync(r, { recursive: true, force: true })));

const MD_BIN = "/fake/bin/markitdown";

function wiki(rawDestination: string | null = "raw/") {
  return {
    id: "wiki",
    label: "Main Wiki",
    path: "wiki",
    enabled: true,
    contractFiles: ["AGENTS.md", "index.md"],
    rawDestination,
    discovered: true,
    confidence: "high" as const,
  };
}

function fixture(opts: {
  openrouterKey?: boolean;
  rawDestination?: string | null;
  llm?: string;
  prompt?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "solaris-wiki-ingest-"));
  ROOTS.push(root);
  const vault = join(root, "vault");
  const data = join(root, "data");
  mkdirSync(join(vault, "wiki"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(vault, "wiki", "AGENTS.md"), "# Contract\nUse links.\n");
  writeFileSync(join(vault, "wiki", "index.md"), "# Index\n");
  writeFileSync(join(vault, "wiki", "existing.md"), "# Existing\nold\n");
  const doc = join(root, "source.pdf");
  writeFileSync(doc, "pdf bytes");
  const graphPath = join(data, "graph.json");
  writeFileSync(
    graphPath,
    JSON.stringify({
      meta: { vaultName: "t", vaultPath: vault, notes: 1, excludes: [] },
      nodes: [{ id: "wiki/existing.md", title: "Existing", in: 0, out: 0 }],
      links: [],
    }),
  );
  const configPath = join(data, "config.json");
  updateConfig(
    {
      openrouterKey: opts.openrouterKey === false ? null : "or-key",
      prompts: opts.prompt ? { wikiIngest: opts.prompt } : undefined,
      vaults: {
        [vault]: { path: vault, wikis: [wiki(opts.rawDestination ?? "raw/")] },
      },
    },
    configPath,
  );
  let chatBody: { messages?: Array<{ role: string; content: string }> } | null =
    null;
  const app = createApp(graphPath, undefined, {
    configPath,
    detectDeps: {
      home: "/h",
      env: { PATH: "/fake/bin" },
      fileExists: (p) => p === MD_BIN,
      run: async (cmd, args) => {
        if (cmd === MD_BIN && args[0] === "--version")
          return { ok: true, stdout: "markitdown 1.0", stderr: "" };
        return { ok: true, stdout: "# Source Title\n\nConverted body.", stderr: "" };
      },
    },
    openrouter: {
      fetch: (async (_url: string, init?: RequestInit) => {
        chatBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    opts.llm ??
                    JSON.stringify({
                      operations: [
                        {
                          type: "create",
                          path: "wiki/source-title.md",
                          content: "# Source Title\n\nSynthesized.",
                        },
                      ],
                    }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as never,
    },
  }).app;
  return { app, vault, data, doc, chatBody: () => chatBody };
}

async function token(app: ReturnType<typeof fixture>["app"]) {
  return (await request(app).get("/api/session")).body.token as string;
}

describe("wiki ingest proposals", () => {
  it("requires an OpenRouter key before converting or writing", async () => {
    const f = fixture({ openrouterKey: false });
    const before = readChangeLog(f.data).length;
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({ source: f.doc, wikiId: "wiki" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("OpenRouter");
    expect(readChangeLog(f.data)).toHaveLength(before);
  });

  it("previews a raw copy in the inferred ../raw fallback without writing", async () => {
    const f = fixture({ llm: '{"operations":[]}' });
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({ source: f.doc, wikiId: "wiki" });
    expect(res.status).toBe(200);
    expect(res.body.operations[0]).toMatchObject({ type: "create", raw: true });
    expect(res.body.operations[0].path).toMatch(
      /^raw\/\d{4}-\d{2}-\d{2}_source-title\.md$/,
    );
    expect(existsSync(join(f.vault, res.body.operations[0].path))).toBe(false);
  });

  it("previews custom ../research raw destinations under the vault", async () => {
    const f = fixture({ rawDestination: "../research/", llm: '{"operations":[]}' });
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({ source: f.doc });
    expect(res.status).toBe(200);
    expect(res.body.operations[0].path).toMatch(
      /^research\/\d{4}-\d{2}-\d{2}_source-title\.md$/,
    );
  });

  it("drops generated contract and meta operations from the proposal", async () => {
    const f = fixture({
      llm: JSON.stringify({
        operations: [
          { type: "edit", path: "wiki/index.md", content: "# Index\nnew" },
          { type: "edit", path: "wiki/log.md", content: "log" },
          { type: "edit", path: "wiki/hot.md", content: "hot" },
          { type: "edit", path: "wiki/AGENTS.md", content: "contract" },
          { type: "create", path: "wiki/source-title.md", content: "# Source\n" },
        ],
      }),
    });
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({ source: f.doc, wikiId: "wiki" });
    expect(res.status).toBe(200);
    expect(res.body.operations.map((op: { path: string }) => op.path)).toEqual([
      expect.stringMatching(/^raw\/\d{4}-\d{2}-\d{2}_source-title\.md$/),
      "wiki/source-title.md",
    ]);
  });

  it("includes contract files and the configured prompt in the OpenRouter call", async () => {
    const f = fixture({ prompt: "Custom wiki ingest prompt" });
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({ source: f.doc, wikiId: "wiki" });
    expect(res.status).toBe(200);
    const prompt = f.chatBody()?.messages?.at(-1)?.content ?? "";
    expect(prompt).toContain("Custom wiki ingest prompt");
    expect(prompt).toContain("wiki/AGENTS.md");
    expect(prompt).toContain("Use links.");
    expect(res.body.contracts.map((c: { path: string }) => c.path)).toEqual([
      "wiki/AGENTS.md",
      "wiki/index.md",
    ]);
  });

  it("applies approved creates through write.ts and journals them", async () => {
    const f = fixture({
      llm: JSON.stringify({
        operations: [
          { type: "create", path: "wiki/new-page.md", content: "# New\n" },
        ],
      }),
    });
    const t = await token(f.app);
    const proposed = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, t)
      .send({ source: f.doc, wikiId: "wiki" });
    const applied = await request(f.app)
      .post("/api/wiki-ingest/apply")
      .set(TOKEN_HEADER, t)
      .send({ wikiId: "wiki", operations: proposed.body.operations });
    expect(applied.status).toBe(200);
    expect(applied.body.ids).toContain("wiki/new-page.md");
    expect(readFileSync(join(f.vault, "wiki", "new-page.md"), "utf-8")).toBe(
      "# New\n",
    );
    expect(readChangeLog(f.data).at(-1)).toMatchObject({
      action: "create",
      path: "wiki/new-page.md",
      mode: "approval",
    });
  });

  it("runs synthesis on the thinker tier when configured (U2)", async () => {
    const f = fixture({ llm: '{"operations":[]}' });
    updateConfig(
      { deepseekKey: "ds-k", thinkerProvider: "deepseek" },
      join(f.data, "config.json"),
    );
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({ source: f.doc, wikiId: "wiki" });
    expect(res.status).toBe(200);
    const body = f.chatBody() as unknown as {
      model?: string;
      thinking?: unknown;
    };
    expect(body?.model).toBe("deepseek-v4-pro"); // thinker resolution
    expect(body?.thinking).toEqual({ type: "enabled" });
  });

  it("falls back to the worker slot when no thinker is configured (AE2)", async () => {
    const f = fixture({ llm: '{"operations":[]}' });
    updateConfig(
      { workerProvider: "openrouter", workerModel: "meta/fast" },
      join(f.data, "config.json"),
    );
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({ source: f.doc, wikiId: "wiki" });
    expect(res.status).toBe(200);
    expect((f.chatBody() as unknown as { model?: string })?.model).toBe(
      "meta/fast",
    );
  });

  it("rejecting a preview writes nothing", async () => {
    const f = fixture({
      llm: JSON.stringify({
        operations: [
          {
            type: "edit",
            path: "wiki/existing.md",
            content: "# Existing\nnew\n",
          },
        ],
      }),
    });
    const beforeLog = readChangeLog(f.data).length;
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({ source: f.doc, wikiId: "wiki" });
    expect(res.status).toBe(200);
    expect(readFileSync(join(f.vault, "wiki", "existing.md"), "utf-8")).toBe(
      "# Existing\nold\n",
    );
    expect(readChangeLog(f.data)).toHaveLength(beforeLog);
  });

  it("rejects LLM proposal paths outside the selected wiki", async () => {
    const f = fixture({ llm: '{"operations":[{"type":"create","path":"elsewhere/page.md","content":"x"}]}' });
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({ source: f.doc, wikiId: "wiki" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("outside selected wiki");
  });

  it("rejects tampered approval paths outside the vault", async () => {
    const f = fixture();
    const res = await request(f.app)
      .post("/api/wiki-ingest/apply")
      .set(TOKEN_HEADER, await token(f.app))
      .send({
        wikiId: "wiki",
        operations: [{ type: "create", path: "../escape.md", content: "x" }],
      });
    expect(res.status).toBe(400);
    expect(existsSync(join(f.vault, "..", "escape.md"))).toBe(false);
  });

  it("previews browser uploads with the same wiki target", async () => {
    const f = fixture({ llm: '{"operations":[]}' });
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose-upload?name=clip.docx&wikiId=wiki")
      .set(TOKEN_HEADER, await token(f.app))
      .set("content-type", "application/octet-stream")
      .send("raw bytes");
    expect(res.status).toBe(200);
    expect(res.body.operations[0].path).toMatch(/raw\/.*source-title\.md$/);
  });

  it("accepts an already converted preview payload", async () => {
    const f = fixture({ llm: '{"operations":[]}' });
    const res = await request(f.app)
      .post("/api/wiki-ingest/propose")
      .set(TOKEN_HEADER, await token(f.app))
      .send({
        wikiId: "wiki",
        converted: {
          source: "https://example.com/article",
          sourceLabel: "https://example.com/article",
          title: "Article Title",
          markdown: "Article body.",
          via: "markitdown",
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Article Title");
    expect(res.body.operations[0]).toMatchObject({ raw: true });
  });
});
