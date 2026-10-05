// Gives app.js one socket-like object with two implementations:
//  - WebSocket to the local server (full features, including computer control)
//  - HTTP streaming to /api/turn (hosted on Vercel, which has no WebSocket)
// app.js only uses send(), onmessage and the string/ArrayBuffer message shapes below.
function createSocket() {
  const override = new URLSearchParams(location.search).get("transport");
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (override === "ws" || (!override && local)) {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
    ws.binaryType = "arraybuffer";
    return ws;
  }
  return new HttpSocket();
}

class HttpSocket {
  constructor() {
    this.onmessage = null;
    this.mime = "audio/webm";
    this.chunks = [];
    this.controller = null;
  }

  emit(data) {
    this.onmessage?.({ data });
  }

  send(data) {
    if (typeof data !== "string") return this.chunks.push(data); // binary audio chunk
    const msg = JSON.parse(data);
    switch (msg.type) {
      case "start": this.mime = msg.mime || this.mime; this.chunks = []; break;
      case "cancel": this.chunks = []; break;
      case "end": {
        const audio = new Blob(this.chunks, { type: this.mime });
        this.chunks = [];
        if (audio.size) this.turn(audio, { "Content-Type": "application/octet-stream", "x-audio-mime": this.mime });
        break;
      }
      case "text":
        this.turn(JSON.stringify({ text: msg.text }), { "Content-Type": "application/json" });
        break;
      case "interrupt": this.controller?.abort(); break;
      // confirm_reply: hosted mode has no approval-gated tools
    }
  }

  async turn(body, headers) {
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    try {
      const res = await fetch("/api/turn", { method: "POST", body, headers, signal: controller.signal });
      if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "Not signed in to this deployment." : `Server error ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) if (line.trim()) this.handle(JSON.parse(line));
      }
      if (buf.trim()) this.handle(JSON.parse(buf));
    } catch (err) {
      if (err.name !== "AbortError") this.emit(JSON.stringify({ type: "error", message: err.message }));
    }
  }

  handle(msg) {
    if (msg.type === "audio" && msg.b64) {
      const bytes = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
      return this.emit(bytes.buffer); // app.js expects the MP3 as a binary message
    }
    this.emit(JSON.stringify(msg));
  }
}
