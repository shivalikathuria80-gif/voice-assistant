import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { transcribe, chat, synthesize, takeSentences } from "./providers.js";

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer((req, res) => {
  const name = req.url === "/" ? "index.html" : path.basename(req.url.split("?")[0]);
  const file = path.join(clientDir, name);
  if (!fs.existsSync(file)) return res.writeHead(404).end("Not found");
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const history = [
    { role: "system", content: process.env.SYSTEM_PROMPT || "You are a helpful voice assistant. Keep replies short." },
  ];
  let mime = "audio/webm";
  let chunks = [];
  let abort = null;

  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  async function handleTurn(audio) {
    abort?.abort();
    abort = new AbortController();
    const { signal } = abort;
    const t0 = Date.now();
    try {
      send({ type: "status", value: "transcribing" });
      const text = await transcribe(audio, mime);
      if (!text) return send({ type: "status", value: "idle" });
      const tStt = Date.now() - t0;
      send({ type: "user", text });
      history.push({ role: "user", content: text });

      send({ type: "status", value: "thinking" });
      let pending = "";
      let firstToken = null;
      const speak = async (sentence) => {
        const mp3 = await synthesize(sentence);
        if (signal.aborted) return;
        if (mp3) {
          send({ type: "audio", text: sentence });
          ws.send(mp3);
        } else {
          send({ type: "speak", text: sentence });
        }
      };

      // Sentences are synthesized in order; TTS of sentence N overlaps LLM streaming.
      let speakChain = Promise.resolve();
      const reply = await chat(
        history,
        (token) => {
          firstToken ??= Date.now() - t0;
          send({ type: "token", text: token });
          pending += token;
          const { sentences, rest } = takeSentences(pending);
          pending = rest;
          for (const s of sentences) speakChain = speakChain.then(() => speak(s));
        },
        signal,
      );
      if (pending.trim()) speakChain = speakChain.then(() => speak(pending.trim()));
      await speakChain;

      history.push({ role: "assistant", content: reply });
      send({ type: "done", timings: { sttMs: tStt, firstTokenMs: firstToken, totalMs: Date.now() - t0 } });
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      send({ type: "error", message: err.message });
    }
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) return chunks.push(data);
    const msg = JSON.parse(data.toString());
    if (msg.type === "start") {
      mime = msg.mime || mime;
      chunks = [];
    } else if (msg.type === "end") {
      const audio = Buffer.concat(chunks);
      chunks = [];
      if (audio.length) handleTurn(audio);
    } else if (msg.type === "interrupt") {
      abort?.abort();
    }
  });

  ws.on("close", () => abort?.abort());
});

const port = process.env.PORT || 3002;
server.listen(port, () => {
  console.log(`Voice assistant on http://localhost:${port}`);
  if (!process.env.GROQ_API_KEY) console.warn("GROQ_API_KEY is not set; copy .env.example to .env");
});
