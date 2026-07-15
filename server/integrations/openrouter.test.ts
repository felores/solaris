import { describe, it, expect } from "vitest";
import {
  chatCompletion,
  listModels,
  OpenRouterError,
  validateKey,
} from "./openrouter";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("openrouter adapter", () => {
  it("returns the assistant text and targets the chat endpoint with the bearer key", async () => {
    let calledUrl = "";
    let calledAuth = "";
    const f = async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledAuth = (init!.headers as Record<string, string>).authorization;
      return json(200, {
        choices: [{ message: { content: '["a?","b?"]' } }],
      }) as Response;
    };
    const text = await chatCompletion(
      "secret-key",
      "deepseek/deepseek-v4-flash",
      [{ role: "user", content: "hi" }],
      { fetch: f as never },
    );
    expect(text).toBe('["a?","b?"]');
    expect(calledUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calledAuth).toBe("Bearer secret-key");
  });

  it("surfaces a non-OK response as OpenRouterError", async () => {
    const f = async () => json(401, "unauthorized") as Response;
    await expect(
      chatCompletion("bad", "m", [{ role: "user", content: "x" }], {
        fetch: f as never,
      }),
    ).rejects.toBeInstanceOf(OpenRouterError);
  });

  it("lists models as id/name pairs, falling back to id for name", async () => {
    const f = async () =>
      json(200, {
        data: [{ id: "z-ai/glm-5.2", name: "GLM 5.2" }, { id: "orphan" }],
      }) as Response;
    const models = await listModels("k", { fetch: f as never });
    expect(models).toEqual([
      { id: "z-ai/glm-5.2", name: "GLM 5.2" },
      { id: "orphan", name: "orphan" },
    ]);
  });

  it("validateKey hits GET /key and returns usage/limit for a valid key", async () => {
    let url = "";
    const f = async (u: string) => {
      url = u;
      return json(200, { data: { usage: 1.5, limit: 10 } }) as Response;
    };
    const s = await validateKey("k", { fetch: f as never });
    expect(url).toBe("https://openrouter.ai/api/v1/key");
    expect(s).toEqual({ ok: true, usage: 1.5, limit: 10 });
  });

  it("validateKey reports an invalid key on 401 without throwing", async () => {
    const f = async () => json(401, { error: "no" }) as Response;
    await expect(validateKey("bad", { fetch: f as never })).resolves.toEqual({
      ok: false,
    });
  });
});
