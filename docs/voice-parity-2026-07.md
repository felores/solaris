# Voice-parity checklist — Gemini live models (recorded 2026-07-10)

Voice-model parity evidence from `tests/parity-probe.ts`, which opens a real
live session per voice, requests one audio reply, and counts audio bytes.

## Context: the plan's pinned model does not exist

`gemini-2.5-flash-live` is rejected by the API. The real 2.5 live line is
`gemini-2.5-flash-native-audio-latest`; the default remains
`gemini-3.1-flash-live-preview`.

The selectable second model is `gemini-2.5-flash-native-audio-latest`.

## Checklist: all 30 curated voices on `gemini-2.5-flash-native-audio-latest`

PASS (29/30): Aoede, Charon, Fenrir, Kore, Orus, Puck, Zephyr, Achernar*,
Achird, Algenib, Algieba, Alnilam, Autonoe, Callirrhoe, Despina, Enceladus*,
Erinome, Gacrux, Iapetus, Laomedeia, Pulcherrima, Rasalgethi*, Sadachbia,
Sadaltager, Schedar, Sulafat, Umbriel, Vindemiatrix, Zubenelgenubi.
(* = passed on retry; first attempt timed out.)

MISS (1/30): **Leda** — 0/4 attempts produced audio on the 2.5 model
(session opens, no speech). Leda works on the 3.1 default (control run
passed). Leda sessions stay on `gemini-3.1-flash-live-preview`, which is the
default anyway.

## Verdict

- Default model (3.1 preview): all voices in production use today. No change.
- Selectable 2.5 native-audio model: usable, one known voice miss (Leda)
  and occasional first-try audio timeouts.
