import { describe, expect, it } from "vitest";
import {
  buildVoiceSystemPrompt,
  realtimeSessionConfig,
  realtimeVoiceTools,
  resamplePcm16Base64,
  voiceNameForProvider,
} from "./voice";
import { defaultConfig } from "./config";

describe("voice system prompt", () => {
  it("injects Admin wiki routes and contract paths", () => {
    const cfg = defaultConfig();
    cfg.prompts.voiceAssistant = "Custom voice rule.";
    const prompt = buildVoiceSystemPrompt(cfg, [
      {
        id: "agencia/wiki",
        label: "agencia/wiki",
        path: "agencia/wiki",
        enabled: true,
        rawDestination: "../research/",
        contractFiles: ["AGENTS.md", "index.md"],
      },
    ]);

    expect(prompt).toContain("Custom voice rule.");
    expect(prompt).toContain("id=agencia/wiki");
    expect(prompt).toContain("raw=../research/");
    expect(prompt).toContain("agencia/wiki/AGENTS.md");
    expect(prompt).toContain("read that wiki's contract files");
    expect(prompt).toContain("selectedContext.current");
    expect(prompt).toContain("Archive destination from Admin: archive");
    expect(prompt).toContain("archive_vault_note");
  });
});

describe("voice provider helpers", () => {
  it("keeps official voices and falls back per provider", () => {
    expect(voiceNameForProvider("gemini", "Puck")).toBe("Puck");
    expect(voiceNameForProvider("gemini", "bogus")).toBe("Aoede");
    expect(voiceNameForProvider("openai", "cedar")).toBe("cedar");
    expect(voiceNameForProvider("openai", "bogus")).toBe("marin");
    expect(voiceNameForProvider("xai", "rex")).toBe("rex");
    expect(voiceNameForProvider("xai", "bogus")).toBe("eve");
  });

  it("maps Gemini tool declarations to realtime function tools", () => {
    const currentView = realtimeVoiceTools().find(
      (tool) => tool.name === "current_view",
    );
    expect(currentView?.type).toBe("function");
    expect(currentView?.parameters).toMatchObject({ type: "object" });
  });

  it("uses provider-specific realtime session shapes", () => {
    expect(
      realtimeSessionConfig("openai", "gpt-realtime-2.1", "marin", "s"),
    ).toMatchObject({
      audio: {
        input: { turn_detection: { type: "server_vad" } },
        output: { voice: "marin" },
      },
    });
    expect(
      realtimeSessionConfig("xai", "grok-voice-latest", "eve", "s"),
    ).toMatchObject({
      voice: "eve",
      turn_detection: { type: "server_vad" },
    });
  });

  it("resamples browser PCM16 chunks for realtime providers", () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(-1000, 0);
    input.writeInt16LE(1000, 2);
    const out = Buffer.from(resamplePcm16Base64(input.toString("base64"), 16000, 24000), "base64");
    expect(out.length).toBe(6);
  });
});
