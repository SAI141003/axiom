/**
 * AXIOM's ears — local Whisper dictation, not the browser's guesswork.
 *
 * Chrome's SpeechRecognition sends audio to Google and returns a paraphrase:
 * "Axiom" comes back as "action", "yes Sai" as "yes sign", short commands get
 * rewritten. Whisper (MIT weights) running on this machine through whisper.cpp
 * writes down what was actually said — the same engine the open-source Wispr
 * Flow alternatives use.
 *
 * Here we only do the audio: capture the mic, find where speech starts and
 * stops (RMS gate with a pre-roll so the first word survives), and POST each
 * utterance to /api/jarvis/stt. If Whisper is not installed the caller falls
 * back to the browser recogniser.
 */
export type EarsEvents = {
  onText: (text: string) => void;
  onState?: (s: "idle" | "listening" | "hearing" | "thinking") => void;
  onError?: (e: string) => void;
};

const SILENCE_MS = 700;        // speech is over after this much quiet
const MAX_UTTERANCE_MS = 15_000;
const PREROLL_CHUNKS = 2;      // ~400 ms kept before the gate opens
const CHUNK_MS = 200;

export async function whisperReady(): Promise<boolean> {
  try { const r = await fetch("/api/jarvis/stt", { cache: "no-store" }); return (await r.json()).ok === true; } catch { return false; }
}

export class Ears {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private pre: Blob[] = [];
  private speaking = false;
  private lastVoice = 0;
  private startedAt = 0;
  private raf = 0;
  private paused = false;
  private stopped = false;
  private floor = 0.012;       // adapts to the room

  constructor(private ev: EarsEvents) {}

  async start(): Promise<boolean> {
    if (this.stream) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e: any) { this.ev.onError?.(e?.name === "NotAllowedError" ? "not-allowed" : String(e?.message ?? e)); return false; }
    this.stopped = false;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const an = this.ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
    const buf = new Float32Array(an.fftSize);

    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      if (this.speaking) this.chunks.push(e.data);
      else { this.pre.push(e.data); if (this.pre.length > PREROLL_CHUNKS) this.pre.shift(); }
    };
    this.rec.start(CHUNK_MS);
    this.ev.onState?.("listening");

    const tick = () => {
      if (this.stopped) return;
      this.raf = requestAnimationFrame(tick);
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (this.paused) return;
      // the noise floor creeps toward the quiet moments, so a loud room does not deafen it
      if (!this.speaking && rms < this.floor * 1.5) this.floor = this.floor * 0.995 + rms * 0.005;
      const gate = Math.max(0.008, this.floor * 2.6);
      const now = Date.now();
      if (rms > gate) {
        if (!this.speaking) { this.speaking = true; this.startedAt = now; this.chunks = [...this.pre]; this.ev.onState?.("hearing"); }
        this.lastVoice = now;
      } else if (this.speaking && now - this.lastVoice > SILENCE_MS) {
        this.cut();
      }
      if (this.speaking && now - this.startedAt > MAX_UTTERANCE_MS) this.cut();
    };
    tick();
    return true;
  }

  /** Stop collecting and send what we have. */
  private cut() {
    this.speaking = false;
    const parts = this.chunks; this.chunks = []; this.pre = [];
    this.ev.onState?.("listening");
    if (parts.length < 2) return;                     // a cough, not a sentence
    const blob = new Blob(parts, { type: this.rec?.mimeType || "audio/webm" });
    if (blob.size < 4000) return;
    this.ev.onState?.("thinking");
    fetch("/api/jarvis/stt", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: blob })
      .then((r) => r.json())
      .then((d) => { this.ev.onState?.("listening"); if (d.text) this.ev.onText(d.text); else if (d.error) this.ev.onError?.(d.error); })
      .catch((e) => { this.ev.onState?.("listening"); this.ev.onError?.(String(e?.message ?? e)); });
  }

  /** Half-duplex: deaf while AXIOM speaks, so it never transcribes itself. */
  pause() { this.paused = true; this.speaking = false; this.chunks = []; this.pre = []; }
  resume() { this.paused = false; this.floor = 0.012; this.lastVoice = Date.now(); }

  stop() {
    this.stopped = true; cancelAnimationFrame(this.raf);
    try { this.rec?.state !== "inactive" && this.rec?.stop(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null; this.rec = null; this.ctx = null; this.chunks = []; this.pre = [];
    this.ev.onState?.("idle");
  }

  get live() { return !!this.stream && !this.stopped; }
}
