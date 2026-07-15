/**
 * Voice mode (browser side): capture the mic as 16 kHz PCM16, stream it to the
 * Sinapso voice relay over one WebSocket, and play back the 24 kHz PCM16 the
 * provider returns. The relay holds the API key and does the provider + tool
 * work; this file is only audio plumbing. Native-audio models do their own
 * turn-taking, so there is no VAD here — we just stream mic in, play audio out,
 * and clear the playback queue when the model says it was interrupted.
 */

export interface VoiceHandlers {
  onReady?: () => void; // provider session is live
  onClose?: () => void; // session ended (any reason)
  onError?: (message: string) => void;
  // the agent asked the UI to do something (open a note / research panel)
  onAction?: (
    action: string,
    payload: Record<string, unknown>,
  ) => void | Promise<void>;
  // tool-activity status line (searching, opening, writing, ...)
  onStatus?: (payload: Record<string, unknown>) => void;
}

export interface VoiceSession {
  stop(): void;
  sendContext(context: unknown): void;
  /** analyser nodes for the waveform visualizer; null when session not live */
  readonly micAnalyser: AnalyserNode | null;
  readonly agentAnalyser: AnalyserNode | null;
}

// AudioWorklet that turns each render quantum of Float32 mono into PCM16 and
// posts it to the main thread. Loaded from a Blob so there is no extra file.
const CAPTURE_WORKLET = `
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        let s = ch[i]; s = s < -1 ? -1 : s > 1 ? 1 : s;
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('cap', Cap);
`;

const b64encode = (buf: ArrayBuffer): string => {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};

const b64decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

/**
 * Open a voice session. Must be called from a user gesture (button click) so
 * the AudioContexts are allowed to start. Returns a handle with stop().
 */
export async function startVoice(
  token: string,
  handlers: VoiceHandlers = {},
): Promise<VoiceSession> {
  let closed = false;
  let stream: MediaStream | undefined;
  let captureCtx: AudioContext | undefined;
  let playCtx: AudioContext | undefined;
  let ws: WebSocket | undefined;
  let micAnalyser: AnalyserNode | undefined;
  let agentAnalyser: AnalyserNode | undefined;
  const sources = new Set<AudioBufferSourceNode>();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    sources.clear();
    stream?.getTracks().forEach((t) => {
      t.stop();
    });
    captureCtx?.close().catch(() => {});
    playCtx?.close().catch(() => {});
    handlers.onClose?.();
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // ---- playback (24 kHz), scheduled back-to-back ----
    playCtx = new AudioContext({ sampleRate: 24000 });
    await playCtx.resume().catch(() => {}); // created after an await → may start suspended
    // Single persistent analyser every playback source routes through, so all
    // agent audio is measured by one node (waveform visualizer tap).
    agentAnalyser = playCtx.createAnalyser();
    agentAnalyser.fftSize = 512;
    agentAnalyser.smoothingTimeConstant = 0.85;
    agentAnalyser.connect(playCtx.destination);
    let playhead = 0;
    const enqueue = (pcm: Int16Array) => {
      if (!playCtx || !pcm.length) return;
      const f32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
      const buf = playCtx.createBuffer(1, f32.length, 24000);
      buf.getChannelData(0).set(f32);
      const node = playCtx.createBufferSource();
      node.buffer = buf;
      node.connect(agentAnalyser!);
      const t = Math.max(playCtx.currentTime + 0.02, playhead);
      node.start(t);
      playhead = t + buf.duration;
      sources.add(node);
      node.onended = () => sources.delete(node);
    };
    const clearPlayback = () => {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* ignore */
        }
      }
      sources.clear();
      playhead = 0;
    };

    // ---- the relay socket ----
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(
      `${proto}://${location.host}/api/voice/ws?token=${encodeURIComponent(token)}`,
    );
    ws.onmessage = (e) => {
      let m: {
        type?: string;
        data?: string;
        message?: string;
        action?: string;
        key?: string;
      };
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === "audio" && m.data) {
        const bytes = b64decode(m.data);
        if (bytes.length % 2 === 0)
          enqueue(new Int16Array(bytes.buffer, 0, bytes.length / 2));
      } else if (m.type === "interrupted") {
        clearPlayback();
      } else if (m.type === "ready") {
        handlers.onReady?.();
      } else if (m.type === "action" && m.action) {
        handlers.onAction?.(m.action, m as Record<string, unknown>);
      } else if (m.type === "status" && m.key) {
        handlers.onStatus?.(m as Record<string, unknown>);
      } else if (m.type === "error") {
        handlers.onError?.(m.message ?? "voice error");
        cleanup();
      }
    };
    ws.onclose = cleanup;
    ws.onerror = () => handlers.onError?.("connection error");

    // ---- capture (16 kHz) → relay ----
    captureCtx = new AudioContext({ sampleRate: 16000 });
    await captureCtx.resume().catch(() => {}); // may start suspended after awaits
    const url = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: "application/javascript" }),
    );
    await captureCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const srcNode = captureCtx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(captureCtx, "cap");
    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "audio", data: b64encode(e.data) }));
    };
    // A muted sink keeps the graph "pulling" so the worklet actually runs,
    // without routing the mic to the speakers.
    const mute = captureCtx.createGain();
    mute.gain.value = 0;
    srcNode.connect(worklet);
    worklet.connect(mute);
    mute.connect(captureCtx.destination);
    // Waveform tap: analyse the mic alongside the worklet, routed through the
    // existing muted sink so the graph keeps pulling without reaching speakers.
    micAnalyser = captureCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.smoothingTimeConstant = 0.85;
    srcNode.connect(micAnalyser);
    micAnalyser.connect(mute);
  } catch (e) {
    handlers.onError?.(
      e instanceof Error ? e.message : "could not start voice",
    );
    cleanup();
  }

  return {
    stop: cleanup,
    sendContext(context: unknown) {
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "context", context }));
    },
    get micAnalyser() {
      return micAnalyser ?? null;
    },
    get agentAnalyser() {
      return agentAnalyser ?? null;
    },
  };
}
