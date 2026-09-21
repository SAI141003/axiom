"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type Msg = { role: "you" | "jarvis"; text: string; tools?: string[]; brain?: "bridge" | "local" };
export type JarvisState = "idle" | "listening" | "thinking" | "speaking";
export type BridgeState = "connecting" | "online" | "offline";

const BRIDGE = "ws://127.0.0.1:8788";
export const WAKE = /\b(hey|ok|okay)\s+axiom\b/i;
export const BRIEF = "Good morning, Axiom. Give me the status briefing.";

// One AXIOM for the whole desk. The page at /jarvis and the dock on every
// other page share this hook, so a conversation started in one continues in
// the other (the bridge holds the thread; this hook holds the transcript).
const WAKE_KEY = "axiom.wake";
export const wakeArmed = () => { try { return localStorage.getItem(WAKE_KEY) !== "off"; } catch { return true; } };

// The wake word is on by default and stays on: AXIOM listens on every page
// ("hey Axiom" alone gives the briefing). Browsers only let a page speak
// after the first click or key, so the first spoken reply waits for that.
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

  // One voice. The server renders AXIOM's neural voice (edge-tts, en-GB Ryan);
  // the browser's own en-GB voice is only the fallback when that route fails,
  // so the desk never switches voices mid-conversation.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speakingRef = useRef(false);
  const hush = useCallback(() => { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; } try { speechSynthesis.cancel(); } catch {} speakingRef.current = false; setState("idle"); }, []);
  const speak = useCallback(async (text: string) => {
    const clean = (text || "").replace(/[*_#`]/g, "").trim();
    if (!voiceRef.current || !clean) { setState("idle"); return; }
    try { speechSynthesis.cancel(); } catch {}
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    try {
      const r = await fetch("/api/jarvis/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: clean }) });
      if (!r.ok) throw new Error(String(r.status));
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url); audioRef.current = a;
      a.onplay = () => { speakingRef.current = true; setState("speaking"); };
      a.onended = () => { speakingRef.current = false; setState("idle"); URL.revokeObjectURL(url); };
      a.onerror = () => { speakingRef.current = false; setState("idle"); URL.revokeObjectURL(url); };
      await a.play();
      return;
    } catch { /* fall through to the browser voice */ }
    if (typeof speechSynthesis === "undefined") { setState("idle"); return; }
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.0; u.pitch = 0.95;
    const vs = speechSynthesis.getVoices();
    const v = vs.find((x) => /Daniel/i.test(x.name) && /en[-_]GB/i.test(x.lang)) ?? vs.find((x) => /Google UK English Male/i.test(x.name)) ?? vs.find((x) => /en[-_]GB/i.test(x.lang));
    if (v) u.voice = v;
    u.onstart = () => { speakingRef.current = true; setState("speaking"); };
    u.onend = () => { speakingRef.current = false; setState("idle"); };
    u.onerror = () => { speakingRef.current = false; setState("idle"); };
    speechSynthesis.speak(u);
  }, []);

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
          else if (m.type === "delta") patchLast((l) => { l.text += m.text; });
          else if (m.type === "tool") patchLast((l) => { l.tools = [...(l.tools ?? []), m.name]; });
          else if (m.type === "done") { patchLast((l) => { l.text = m.text || l.text; l.brain = "bridge"; }); speak(m.text); }
          else if (m.type === "error") setMsgs((p) => [...p, { role: "jarvis", text: m.text, brain: "bridge" }]);
          else if (m.type === "ui" && m.op === "navigate" && typeof m.href === "string" && m.href.startsWith("/")) { routerRef.current.push(m.href); window.dispatchEvent(new Event("axiom:jarvis-open")); }
        };
        ws.current = s;
      } catch { setBridge("offline"); }
    };
    connect();
    return () => { alive = false; clearTimeout(timer); ws.current?.close(); };
  }, [patchLast, speak]);

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
  }, [patchLast, speak]);

  const forget = useCallback(() => { ws.current?.send(JSON.stringify({ type: "forget" })); setMsgs([]); }, []);

  const listen = useCallback((continuous: boolean) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setMicOk(false); return; }
    rec.current?.stop();
    const r = new SR(); r.lang = "en-US"; r.continuous = continuous; r.interimResults = false;
    r.onstart = () => { setMicOk(true); setState("listening"); };
    r.onerror = (e: any) => { if (e.error === "not-allowed") setMicOk(false); setState("idle"); };
    r.onend = () => { if (continuous && wakeRef.current) { try { r.start(); } catch {} } else setState((s) => (s === "listening" ? "idle" : s)); };
    r.onresult = (e: any) => {
      const t = Array.from(e.results).slice(e.resultIndex).map((x: any) => x[0].transcript).join(" ").trim();
      if (!t) return;
      // "axiom, stop" cuts it off; anything else heard while it speaks is its own voice
      if (speakingRef.current) { if (/\b(stop|quiet|enough|shut up)\b/i.test(t)) hush(); return; }
      if (continuous) { if (WAKE.test(t)) { const q = t.replace(WAKE, "").replace(/^[,.\s]+/, "").trim(); ask(q.length > 2 ? q : BRIEF); } }
      else ask(t);
    };
    try { r.start(); rec.current = r; } catch { setState("idle"); }
  }, [ask, hush]);

  const stopListening = useCallback(() => { rec.current?.stop(); }, []);
  const setWake = useCallback((on: boolean) => { wakeRef.current = on; setWakeOn(on); try { localStorage.setItem(WAKE_KEY, on ? "on" : "off"); } catch {} if (on) listen(true); else { rec.current?.stop(); rec.current = null; } }, [listen]);

  // Always on: arm the wake word on mount when this instance owns the mic.
  useEffect(() => {
    if (opts.listen === false) return;
    if (!wakeArmed()) return;
    const t = setTimeout(() => { wakeRef.current = true; setWakeOn(true); listen(true); }, 800);
    return () => { clearTimeout(t); rec.current?.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.listen]);

  // Unlock speech on the first gesture so the next reply is heard.
  useEffect(() => {
    const prime = () => { try { speechSynthesis.resume(); const u = new SpeechSynthesisUtterance(""); u.volume = 0; speechSynthesis.speak(u); } catch {} window.removeEventListener("pointerdown", prime); window.removeEventListener("keydown", prime); };
    window.addEventListener("pointerdown", prime); window.addEventListener("keydown", prime);
    return () => { window.removeEventListener("pointerdown", prime); window.removeEventListener("keydown", prime); };
  }, []);

  return { state, msgs, bridge, brainName, micOk, wakeOn, ask, forget, listen, stopListening, setWake, hush, brief: () => ask(BRIEF) };
}
