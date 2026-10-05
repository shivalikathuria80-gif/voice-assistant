import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { transcribe } from "./providers.js";
import { getFacts, getHistory, loadMemory } from "./memory.js";
import { initLocalTools } from "./tools/index.js";
import { runTurn } from "./turn.js";
import turnHandler from "../api/turn.js";

const CONFIRM_TIMEOUT_MS = 60_000;

const YES = /^\W*(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|please do|go for it|proceed|absolutely|affirmative)\b/i;
const NO = /^\W*(no|nope|nah|cancel|stop|don'?t|do not|never ?mind|negative)\b/i;
const verdict = (text) => (YES.test(text) ? true : NO.test(text) ? false : null);

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer((req, res) => {
  // The same HTTP endpoint the hosted (Vercel) build uses; handy for testing that path locally.
  if (req.url.startsWith("/api/turn")) return turnHandler(req, res);
  const urlPath = req.url.split("?")[0];
  const name = urlPath === "/" ? "index.html" : path.basename(urlPath);
  const file = path.join(clientDir, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end("Not found");
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
});

const wss = new WebSocketServer({ server });
const registry = await initLocalTools();

wss.on("connection", (ws) => {
  let history = [];
  let mime = "audio/webm";
  let chunks = [];
  let abort = null;
  let pendingConfirm = null; // { id, resolve }

  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const sendMemory = () => send({ type: "memory", count: getFacts().length });
  loadMemory().then(sendMemory);

  // Asks the user to approve an action; resolves true/false from voice or the on-screen buttons.
  const approveFor = (signal) => (summary, say) =>
    new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const finish = (ok) => {
        clearTimeout(timer);
        pendingConfirm = null;
        send({ type: "confirm_done", id });
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
      signal.addEventListener("abort", () => finish(false), { once: true });
      pendingConfirm = { id, resolve: finish };
      send({ type: "status", value: "confirm" });
      send({ type: "confirm", id, text: summary });
      const line = `I'd like to ${summary}. Shall I go ahead?`;
      send({ type: "token", text: `\n${line}` });
      say(line);
    });

  async function handleTurn(audio, typed) {
    // While a tool is waiting for approval, the next utterance is the answer (or a new request).
    let text = typed ?? null;
    if (pendingConfirm) {
      text ??= await transcribe(audio, mime).catch(() => "");
      const v = verdict(text);
      if (pendingConfirm) {
        if (v !== null) {
          send({ type: "user", text });
          return pendingConfirm.resolve(v);
        }
        pendingConfirm.resolve(false); // unclear answer: decline and treat it as a new request
      }
    }

    abort?.abort();
    abort = new AbortController();
    const { signal } = abort;
    const t0 = Date.now();
    try {
      send({ type: "status", value: "transcribing" });
      text ??= await transcribe(audio, mime);
      if (!text) return send({ type: "status", value: "idle" });
      const tStt = Date.now() - t0;
      send({ type: "user", text });

      await loadMemory();
      history = getHistory();
      await runTurn({
        text,
        history,
        send,
        deliverAudio: (sentence, mp3) => {
          send({ type: "audio", text: sentence });
          ws.send(mp3);
        },
        signal,
        registry,
        approve: approveFor(signal),
        t0,
        tStt,
        awaitLearning: false,
      });
      sendMemory();
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
    } else if (msg.type === "text") {
      // Typed input (testing / accessibility): same pipeline, no speech-to-text.
      if (typeof msg.text === "string" && msg.text.trim()) handleTurn(null, msg.text.trim());
    } else if (msg.type === "cancel") {
      chunks = [];
    } else if (msg.type === "confirm_reply") {
      if (pendingConfirm?.id === msg.id) pendingConfirm.resolve(!!msg.ok);
    } else if (msg.type === "interrupt") {
      if (!pendingConfirm) abort?.abort();
    }
  });

  ws.on("close", () => abort?.abort());
});

const port = process.env.PORT || 3002;
server.listen(port, () => {
  console.log(`Voice assistant on http://localhost:${port}`);
  if (!process.env.GROQ_API_KEY) console.warn("GROQ_API_KEY is not set; copy .env.example to .env");
});
