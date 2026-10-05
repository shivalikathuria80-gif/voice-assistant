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

## Tools
`server/tools/` holds the tool registry. `native.js` has the built-in computer-control tools, `mcp.js` connects to every server in `mcp.config.json` over stdio (official MCP SDK) and exposes their tools as `server__tool`. Each tool declares a spoken summary if it needs approval.

Turn loop (`server/index.js`): the model streams a reply; if it returns tool calls, each one is checked, approved (if needed) and run, the result goes back to the model, and the loop repeats (max 6 steps). Approval flow: server sends `confirm`, speaks the question, and waits for `confirm_reply` (buttons) or the next utterance (yes/no by voice). While waiting, `interrupt` is ignored so talking does not cancel the pending action.

Reliability notes: small models sometimes claim "Opening Notepad" without calling the tool. If the user asked for an action and the reply starts like such a claim, the text is held back and a tool call is forced (`tool_choice: "required"`). Tool calls and results are kept in the saved history so the model sees that actions really happened. Reasoning is switched off or hidden per model family (`reasoningOpts` in `providers.js`) because it adds latency and gets spoken aloud.
