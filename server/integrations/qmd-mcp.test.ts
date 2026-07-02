import { describe, it, expect } from "vitest";
import { createQmdMcp, type McpProc } from "./qmd-mcp";

const BIN = "/fake/bin/qmd";

class FakeMcpProc implements McpProc {
  written: string[] = [];
  dataHandlers: Array<(c: string) => void> = [];
  exitHandlers: Array<(a?: unknown) => void> = [];
  errorHandlers: Array<(a?: unknown) => void> = [];
  killed = false;
  autoRespond: boolean;

  constructor(autoRespond = true) {
    this.autoRespond = autoRespond;
  }
  stdin = {
    write: (s: string) => {
      this.written.push(s);
      if (!this.autoRespond) return;
      const msg = JSON.parse(s);
      if (msg.method === "initialize") {
        this.reply({
          jsonrpc: "2.0",
          id: msg.id,
          result: { serverInfo: { name: "qmd" } },
        });
      } else if (msg.method === "tools/call") {
        this.reply({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: "..." }],
            structuredContent: {
              results: [
                {
                  docid: "#1",
                  file: "notes/a.md",
                  title: "A",
                  score: 0.9,
                  snippet: "s1",
                },
                { docid: "#2", file: "docs/b.md", title: "B", score: 0.5 },
                { docid: "#3", title: "no file, dropped" },
              ],
            },
          },
        });
      }
    },
  };
  stdout = {
    on: (_ev: "data", fn: (c: string) => void) => {
      this.dataHandlers.push(fn);
    },
  };
  on(ev: "exit" | "error", fn: (a?: unknown) => void) {
    (ev === "exit" ? this.exitHandlers : this.errorHandlers).push(fn);
  }
  kill() {
    this.killed = true;
  }
  reply(msg: object) {
    // async like a real pipe, and split across chunks to exercise buffering
    const line = JSON.stringify(msg) + "\n";
    const mid = Math.floor(line.length / 2);
    setTimeout(() => {
      for (const fn of this.dataHandlers) fn(line.slice(0, mid));
      for (const fn of this.dataHandlers) fn(line.slice(mid));
    }, 0);
  }
  emitExit() {
    for (const fn of this.exitHandlers) fn(1);
  }
}

function spawner(autoRespond = true) {
  const procs: FakeMcpProc[] = [];
  return {
    procs,
    spawn: () => {
      const p = new FakeMcpProc(autoRespond);
      procs.push(p);
      return p;
    },
  };
}

describe("qmd mcp client", () => {
  it("handshakes, sends vec-typed scoped queries, maps structured results", async () => {
    const { procs, spawn } = spawner();
    const mcp = createQmdMcp({ spawn, callTimeoutMs: 1000 });
    const hits = await mcp.vquery(BIN, "storytelling\n tips", 5, [
      "notes",
      "docs",
    ]);

    const msgs = procs[0].written.map((w) => JSON.parse(w));
    expect(msgs[0].method).toBe("initialize");
    expect(msgs[0].params.protocolVersion).toBe("2025-06-18");
    expect(msgs[1].method).toBe("notifications/initialized");
    const call = msgs.find((m) => m.method === "tools/call");
    expect(call.params.name).toBe("query");
    expect(call.params.arguments.searches).toEqual([
      { type: "vec", query: "storytelling tips" }, // whitespace squashed
    ]);
    expect(call.params.arguments.rerank).toBe(false);
    expect(call.params.arguments.collections).toEqual(["notes", "docs"]);
    expect(call.params.arguments.limit).toBe(5);

    // results normalized to the qmd:// form hitsToNodes expects; no-file rows dropped
    expect(hits).toEqual([
      { file: "qmd://notes/a.md", score: 0.9, title: "A", snippet: "s1" },
      { file: "qmd://docs/b.md", score: 0.5, title: "B", snippet: undefined },
    ]);
  });

  it("reuses the warm child across calls", async () => {
    const { procs, spawn } = spawner();
    const mcp = createQmdMcp({ spawn, callTimeoutMs: 1000 });
    await mcp.vquery(BIN, "one", 3);
    await mcp.vquery(BIN, "two", 3);
    expect(procs).toHaveLength(1);
    expect(mcp.running()).toBe(true);
  });

  it("respawns after a crash and rejects in-flight calls", async () => {
    const { procs, spawn } = spawner();
    const mcp = createQmdMcp({ spawn, callTimeoutMs: 1000 });
    await mcp.vquery(BIN, "one", 3);
    procs[0].emitExit();
    expect(mcp.running()).toBe(false);
    await mcp.vquery(BIN, "two", 3); // transparent respawn
    expect(procs).toHaveLength(2);
  });

  it("rejects (so callers fall back to CLI) when the child never answers", async () => {
    const { spawn } = spawner(false); // spawns but stays silent
    const mcp = createQmdMcp({ spawn, callTimeoutMs: 30 });
    await expect(mcp.vquery(BIN, "q", 3)).rejects.toThrow(/timed out/);
  });

  it("stop kills the child and clears state", async () => {
    const { procs, spawn } = spawner();
    const mcp = createQmdMcp({ spawn, callTimeoutMs: 1000 });
    await mcp.vquery(BIN, "one", 3);
    mcp.stop();
    expect(procs[0].killed).toBe(true);
    expect(mcp.running()).toBe(false);
  });
});
