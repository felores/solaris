import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { api, apiRaw, ApiError, getApiToken, resetApiToken } from "./api";

function makeResponse(
  opts: {
    ok?: boolean;
    status?: number;
    body?: unknown;
    contentType?: string;
  } = {},
): Response {
  const {
    ok = true,
    status = ok ? 200 : 400,
    body = null,
    contentType = "application/json",
  } = opts;
  const text =
    body === null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-type": contentType }),
    text: () => Promise.resolve(text),
    json: () =>
      Promise.resolve(typeof body === "string" ? JSON.parse(body) : body),
  } as unknown as Response;
}

let fetchMock: Mock;

beforeEach(() => {
  resetApiToken();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("api: defaults", () => {
  it("GET is the default method", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { hello: "world" } }));
    const result = await api<{ hello: string }>("/api/x");
    expect(result).toEqual({ hello: "world" });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/x");
    expect((init as RequestInit).method).toBe("GET");
  });

  it("GET carries no extra headers (no token, no content-type)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await api("/api/x");
    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-sinapso-token"]).toBeUndefined();
    expect(headers["content-type"]).toBeUndefined();
  });

  it("returns null for a 204 No Content", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 204 }));
    const result = await api("/api/x");
    expect(result).toBeNull();
  });
});

describe("api: non-OK", () => {
  it("throws ApiError with status and parsed JSON body", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 400, body: { error: "bad" } }),
    );
    let caught: unknown;
    try {
      await api("/api/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: "bad" });
    expect(err.name).toBe("ApiError");
  });

  it("keeps a non-JSON error body as text", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: false,
        status: 500,
        body: "oops",
        contentType: "text/plain",
      }),
    );
    let caught: unknown;
    try {
      await api("/api/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(500);
    expect(err.body).toBe("oops");
  });

  it("non-OK with empty body carries body=null", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 503, body: null }),
    );
    let caught: unknown;
    try {
      await api("/api/x");
    } catch (e) {
      caught = e;
    }
    expect((caught as ApiError).body).toBeNull();
  });
});

describe("api: token memoization", () => {
  it("first mutating call fetches /api/session once", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { ok: true } }));
    await api("/api/foo", { json: { a: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/session");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/foo");
  });

  it("second mutating call does NOT re-fetch /api/session", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await api("/api/a", { json: {} });
    await api("/api/b", { json: {} });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sessionCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/session",
    );
    expect(sessionCalls.length).toBe(1);
  });

  it("concurrent mutating calls share one /api/session fetch", async () => {
    let resolveSession: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((res) => {
          resolveSession = res;
        }),
    );
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    const p1 = api("/api/a", { json: {} });
    const p2 = api("/api/b", { json: {} });
    resolveSession(makeResponse({ body: { token: "t1" } }));
    await Promise.all([p1, p2]);
    const sessionCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/session",
    );
    expect(sessionCalls.length).toBe(1);
  });
});

describe("api: mutating call shape", () => {
  it("carries content-type, x-sinapso-token, and stringified body", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await api("/api/foo", { json: { a: 1, b: "x" } });
    const [, init] = fetchMock.mock.calls[1];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-sinapso-token"]).toBe("t1");
    expect((init as RequestInit).body).toBe(JSON.stringify({ a: 1, b: "x" }));
  });

  it("default method is POST when json is provided", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await api("/api/foo", { json: {} });
    const [, init] = fetchMock.mock.calls[1];
    expect((init as RequestInit).method).toBe("POST");
  });

  it("opts.method overrides the default (PUT keeps json+token+content-type)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await api("/api/foo", { json: { a: 1 }, method: "PUT" });
    const [path, init] = fetchMock.mock.calls[1];
    expect(path).toBe("/api/foo");
    expect((init as RequestInit).method).toBe("PUT");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-sinapso-token"]).toBe("t1");
    expect((init as RequestInit).body).toBe(JSON.stringify({ a: 1 }));
  });

  it("DELETE carries the token but no body or content-type", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await api("/api/x", { method: "DELETE" });
    const [, init] = fetchMock.mock.calls[1];
    expect((init as RequestInit).method).toBe("DELETE");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-sinapso-token"]).toBe("t1");
    expect(headers["content-type"]).toBeUndefined();
    expect((init as RequestInit).body).toBeUndefined();
  });
});

describe("api: token overrides", () => {
  it("explicit token: true forces a session fetch for GET", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await api("/api/x", { token: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-sinapso-token"]).toBe("t1");
  });

  it("refreshes a stale token once after a 403", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "old" } }));
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 403, body: { error: "bad token" } }),
    );
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "new" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { ok: true } }));

    await expect(api("/api/x", { token: true })).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/session");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/session");
    expect(
      (
        (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<
          string,
          string
        >
      )["x-sinapso-token"],
    ).toBe("old");
    expect(
      (
        (fetchMock.mock.calls[3][1] as RequestInit).headers as Record<
          string,
          string
        >
      )["x-sinapso-token"],
    ).toBe("new");
  });

  it("explicit token: false skips the token for a mutating method", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await api("/api/x", { json: {}, token: false });
    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-sinapso-token"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });
});

describe("api: custom headers", () => {
  it("merges opts.headers with the default content-type", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await api("/api/x", { json: {}, headers: { "x-custom": "1" } });
    const [, init] = fetchMock.mock.calls[1];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-custom"]).toBe("1");
  });
});

describe("apiRaw", () => {
  it("returns the Response from fetch unchanged", async () => {
    const expected = makeResponse({ body: { x: 1 } });
    fetchMock.mockResolvedValueOnce(expected);
    const got = await apiRaw("/api/x");
    expect(got).toBe(expected);
  });

  it("does NOT add x-sinapso-token by default", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await apiRaw("/api/x");
    expect(fetchMock).toHaveBeenCalledWith("/api/x", undefined);
  });

  it("with token: true adds x-sinapso-token to the headers", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await apiRaw("/api/x", { token: true });
    const [, init] = fetchMock.mock.calls[1];
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get("x-sinapso-token")).toBe("t1");
  });

  it("preserves caller-supplied headers when adding the token", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "t1" } }));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    await apiRaw("/api/x", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new ArrayBuffer(0),
      token: true,
    });
    const [, init] = fetchMock.mock.calls[1];
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("x-sinapso-token")).toBe("t1");
  });
});

describe("getApiToken", () => {
  it("fetches /api/session and returns the token", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "abc" } }));
    const t = await getApiToken();
    expect(t).toBe("abc");
  });

  it("memoizes after the first call (no second /api/session fetch)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { token: "abc" } }));
    await getApiToken();
    await getApiToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
