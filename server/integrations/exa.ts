/**
 * Exa adapter (U6, KTD4): thin server-side layer isolating exa-js's request
 * shape, which renamed parameters twice in the last 12 months. Nothing
 * outside this module builds Exa requests or reads raw Exa responses.
 *
 * Grounded against exa-js dist types (2026-07): search(query, options) with
 * effort-based type ("auto" default here; deep variants opt-in), contents
 * limited to highlights for cost, results carrying title/url/highlights.
 * Defensive retry with backoff: rate limits are undocumented.
 */

import Exa from "exa-js";

export interface ExaClientLike {
  search(query: string, options: Record<string, unknown>): Promise<unknown>;
  /** Full-text fetch for one or more URLs (Exa /contents). Optional so the
   *  research-only mocks don't have to implement it. */
  getContents?(
    urls: string[],
    options: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ResearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate: string | null;
  author: string | null;
  score: number | null;
}

export interface ExaAdapterOptions {
  makeClient?: (key: string) => ExaClientLike;
  /** Backoff between retries; injectable so tests run in ms. */
  retryDelays?: number[];
}

function transient(e: unknown): boolean {
  const status = (e as { statusCode?: number })?.statusCode;
  if (status === undefined) return true; // network-level failure
  return status === 429 || status >= 500;
}

function mapResponse(raw: unknown): ResearchResult[] {
  const results = (raw as { results?: unknown[] })?.results ?? [];
  const out: ResearchResult[] = [];
  for (const r of results as Array<Record<string, unknown>>) {
    if (typeof r?.url !== "string") continue;
    const highlights = Array.isArray(r.highlights)
      ? (r.highlights as unknown[]).filter(
          (h): h is string => typeof h === "string",
        )
      : [];
    const snippet = highlights.length
      ? highlights.join(" … ")
      : typeof r.text === "string"
        ? r.text
        : "";
    out.push({
      title: typeof r.title === "string" && r.title ? r.title : r.url,
      url: r.url,
      snippet: snippet.replace(/\s+/g, " ").trim(),
      publishedDate:
        typeof r.publishedDate === "string" ? r.publishedDate : null,
      author: typeof r.author === "string" ? r.author : null,
      score: typeof r.score === "number" ? r.score : null,
    });
  }
  return out;
}

export interface ResearchAnswer {
  content: string;
  citations: Array<{ url: string; title: string }>;
}

export interface ResearchResponse {
  results: ResearchResult[];
  /** Synthesized answer with grounded citations; deep mode only (F020). */
  answer: ResearchAnswer | null;
}

/** Flatten grounding citations from a deep response, deduped by url. */
function mapAnswer(raw: unknown): ResearchAnswer | null {
  const output = (
    raw as { output?: { content?: unknown; grounding?: unknown } }
  )?.output;
  if (!output || typeof output.content !== "string" || !output.content.trim())
    return null;
  const seen = new Set<string>();
  const citations: Array<{ url: string; title: string }> = [];
  if (Array.isArray(output.grounding)) {
    for (const g of output.grounding as Array<{ citations?: unknown }>) {
      if (!Array.isArray(g?.citations)) continue;
      for (const c of g.citations as Array<{
        url?: unknown;
        title?: unknown;
      }>) {
        if (typeof c?.url !== "string" || seen.has(c.url)) continue;
        seen.add(c.url);
        citations.push({
          url: c.url,
          title: typeof c.title === "string" && c.title ? c.title : c.url,
        });
      }
    }
  }
  return { content: output.content, citations };
}

export function createExaAdapter(opts: ExaAdapterOptions = {}) {
  const makeClient =
    opts.makeClient ?? ((key: string) => new Exa(key) as ExaClientLike);
  const delays = opts.retryDelays ?? [500, 1500];

  return async function research(
    key: string,
    query: string,
    options: { deep?: boolean; numResults?: number } = {},
  ): Promise<ResearchResponse> {
    const client = makeClient(key);
    // Deep mode asks for a synthesized text answer (output.content +
    // grounding citations); fast mode stays raw results only.
    const request: Record<string, unknown> = options.deep
      ? {
          type: "deep",
          outputSchema: { type: "text" },
          contents: { highlights: true },
        }
      : {
          type: "auto",
          numResults: options.numResults ?? 8,
          contents: { highlights: true },
        };
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const raw = await client.search(query, request);
        return {
          results: mapResponse(raw),
          answer: options.deep ? mapAnswer(raw) : null,
        };
      } catch (e) {
        lastErr = e;
        if (!transient(e) || attempt === delays.length) break;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
    throw lastErr;
  };
}

export interface ArticleResult {
  url: string;
  title: string;
  content: string;
  publishedDate: string | null;
  author: string | null;
}

function mapArticle(raw: unknown, url: string): ArticleResult {
  const r = ((raw as { results?: unknown[] })?.results ?? [])[0] as
    | Record<string, unknown>
    | undefined;
  const text = typeof r?.text === "string" ? r.text : "";
  return {
    url: typeof r?.url === "string" && r.url ? r.url : url,
    title: typeof r?.title === "string" && r.title ? r.title : url,
    content: text.replace(/\n{3,}/g, "\n\n").trim(),
    publishedDate:
      typeof r?.publishedDate === "string" ? r.publishedDate : null,
    author: typeof r?.author === "string" ? r.author : null,
  };
}

/** Full-text fetch of one URL via Exa /contents (spend-bearing). Same retry
 *  shape as research; the raw request stays behind this adapter. */
export function createArticleFetcher(opts: ExaAdapterOptions = {}) {
  const makeClient =
    opts.makeClient ?? ((key: string) => new Exa(key) as ExaClientLike);
  const delays = opts.retryDelays ?? [500, 1500];

  return async function fetchArticle(
    key: string,
    url: string,
  ): Promise<ArticleResult> {
    const client = makeClient(key);
    if (!client.getContents) throw new Error("exa client lacks getContents");
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const raw = await client.getContents([url], { text: true });
        return mapArticle(raw, url);
      } catch (e) {
        lastErr = e;
        if (!transient(e) || attempt === delays.length) break;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
    throw lastErr;
  };
}
