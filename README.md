# Voice Assistant

A conversational AI voice assistant. Speak into the mic, get a spoken reply.

```
Browser mic -> WebSocket -> STT (Groq Whisper) -> LLM (Groq Llama, streaming) -> TTS (Deepgram, or browser speechSynthesis)
```

## APIs

| Stage | Provider | Required |
|-------|----------|----------|
| Speech-to-Text | Groq Whisper | yes |
| LLM | Groq Llama 3.3 | yes |
| Text-to-Speech | ElevenLabs or Deepgram Aura | no (falls back to the browser's `speechSynthesis`) |

## Run

```bash
npm install
cp .env.example .env   # add your GROQ_API_KEY (and optionally DEEPGRAM_API_KEY)
npm start
```

Open http://localhost:3002, then tap the orb (or press Space) once. It listens continuously: just talk, pause, and it replies. Talk over it to interrupt. Tap again to end the session.

## Status

- [x] Push-to-talk loop with streamed LLM replies
- [x] Sentence-level TTS, barge-in (talking interrupts the assistant)
- [x] Per-turn latency readout
- [x] Hands-free mode (voice-activity detection, auto turn-taking)
- [x] Persistent memory (conversation history + long-term facts, saved in `data/memory.json`; say "forget everything" to wipe)
- [x] MCP tool calls (any MCP server via `mcp.config.json`; web search + calendar examples)
- [x] Computer control (workspace files, allowed apps, URLs, screenshots; every action needs your approval)
- [ ] Deployment

See [docs/architecture.md](docs/architecture.md).

## Tools and approvals

The assistant can call tools. Anything that changes something asks you first: it says what it wants to do, and you answer **"yes"** or **"no"** out loud, or tap **Allow / Deny** on screen. No answer within 60 seconds counts as no. Read-only tools run without asking.

| Tool | What it does | Asks first? |
|------|--------------|-------------|
| `list_files`, `read_file` | Look inside the `workspace/` folder only | no |
| `write_file` | Create, overwrite or append to a file in `workspace/` | yes |
| `open_app` | Open an app from the allowlist in `computer.config.json` | yes |
| `open_url` | Open an http(s) link in your default browser | yes |
| `take_screenshot` | Save a screenshot to `workspace/screenshots/` (Windows) | yes |
| MCP tools | Whatever you configure below | yes, unless the server marks the tool read-only |

Safety limits: file tools cannot leave `workspace/`; apps are limited to the allowlist; only http/https links open. Tool output is treated as untrusted data, never as instructions. Edit `computer.config.json` to change the folder or allowed apps.

### MCP servers (web search, calendar, anything else)

```bash
cp mcp.config.example.json mcp.config.json   # then add the keys it mentions to .env
```

- **Web search** uses the [Tavily MCP server](https://github.com/tavily-ai/tavily-mcp): get a key at tavily.com and set `TAVILY_API_KEY` in `.env`.
- **Calendar** uses `@cocal/google-calendar-mcp`: create a Google Cloud OAuth client (Desktop app, Calendar API enabled), download its JSON, set `GOOGLE_OAUTH_CREDENTIALS` to that file's path, and run `npx @cocal/google-calendar-mcp auth` once to sign in.
- A server whose env variable is empty is skipped, so you can enable them one at a time.
- Only add MCP servers you trust: they run on your machine.
