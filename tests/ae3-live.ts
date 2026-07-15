/**
 * AE3 end-to-end driver: temp vault + real voice relay + real Gemini live
 * session + real thinker completion. A synthesized speech turn asks the
 * assistant to delegate; we observe the delegate status, the job's real
 * OpenRouter call (request-level model evidence), the open_research action,
 * and post-completion audio (the spoken heads-up).
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "../server/app.js";
import { updateConfig } from "../server/integrations/config.js";

const SP = process.argv[2];
const real = JSON.parse(
  readFileSync(join(homedir(), ".sinapso", "config.json"), "utf-8"),
);
if (!real?.voice?.keys?.gemini || !real?.openrouterKey) {
  console.error("missing gemini/openrouter keys");
  process.exit(2);
}

const ROOT = mkdtempSync(join(tmpdir(), "sinapso-ae3-"));
const VAULT = join(ROOT, "vault");
mkdirSync(VAULT, { recursive: true });
writeFileSync(
  join(VAULT, "garden.md"),
  "# Garden\n\nA garden grows through tending, pruning, and patient cycles of seasons.\n",
);
writeFileSync(
  join(VAULT, "stars.md"),
  "# Stars\n\nStars form in clouds of dust, burn through fusion, and seed the next generation.\n",
);
const graphPath = join(ROOT, "graph.json");
writeFileSync(
  graphPath,
  JSON.stringify({
    meta: { vaultName: "t", vaultPath: VAULT, notes: 2, excludes: [] },
    nodes: [
      { id: "garden.md", title: "Garden" },
      { id: "stars.md", title: "Stars" },
    ],
    links: [],
  }),
);
const configPath = join(ROOT, "config.json");
updateConfig(
  {
    openrouterKey: real.openrouterKey,
    thinkerProvider: "openrouter",
    thinkerModel: "deepseek/deepseek-v4-flash",
    voice: {
      provider: "gemini",
      voice: "Charon",
      keys: { gemini: real.voice.keys.gemini },
    },
  },
  configPath,
);

// Request-level evidence: log every chat-completion request body's model.
const llmModels: string[] = [];
const loggingFetch = (async (input: unknown, init?: RequestInit) => {
  if (String(input).includes("/chat/completions") && init?.body) {
    try {
      llmModels.push(JSON.parse(String(init.body)).model);
    } catch {}
  }
  return fetch(input as never, init as never);
}) as typeof fetch;

const { app, attachVoice } = createApp(graphPath, undefined, {
  configPath,
  openrouter: { fetch: loggingFetch },
});
const server = createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
attachVoice(server);
const a = server.address();
const port = typeof a === "object" && a ? a.port : 0;
const token = (
  await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()
).token;

function pcmChunks(wavPath: string): string[] {
  const buf = readFileSync(wavPath).subarray(44); // skip WAV header
  const chunks: string[] = [];
  for (
    let i = 0;
    i < buf.length;
    i += 6400 // 200ms @16kHz mono 16-bit
  )
    chunks.push(buf.subarray(i, i + 6400).toString("base64"));
  return chunks;
}

const events: string[] = [];
let audioBytes = 0;
let delegated = false;
let openedResearch = false;
let audioAfterCompletion = 0;
let completionSeen = false;

const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/ws?token=${token}`);
const done = new Promise<void>((resolve) => {
  const timer = setTimeout(() => resolve(), 150000);
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === "audio") {
      audioBytes += m.data.length;
      if (completionSeen) audioAfterCompletion += m.data.length;
      return;
    }
    events.push(JSON.stringify(m).slice(0, 160));
    if (m.type === "status" && m.key === "voice.status.delegating")
      delegated = true;
    if (m.type === "action" && m.action === "open_research") {
      openedResearch = true;
      completionSeen = true;
    }
    if (m.type === "error") {
      console.error("WS error:", m.message);
      clearTimeout(timer);
      resolve();
    }
    if (openedResearch && audioAfterCompletion > 5000) {
      clearTimeout(timer);
      setTimeout(resolve, 3000);
    }
  });
  ws.on("close", () => {
    clearTimeout(timer);
    resolve();
  });
});

ws.on("open", async () => {
  events.push("ws open, waiting for ready");
});
const SILENCE = Buffer.alloc(6400).toString("base64");
let streaming = true;
ws.on("message", async (data) => {
  const m = JSON.parse(data.toString());
  if (m.type === "ready") {
    // stream the ask turn as real-time-ish audio, then keep the "mic" open
    // with silence so server-side VAD can close the turn (a real mic never
    // stops streaming).
    for (const c of pcmChunks(join(SP, "ask.wav"))) {
      if (!streaming) return;
      ws.send(JSON.stringify({ type: "audio", data: c }));
      await new Promise((r) => setTimeout(r, 100));
    }
    while (streaming && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "audio", data: SILENCE }));
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

await done;
streaming = false;
// research history should hold the thinker document (read before teardown)
const hist = (await (
  await fetch(`http://127.0.0.1:${port}/api/research/history`)
)
  .json()
  .catch(() => ({}))) as {
  entries?: Array<{ mode: string; document?: { title?: string } }>;
};
ws.close();

console.log("--- AE3 result ---");
console.log("delegating status seen:", delegated);
console.log("llm models called:", JSON.stringify(llmModels));
console.log("open_research (completed doc opened):", openedResearch);
console.log(
  "audio after completion (spoken heads-up bytes):",
  audioAfterCompletion,
);
console.log("total audio bytes:", audioBytes);
console.log("events:", events.join("\n  "));
const doc = (hist.entries ?? []).find((e) => e.mode === "document");
console.log("working document present:", !!doc, doc?.document?.title ?? "");
server.close();
process.exit(
  delegated &&
    openedResearch &&
    llmModels.includes("deepseek/deepseek-v4-flash")
    ? 0
    : 1,
);
