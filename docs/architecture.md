# Architecture

## Flow
1. Client records audio with `MediaRecorder` while the button/space bar is held and streams chunks over the WebSocket.
2. On `end`, the server sends the audio to Groq Whisper and gets a transcript.
3. The transcript plus conversation history goes to the Groq chat completion API with `stream: true`.
4. Tokens are forwarded to the client as they arrive and split into sentences.
5. Each sentence is synthesized (Deepgram MP3) and sent as a binary frame, or sent as a `speak` message so the browser uses `speechSynthesis`.
6. A new `interrupt` message or a new recording aborts the in-flight LLM request and clears queued audio (barge-in).

## WebSocket protocol
Client -> server: `{type:"start",mime}`, binary audio chunks, `{type:"end"}`, `{type:"interrupt"}`.
Server -> client: `status`, `user`, `token`, `speak`, `audio` (followed by a binary MP3 frame), `done` (with timings), `error`.

## Next
- Replace push-to-talk with `@ricky0123/vad-web` for hands-free turn detection.
- Stream STT (Deepgram live) to cut transcription latency.
- Persist history per user (Supabase) and add tool calls.
