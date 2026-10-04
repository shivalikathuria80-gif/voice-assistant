const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const talk = document.getElementById("talk");

const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
ws.binaryType = "arraybuffer";

let recorder = null;
let currentReply = null;
let audioQueue = [];
let playing = null;
let expectAudio = [];

function addMsg(text, cls) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function stopSpeaking() {
  speechSynthesis.cancel();
  audioQueue = [];
  expectAudio = [];
  if (playing) { playing.pause(); playing = null; }
}

function playNext() {
  if (playing || !audioQueue.length) return;
  playing = new Audio(URL.createObjectURL(audioQueue.shift()));
  playing.onended = () => { playing = null; playNext(); };
  playing.play();
}

ws.onmessage = (e) => {
  if (e.data instanceof ArrayBuffer) {
    audioQueue.push(new Blob([e.data], { type: "audio/mpeg" }));
    return playNext();
  }
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case "status": statusEl.textContent = msg.value; break;
    case "user": addMsg(msg.text, "user"); currentReply = addMsg("", "bot"); break;
    case "token": currentReply.textContent += msg.text; logEl.scrollTop = logEl.scrollHeight; break;
    case "speak": speechSynthesis.speak(new SpeechSynthesisUtterance(msg.text)); break;
    case "done":
      statusEl.textContent = "idle";
      statsEl.textContent = `STT ${msg.timings.sttMs} ms · first token ${msg.timings.firstTokenMs} ms · total ${msg.timings.totalMs} ms`;
      break;
    case "error": addMsg(`Error: ${msg.message}`, "bot"); statusEl.textContent = "idle"; break;
  }
};

async function startRecording() {
  if (recorder) return;
  stopSpeaking(); // barge-in: talking cuts off the assistant
  ws.send(JSON.stringify({ type: "interrupt" }));
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recorder = new MediaRecorder(stream);
  ws.send(JSON.stringify({ type: "start", mime: recorder.mimeType }));
  recorder.ondataavailable = async (e) => e.data.size && ws.send(await e.data.arrayBuffer());
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    ws.send(JSON.stringify({ type: "end" }));
    recorder = null;
  };
  recorder.start(250);
  talk.classList.add("rec");
  talk.textContent = "Listening…";
}

function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  talk.classList.remove("rec");
  talk.textContent = "Hold to talk";
}

talk.addEventListener("pointerdown", startRecording);
talk.addEventListener("pointerup", stopRecording);
talk.addEventListener("pointerleave", stopRecording);
addEventListener("keydown", (e) => { if (e.code === "Space" && !e.repeat) { e.preventDefault(); startRecording(); } });
addEventListener("keyup", (e) => { if (e.code === "Space") stopRecording(); });
