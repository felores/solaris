/**
 * Voice tool-dispatch seam (U8, R5).
 *
 * Drives `createVoiceToolSession` with a fake `fetchFn` so the voice
 * business rules (working-document id minting, read_wiki_contract
 * gating, save/write/edit/promote calls, read-only tool URL + param
 * shape, error envelope) are testable without a live WebSocket or
 * Gemini client. The loopback-HTTP design stays intact; the session
 * still calls the same endpoints the inlined voice.ts code did, only
 * through the injected fetcher.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceToolSession, VOICE_TOOLS } from "./voice-tools";

type FetchFn = typeof fetch;

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

type Matcher = string | RegExp | ((url: string, init?: RequestInit) => boolean);

function toMatcher(p: Matcher) {
  if (typeof p === "string") {
    const needle = p;
    return (url: string) => url.includes(needle);
  }
  if (p instanceof RegExp) {
    const re = p;
    return (url: string, init?: RequestInit) => re.test(url) && re.test(`${init?.method ?? "GET"} ${url}`);
  }
  return p;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FakeFetch {
  fn: FetchFn;
  calls: RecordedCall[];
  queue: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: () => Response;
  }>;
  on: (predicate: Matcher, respond: () => Response) => void;
  url: (predicate: Matcher) => RecordedCall[];
}

function makeFakeFetch(): FakeFetch {
  const calls: RecordedCall[] = [];
  const queue: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: () => Response;
  }> = [];
  const fn: FetchFn = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    for (const q of queue) {
      if (q.match(url, init)) return q.respond();
    }
    return new Response("", { status: 200 });
  };
  return {
    fn,
    calls,
    queue,
    on(predicate, respond) {
      queue.push({ match: toMatcher(predicate), respond });
    },
    url(predicate) {
      const m = toMatcher(predicate);
      return calls.filter((c) => m(c.url, c.init));
    },
  };
}

const TEST_TOKEN = "tok-test";
const BASE = "http://127.0.0.1:5175";

function makeCtx(over: Partial<{
  base: string;
  fetchFn: FetchFn;
  getSessionToken: () => string;
  send: (obj: object) => void;
}> = {}) {
  const fake = makeFakeFetch();
  const sent: object[] = [];
  const ctx = {
    base: BASE,
    fetchFn: fake.fn,
    getSessionToken: () => TEST_TOKEN,
    send: (obj: object) => sent.push(obj),
    ...over,
  };
  return { ctx, fake, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("VOICE_TOOLS declarations", () => {
  it("includes the read/write/save tool names", () => {
    const names = new Set(VOICE_TOOLS.map((t) => t.name));
    for (const expected of [
      "current_view",
      "find_notes",
      "list_wikis",
      "read_wiki_contract",
      "write_document",
      "save_working_document",
      "edit_vault_note",
      "archive_vault_note",
      "web_research",
      "fetch_url",
    ]) {
      expect(names.has(expected), `missing tool: ${expected}`).toBe(true);
    }
  });
});

describe("createVoiceToolSession — selected context", () => {
  it("current_view returns the selected slot", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/reader-history", () => jsonResponse({ entries: [] }));
    fake.on("/api/research/history", () => jsonResponse({ entries: [] }));
    const session = createVoiceToolSession(ctx);

    session.setSelectedContext({
      current: {
        source: "research",
        text: "research selected",
        title: "Q",
      },
    });
    const out = (await session.run("current_view", {})) as {
      selectedContext: { current: { source: string; text: string } };
    };

    expect(out.selectedContext.current).toMatchObject({
      source: "research",
      text: "research selected",
    });
  });

  it("current_view preserves client-side truncation metadata", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/reader-history", () => jsonResponse({ entries: [] }));
    fake.on("/api/research/history", () => jsonResponse({ entries: [] }));
    const session = createVoiceToolSession(ctx);

    session.setSelectedContext({
      current: {
        source: "reader",
        text: "trimmed text",
        truncated: true,
        originalWordCount: 500,
        originalCharCount: 5000,
      },
    });
    const out = (await session.run("current_view", {})) as {
      selectedContext: {
        current: { truncated: boolean; originalWordCount: number; originalCharCount: number };
      };
    };

    expect(out.selectedContext.current).toMatchObject({
      truncated: true,
      originalWordCount: 500,
      originalCharCount: 5000,
    });
  });

  it("new context replaces the old context and ignores invalid context", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/reader-history", () => jsonResponse({ entries: [] }));
    fake.on("/api/research/history", () => jsonResponse({ entries: [] }));
    const session = createVoiceToolSession(ctx);
    session.setSelectedContext({
      current: { source: "research", text: "research selected" },
    });
    session.setSelectedContext({ current: { source: "reader", text: "new reader" } });
    session.setSelectedContext({ nope: true });

    const out = (await session.run("current_view", {})) as {
      selectedContext: { current: { source: string; text: string } };
    };
    expect(out.selectedContext.current).toMatchObject({ source: "reader", text: "new reader" });
  });

  it("starts a new voice tool session with no selected context", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/reader-history", () => jsonResponse({ entries: [] }));
    fake.on("/api/research/history", () => jsonResponse({ entries: [] }));
    const session = createVoiceToolSession(ctx);
    const out = (await session.run("current_view", {})) as {
      selectedContext: { current: null };
    };
    expect(out.selectedContext).toEqual({ current: null });
  });
});

describe("createVoiceToolSession — read-only tools", () => {
  it("find_notes issues GET to /api/search with the query and maps the response", async () => {
    const { ctx, fake, sent } = makeCtx();
    fake.on("/api/search", () =>
      jsonResponse({
        historyId: "hist-keyword",
        results: [
          { id: "alpha/one.md", title: "One", snippet: "first match" },
          { id: "alpha/two.md", title: "Two", snippet: "second match" },
          { id: "other/skip.md", title: "Skip", snippet: "wrong folder" },
        ],
      }),
    );

    const session = createVoiceToolSession(ctx);
    const out = (await session.run("find_notes", { query: "alpha" })) as {
      historyId?: string;
      results: Array<{ title: string; path: string; snippet: string }>;
    };

    expect(out.results).toHaveLength(3);
    expect(out.results[0]).toEqual({
      title: "One",
      snippet: "first match",
      path: "alpha/one.md",
    });
    expect(out.historyId).toBe("hist-keyword");
    expect(sent).toContainEqual({ type: "action", action: "open_research", id: "hist-keyword" });
    const call = fake.calls[0];
    expect(call.url).toBe(`${BASE}/api/search?q=alpha&history=1&displayQuery=alpha`);
    expect(call.init?.method).toBeUndefined();
    expect((call.init?.headers as Record<string, string>)["x-solaris-token"]).toBe(TEST_TOKEN);
  });

  it("find_notes scopes results to the requested path prefix and trims trailing slashes", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/search", () =>
      jsonResponse([
        { id: "felo/wiki/intro.md", title: "Intro", snippet: "x" },
        { id: "felo/wiki/sub/deep.md", title: "Deep", snippet: "x" },
        { id: "felo/other.md", title: "Other", snippet: "x" },
      ]),
    );

    const session = createVoiceToolSession(ctx);
    const out = (await session.run("find_notes", {
      query: "anything",
      path: "felo/wiki/",
    })) as { results: Array<{ path: string }> };

    expect(out.results.map((r) => r.path)).toEqual([
      "felo/wiki/intro.md",
      "felo/wiki/sub/deep.md",
    ]);
    expect(fake.calls[0].url).toBe(`${BASE}/api/search?q=anything`);
  });

  it("find_notes caps the result list at 8 entries", async () => {
    const { ctx, fake } = makeCtx();
    const ten = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}.md`,
      title: `N${i}`,
      snippet: `s${i}`,
    }));
    fake.on("/api/search", () => jsonResponse(ten));

    const session = createVoiceToolSession(ctx);
    const out = (await session.run("find_notes", { query: "x" })) as {
      results: unknown[];
    };
    expect(out.results).toHaveLength(8);
  });

  it("an HTTP error from the read-only fetch surfaces the tool-error envelope", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/search", () => {
      throw new Error("ECONNREFUSED");
    });

    const session = createVoiceToolSession(ctx);
    const out = (await session.run("find_notes", { query: "x" })) as {
      error: string;
    };
    expect(out.error).toMatch(/^tool find_notes failed: /);
    expect(out.error).toContain("ECONNREFUSED");
  });
});

describe("createVoiceToolSession — read_wiki_contract gating (save_working_document)", () => {
  it("rejects save_working_document (wiki_note) before read_wiki_contract with the current error", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () => jsonResponse({ ok: true }));
    const session = createVoiceToolSession(ctx);

    await session.run("write_document", { title: "T", markdown: "M" });
    fake.calls.length = 0;

    const out = (await session.run("save_working_document", {
      kind: "wiki_note",
      wikiId: "agencia/wiki",
    })) as { error: string };
    expect(out.error).toBe(
      "read_wiki_contract before saving a structured wiki note",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("allows save_working_document (wiki_note) after read_wiki_contract for the same wiki", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () => jsonResponse({ ok: true }));
    fake.on("/api/wiki-contracts", () =>
      jsonResponse({ wiki: { id: "agencia/wiki", path: "agencia/wiki" } }),
    );
    fake.on((url) => url.includes("/promote"), () =>
      jsonResponse({ id: "agencia/wiki/notes/foo.md", ids: ["x"], removedHistory: true }),
    );
    const session = createVoiceToolSession(ctx);

    await session.run("write_document", { title: "T", markdown: "M" });
    await session.run("read_wiki_contract", { wikiId: "agencia/wiki" });
    fake.calls.length = 0;

    const out = (await session.run("save_working_document", {
      kind: "wiki_note",
      wikiId: "agencia/wiki",
    })) as { ok: boolean; path: string };
    expect(out.ok).toBe(true);
    expect(out.path).toBe("agencia/wiki/notes/foo.md");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toMatch(
      new RegExp(`^${BASE.replace(/\./g, "\\.")}/api/document/doc-[\\w-]+/promote$`),
    );
    expect(fake.calls[0].init?.method).toBe("POST");
    const headers = fake.calls[0].init?.headers as Record<string, string>;
    expect(headers["x-solaris-token"]).toBe(TEST_TOKEN);
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({
      kind: "wiki_note",
      wikiId: "agencia/wiki",
    });
  });

  it("skips the read_wiki_contract check when kind=raw_copy", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () => jsonResponse({ ok: true }));
    fake.on((url) => url.includes("/promote"), () =>
      jsonResponse({ id: "research/2025-01-01_thing.md", removedHistory: false }),
    );
    const session = createVoiceToolSession(ctx);

    await session.run("write_document", { title: "T", markdown: "M" });
    fake.calls.length = 0;

    const out = (await session.run("save_working_document", {
      kind: "raw_copy",
      wikiId: "agencia/wiki",
    })) as { ok: boolean; path: string };
    expect(out.ok).toBe(true);
    expect(out.path).toBe("research/2025-01-01_thing.md");
    expect(fake.calls[0].url).toMatch(/\/api\/document\/doc-[\w-]+\/promote$/);
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({
      kind: "raw_copy",
      wikiId: "agencia/wiki",
    });
  });

  it("save_working_document with no working document yields the current error", async () => {
    const { ctx } = makeCtx();
    const session = createVoiceToolSession(ctx);
    const out = (await session.run("save_working_document", {
      kind: "wiki_note",
    })) as { error: string };
    expect(out.error).toBe("no working document to save");
  });
});

describe("createVoiceToolSession — write_document", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  it("mints a doc-<base36 timestamp>-<slug> id on first call and tracks it", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () => jsonResponse({ ok: true }));
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("write_document", {
      title: "My Note!",
      markdown: "body",
    })) as { ok: boolean; id: string; chars: number };

    expect(out.ok).toBe(true);
    expect(out.id).toMatch(/^doc-[a-z0-9]+-my-note$/);
    expect(out.chars).toBe(4);

    expect(fake.calls[0].init?.method).toBe("POST");
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({ id: out.id, title: "My Note!", content: "body" });
    const headers = fake.calls[0].init?.headers as Record<string, string>;
    expect(headers["x-solaris-token"]).toBe(TEST_TOKEN);
  });

  it("reuses the same working doc id on a second write_document call (no second mint)", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () => jsonResponse({ ok: true }));
    const session = createVoiceToolSession(ctx);

    const first = (await session.run("write_document", {
      title: "T1",
      markdown: "M1",
    })) as { id: string };
    const second = (await session.run("write_document", {
      title: "T1",
      markdown: "M1 edited",
    })) as { id: string };

    expect(first.id).toBe(second.id);
    expect(fake.calls).toHaveLength(2);
    const secondBody = JSON.parse(fake.calls[1].init?.body as string);
    expect(secondBody.id).toBe(first.id);
    expect(secondBody.content).toBe("M1 edited");
  });

  it("falls back to the 'doc' slug when the title slugs to an empty string", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () => jsonResponse({ ok: true }));
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("write_document", {
      title: "!!!",
      markdown: "x",
    })) as { id: string };
    expect(out.id).toMatch(/^doc-[a-z0-9]+-doc$/);
  });

  it("returns the 'could not save the document' error when the document endpoint is non-OK", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () =>
      jsonResponse({ error: "boom" }, 500),
    );
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("write_document", {
      title: "T",
      markdown: "M",
    })) as { error: string };
    expect(out.error).toBe("could not save the document");
  });

  it("emits a show_document action to the browser with the new id, title, and content", async () => {
    const { ctx, fake, sent } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () => jsonResponse({ ok: true }));
    const session = createVoiceToolSession(ctx);

    await session.run("write_document", { title: "T", markdown: "M" });

    const show = sent.find(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        (s as { type?: string }).type === "action" &&
        (s as { action?: string }).action === "show_document",
    ) as { id: string; title: string; content: string } | undefined;
    expect(show).toBeDefined();
    expect(show?.title).toBe("T");
    expect(show?.content).toBe("M");
    expect(show?.id).toMatch(/^doc-[a-z0-9]+-t$/);
  });
});

describe("createVoiceToolSession — promote and edit", () => {
  it("save_working_document hits /api/document/:id/promote with the current working doc id and the session token", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () => jsonResponse({ ok: true }));
    fake.on("/api/wiki-contracts", () =>
      jsonResponse({ wiki: { id: "w", path: "w" } }),
    );
    fake.on((url) => url.includes("/promote"), () =>
      jsonResponse({
        id: "w/note.md",
        ids: ["w/note.md"],
        removedHistory: true,
      }),
    );
    const session = createVoiceToolSession(ctx);

    await session.run("write_document", { title: "T", markdown: "M" });
    await session.run("read_wiki_contract", { wikiId: "w" });
    fake.calls.length = 0;

    const out = (await session.run("save_working_document", {
      kind: "wiki_note",
      wikiId: "w",
      path: "w/note.md",
      title: "Note",
    })) as {
      ok: boolean;
      path: string;
      ids: string[];
      removedTemporaryDocument: boolean;
    };

    expect(out).toEqual({
      ok: true,
      path: "w/note.md",
      ids: ["w/note.md"],
      removedTemporaryDocument: true,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toMatch(
      new RegExp(`^${BASE.replace(/\./g, "\\.")}/api/document/doc-[\\w-]+/promote$`),
    );
    const headers = fake.calls[0].init?.headers as Record<string, string>;
    expect(headers["x-solaris-token"]).toBe(TEST_TOKEN);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({
      kind: "wiki_note",
      wikiId: "w",
      path: "w/note.md",
      title: "Note",
    });
  });

  it("save_working_document surfaces the server error message when the promote endpoint fails", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/document`, () => jsonResponse({ ok: true }));
    fake.on("/api/wiki-contracts", () =>
      jsonResponse({ wiki: { id: "w", path: "w" } }),
    );
    fake.on((url) => url.includes("/promote"), () =>
      jsonResponse({ error: "wiki contract missing" }, 400),
    );
    const session = createVoiceToolSession(ctx);

    await session.run("write_document", { title: "T", markdown: "M" });
    await session.run("read_wiki_contract", { wikiId: "w" });
    fake.calls.length = 0;

    const out = (await session.run("save_working_document", {
      kind: "wiki_note",
      wikiId: "w",
    })) as { error: string };
    expect(out.error).toBe("wiki contract missing");
  });

  it("edit_vault_note PUTs the full body to /api/notes with the session token", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/notes", () => jsonResponse({ id: "foo.md" }));
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("edit_vault_note", {
      note: "foo.md",
      markdown: "# new body",
    })) as { ok: boolean; path: string };
    expect(out).toEqual({ ok: true, path: "foo.md" });
    expect(fake.calls[0].url).toBe(`${BASE}/api/notes`);
    expect(fake.calls[0].init?.method).toBe("PUT");
    const headers = fake.calls[0].init?.headers as Record<string, string>;
    expect(headers["x-solaris-token"]).toBe(TEST_TOKEN);
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({ id: "foo.md", content: "# new body" });
  });

  it("edit_vault_note rejects an empty path or empty body with the current errors", async () => {
    const { ctx } = makeCtx();
    const session = createVoiceToolSession(ctx);
    expect(await session.run("edit_vault_note", { note: "  ", markdown: "x" })).toEqual({
      error: "note path required",
    });
    expect(await session.run("edit_vault_note", { note: "x.md", markdown: "  " })).toEqual({
      error: "content required",
    });
  });

  it("archive_vault_note POSTs to /api/archive with the session token", async () => {
    const { ctx, fake, sent } = makeCtx();
    fake.on("/api/archive", () => jsonResponse({ id: "archive/foo.md" }));
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("archive_vault_note", {
      note: "foo.md",
    })) as { ok: boolean; path: string };

    expect(out).toEqual({ ok: true, path: "archive/foo.md" });
    expect(fake.calls[0].url).toBe(`${BASE}/api/archive`);
    expect(fake.calls[0].init?.method).toBe("POST");
    const headers = fake.calls[0].init?.headers as Record<string, string>;
    expect(headers["x-solaris-token"]).toBe(TEST_TOKEN);
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({ id: "foo.md" });
    expect(sent).toContainEqual({
      type: "action",
      action: "archived_note",
      note: "archive/foo.md",
    });
  });

  it("archive_vault_note rejects an empty path", async () => {
    const { ctx } = makeCtx();
    const session = createVoiceToolSession(ctx);
    expect(await session.run("archive_vault_note", { note: "  " })).toEqual({
      error: "note path required",
    });
  });
});

describe("createVoiceToolSession — web tools", () => {
  it("web_research POSTs to /api/research with deep:true and the query, carries the session token", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/research", () =>
      jsonResponse({
        historyId: "hist-1",
        answer: { content: "an answer" },
        results: [
          { title: "Result A", url: "https://a.example" },
          { title: "Result B", url: "https://b.example" },
        ],
      }),
    );
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("web_research", { query: "what is X" })) as {
      answer: string;
      sources: Array<{ title: string; url: string }>;
    };
    expect(out.answer).toBe("an answer");
    expect(out.sources).toEqual([
      { title: "Result A", url: "https://a.example" },
      { title: "Result B", url: "https://b.example" },
    ]);
    expect(fake.calls[0].url).toBe(`${BASE}/api/research`);
    expect(fake.calls[0].init?.method).toBe("POST");
    const headers = fake.calls[0].init?.headers as Record<string, string>;
    expect(headers["x-solaris-token"]).toBe(TEST_TOKEN);
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({ query: "what is X", deep: true });
  });

  it("web_research rejects an empty query with the current error", async () => {
    const { ctx } = makeCtx();
    const session = createVoiceToolSession(ctx);
    expect(await session.run("web_research", { query: "   " })).toEqual({
      error: "empty query",
    });
  });

  it("fetch_url POSTs the URL to /api/article and returns the title + text", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/article", () =>
      jsonResponse({ title: "An article", content: "hello world" }),
    );
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("fetch_url", { url: "https://example.com/x" })) as {
      title: string;
      text: string;
    };
    expect(out).toEqual({ title: "An article", text: "hello world" });
    expect(fake.calls[0].url).toBe(`${BASE}/api/article`);
    expect(fake.calls[0].init?.method).toBe("POST");
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({ url: "https://example.com/x" });
  });

  it("fetch_url rejects non-http URLs with the current error", async () => {
    const { ctx } = makeCtx();
    const session = createVoiceToolSession(ctx);
    expect(await session.run("fetch_url", { url: "ftp://example.com" })).toEqual({
      error: "a valid http(s) URL is required",
    });
  });
});

describe("createVoiceToolSession — default fetchFn", () => {
  it("uses the global fetch when no fetchFn is injected", async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () =>
      jsonResponse([{ id: "x.md", title: "X", snippet: "s" }]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const ctx = {
        base: BASE,
        getSessionToken: () => "t",
        send: () => {},
      };
      const session = createVoiceToolSession(ctx);
      const out = (await session.run("find_notes", { query: "x" })) as {
        results: Array<{ title: string; path: string }>;
      };
      expect(out.results).toEqual([{ title: "X", snippet: "s", path: "x.md" }]);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });
});
