/**
 * AXIOM's ears — local Whisper dictation, not the browser's guesswork.
 *
 * Chrome's SpeechRecognition sends audio to Google and returns a paraphrase:
 * "Axiom" comes back as "action", "yes Sai" as "yes sign", short commands get
 * rewritten. Whisper (MIT weights) running on this machine through whisper.cpp
 * writes down what was actually said.
 *
 * We take the microphone's samples directly and write the WAV ourselves. The
 * obvious route — MediaRecorder with a timeslice — does not survive contact
 * with a voice gate: every chunk after the first is a bare WebM cluster, so an
 * utterance cut out of the middle has no header and ffmpeg refuses it outright,
 * and putting the header back in front leaves the cluster's original timestamp,
 * so the decoder emits however long the session has been running as silence and
 * Whisper hallucinates over the gap ("[MUSIC PLAYING]", "I'm on camera").
 * Raw PCM has neither problem: what we send is exactly the half-second to ten
 * seconds that Sai spoke.
 *
 * The capture runs in an AudioWorklet, on the audio thread. A ScriptProcessor
 * does the same job on the main thread and drops buffers whenever the page is
 * busy — with the globe and the charts running, that chopped every sentence
 * into single words ("bot", "btw") before Whisper ever saw it.
 */

// the worklet: hand every frame straight back, on the audio thread
const WORKLET = `class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor("axiom-tap", Tap);`;
export type EarsEvents = {
  onText: (text: string) => void;
  onState?: (s: "idle" | "listening" | "hearing" | "thinking") => void;
  onError?: (e: string) => void;
};

const SILENCE_MS = 420;         // speech is over after this much quiet — every ms here is a ms Sai waits
const MIN_SPEECH_MS = 180;      // shorter than this is a cough, not a word
const MAX_UTTERANCE_MS = 15_000;
const PREROLL_MS = 400;         // kept before the gate opens so the first word survives
const OUT_RATE = 16_000;        // what whisper.cpp wants

export async function whisperReady(): Promise<boolean> {
  try { const r = await fetch("/api/jarvis/stt", { cache: "no-store" }); return (await r.json()).ok === true; } catch { return false; }
}

/** 16-bit mono WAV, the one format every decoder agrees on. */
function wav(samples: Float32Array, rate: number): Blob {
  const b = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(b);
  const put = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  put(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); put(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  put(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([b], { type: "audio/wav" });
}

export class Ears {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ring: Float32Array[] = [];     // the pre-roll, a few frames deep
  private held: Float32Array[] = [];     // the utterance being collected
  private speaking = false;
  private lastVoice = 0;
  private startedAt = 0;
  private paused = false;
  private ducked = false;      // AXIOM is talking: still listening, but only for a real interruption
  private stopped = false;
  private floor = 0.012;                 // follows the room
  private inFlight = false;              // Whisper serialises; do not queue rubbish behind a real question
  private rate = 48_000;

  constructor(private ev: EarsEvents) {}

  async start(): Promise<boolean> {
    if (this.stream) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    } catch (e: any) { this.ev.onError?.(e?.name === "NotAllowedError" ? "not-allowed" : String(e?.message ?? e)); return false; }
    this.stopped = false;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    // an AudioContext can open suspended under the autoplay policy, and a
    // suspended one reports pure silence for ever
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    this.rate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.stream);
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch (e: any) { this.ev.onError?.(`worklet: ${String(e?.message ?? e)}`); return false; }
    const node = new AudioWorkletNode(this.ctx, "axiom-tap");
    this.node = node;
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(this.ctx.destination);

    const frameMs = 128 / this.rate * 1000;                       // a worklet render quantum
    const preFrames = Math.max(1, Math.ceil(PREROLL_MS / frameMs));
    node.port.onmessage = (e: MessageEvent) => {
      if (this.stopped) return;
      const frame = e.data as Float32Array;
      let sum = 0; for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      if (this.paused) return;

      // The floor tracks the room at all times, including while Sai is
      // talking — a real microphone never reaches digital silence, so a floor
      // that only moved between utterances left the gate stuck open and every
      // "utterance" ran to the fifteen-second ceiling.
      this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.9995 + rms * 0.0005;

      // Two thresholds, not one: speech has to clear the higher bar to open
      // the gate and fall below the lower one to close it, so an ordinary dip
      // between words does not end the sentence.
      // While AXIOM speaks the ears stay open so Sai can cut in mid-sentence.
      // The browser's echo canceller removes most of AXIOM's own voice; the
      // raised bar removes the rest.
      const open = this.ducked ? this.floor * 8 + 0.03 : this.floor * 3.5 + 0.004;
      const close = this.ducked ? this.floor * 5 + 0.02 : this.floor * 2.0 + 0.002;
      const now = Date.now();

      if (rms > (this.speaking ? close : open)) {
        if (!this.speaking) {
          this.speaking = true; this.startedAt = now;
          this.held = [...this.ring];
          this.ev.onState?.("hearing");
        }
        this.lastVoice = now;
      }
      if (this.speaking) {
        this.held.push(frame);
        if (now - this.lastVoice > (this.ducked ? 450 : SILENCE_MS) || now - this.startedAt > MAX_UTTERANCE_MS) this.cut();
      } else {
        this.ring.push(frame); if (this.ring.length > preFrames) this.ring.shift();
      }
    };
    this.ev.onState?.("listening");
    return true;
  }

  /** Stop collecting and send what was said. */
  private cut() {
    const heldMs = this.lastVoice - this.startedAt;
    const frames = this.held;
    this.speaking = false; this.held = []; this.ring = [];
    this.ev.onState?.("listening");
    if (heldMs < MIN_SPEECH_MS || !frames.length) return;
    // room noise can cross a gate; speech stays loud for a while. Require a
    // real run of voiced frames before spending a transcription on it.
    let voiced = 0;
    for (const f of frames) { let s2 = 0; for (let i = 0; i < f.length; i++) s2 += f[i] * f[i]; if (Math.sqrt(s2 / f.length) > this.floor * 3) voiced++; }
    if (voiced < frames.length * 0.12) return;

    // flatten, then decimate to 16 kHz by averaging — a whole-number ratio, and
    // 48k to 16k is the case every machine here hits
    const total = frames.reduce((a, f) => a + f.length, 0);
    const flat = new Float32Array(total);
    let o = 0; for (const f of frames) { flat.set(f, o); o += f.length; }
    const step = Math.max(1, Math.round(this.rate / OUT_RATE));
    const out = new Float32Array(Math.floor(flat.length / step));
    for (let i = 0; i < out.length; i++) {
      let s = 0; for (let k = 0; k < step; k++) s += flat[i * step + k] || 0;
      out[i] = s / step;
    }

    if (this.inFlight) return;           // still transcribing the last one
    this.inFlight = true;
    this.ev.onState?.("thinking");
    fetch("/api/jarvis/stt", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav(out, Math.round(this.rate / step)) })
      .then((r) => r.json())
      .then((d) => {
        this.inFlight = false;
        this.ev.onState?.("listening");
        // whisper brackets what is not speech — [BLANK_AUDIO], (music) — and
        // that is not something Sai said
        const said = String(d.text ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
        if (said.length > 1) this.ev.onText(said);
        else if (d.error) this.ev.onError?.(d.error);
      })
      .catch((e) => { this.inFlight = false; this.ev.onState?.("listening"); this.ev.onError?.(String(e?.message ?? e)); });
  }

  /** AXIOM is speaking: keep the ears open, but only a real voice gets through. */
  duck(on: boolean) { this.ducked = on; if (on) { this.speaking = false; this.held = []; this.ring = []; } else { this.ring = []; this.held = []; this.lastVoice = Date.now(); } }
  pause() { this.paused = true; this.speaking = false; this.held = []; this.ring = []; }
  resume() { this.paused = false; this.ducked = false; this.ring = []; this.held = []; this.floor = 0.012; this.lastVoice = Date.now(); }

  stop() {
    this.stopped = true;
    try { if (this.node) this.node.port.onmessage = null; this.node?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null; this.node = null; this.ctx = null; this.held = []; this.ring = [];
    this.ev.onState?.("idle");
  }

  get live() { return !!this.stream && !this.stopped; }
}
