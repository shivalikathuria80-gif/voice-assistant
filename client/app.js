const $ = (id) => document.getElementById(id);
const orb = $("orb");
const labels = { idle: "tap the orb to talk", listening: "listening · tap to send", thinking: "thinking", speaking: "speaking · tap to interrupt" };

const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
ws.binaryType = "arraybuffer";

let state = "idle";
let recorder = null;
let audioCtx = null;
let analyser = null;
let audioQueue = [];
let playing = null;
let serverBusy = false;
let browserTts = 0;

function setState(s) {
  state = s;
  document.body.dataset.state = s;
  $("state").textContent = labels[s];
  if (s !== "listening") document.documentElement.style.setProperty("--level", s === "speaking" ? 0.1 : 0);
}

function stopSpeaking() {
  speechSynthesis.cancel();
  browserTts = 0;
  audioQueue = [];
  if (playing) { playing.pause(); playing = null; }
}

function afterSpeech() {
  if (!serverBusy && !playing && !audioQueue.length && !browserTts && state === "speaking") setState("idle");
}

function playNext() {
  if (playing) return;
  if (!audioQueue.length) return afterSpeech();
  setState("speaking");
  playing = new Audio(URL.createObjectURL(audioQueue.shift()));
  playing.onended = () => { playing = null; playNext(); };
  playing.play();
}

function speakBrowser(text) {
  const u = new SpeechSynthesisUtterance(text);
  browserTts++;
  setState("speaking");
  u.onend = u.onerror = () => { browserTts = Math.max(0, browserTts - 1); afterSpeech(); };
  speechSynthesis.speak(u);
}

ws.onmessage = (e) => {
  if (e.data instanceof ArrayBuffer) {
    audioQueue.push(new Blob([e.data], { type: "audio/mpeg" }));
    return playNext();
  }
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case "status": serverBusy = msg.value !== "idle"; if (msg.value === "transcribing" || msg.value === "thinking") setState("thinking"); break;
    case "user": $("you").textContent = `“${msg.text}”`; $("bot").textContent = ""; break;
    case "token": $("bot").textContent += msg.text; break;
    case "speak": speakBrowser(msg.text); break;
    case "done":
      serverBusy = false;
      $("stats").textContent = `STT ${msg.timings.sttMs} ms · first token ${msg.timings.firstTokenMs} ms · total ${msg.timings.totalMs} ms`;
      if (!playing && !audioQueue.length && !browserTts) setState("idle");
      break;
    case "error": serverBusy = false; $("bot").textContent = msg.message; setState("idle"); break;
  }
};

function meter() {
  if (!analyser || state !== "listening") return;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += ((v - 128) / 128) ** 2;
  const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
  document.documentElement.style.setProperty("--level", level.toFixed(3));
  requestAnimationFrame(meter);
}

async function startRecording() {
  stopSpeaking(); // barge-in
  ws.send(JSON.stringify({ type: "interrupt" }));
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $("bot").textContent = "Microphone access is needed."; return; }

  audioCtx ??= new AudioContext();
  analyser = audioCtx.createAnalyser();
  audioCtx.createMediaStreamSource(stream).connect(analyser);

  recorder = new MediaRecorder(stream);
  ws.send(JSON.stringify({ type: "start", mime: recorder.mimeType }));
  recorder.ondataavailable = async (e) => e.data.size && ws.send(await e.data.arrayBuffer());
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    ws.send(JSON.stringify({ type: "end" }));
    recorder = null;
  };
  recorder.start(250);
  $("you").textContent = "";
  setState("listening");
  meter();
}

function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  setState("thinking");
}

function toggle() {
  if (recorder) stopRecording();
  else startRecording();
}

orb.addEventListener("click", toggle);
addEventListener("keydown", (e) => { if (e.code === "Space" && !e.repeat) { e.preventDefault(); toggle(); } });
