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
      snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 500),
      publishedDate:
        typeof r.publishedDate === "string" ? r.publishedDate : null,
      author: typeof r.author === "string" ? r.author : null,
      score: typeof r.score === "number" ? r.score : null,
    });
  }
  return out;
}

export function createExaAdapter(opts: ExaAdapterOptions = {}) {
  const makeClient =
    opts.makeClient ?? ((key: string) => new Exa(key) as ExaClientLike);
  const delays = opts.retryDelays ?? [500, 1500];

  return async function research(
    key: string,
    query: string,
    options: { deep?: boolean; numResults?: number } = {},
  ): Promise<ResearchResult[]> {
    const client = makeClient(key);
    const request: Record<string, unknown> = options.deep
      ? { type: "deep", contents: { highlights: true } }
      : {
          type: "auto",
          numResults: options.numResults ?? 8,
          contents: { highlights: true },
        };
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return mapResponse(await client.search(query, request));
      } catch (e) {
        lastErr = e;
        if (!transient(e) || attempt === delays.length) break;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
    throw lastErr;
  };
}
