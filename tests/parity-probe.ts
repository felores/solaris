/** Live-model probe: session opens? audio? NON_BLOCKING tool accepted +
 * async completion round-trip works? Usage:
 *   npx tsx tests/parity-probe.ts <model> [--async] <voice...> */
import {
  GoogleGenAI,
  Modality,
  Behavior,
  FunctionResponseScheduling,
  Type,
} from "@google/genai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cfg = JSON.parse(
  readFileSync(join(homedir(), ".sinapso", "config.json"), "utf-8"),
);
const key = cfg?.voice?.keys?.gemini;
if (!key) {
  console.error("no gemini key");
  process.exit(2);
}
const args = process.argv.slice(2);
const model = args[0];
const asyncMode = args.includes("--async");
const voices = args.slice(1).filter((a) => a !== "--async");
const ai = new GoogleGenAI({ apiKey: key });

const TOOL = {
  name: "start_report",
  description:
    "Starts generating a background report. Call it when the user asks for a report.",
  parameters: {
    type: Type.OBJECT,
    properties: { topic: { type: Type.STRING } },
    required: ["topic"],
  },
  ...(asyncMode ? { behavior: Behavior.NON_BLOCKING } : {}),
};

async function probe(voice: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let audioBytes = 0;
    let phase: "setup" | "awaiting_call" | "awaiting_final" = "setup";
    let done = false;
    let sess: any = null;
    const finish = (msg: string) => {
      if (!done) {
        done = true;
        try {
          sess?.close();
        } catch {}
        resolve(msg);
      }
    };
    const timer = setTimeout(
      () => finish(`TIMEOUT phase=${phase} audio=${audioBytes}`),
      30000,
    );
    ai.live
      .connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
          ...(asyncMode ? { tools: [{ functionDeclarations: [TOOL] }] } : {}),
        },
        callbacks: {
          onopen: () => {},
          onmessage: (m: any) => {
            for (const part of m?.serverContent?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data)
                audioBytes += part.inlineData.data.length;
            }
            if (m?.setupComplete) {
              phase = asyncMode ? "awaiting_call" : "awaiting_final";
              sess?.sendClientContent({
                turns: [
                  {
                    role: "user",
                    parts: [
                      {
                        text: asyncMode
                          ? "Please start a report about the ocean using your tool."
                          : "Say the word OK and nothing else.",
                      },
                    ],
                  },
                ],
                turnComplete: true,
              });
            }
            const calls = m?.toolCall?.functionCalls;
            if (calls?.length && phase === "awaiting_call") {
              const fc = calls[0];
              // interim ack, then a scheduled INTERRUPT completion 3s later
              sess?.sendToolResponse({
                functionResponses: [
                  { id: fc.id, name: fc.name, response: { result: "started" } },
                ],
              });
              setTimeout(() => {
                phase = "awaiting_final";
                audioBytes = 0; // count only post-completion audio
                sess?.sendToolResponse({
                  functionResponses: [
                    {
                      id: fc.id,
                      name: fc.name,
                      response: {
                        result:
                          "The report is finished. Tell the user it is ready.",
                        scheduling: FunctionResponseScheduling.INTERRUPT,
                      },
                    },
                  ],
                });
              }, 6000);
            }
            if (
              m?.serverContent?.turnComplete &&
              phase === "awaiting_final" &&
              audioBytes > 0
            ) {
              clearTimeout(timer);
              finish(`PASS audio=${audioBytes}`);
            }
          },
          onerror: (e: any) => {
            clearTimeout(timer);
            finish(`ERROR ${String(e?.message ?? e).slice(0, 140)}`);
          },
          onclose: (e: any) => {
            clearTimeout(timer);
            if (!done)
              finish(`CLOSED ${String(e?.reason ?? "").slice(0, 140)}`);
          },
        },
      })
      .then((s) => {
        sess = s;
      })
      .catch((e) => {
        clearTimeout(timer);
        finish(`CONNECT_FAIL ${String(e?.message ?? e).slice(0, 140)}`);
      });
  });
}

async function main() {
  for (const v of voices)
    console.log(
      `${model}${asyncMode ? " [async-fc]" : ""} ${v}: ${await probe(v)}`,
    );
}
void main();
