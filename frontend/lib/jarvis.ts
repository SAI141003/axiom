"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type Msg = { role: "you" | "jarvis"; text: string; tools?: string[]; brain?: "bridge" | "local" };
export type JarvisState = "idle" | "listening" | "thinking" | "speaking";
export type BridgeState = "connecting" | "online" | "offline";

const BRIDGE = "ws://127.0.0.1:8788";
// How Chrome's recogniser actually hears "Axiom": axiom, axium, axeum, axon, axiam, "ax iom", action-ish slips.
export const WAKE = /\b(?:hey|ok|okay|yo|hi)?[,\s]*(?:axiom|axium|axeum|axeom|axiam|axion|axon|ax\s?i[ou]m|acxiom|exiom)\b[,.!?]*/i;
export const WAKE_ONLY = /^\s*(?:wake up|are you there|you there|hello|hey|hi|status|what's up|whats up)?\s*[,.!?]*\s*$/i;
export const BRIEF = "Good morning, Axiom. Give me the status briefing.";

// One AXIOM for the whole desk. The page at /jarvis and the dock on every
// other page share this hook, so a conversation started in one continues in
// the other (the bridge holds the thread; this hook holds the transcript).
const WAKE_KEY = "axiom.wake";
export const wakeArmed = () => { try { return localStorage.getItem(WAKE_KEY) !== "off"; } catch { return true; } };

// The wake word is on by default and stays on: AXIOM listens on every page
// ("hey Axiom" alone gives the briefing). Browsers only let a page speak
// after the first click or key, so the first spoken reply waits for that.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const lev = (a: string, b: string) => { const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; };
const like = (a: string, b: string) => a === b || (a[0] === b[0] && lev(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 2)));

export function useJarvis(opts: { voice?: boolean; context?: () => string; listen?: boolean } = {}) {
  const [state, setState] = useState<JarvisState>("idle");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [bridge, setBridge] = useState<BridgeState>("connecting");
  const [micOk, setMicOk] = useState<boolean | null>(null);
  const [brainName, setBrainName] = useState<string>("");
  const [wakeOn, setWakeOn] = useState<boolean>(false);
  const voiceRef = useRef(opts.voice ?? true);
  voiceRef.current = opts.voice ?? true;
  const ctxRef = useRef(opts.context);
  ctxRef.current = opts.context;
  const ws = useRef<WebSocket | null>(null);
  const rec = useRef<any>(null);
  const wakeRef = useRef(false);
  const router = useRouter();
  const routerRef = useRef(router); routerRef.current = router;

  useEffect(() => { try { window.dispatchEvent(new CustomEvent("axiom:jarvis-state", { detail: state })); } catch {} }, [state]);

  const patchLast = useCallback((fn: (m: Msg) => void) => {
    setMsgs((p) => { const n = [...p]; const last = n[n.length - 1]; if (last?.role === "jarvis") fn(last); return n; });
  }, []);

  // One voice, spoken as it arrives. Sentences are cut from the stream as they
  // complete and rendered by the server (edge-tts, en-GB Ryan) one ahead of
  // playback, so AXIOM starts talking on the first sentence, not the last.
  // The browser's own en-GB voice is only the fallback when that route fails.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);   // created inside the first gesture, so later plays are allowed
  const [voiceLocked, setVoiceLocked] = useState(false);
  const [heard, setHeard] = useState<string>("");   // the last thing the recogniser transcribed, shown for a few seconds
  const speakingRef = useRef(false);
  const armed = useRef(false);          // the wake word should be running
  const spinRef = useRef<null | (() => void)>(null);
  const queue = useRef<{ text: string; audio?: Promise<string | null> }[]>([]);
  const spoken = useRef<{ words: string[]; at: number }[]>([]);   // what AXIOM said lately, for the echo filter
  const echoUntil = useRef(0);                                    // a tail after playback: the recogniser reports late
  const playing = useRef(false);
  const streamBuf = useRef("");
  const afterSpeech = useRef<null | (() => void)>(null);

  const hush = useCallback(() => { queue.current = []; streamBuf.current = ""; afterSpeech.current = null; if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; } try { speechSynthesis.cancel(); } catch {} speakingRef.current = false; playing.current = false; setState("idle"); }, []);

  const render = useCallback(async (text: string): Promise<string | null> => {
    try { const r = await fetch("/api/jarvis/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); if (!r.ok) return null; return URL.createObjectURL(await r.blob()); } catch { return null; }
  }, []);

  const playNext = useCallback(async () => {
    if (playing.current) return;
    const item = queue.current.shift();
    if (!item) {
      speakingRef.current = false; playing.current = false; echoUntil.current = Date.now() + 2500; setState("idle");
      if (armed.current) setTimeout(() => { if (armed.current && !speakingRef.current) spinRef.current?.(); }, 700);   // ears back on
      const f = afterSpeech.current; afterSpeech.current = null; f?.(); return;
    }
    playing.current = true; speakingRef.current = true; setState("speaking");
    try { rec.current?.abort?.(); } catch {}          // half-duplex: the mic cannot hear AXIOM if it is off
    spoken.current = [...spoken.current.filter((x) => Date.now() - x.at < 25_000), { words: norm(item.text), at: Date.now() }];
    if (queue.current[0] && !queue.current[0].audio) queue.current[0].audio = render(queue.current[0].text);   // one ahead
    const url = await (item.audio ?? render(item.text));
    let settled = false;
    const finish = () => { if (settled) return; settled = true; playing.current = false; echoUntil.current = Date.now() + 2500; playNext(); };
    setTimeout(finish, Math.max(6000, item.text.length * 110));   // an audio element that never fires onended cannot hold the queue
    if (url) {
      const a = player.current ?? new Audio(); player.current = a; audioRef.current = a;
      a.muted = false; a.volume = 1; a.src = url;
      a.onended = () => { URL.revokeObjectURL(url); finish(); };
      a.onerror = () => { URL.revokeObjectURL(url); finish(); };
      try { await a.play(); setVoiceLocked(false); return; }
      catch (e: any) {
        if (e?.name === "NotAllowedError") { setVoiceLocked(true); URL.revokeObjectURL(url); queue.current = []; streamBuf.current = ""; playing.current = false; speakingRef.current = false; setState("idle"); const f = afterSpeech.current; afterSpeech.current = null; f?.(); return; }   // no gesture yet: drop the speech, never block the ears
      }
    }
    // fallback: the browser's voice, one fixed en-GB choice
    if (typeof speechSynthesis === "undefined") { finish(); return; }
    const u = new SpeechSynthesisUtterance(item.text); u.rate = 1.0; u.pitch = 0.95;
    const vs = speechSynthesis.getVoices();
    const v = vs.find((x) => /Daniel/i.test(x.name) && /en[-_]GB/i.test(x.lang)) ?? vs.find((x) => /Google UK English Male/i.test(x.name)) ?? vs.find((x) => /en[-_]GB/i.test(x.lang));
    if (v) u.voice = v;
    let done = false; const once = () => { if (!done) { done = true; finish(); } };
    u.onend = once; u.onerror = once;
    setTimeout(once, Math.max(4000, item.text.length * 90));   // a synthesis that never reports back cannot hold the desk mute
    speechSynthesis.speak(u);
  }, [render]);

  const enqueue = useCallback((text: string) => {
    const clean = (text || "").replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim();
    if (!voiceRef.current || !clean) return;
    queue.current.push({ text: clean, audio: queue.current.length === 0 && !playing.current ? render(clean) : undefined });
    playNext();
  }, [playNext, render]);

  // feed the stream: cut at sentence ends, speak each one as it completes
  const feed = useCallback((delta: string) => {
    streamBuf.current += delta;
    const m = streamBuf.current.match(/^[\s\S]*?[.!?](?=\s|$)/);
    if (m && m[0].trim().length > 12) { enqueue(m[0]); streamBuf.current = streamBuf.current.slice(m[0].length); }
  }, [enqueue]);
  const flush = useCallback(() => { const rest = streamBuf.current.trim(); streamBuf.current = ""; if (rest) enqueue(rest); else if (!playing.current && !queue.current.length) setState("idle"); }, [enqueue]);

  const speak = useCallback((text: string) => { streamBuf.current = ""; queue.current = []; enqueue(text); if (!text?.trim()) setState("idle"); }, [enqueue]);

  useEffect(() => {
    let alive = true, timer: any;
    const connect = () => {
      try {
        const s = new WebSocket(BRIDGE);
        s.onopen = () => { if (alive) setBridge("online"); };
        s.onclose = () => { if (!alive) return; setBridge("offline"); ws.current = null; timer = setTimeout(connect, 5000); };
        s.onerror = () => s.close();
        s.onmessage = (e) => {
          let m: any; try { m = JSON.parse(e.data); } catch { return; }
          if (m.type === "ready" && m.brain) setBrainName(m.brain === "claude" ? "Claude Agent SDK" : "platform AI");
          else if (m.type === "brain" && typeof m.brain === "string") setBrainName(m.brain.replace(/^(\w+)\/.*?\/?([^/]+)$/, "$1 · $2"));
          else if (m.type === "delta") { patchLast((l) => { l.text += m.text; }); feed(m.text); }
          else if (m.type === "tool") patchLast((l) => { l.tools = [...(l.tools ?? []), m.name]; });
          else if (m.type === "done") { patchLast((l) => { l.text = m.text || l.text; l.brain = "bridge"; }); flush(); }
          else if (m.type === "error") setMsgs((p) => [...p, { role: "jarvis", text: m.text, brain: "bridge" }]);
          else if (m.type === "ui" && m.op === "navigate" && typeof m.href === "string" && m.href.startsWith("/")) { routerRef.current.push(m.href); window.dispatchEvent(new Event("axiom:jarvis-open")); }
          else if (m.type === "ui" && m.op === "eye") { const fire = () => window.dispatchEvent(new CustomEvent("axiom:eye", { detail: m })); fire(); setTimeout(fire, 2500); }
        };
        ws.current = s;
      } catch { setBridge("offline"); }
    };
    connect();
    return () => { alive = false; clearTimeout(timer); ws.current?.close(); };
  }, [patchLast, feed, flush]);

  const ask = useCallback(async (raw: string) => {
    const text = raw.trim(); if (!text) return;
    setMsgs((p) => [...p, { role: "you", text }, { role: "jarvis", text: "" }]);
    setState("thinking");
    const ctx = ctxRef.current?.();
    const payload = ctx ? `${ctx}\n\n${text}` : text;
    if (ws.current && ws.current.readyState === WebSocket.OPEN) { ws.current.send(JSON.stringify({ type: "ask", text: payload })); return; }
    try {
      const r = await fetch("/api/jarvis", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const d = await r.json();
      patchLast((l) => { l.text = d.text; l.brain = "local"; });
      speak(d.text);
    } catch { patchLast((l) => { l.text = "The desk is not answering."; }); setState("idle"); }
  }, [patchLast, feed, flush]);

  const forget = useCallback(() => { ws.current?.send(JSON.stringify({ type: "forget" })); setMsgs([]); }, []);

  // ── The ears ────────────────────────────────────────────────────────────
  // Chrome's SpeechRecognition stops on its own constantly: silence, a tab
  // blur, a network hiccup, an "aborted" it never explains. A one-shot
  // restart in onend is not enough — it dies and the desk goes deaf without
  // saying so. So: one supervisor, a fresh recogniser each time, a heartbeat
  // that notices when it has not been alive recently, and backoff on errors.
  const oneShot = useRef(false);        // next result is a question, not a wake word
  const running = useRef(false);        // the recogniser is live right now (onstart → onend)
  const startedAt = useRef(0);
  const fails = useRef(0);

  // Chrome hands us its transcript after the audio has played, so AXIOM's own
  // voice arrives glued to the front of what Sai says ("Yes, Sai?" came back
  // as "yes sign open the eye"). Subtract the words it just spoke, loosely —
  // the recogniser mangles them — and ignore what is left if it is only echo.
  const deEcho = useCallback((t: string): string => {
    let words = norm(t);
    for (const utt of spoken.current) {
      let i = 0, j = 0, matched = 0;
      while (i < words.length && j < utt.words.length) {
        if (like(words[i], utt.words[j])) { i++; j++; matched++; }
        else if (j + 1 < utt.words.length && like(words[i], utt.words[j + 1])) { i++; j += 2; matched++; }
        else break;
      }
      if (matched >= Math.min(2, utt.words.length)) words = words.slice(i);
    }
    return words.join(" ");
  }, []);

  const handle = useCallback((t: string) => {
    setHeard(t); setTimeout(() => setHeard((h) => (h === t ? "" : h)), 6000);
    if (speakingRef.current) { if (/\b(stop|quiet|enough|shut up)\b/i.test(t)) hush(); return; }
    if (Date.now() < echoUntil.current || spoken.current.length) {
      const rest = deEcho(t);
      if (!rest || rest.length < 3) return;                       // it only heard itself
      if (rest !== norm(t).join(" ")) t = rest;                   // AXIOM's words removed, Sai's kept
    }
    if (oneShot.current) { oneShot.current = false; ask(t); return; }
    if (!WAKE.test(t)) return;
    const q = t.replace(WAKE, "").replace(/^[,.\s]+/, "").trim();
    if (q && !WAKE_ONLY.test(q)) { ask(q); return; }
    if (/status|what.s up|whats up|wake up|brief/i.test(q)) { ask(BRIEF); return; }
    oneShot.current = true;               // "Axiom?" — answer, then take the next thing said as the question
    speak("Yes, Sai?");
    setTimeout(() => { oneShot.current = false; }, 12_000);
  }, [ask, hush, speak, deEcho]);

  const spin = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setMicOk(false); return; }
    try { rec.current?.abort?.(); } catch {}
    const r = new SR(); r.lang = "en-US"; r.continuous = true; r.interimResults = false; r.maxAlternatives = 1;
    r.onstart = () => { running.current = true; startedAt.current = Date.now(); setMicOk(true); fails.current = 0; setState((s) => (s === "idle" ? "listening" : s)); };
    r.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { running.current = false; setMicOk(false); armed.current = false; setWakeOn(false); return; }
      if (e.error !== "no-speech" && e.error !== "aborted") fails.current++;
    };
    r.onend = () => { running.current = false; setState((s) => (s === "listening" ? "idle" : s)); };
    r.onresult = (e: any) => {
      const t = Array.from(e.results).slice(e.resultIndex).map((x: any) => x[0].transcript).join(" ").trim();
      if (t) handle(t);
    };
    try { r.start(); rec.current = r; } catch { running.current = false; }
  }, [handle]);
  spinRef.current = spin;

  // the heartbeat: Chrome stops the recogniser on its own (silence, a blur, a
  // network hiccup) and simply stops listening. Spin a new one whenever it is
  // not running, and force a fresh one every few minutes because a long-lived
  // session goes quietly deaf.
  useEffect(() => {
    const t = setInterval(() => {
      if (!armed.current || micOk === false) return;
      if (fails.current > 8) { setMicOk(false); return; }
      if (speakingRef.current) return;                       // deliberately deaf while it talks
      if (!running.current) { spin(); return; }
      if (Date.now() - startedAt.current > 4 * 60_000 && !speakingRef.current) spin();   // refresh before Chrome's own limits bite
    }, 1500);
    return () => clearInterval(t);
  }, [spin, micOk]);
  useEffect(() => { const onVis = () => { if (!document.hidden && armed.current) spin(); }; document.addEventListener("visibilitychange", onVis); return () => document.removeEventListener("visibilitychange", onVis); }, [spin]);

  const listen = useCallback((asQuestion = false) => {
    if (asQuestion) oneShot.current = true;
    armed.current = true; wakeRef.current = true; setWakeOn(true); fails.current = 0; setMicOk(null);
    spin();
  }, [spin]);

  const stopListening = useCallback(() => { armed.current = false; wakeRef.current = false; setWakeOn(false); try { rec.current?.abort?.(); } catch {} setState((s) => (s === "listening" ? "idle" : s)); }, []);
  const setWake = useCallback((on: boolean) => { try { localStorage.setItem(WAKE_KEY, on ? "on" : "off"); } catch {} if (on) listen(); else stopListening(); }, [listen, stopListening]);

  // Always on: arm the wake word on mount when this instance owns the mic.
  useEffect(() => {
    if (opts.listen === false) return;
    if (!wakeArmed()) return;
    const t = setTimeout(() => listen(), 800);
    return () => { clearTimeout(t); armed.current = false; try { rec.current?.abort?.(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.listen]);

  // Unlock speech on the first gesture so the next reply is heard.
  useEffect(() => {
    const prime = () => {
      try { speechSynthesis.resume(); const u = new SpeechSynthesisUtterance(""); u.volume = 0; speechSynthesis.speak(u); } catch {}
      try { const a = player.current ?? new Audio(); player.current = a; a.muted = true; a.play().catch(() => {}); setTimeout(() => { a.pause(); a.muted = false; }, 50); setVoiceLocked(false); } catch {}
      window.removeEventListener("pointerdown", prime); window.removeEventListener("keydown", prime);
    };
    window.addEventListener("pointerdown", prime); window.addEventListener("keydown", prime);
    return () => { window.removeEventListener("pointerdown", prime); window.removeEventListener("keydown", prime); };
  }, []);

  // a stuck "speaking" is the one state that deafens the desk; never allow it past a minute
  useEffect(() => { if (state !== "speaking") return; const t = setTimeout(() => { if (speakingRef.current) hush(); }, 60_000); return () => clearTimeout(t); }, [state, hush]);
  return { state, msgs, bridge, brainName, micOk, wakeOn, voiceLocked, heard, ask, forget, listen, stopListening, setWake, hush, speak, brief: () => ask(BRIEF) };
}
