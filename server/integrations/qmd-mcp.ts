/**
 * Warm qmd client (F015): a persistent `qmd mcp` child speaking JSON-RPC
 * over stdio (MCP protocol 2025-06-18, newline-delimited). The embedding
 * model and SQLite index load once per Solaris session, so vector queries
 * drop from 5-9s (per-spawn CLI) to ~0.2s warm.
 *
 * Grounded against qmd mcp 2.6.3: tools/call "query" with typed sub-queries
 * ({type:"vec"} = pure vector, no LLM expansion), `collections` scoping,
 * `rerank:false` for speed, and result.structuredContent.results carrying
 * {docid, file: "collection/relpath", title, score, snippet}.
 *
 * Callers treat any failure here as "fall back to the CLI spawn path".
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { QmdHit } from "./qmd.js";

const CALL_TIMEOUT_MS = 60_000; // first call loads the embedding model

export interface McpProc {
  stdin: { write(s: string): void } | null;
  stdout: { on(ev: "data", fn: (chunk: Buffer | string) => void): void } | null;
  on(ev: "exit" | "error", fn: (arg?: unknown) => void): void;
  kill(): void;
}

export interface QmdMcpDeps {
  spawn: (cmd: string, args: string[]) => McpProc;
  callTimeoutMs: number;
}

function realDeps(): QmdMcpDeps {
  return {
    spawn: (cmd, args) =>
      nodeSpawn(cmd, args, {
        stdio: ["pipe", "pipe", "ignore"],
      }) as unknown as McpProc,
    callTimeoutMs: CALL_TIMEOUT_MS,
  };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createQmdMcp(overrides: Partial<QmdMcpDeps> = {}) {
  const deps: QmdMcpDeps = { ...realDeps(), ...overrides };

  let proc: McpProc | null = null;
  let ready: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function teardown(reason: string) {
    proc = null;
    ready = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
  }

  function send(msg: Record<string, unknown>) {
    proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  function request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`qmd mcp: ${method} timed out`));
      }, deps.callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function boot(bin: string): Promise<void> {
    const child = deps.spawn(bin, ["mcp"]);
    proc = child;
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // stray log line
        }
        if (typeof msg.id !== "number") continue; // notification
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error)
          p.reject(new Error(msg.error.message ?? "qmd mcp error"));
        else p.resolve(msg.result);
      }
    });
    child.on("exit", () => {
      if (proc === child) teardown("qmd mcp exited");
    });
    child.on("error", (e) => {
      if (proc === child)
        teardown(`qmd mcp spawn failed: ${e instanceof Error ? e.message : e}`);
    });
    return request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "solaris", version: "1.0" },
    }).then(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    });
  }

  async function ensureReady(bin: string): Promise<void> {
    if (proc && ready) return ready;
    ready = boot(bin).catch((e) => {
      teardown(e instanceof Error ? e.message : String(e));
      throw e;
    });
    return ready;
  }

  return {
    running: () => !!proc,

    /** Pure vector query via the warm child; throws so callers can fall back. */
    async vquery(
      bin: string,
      query: string,
      limit: number,
      collections?: string[],
    ): Promise<QmdHit[]> {
      await ensureReady(bin);
      const args: Record<string, unknown> = {
        searches: [{ type: "vec", query: query.replace(/\s+/g, " ").trim() }],
        limit,
        rerank: false,
      };
      if (collections?.length) args.collections = collections;
      const result = (await request("tools/call", {
        name: "query",
        arguments: args,
      })) as {
        isError?: boolean;
        structuredContent?: { results?: unknown[] };
      };
      if (result?.isError) throw new Error("qmd mcp query returned an error");
      const rows = result?.structuredContent?.results;
      if (!Array.isArray(rows))
        throw new Error("qmd mcp: no structured results");
      const hits: QmdHit[] = [];
      for (const r of rows as Array<Record<string, unknown>>) {
        if (typeof r?.file !== "string") continue;
        hits.push({
          // MCP reports "collection/relpath"; normalize to the qmd:// form
          // the existing hitsToNodes mapper expects.
          file: `qmd://${r.file}`,
          score: typeof r.score === "number" ? r.score : 0,
          title: typeof r.title === "string" ? r.title : undefined,
          snippet: typeof r.snippet === "string" ? r.snippet : undefined,
        });
      }
      return hits;
    },

    stop() {
      const p = proc;
      teardown("stopped");
      p?.kill();
    },
  };
}

export type QmdMcp = ReturnType<typeof createQmdMcp>;
