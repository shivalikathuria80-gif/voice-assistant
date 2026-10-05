const GROQ = "https://api.groq.com/openai/v1";

// Qwen3-style models "think" first, which is slow and gets spoken aloud; turn that off for voice.
const reasoningOpts = (model) =>
  /qwen/i.test(model)
    ? { reasoning_effort: "none", reasoning_format: "hidden" }
    : /gpt-oss/i.test(model)
      ? { reasoning_effort: "low", include_reasoning: false }
      : {};

export async function transcribe(audio, mime) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime }), "speech.webm");
  form.append("model", process.env.STT_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "json");
  const res = await fetch(`${GROQ}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
  return (await res.json()).text.trim();
}

// Streams reply tokens via onToken. Resolves with { content, toolCalls } where toolCalls is
// [{ id, name, args }] (args already parsed) when the model asked to use tools.
export async function chat(messages, onToken, signal, tools, toolChoice) {
  const model = process.env.LLM_MODEL || "llama-3.3-70b-versatile";
  const body = { model, messages, stream: true, ...reasoningOpts(model) };
  if (tools?.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${GROQ}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 || attempt >= 1) break;
    // Free-tier token-per-minute limit: wait the suggested time (capped) and retry once.
    const msg = await res.text();
    const wait = Math.min(12, Number(msg.match(/try again in ([\d.]+)s/)?.[1] ?? 6) + 0.5);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);

  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  const calls = [];
  const handle = (line) => {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) return;
    const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onToken(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const c = (calls[tc.index ?? 0] ??= { id: "", name: "", args: "" });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    lines.forEach(handle);
  }
  handle(buf);

  const toolCalls = calls.filter(Boolean).map((c, i) => {
    let args = {};
    try { args = c.args ? JSON.parse(c.args) : {}; } catch {}
    return { id: c.id || `call_${Date.now()}_${i}`, name: c.name, args };
  });
  return { content, toolCalls };
}

// Non-streaming call that returns parsed JSON ({} on any failure). Used for background memory extraction.
export async function chatJSON(messages) {
  try {
    const model = process.env.MEMORY_MODEL || process.env.LLM_MODEL || "llama-3.3-70b-versatile";
    const res = await fetch(`${GROQ}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        ...reasoningOpts(model),
        messages,
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const text = (await res.json()).choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/g, "").trim());
  } catch (err) {
    console.warn("memory extraction failed:", err.message);
    return {};
  }
}

// Returns an MP3 Buffer, or null when no TTS key is configured (client falls back to speechSynthesis).
export async function synthesize(text) {
  if (process.env.ELEVENLABS_API_KEY) return synthesizeEleven(text);
  if (!process.env.DEEPGRAM_API_KEY) return null;
  const voice = process.env.TTS_VOICE || "aura-asteria-en";
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function synthesizeEleven(text) {
  const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel"
  const model = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5"; // lowest latency
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Splits streamed text into speakable sentences.
export function takeSentences(buffer) {
  const sentences = [];
  let rest = buffer;
  let m;
  while ((m = rest.match(/^(.+?[.!?])(\s+|$)/s)) && m[0].length < rest.length) {
    sentences.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { sentences, rest };
}
