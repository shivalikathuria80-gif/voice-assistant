import { transcribe, synthesize } from "../server/providers.js";
import { getHistory, loadMemory, getFacts } from "../server/memory.js";
import { hostedRegistry } from "../server/tools/hosted.js";
import { runTurn } from "../server/turn.js";

// One conversation turn over plain HTTP, streamed back as newline-delimited JSON events.
// Used by the Vercel deployment (serverless has no WebSocket) and mounted locally for testing.
// Only read-only tools are exposed here: there is no approval channel and no local machine to control.
const MAX_BODY = 4 * 1024 * 1024; // Vercel's request limit is 4.5 MB

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Audio too long.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.writeHead(405, { Allow: "POST" }).end();

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  const send = (msg) => !res.writableEnded && res.write(`${JSON.stringify(msg)}\n`);

  const ac = new AbortController();
  res.on("close", () => !res.writableEnded && ac.abort()); // client hung up or interrupted
  const t0 = Date.now();

  try {
    const body = await readBody(req);
    const isJson = (req.headers["content-type"] || "").includes("application/json");
    let text = isJson ? String(JSON.parse(body.toString() || "{}").text ?? "").trim() : null;

    send({ type: "status", value: "transcribing" });
    if (text === null) {
      if (!body.length) throw new Error("No audio received.");
      text = await transcribe(body, req.headers["x-audio-mime"] || "audio/webm");
    }
    if (!text) {
      send({ type: "status", value: "idle" });
      return res.end();
    }
    const tStt = Date.now() - t0;
    send({ type: "user", text });

    await loadMemory();
    send({ type: "memory", count: getFacts().length });
    await runTurn({
      text,
      history: getHistory(),
      send,
      deliverAudio: (sentence, mp3) => send({ type: "audio", text: sentence, b64: mp3.toString("base64") }),
      signal: ac.signal,
      registry: hostedRegistry(),
      approve: async () => false,
      t0,
      tStt,
      awaitLearning: true,
    });
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error(err);
      send({ type: "error", message: err.message });
    }
  }
  res.end();
}
