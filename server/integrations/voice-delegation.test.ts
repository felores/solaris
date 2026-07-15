/**
 * Bridge-level delegation wiring (U7, KTD5): drives wireDelegation with the
 * real delegate manager and a faked session, covering AE3/F1 (interim ack →
 * scheduled INTERRUPT response), the spoken-error variant (R14), and the
 * degraded non-async path (R13).
 */
import { describe, it, expect, vi } from "vitest";
import {
  geminiToolDeclarations,
  realtimeVoiceTools,
  wireDelegation,
} from "./voice";
import { createDelegateManager, type DelegateJob } from "./delegate";
import { VOICE_TOOLS } from "./voice-tools";
import { defaultConfig } from "./config";
import { geminiLiveModel } from "./voice";

function stubManager() {
  const subs = new Map<string, Array<(job: DelegateJob) => void>>();
  return {
    manager: {
      start: () => ({ error: "unused", status: 400 }),
      status: () => null,
      subscribe(sessionId: string, cb: (job: DelegateJob) => void) {
        const list = subs.get(sessionId) ?? [];
        list.push(cb);
        subs.set(sessionId, list);
        return () => {};
      },
    },
    fire(sessionId: string, job: Partial<DelegateJob>) {
      for (const cb of subs.get(sessionId) ?? [])
        cb({
          id: "job-1",
          sessionId,
          state: "succeeded",
          task: "t",
          documentId: "doc-1",
          title: "Doc",
          error: null,
          startedAt: 0,
          finishedAt: 1,
          ...job,
        });
    },
  };
}

describe("wireDelegation (faked session)", () => {
  it("sends an INTERRUPT-scheduled function response on completion (AE3/F1)", () => {
    const { manager, fire } = stubManager();
    const send = vi.fn();
    const sendToolResponse = vi.fn();
    const relay = wireDelegation({
      delegate: manager,
      sessionId: "s1",
      asyncCapable: true,
      send,
      sendToolResponse,
    });
    relay.noteCall({ id: "fc-9", name: "delegate_to_thinker" });
    fire("s1", { state: "succeeded" });
    expect(sendToolResponse).toHaveBeenCalledTimes(1);
    const fr = sendToolResponse.mock.calls[0][0].functionResponses[0];
    expect(fr.id).toBe("fc-9");
    expect(fr.name).toBe("delegate_to_thinker");
    expect((fr.response as { scheduling: string }).scheduling).toBe(
      "INTERRUPT",
    );
    expect((fr.response as { result: string }).result).toContain("finished");
    // the finished document opens in the research panel
    expect(send).toHaveBeenCalledWith({
      type: "action",
      action: "open_research",
      id: "doc-1",
    });
  });

  it("failure produces the spoken-error variant (R14)", () => {
    const { manager, fire } = stubManager();
    const sendToolResponse = vi.fn();
    const relay = wireDelegation({
      delegate: manager,
      sessionId: "s1",
      asyncCapable: true,
      send: vi.fn(),
      sendToolResponse,
    });
    relay.noteCall({ id: "fc-1", name: "delegate_to_thinker" });
    fire("s1", { state: "failed", error: "the reasoner timed out" });
    const fr = sendToolResponse.mock.calls[0][0].functionResponses[0];
    expect((fr.response as { error: string }).error).toContain("timed out");
    expect((fr.response as { scheduling: string }).scheduling).toBe(
      "INTERRUPT",
    );
  });

  it("non-async models get no scheduled response, only the browser signal (R13)", () => {
    const { manager, fire } = stubManager();
    const send = vi.fn();
    const sendToolResponse = vi.fn();
    const relay = wireDelegation({
      delegate: manager,
      sessionId: "s1",
      asyncCapable: false,
      send,
      sendToolResponse,
    });
    relay.noteCall({ id: "fc-1", name: "delegate_to_thinker" });
    fire("s1", { state: "succeeded" });
    expect(sendToolResponse).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: "status",
      key: "voice.status.delegateDone",
      state: "succeeded",
    });
  });

  it("ignores non-delegate calls and unsubscribes on dispose", () => {
    const mgr = createDelegateManager({
      fetchFn: (async () => new Response("{}")) as typeof fetch,
    });
    const sendToolResponse = vi.fn();
    const relay = wireDelegation({
      delegate: mgr,
      sessionId: "s1",
      asyncCapable: true,
      send: vi.fn(),
      sendToolResponse,
    });
    relay.noteCall({ id: "fc-1", name: "search_notes" });
    relay.dispose();
    expect(sendToolResponse).not.toHaveBeenCalled();
  });
});

describe("per-model tool declarations (KTD5)", () => {
  it("non-async models build declarations with no behavior field", () => {
    // Empirically the 3.1 default DOES support async FC; an unknown/legacy
    // model id exercises the plain-declaration path (KTD5 safety property).
    const tools = geminiToolDeclarations("gemini-live-some-older-model");
    expect(tools).toBe(VOICE_TOOLS);
    for (const t of tools)
      expect((t as { behavior?: string }).behavior).toBeUndefined();
    expect(tools.map((t) => t.name)).toContain("delegate_to_thinker");
  });

  it("async-capable models mark only the delegate tool NON_BLOCKING", () => {
    const tools = geminiToolDeclarations(
      "gemini-2.5-flash-native-audio-latest",
    );
    for (const t of tools) {
      const behavior = (t as { behavior?: string }).behavior;
      if (t.name === "delegate_to_thinker")
        expect(behavior).toBe("NON_BLOCKING");
      else expect(behavior).toBeUndefined();
    }
  });

  it("OpenAI/xAI realtime tool lists exclude the delegate tool (R11)", () => {
    const names = realtimeVoiceTools().map((t) => t.name);
    expect(names).not.toContain("delegate_to_thinker");
    expect(names).toContain("search_notes");
  });

  it("the live model config value resolves with the 3.1 default", () => {
    const cfg = defaultConfig();
    expect(geminiLiveModel(cfg)).toBe("gemini-3.1-flash-live-preview");
    cfg.voice.model = "gemini-2.5-flash-native-audio-latest";
    expect(geminiLiveModel(cfg)).toBe("gemini-2.5-flash-native-audio-latest");
    cfg.voice.model = "bogus-model";
    expect(geminiLiveModel(cfg)).toBe("gemini-3.1-flash-live-preview");
  });
});
