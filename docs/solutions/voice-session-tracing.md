# Voice Session Tracing

Voice tracing is a development-only diagnostic for troubleshooting real voice sessions. It is not an end-user feature or vault knowledge.

## Enable tracing

`npm run dev` sets `SINAPSO_VOICE_TRACE=1`. `npm start` and the desktop app do not enable tracing automatically. To opt in explicitly, set the variable for the command you run:

```bash
SINAPSO_VOICE_TRACE=1 npm start
```

## Trace storage and API

Each session is appended to app runtime data at `voice-traces/<sessionId>.jsonl`. Traces contain no raw audio, and secret-key fields are redacted.

Read available sessions and one session's events:

```bash
curl http://127.0.0.1:5175/api/voice/sessions
curl http://127.0.0.1:5175/api/voice/sessions/<SESSION_ID>/events
```

Delete all traces through the guarded endpoint using the current session token:

```bash
curl -X DELETE -H 'x-sinapso-token: <TOKEN>' http://127.0.0.1:5175/api/voice/sessions
```

Trace events include `session_started`, `session_ended`, `user_transcript`, `assistant_transcript`, `tool_call`, `tool_result`, `browser_action`, `browser_status`, `browser_context`, and `provider_error`.

## Verified live transcription

On 2026-07-18, the configured `gemini-3.1-flash-live-preview` emitted both input and output transcription for real PCM speech despite using native multimodal audio. It did not emit `finished`; `turnComplete` is therefore the observed flush boundary. A relay-level probe confirmed that both transcript events persisted.

Groq's official transcription endpoint accepts file uploads rather than streaming audio. Its free tier currently allows 20 RPM and 7,200 audio seconds per hour, with a 10-second minimum billable duration. It remains a possible batch fallback, but the verified live path does not require it.

## Troubleshooting

1. Verify `SINAPSO_VOICE_TRACE=1` in the running process.
2. List sessions and inspect the latest session's events.
3. Correlate call, job, and document IDs across related events.
4. Check `provider_error` plus save and rescan events around the failure.
