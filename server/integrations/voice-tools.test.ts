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
import { readFileSync } from "node:fs";
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
    return (url: string, init?: RequestInit) =>
      re.test(url) && re.test(`${init?.method ?? "GET"} ${url}`);
  }
  return p;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let documentSequence = 0;
function documentResponse(_url: string, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    id?: string;
    title?: string;
  };
  // Plan 020 U5: vault-backed /api/agent/notes returns { ok, id, baseHash }.
  // The server picks the path under the configured Inbox; the test fake
  // synthesizes one from the title so callers can deterministically
  // assert the returned path.
  const seq = ++documentSequence;
  const slug = String(body.title ?? "doc")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = body.id ?? `inbox/${slug || "doc"}-${seq}.md`;
  return jsonResponse({
    ok: true,
    id,
    baseHash: `hash-${seq}`,
  });
}

interface FakeFetch {
  fn: FetchFn;
  calls: RecordedCall[];
  queue: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: (url: string, init?: RequestInit) => Response;
  }>;
  on: (
    predicate: Matcher,
    respond: (url: string, init?: RequestInit) => Response,
  ) => void;
  url: (predicate: Matcher) => RecordedCall[];
}

function makeFakeFetch(): FakeFetch {
  const calls: RecordedCall[] = [];
  const queue: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: (url: string, init?: RequestInit) => Response;
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
      if (q.match(url, init)) return q.respond(url, init);
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

function makeCtx(
  over: Partial<{
    base: string;
    fetchFn: FetchFn;
    getSessionToken: () => string;
    send: (obj: object) => void;
  }> = {},
) {
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
  it("matches the documented characterization fixture", () => {
    const snapshot = JSON.parse(
      readFileSync(
        new URL("./__fixtures__/voice-tools.snapshot.json", import.meta.url),
        "utf-8",
      ),
    );
    expect(snapshot).toEqual(VOICE_TOOLS);
  });

  it("includes the read/write/save tool names", () => {
    const names = new Set(VOICE_TOOLS.map((t) => t.name));
    for (const expected of [
      "current_view",
      "search_vault",
      "list_wikis",
      "read_wiki_contract",
      "write_document",
      "save_research_to_inbox",
      "propose_wiki_ingest",
      "apply_wiki_ingest",
      "edit_vault_note",
      "archive_vault_note",
      "web_research",
      "fetch_url",
      "open_resource",
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
        current: {
          truncated: boolean;
          originalWordCount: number;
          originalCharCount: number;
        };
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
    session.setSelectedContext({
      current: { source: "reader", text: "new reader" },
    });
    session.setSelectedContext({ nope: true });

    const out = (await session.run("current_view", {})) as {
      selectedContext: { current: { source: string; text: string } };
    };
    expect(out.selectedContext.current).toMatchObject({
      source: "reader",
      text: "new reader",
    });
  });

  it("starts a new voice tool session with no selected context", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/reader-history", () => jsonResponse({ entries: [] }));
    fake.on("/api/research/history", () => jsonResponse({ entries: [] }));
    const session = createVoiceToolSession(ctx);
    const out = (await session.run("current_view", {})) as {
      viewStateKnown: boolean;
      recentResearch: null;
      selectedContext: { current: null };
    };
    expect(out).toEqual({
      viewStateKnown: false,
      recentResearch: null,
      selectedContext: { current: null },
    });
  });
});

describe("createVoiceToolSession — read-only tools", () => {
  it("search_vault forwards to GET /api/search-vault and returns the body", async () => {
    const { ctx, fake, sent } = makeCtx();
    fake.on("/api/search-vault", () =>
      jsonResponse({
        mode: "auto",
        source: "semantic",
        results: [{ path: "a.md", title: "A", snippet: "s" }],
      }),
    );
    const session = createVoiceToolSession(ctx);
    const out = (await session.run("search_vault", { queries: "topic" })) as {
      mode?: string;
      results?: Array<{ path: string }>;
    };
    expect(out.mode).toBe("auto");
    expect(out.results).toEqual([{ path: "a.md", title: "A", snippet: "s" }]);
    const call = fake.url("/api/search-vault?")[0];
    expect(call.url).toContain("queries=topic");
    expect(call.url).toContain("mode=auto");
    expect(sent.some((m) => (m as { type?: string }).type === "status")).toBe(
      true,
    );
  });

  it("search_vault passes scope, note, mode and limit through", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/search-vault", () =>
      jsonResponse({ mode: "exact", source: "exact", results: [] }),
    );
    const session = createVoiceToolSession(ctx);
    await session.run("search_vault", {
      queries: "term",
      mode: "exact",
      path: "felo/wiki",
      note: "felo/wiki/n.md",
      limit: 5,
    });
    const url = fake.url("/api/search-vault?")[0].url;
    expect(url).toContain("queries=term");
    expect(url).toContain("mode=exact");
    expect(url).toContain("path=felo");
    expect(url).toContain("note=felo");
    expect(url).toContain("limit=5");
  });

  it("search_vault accepts the legacy 'query' alias", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/search-vault", () =>
      jsonResponse({ mode: "auto", source: "keyword", results: [] }),
    );
    const session = createVoiceToolSession(ctx);
    await session.run("search_vault", { query: "legacy" });
    expect(fake.url("/api/search-vault?")[0].url).toContain("queries=legacy");
  });

  it("search_vault surfaces a route error as the tool-error envelope", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/search-vault", () => jsonResponse({ error: "boom" }, 500));
    const session = createVoiceToolSession(ctx);
    const out = (await session.run("search_vault", { queries: "x" })) as {
      error?: string;
    };
    expect(out.error).toBe("boom");
  });

  it("empty search_vault results keep one consistent shape", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/search-vault", () =>
      jsonResponse({ mode: "auto", source: "keyword", results: [] }),
    );
    const session = createVoiceToolSession(ctx);
    const out = await session.run("search_vault", { queries: "none" });
    expect(out).toEqual({ mode: "auto", source: "keyword", results: [] });
  });

  it("read_note anchored mode builds a centered line query and preserves total", async () => {
    const { ctx, fake } = makeCtx();
    const calls: string[] = [];
    fake.on(
      (url) => url.startsWith(`${BASE}/api/note-lines`),
      (u) => {
        calls.push(u);
        return jsonResponse({
          id: "x.md",
          from: 91,
          to: 101,
          total: 200,
          text: "surrounding lines",
        });
      },
    );
    const session = createVoiceToolSession(ctx);
    const out = await session.run("read_note", {
      note: "x.md",
      line: 96,
      before: 5,
      after: 5,
    });
    // line + before + after are forwarded; from/count are NOT.
    expect(calls[0]).toContain("line=96");
    expect(calls[0]).toContain("before=5");
    expect(calls[0]).toContain("after=5");
    expect(calls[0]).not.toContain("from=");
    expect(calls[0]).toContain("id=x.md");
    expect(out).toEqual({
      path: "x.md",
      from: 91,
      to: 101,
      total: 200,
      snippet: "surrounding lines",
    });
  });

  it("read_note range mode builds a from/count query", async () => {
    const { ctx, fake } = makeCtx();
    const calls: string[] = [];
    fake.on(
      (url) => url.startsWith(`${BASE}/api/note-lines`),
      (u) => {
        calls.push(u);
        return jsonResponse({
          id: "x.md",
          from: 1,
          to: 60,
          total: 200,
          text: "first chunk",
        });
      },
    );
    const session = createVoiceToolSession(ctx);
    const out = await session.run("read_note", {
      note: "x.md",
      from: 1,
      count: 60,
    });
    expect(calls[0]).toContain("from=1");
    expect(calls[0]).toContain("count=60");
    expect(calls[0]).not.toContain("line=");
    expect(out).toEqual({
      path: "x.md",
      from: 1,
      to: 60,
      total: 200,
      snippet: "first chunk",
    });
  });
});

describe("createVoiceToolSession — write_document", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  it("creates without an id and adopts the server path and baseHash", async () => {
    const { ctx, fake } = makeCtx();
    fake.on((url) => url === `${BASE}/api/agent/notes`, documentResponse);
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("write_document", {
      operation: "create",
      title: "My Note!",
      markdown: "body",
    })) as {
      ok: boolean;
      path: string;
      baseHash: string;
      chars: number;
    };

    expect(out.ok).toBe(true);
    expect(out.path).toMatch(/^inbox\/my-note-\d+\.md$/);
    expect(out.baseHash).toMatch(/^hash-\d+$/);
    expect(out.chars).toBe(4);
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({ title: "My Note!", content: "body" });
    const headers = fake.calls[0].init?.headers as Record<string, string>;
    expect(headers["x-sinapso-token"]).toBe(TEST_TOKEN);
  });

  it("requires explicit create or update semantics", async () => {
    const { ctx, fake } = makeCtx();
    const session = createVoiceToolSession(ctx);
    const out = await session.run("write_document", {
      title: "T",
      markdown: "M",
    });
    expect(out).toEqual({ error: "operation must be create or update" });
    expect(fake.calls).toHaveLength(0);
  });

  it("reads a vault note before replacing it with its current baseHash (plan 020 U5)", async () => {
    const { ctx, fake } = makeCtx();
    fake.on(
      (url) => url.startsWith(`${BASE}/api/note?`),
      () =>
        jsonResponse({
          id: "inbox/existing.md",
          markdown: "# Existing\none",
          baseHash: "hash-1",
        }),
    );
    fake.on(
      (url, init) =>
        url === `${BASE}/api/agent/notes` && init?.method === "PUT",
      (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, id: body.id, baseHash: "hash-2" });
      },
    );
    const session = createVoiceToolSession(ctx);

    const read = await session.run("read_working_document", {
      note: "inbox/existing.md",
    });
    expect(read).toMatchObject({
      note: "inbox/existing.md",
      markdown: "# Existing\none",
      baseHash: "hash-1",
      title: "Existing",
    });
    const out = await session.run("write_document", {
      operation: "update",
      note: "inbox/existing.md",
      baseHash: "hash-1",
      title: "Existing",
      markdown: "# Existing\none edited",
    });

    expect(out).toMatchObject({
      ok: true,
      path: "inbox/existing.md",
      baseHash: "hash-2",
    });
    const write = fake.calls.find(
      (c) => c.url === `${BASE}/api/agent/notes` && c.init?.method === "PUT",
    )!;
    expect(JSON.parse(String(write.init?.body))).toEqual({
      id: "inbox/existing.md",
      content: "# Existing\none edited",
      baseHash: "hash-1",
    });
  });

  it("legacy mode=document: reads with documentId then updates through /api/document", async () => {
    const { ctx, fake } = makeCtx();
    fake.on(
      (url) => url === `${BASE}/api/document/doc-existing`,
      () =>
        jsonResponse({
          id: "doc-existing",
          title: "A",
          content: "one",
          revision: "rev-1",
        }),
    );
    fake.on(
      (url) => url === `${BASE}/api/document`,
      (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, id: body.id, revision: "rev-2" });
      },
    );
    const session = createVoiceToolSession(ctx);

    const read = await session.run("read_working_document", {
      documentId: "doc-existing",
    });
    expect(read).toMatchObject({ content: "one", revision: "rev-1" });
    const out = await session.run("write_document", {
      operation: "update",
      documentId: "doc-existing",
      revision: "rev-1",
      title: "A",
      markdown: "one edited",
    });

    expect(out).toMatchObject({
      ok: true,
      id: "doc-existing",
      revision: "rev-2",
    });
    expect(JSON.parse(fake.calls[1].init?.body as string)).toEqual({
      id: "doc-existing",
      title: "A",
      content: "one edited",
      revision: "rev-1",
    });
  });

  it("rejects vault update without a prior full read (no baseHash)", async () => {
    const { ctx, fake } = makeCtx();
    const session = createVoiceToolSession(ctx);
    const out = await session.run("write_document", {
      operation: "update",
      note: "inbox/fresh.md",
      title: "A",
      markdown: "x",
    });
    expect(out).toEqual({
      error: "read_working_document required before update",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects legacy update without revision", async () => {
    const { ctx, fake } = makeCtx();
    const session = createVoiceToolSession(ctx);
    const out = await session.run("write_document", {
      operation: "update",
      documentId: "doc-existing",
      title: "A",
      markdown: "x",
    });
    expect(out).toEqual({ error: "revision required to update a document" });
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects legacy update without a prior full read", async () => {
    const { ctx, fake } = makeCtx();
    const session = createVoiceToolSession(ctx);
    const out = await session.run("write_document", {
      operation: "update",
      documentId: "doc-missing",
      revision: "rev-1",
      title: "A",
      markdown: "x",
    });
    expect(out).toEqual({
      error: "read_working_document required before update",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("surfaces the agent note endpoint error when the create fails", async () => {
    const { ctx, fake } = makeCtx();
    fake.on(
      (url) => url === `${BASE}/api/agent/notes`,
      () => jsonResponse({ error: "boom" }, 500),
    );
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("write_document", {
      operation: "create",
      title: "T",
      markdown: "M",
    })) as { error: string };
    expect(out.error).toBe("boom");
  });

  it("emits an open_saved_note action for pin-aware Inbox arrival on create", async () => {
    const { ctx, fake, sent } = makeCtx();
    fake.on((url) => url === `${BASE}/api/agent/notes`, documentResponse);
    const session = createVoiceToolSession(ctx);

    await session.run("write_document", {
      operation: "create",
      title: "T",
      markdown: "M",
    });

    // open_saved_note is the existing pin-aware Inbox arrival action; the
    // browser context's pin still rules what stays visible. No display
    // acknowledgment is requested for the vault-backed create (the
    // machinery is reserved for legacy mode=document updates).
    const open = sent.find(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        (s as { type?: string }).type === "action" &&
        (s as { action?: string }).action === "open_saved_note",
    ) as { note: string } | undefined;
    expect(open).toBeDefined();
    expect(open?.note).toMatch(/^inbox\/t-\d+\.md$/);
  });

  it("legacy update still emits show_document with display acknowledgment (R23)", async () => {
    // The legacy mode=document path keeps the show_document + display-ack
    // contract. The display-ack machinery is preserved for it; new vault-
    // backed create/update go through open_saved_note without an ack.
    const { ctx, fake, sent } = makeCtx();
    fake.on(
      (url) => url === `${BASE}/api/document/doc-leg`,
      () =>
        jsonResponse({
          id: "doc-leg",
          title: "L",
          content: "old",
          revision: "rev-1",
        }),
    );
    fake.on(
      (url) => url === `${BASE}/api/document`,
      () => jsonResponse({ ok: true, id: "doc-leg", revision: "rev-2" }),
    );
    const session = createVoiceToolSession(ctx);
    session.setBrowserContext({
      view: {
        readerNoteId: null,
        researchPanelOpen: true,
        visibleResearchId: null,
        pinnedResearchId: null,
      },
    });

    await session.run("read_working_document", { documentId: "doc-leg" });
    const pending = session.run("write_document", {
      operation: "update",
      documentId: "doc-leg",
      revision: "rev-1",
      title: "L",
      markdown: "new",
    });
    let action: object | undefined;
    await vi.waitFor(() => {
      action = sent.find(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          "action" in value &&
          value.action === "show_document",
      );
      expect(action).toBeDefined();
    });
    if (!action || !("requestId" in action))
      throw new Error("missing requestId");
    session.setBrowserContext({
      displayAcknowledgment: {
        requestId: action.requestId,
        decision: "shown",
        visibleId: "doc-leg",
        pinnedId: null,
      },
    });

    await expect(pending).resolves.toMatchObject({
      display: { decision: "shown" },
    });
  });

  it("bounds legacy display acknowledgment waits and clears them on session close", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, fake } = makeCtx();
      fake.on(
        (url) => url === `${BASE}/api/document/doc-leg`,
        () =>
          jsonResponse({
            id: "doc-leg",
            title: "L",
            content: "old",
            revision: "rev-1",
          }),
      );
      fake.on(
        (url) => url === `${BASE}/api/document`,
        () => jsonResponse({ ok: true, id: "doc-leg", revision: "rev-2" }),
      );
      const session = createVoiceToolSession(ctx);
      session.setBrowserContext({
        view: {
          readerNoteId: null,
          researchPanelOpen: true,
          visibleResearchId: null,
          pinnedResearchId: null,
        },
      });
      await session.run("read_working_document", { documentId: "doc-leg" });
      const timedOut = session.run("write_document", {
        operation: "update",
        documentId: "doc-leg",
        revision: "rev-1",
        title: "L",
        markdown: "M",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(timedOut).resolves.toMatchObject({
        display: { decision: "display-timeout" },
      });

      await session.run("read_working_document", { documentId: "doc-leg" });
      const closing = session.run("write_document", {
        operation: "update",
        documentId: "doc-leg",
        revision: "rev-1",
        title: "L",
        markdown: "Second",
      });
      await vi.advanceTimersByTimeAsync(0);
      session.close();
      await expect(closing).resolves.toMatchObject({
        display: { decision: "display-unavailable" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createVoiceToolSession — curation and edit", () => {
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
    expect(headers["x-sinapso-token"]).toBe(TEST_TOKEN);
    const body = JSON.parse(fake.calls[0].init?.body as string);
    expect(body).toEqual({ id: "foo.md", content: "# new body" });
  });

  it("edit_vault_note rejects an empty path or empty body with the current errors", async () => {
    const { ctx } = makeCtx();
    const session = createVoiceToolSession(ctx);
    expect(
      await session.run("edit_vault_note", { note: "  ", markdown: "x" }),
    ).toEqual({
      error: "note path required",
    });
    expect(
      await session.run("edit_vault_note", { note: "x.md", markdown: "  " }),
    ).toEqual({
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
    expect(headers["x-sinapso-token"]).toBe(TEST_TOKEN);
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

  it("proposes before applying wiki ingestion with the returned operation shape", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/wiki-ingest/propose", () =>
      jsonResponse({
        wiki: { id: "wiki" },
        operations: [
          { type: "create", path: "wiki/derived.md", content: "# Derived" },
          {
            type: "move",
            path: "raw/source.md",
            raw: true,
            sourceNote: "inbox/source.md",
          },
        ],
      }),
    );
    fake.on("/api/wiki-ingest/apply", () =>
      jsonResponse({ ids: ["wiki/derived.md", "raw/source.md"] }),
    );
    const session = createVoiceToolSession(ctx);
    const proposal = await session.run("propose_wiki_ingest", {
      researchId: "research-1",
      wikiId: "wiki",
    });
    expect(proposal).toMatchObject({ ok: true, operations: expect.any(Array) });
    expect(JSON.parse(String(fake.calls[0].init?.body))).toEqual({
      wikiId: "wiki",
      researchId: "research-1",
      sourceNote: undefined,
    });
    const applied = await session.run("apply_wiki_ingest", {
      wikiId: "wiki",
      researchId: "research-1",
      operations: proposal.operations,
    });
    expect(applied).toMatchObject({
      ok: true,
      ids: ["wiki/derived.md", "raw/source.md"],
    });
    expect(fake.calls.map((call) => call.url)).toEqual([
      `${BASE}/api/wiki-ingest/propose`,
      `${BASE}/api/wiki-ingest/apply`,
    ]);
  });
});

describe("createVoiceToolSession — web tools", () => {
  it("current_view resolves the browser-visible document and pinned article", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/research/history", () =>
      jsonResponse({
        entries: [
          {
            id: "article-a",
            mode: "article",
            query: "Article",
            article: {
              title: "Source",
              url: "https://source.example/article",
              content: "immutable body",
            },
          },
          {
            id: "doc-a",
            mode: "document",
            query: "Doc A",
            document: { title: "Doc A", content: "mutable body" },
          },
        ],
      }),
    );
    const session = createVoiceToolSession(ctx);
    session.setBrowserContext({
      current: { source: "research", text: "selected passage" },
      view: {
        readerNoteId: null,
        researchPanelOpen: true,
        visibleResearchId: "doc-a",
        pinnedResearchId: "article-a",
        recentResearch: {
          id: "doc-a",
          mode: "document",
          query: "Doc A",
          document: { title: "Doc A", content: "mutable body" },
        },
      },
    });

    const out = (await session.run("current_view", {})) as Record<string, any>;
    expect(out).toMatchObject({
      viewStateKnown: true,
      recentResearch: { id: "article-a", mode: "article" },
      research: {
        panelOpen: true,
        visible: {
          id: "doc-a",
          mutable: true,
          document: { title: "Doc A", content: "mutable body" },
        },
        pinned: {
          id: "article-a",
          mutable: false,
          article: { title: "Source", url: "https://source.example/article" },
        },
      },
      selectedContext: {
        current: { source: "research", text: "selected passage" },
      },
    });

    session.setBrowserContext({
      view: {
        readerNoteId: null,
        researchPanelOpen: false,
        visibleResearchId: "doc-a",
        pinnedResearchId: "article-a",
      },
    });
    const closed = (await session.run("current_view", {})) as Record<
      string,
      any
    >;
    expect(closed.research).toMatchObject({
      panelOpen: false,
      visible: null,
      pinned: { id: "article-a" },
    });
  });

  it("uses browser recentResearch without loading history for a closed unpinned panel", async () => {
    const { ctx, fake } = makeCtx();
    const session = createVoiceToolSession(ctx);
    session.setBrowserContext({
      view: {
        readerNoteId: null,
        researchPanelOpen: false,
        visibleResearchId: null,
        pinnedResearchId: null,
        recentResearch: {
          id: "recent",
          mode: "web",
          query: "Recent",
          results: [],
        },
      },
    });

    await expect(session.run("current_view", {})).resolves.toMatchObject({
      recentResearch: { id: "recent", mode: "web", query: "Recent" },
    });
    expect(fake.url("/api/research/history")).toHaveLength(0);
  });

  it("open_note rejects http URLs without sending an open_note action", async () => {
    const { ctx, sent } = makeCtx();
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("open_note", {
      note: "https://example.com/a",
    })) as { error: string };

    expect(out.error).toBe(
      "target is a web URL; use open_resource or fetch_url",
    );
    expect(sent).not.toContainEqual({
      type: "action",
      action: "open_note",
      note: "https://example.com/a",
    });
  });

  it("open_resource routes http URLs through /api/article and opens research", async () => {
    const { ctx, fake, sent } = makeCtx();
    fake.on("/api/article", () =>
      jsonResponse({
        title: "An article",
        content: "hello",
        historyId: "hist-article",
      }),
    );
    fake.on("/api/research/history/hist-article/save-inbox", () =>
      jsonResponse({ id: "inbox/an-article.md", removedHistory: true }),
    );
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("open_resource", {
      target: "https://example.com/a",
    })) as { researchId: string; title: string; text: string };

    expect(out).toEqual({
      researchId: "hist-article",
      title: "An article",
      text: "hello",
    });
    expect(fake.calls[0].url).toBe(`${BASE}/api/article`);
    expect(JSON.parse(fake.calls[0].init?.body as string)).toEqual({
      url: "https://example.com/a",
    });
    expect(sent).toContainEqual({
      type: "action",
      action: "open_research",
      id: "hist-article",
    });
    await expect(
      session.run("save_research_to_inbox", {}),
    ).resolves.toMatchObject({ ok: true, path: "inbox/an-article.md" });
    expect(
      fake.url("/api/research/history/hist-article/save-inbox"),
    ).toHaveLength(1);
  });

  it("open_resource routes vault note paths to open_note", async () => {
    const { ctx, fake, sent } = makeCtx();
    fake.on("/api/note", () => jsonResponse({ markdown: "# Note\n\nbody" }));
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("open_resource", {
      target: "folder/note.md",
    })) as { path: string; title: string };

    expect(out.path).toBe("folder/note.md");
    expect(out.title).toBe("Note");
    expect(sent).toContainEqual({
      type: "action",
      action: "open_note",
      note: "folder/note.md",
    });
  });

  it("open_resource reopens an existing research-history id", async () => {
    const { ctx, fake, sent } = makeCtx();
    fake.on("/api/research/history", () =>
      jsonResponse({
        entries: [
          {
            id: "hist-1",
            mode: "article",
            query: "An article",
            article: { title: "An article", url: "https://example.com/a" },
          },
        ],
      }),
    );
    const session = createVoiceToolSession(ctx);

    const out = (await session.run("open_resource", {
      target: "hist-1",
    })) as { id: string; mode: string };

    expect(out).toMatchObject({ id: "hist-1", mode: "article" });
    expect(sent).toContainEqual({
      type: "action",
      action: "open_research",
      id: "hist-1",
    });
  });

  it("open_resource rejects unknown non-note resources", async () => {
    const { ctx, fake } = makeCtx();
    fake.on("/api/research/history", () => jsonResponse({ entries: [] }));
    const session = createVoiceToolSession(ctx);

    await expect(
      session.run("open_resource", { target: "not-a-known-resource" }),
    ).resolves.toEqual({ error: "unknown resource; use search tools first" });
  });

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
      researchId: string;
      sources: Array<{ title: string; url: string }>;
    };
    expect(out.researchId).toBe("hist-1");
    expect(out.answer).toBe("an answer");
    expect(out.sources).toEqual([
      { title: "Result A", url: "https://a.example" },
      { title: "Result B", url: "https://b.example" },
    ]);
    expect(fake.calls[0].url).toBe(`${BASE}/api/research`);
    expect(fake.calls[0].init?.method).toBe("POST");
    const headers = fake.calls[0].init?.headers as Record<string, string>;
    expect(headers["x-sinapso-token"]).toBe(TEST_TOKEN);
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

    const out = (await session.run("fetch_url", {
      url: "https://example.com/x",
    })) as {
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
    expect(
      await session.run("fetch_url", { url: "ftp://example.com" }),
    ).toEqual({
      error: "a valid http(s) URL is required",
    });
  });
});

describe("createVoiceToolSession — default fetchFn", () => {
  it("uses the global fetch when no fetchFn is injected", async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () =>
      jsonResponse({
        mode: "auto",
        source: "keyword",
        results: [{ path: "x.md", title: "X", snippet: "s" }],
      }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const ctx = {
        base: BASE,
        getSessionToken: () => "t",
        send: () => {},
      };
      const session = createVoiceToolSession(ctx);
      const out = (await session.run("search_vault", { queries: "x" })) as {
        results: Array<{ title: string; path: string }>;
      };
      expect(out.results).toEqual([{ path: "x.md", title: "X", snippet: "s" }]);
      expect(spy).toHaveBeenCalledTimes(1); // one consolidated /api/search-vault call
    } finally {
      globalThis.fetch = original;
    }
  });
});
