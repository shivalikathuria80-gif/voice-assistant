const GROQ = "https://api.groq.com/openai/v1";

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

// Streams reply tokens via onToken; resolves with the full reply.
export async function chat(messages, onToken, signal) {
  const res = await fetch(`${GROQ}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || "llama-3.3-70b-versatile",
      messages,
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);

  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const token = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
      if (token) {
        full += token;
        onToken(token);
      }
    }
  }
  return full;
}

// Returns an MP3 Buffer, or null when no TTS key is configured (client falls back to speechSynthesis).
export async function synthesize(text) {
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
