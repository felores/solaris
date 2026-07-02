/**
 * OpenRouter adapter: thin server-side layer over the OpenRouter chat
 * completions API (OpenAI-compatible). The key never leaves the server;
 * the client only sees model ids and generated text.
 *
 * Grounded against https://openrouter.ai/docs/quickstart (2026-07):
 * POST {endpoint}/chat/completions with Authorization: Bearer <key>,
 * GET {endpoint}/models to list slugs.
 */

export type FetchLike = typeof fetch;

export interface OpenRouterOptions {
  fetch?: FetchLike;
  /** Override the API base (tests). */
  endpoint?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class OpenRouterError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

const BASE = "https://openrouter.ai/api/v1";

/** Send a chat completion; return the assistant message text. */
export async function chatCompletion(
  key: string,
  model: string,
  messages: ChatMessage[],
  opts: OpenRouterOptions = {},
): Promise<string> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${opts.endpoint ?? BASE}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new OpenRouterError(
      res.status,
      t.slice(0, 300) || `HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

export interface LlmModel {
  id: string;
  name: string;
}

/** List available models; the key stays server-side, ids only reach the client. */
export async function listModels(
  key: string,
  opts: OpenRouterOptions = {},
): Promise<LlmModel[]> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${opts.endpoint ?? BASE}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new OpenRouterError(res.status, `HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: Array<{ id?: string; name?: string }>;
  };
  return (data.data ?? [])
    .filter((m) => typeof m.id === "string")
    .map((m) => ({ id: m.id!, name: m.name ?? m.id! }));
}
