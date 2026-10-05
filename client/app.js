const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const labels = {
  idle: "tap the orb to start",
  listening: "listening · just talk",
  thinking: "thinking",
  speaking: "speaking · talk to interrupt",
};

// Voice-activity detection tuning
const FRAME_MS = 30;
const START_FRAMES = 2;      // consecutive loud frames that open an utterance
const END_SILENCE_MS = 900;  // silence that closes an utterance
const MIN_SPEECH_MS = 350;   // shorter blips are discarded
const MAX_UTTERANCE_MS = 30000;
const BASE_THRESHOLD = 0.02;
const SPEAKING_THRESHOLD = 0.07; // higher while the assistant talks, to ignore speaker bleed

const ws = createSocket(); // see transport.js

let state = "idle";
let session = false;   // hands-free conversation active
let stream = null;
let audioCtx = null;
let analyser = null;
let timer = null;
let recorder = null;
let speechMs = 0;
let silenceMs = 0;
let loudFrames = 0;
let noiseFloor = 0.01;
let audioQueue = [];
let playing = null;
let serverBusy = false;
let browserTts = 0;
let awaitingConfirm = false;
let confirmId = null;

function setState(s) {
  state = s;
  document.body.dataset.state = s;
  $("state").textContent = labels[s];
}

function settle() {
  if (serverBusy || playing || audioQueue.length || browserTts) return;
  setState(session ? "listening" : "idle");
}

function stopSpeaking() {
  speechSynthesis.cancel();
  browserTts = 0;
  audioQueue = [];
  if (playing) { playing.pause(); playing = null; }
}

function playNext() {
  if (playing) return;
  if (!audioQueue.length) return settle();
  setState("speaking");
  playing = new Audio(URL.createObjectURL(audioQueue.shift()));
  playing.onended = () => { playing = null; playNext(); };
  playing.play();
}

function speakBrowser(text) {
  const u = new SpeechSynthesisUtterance(text);
  browserTts++;
  setState("speaking");
  u.onend = u.onerror = () => { browserTts = Math.max(0, browserTts - 1); settle(); };
  speechSynthesis.speak(u);
}

ws.onmessage = (e) => {
  if (e.data instanceof ArrayBuffer) {
    audioQueue.push(new Blob([e.data], { type: "audio/mpeg" }));
    return playNext();
  }
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case "status":
      awaitingConfirm = msg.value === "confirm";
      serverBusy = msg.value !== "idle" && !awaitingConfirm;
      if (awaitingConfirm && !recorder) { setState("listening"); $("state").textContent = "say yes or no"; }
      else if (serverBusy && !recorder) setState("thinking");
      if (!serverBusy) settle();
      break;
    case "user": $("you").textContent = `“${msg.text}”`; if (!awaitingConfirm) $("bot").textContent = ""; $("tool").textContent = ""; break;
    case "token": $("bot").textContent += msg.text; break;
    case "speak": speakBrowser(msg.text); break;
    case "tool": $("tool").textContent = msg.text; break;
    case "confirm":
      confirmId = msg.id;
      $("confirm-text").textContent = `Allow me to ${msg.text}?`;
      $("confirm").hidden = false;
      break;
    case "confirm_done":
      awaitingConfirm = false;
      confirmId = null;
      $("confirm").hidden = true;
      if (!playing && !browserTts) setState(serverBusy ? "thinking" : session ? "listening" : "idle");
      break;
    case "memory": $("mem").textContent = msg.count ? `${msg.count} ${msg.count === 1 ? "memory" : "memories"}` : ""; break;
    case "done":
      serverBusy = false;
      $("tool").textContent = "";
      $("stats").textContent = `STT ${msg.timings.sttMs} ms · first token ${msg.timings.firstTokenMs} ms · total ${msg.timings.totalMs} ms`;
      settle();
      break;
    case "error": serverBusy = false; $("bot").textContent = msg.message; settle(); break;
  }
};

function rms() {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += ((v - 128) / 128) ** 2;
  return Math.sqrt(sum / data.length);
}

function beginUtterance() {
  // Barge-in: user speech cuts off the assistant and any in-flight reply.
  if (playing || audioQueue.length || browserTts || serverBusy || awaitingConfirm) {
    stopSpeaking();
    if (!awaitingConfirm) { // a pending approval must survive: the user's next words are the answer
      ws.send(JSON.stringify({ type: "interrupt" }));
      serverBusy = false;
    }
  }
  recorder = new MediaRecorder(stream);
  ws.send(JSON.stringify({ type: "start", mime: recorder.mimeType }));
  const rec = recorder;
  rec.sent = Promise.resolve(); // keeps chunks ordered ahead of the final "end"
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    const buf = e.data.arrayBuffer();
    rec.sent = rec.sent.then(() => buf).then((b) => ws.send(b));
  };
  rec.start(250);
  document.body.dataset.hearing = "true";
  setState("listening");
  if (!awaitingConfirm) $("you").textContent = "";
}

function endUtterance(keep) {
  const r = recorder;
  recorder = null;
  document.body.dataset.hearing = "false";
  if (!r) return;
  r.onstop = () => r.sent.then(() => ws.send(JSON.stringify({ type: keep ? "end" : "cancel" })));
  r.stop();
  if (keep) { serverBusy = true; setState("thinking"); } else settle();
}

function tick() {
  const level = rms();
  const assistantTalking = !!(playing || browserTts);
  const threshold = Math.max(assistantTalking ? SPEAKING_THRESHOLD : BASE_THRESHOLD, noiseFloor * 3);
  const loud = level > threshold;
  root.style.setProperty("--level", Math.min(1, level * 4).toFixed(3));

  if (!recorder) {
    if (!loud) noiseFloor = noiseFloor * 0.95 + level * 0.05;
    loudFrames = loud ? loudFrames + 1 : 0;
    if (loudFrames >= START_FRAMES) {
      loudFrames = 0;
      speechMs = 0;
      silenceMs = 0;
      beginUtterance();
    }
    return;
  }

  speechMs += FRAME_MS;
  silenceMs = loud ? 0 : silenceMs + FRAME_MS;
  const spokenMs = speechMs - silenceMs;
  if (silenceMs >= END_SILENCE_MS || speechMs >= MAX_UTTERANCE_MS) endUtterance(spokenMs >= MIN_SPEECH_MS);
}

async function startSession() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    $("bot").textContent = "Microphone access is needed.";
    return;
  }
  audioCtx ??= new AudioContext();
  await audioCtx.resume();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  session = true;
  noiseFloor = 0.01;
  timer = setInterval(tick, FRAME_MS);
  setState("listening");
}

function stopSession() {
  session = false;
  clearInterval(timer);
  if (recorder) endUtterance(false);
  stopSpeaking();
  ws.send(JSON.stringify({ type: "interrupt" }));
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  serverBusy = false;
  root.style.setProperty("--level", 0);
  setState("idle");
}

function toggle() { session ? stopSession() : startSession(); }

$("orb").addEventListener("click", toggle);
addEventListener("keydown", (e) => { if (e.code === "Space" && !e.repeat) { e.preventDefault(); toggle(); } });

function reply(ok) {
  if (confirmId) ws.send(JSON.stringify({ type: "confirm_reply", id: confirmId, ok }));
}
$("allow").addEventListener("click", () => reply(true));
$("deny").addEventListener("click", () => reply(false));
