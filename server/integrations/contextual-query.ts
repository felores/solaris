import { DEFAULT_MODEL, chatCompletion, type OpenRouterOptions } from "./openrouter.js";

export interface ContextualQueryResult {
  effectiveQuery: string;
  contextApplied: boolean;
  contextRewriteSource: "none" | "openrouter" | "fallback";
  contextWarning: string | null;
}

type Chat = typeof chatCompletion;

interface BuildOpts {
  openrouterKey?: string | null;
  model?: string | null;
  openrouter?: OpenRouterOptions;
  chat?: Chat;
}

interface Slot {
  source: "reader" | "research";
  text: string;
  label: string;
  truncated?: boolean;
}

const MAX_QUERY_CHARS = 1200;

const clean = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

function slot(raw: unknown): Slot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const source = r.source === "reader" || r.source === "research" ? r.source : null;
  const text = clean(r.text);
  if (!source || !text) return null;
  const label = source === "reader"
    ? clean(r.noteTitle) || clean(r.noteId) || "reader selection"
    : clean(r.title) || clean(r.query) || clean(r.url) || "research selection";
  return { source, text, label, truncated: r.truncated === true };
}

export function selectedSlots(contexts: unknown): Slot[] {
  if (!contexts || typeof contexts !== "object") return [];
  const c = contexts as Record<string, unknown>;
  const current = slot(c.current);
  return current ? [current] : [];
}

function clamp(s: string): string {
  return s.length > MAX_QUERY_CHARS ? s.slice(0, MAX_QUERY_CHARS).trim() : s;
}

export function fallbackContextQuery(query: string, contexts: unknown): string {
  const slots = selectedSlots(contexts);
  if (!slots.length) return query;
  return clamp(
    [
      query,
      ...slots.map(
        (s) => [
          `${s.source === "reader" ? "Reader" : "Research"} (${s.label})`,
          `Selected text: ${s.text}`,
        ].filter(Boolean).join("\n"),
      ),
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

function parseRewrite(raw: string): string | null {
  const body = raw.replace(/^```json\s*|```$/g, "").trim();
  try {
    const parsed = JSON.parse(body) as { query?: unknown };
    const q = clean(parsed.query);
    return q ? clamp(q) : null;
  } catch {
    return null;
  }
}

export async function buildContextualQuery(
  query: string,
  contexts: unknown,
  opts: BuildOpts = {},
): Promise<ContextualQueryResult> {
  const slots = selectedSlots(contexts);
  if (!slots.length) {
    return {
      effectiveQuery: query,
      contextApplied: false,
      contextRewriteSource: "none",
      contextWarning: null,
    };
  }
  const warning = slots.some((s) => s.truncated)
    ? "Selected context was trimmed before research."
    : null;
  if (opts.openrouterKey) {
    try {
      const ask = [
        "Rewrite the user's web research query using the selected context.",
        "Return only JSON: {\"query\":\"...\"}.",
        `User query: ${query}`,
        ...slots.map((s) => [
          `Selected ${s.source}: ${s.label}`,
          `Selected text: ${s.text}`,
        ].filter(Boolean).join("\n")),
      ].join("\n\n");
      const raw = await (opts.chat ?? chatCompletion)(
        opts.openrouterKey,
        opts.model || DEFAULT_MODEL,
        [
          { role: "system", content: "You produce concise web search queries." },
          { role: "user", content: ask },
        ],
        opts.openrouter,
      );
      const rewritten = parseRewrite(raw);
      if (rewritten) {
        return {
          effectiveQuery: rewritten,
          contextApplied: true,
          contextRewriteSource: "openrouter",
          contextWarning: warning,
        };
      }
    } catch {
      // Fall through to deterministic local query. Web search still remains explicit.
    }
  }
  return {
    effectiveQuery: fallbackContextQuery(query, contexts),
    contextApplied: true,
    contextRewriteSource: "fallback",
    contextWarning: warning,
  };
}
