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
- [ ] Persistent memory, tools / web search
- [ ] Deployment

See [docs/architecture.md](docs/architecture.md).
