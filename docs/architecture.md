# Architecture

## Flow
1. After one tap, the client keeps the mic open and runs an energy-based VAD (adaptive noise floor). Speech opens a `MediaRecorder` segment, ~0.9 s of silence closes it, and chunks stream over the WebSocket.
2. On `end`, the server sends the audio to Groq Whisper and gets a transcript.
3. The transcript plus conversation history goes to the Groq chat completion API with `stream: true`.
4. Tokens are forwarded to the client as they arrive and split into sentences.
5. Each sentence is synthesized (Deepgram MP3) and sent as a binary frame, or sent as a `speak` message so the browser uses `speechSynthesis`.
6. A new `interrupt` message or a new recording aborts the in-flight LLM request and clears queued audio (barge-in).

## WebSocket protocol
Client -> server: `{type:"start",mime}`, binary audio chunks, `{type:"end"}`, `{type:"cancel"}` (discard a too-short segment), `{type:"interrupt"}`.
Server -> client: `status`, `user`, `token`, `speak`, `audio` (followed by a binary MP3 frame), `done` (with timings), `error`.

## Next
- Swap the energy-based VAD in `client/app.js` for `@ricky0123/vad-web` (neural) if background noise causes false triggers.
- Stream STT (Deepgram live) to cut transcription latency.
- Persist history per user (Supabase) and add tool calls.

## Memory
`server/memory.js` stores two things in `data/memory.json` (git-ignored, single user):
- **History**: the last 30 messages, reloaded on every connection so conversations survive restarts.
- **Facts**: short durable statements about the user. After each turn a background LLM call (`MEMORY_MODEL`, defaults to `LLM_MODEL`) returns `{add, remove}`, which is merged into the list (max 40). Facts are appended to the system prompt on each turn.
Saying "forget everything" or "clear your memory" wipes both.
