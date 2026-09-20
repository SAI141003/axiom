"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Msg = { role: "you" | "jarvis"; text: string; tools?: string[]; brain?: "bridge" | "local" };
export type JarvisState = "idle" | "listening" | "thinking" | "speaking";
export type BridgeState = "connecting" | "online" | "offline";

const BRIDGE = "ws://127.0.0.1:8788";
export const WAKE = /\b(hey|ok|okay)\s+jarvis\b/i;
export const BRIEF = "Good morning, Jarvis. Give me the status briefing.";

// One JARVIS for the whole desk. The page at /jarvis and the dock on every
// other page share this hook, so a conversation started in one continues in
// the other (the bridge holds the thread; this hook holds the transcript).
export function useJarvis(opts: { voice?: boolean; context?: () => string } = {}) {
  const [state, setState] = useState<JarvisState>("idle");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [bridge, setBridge] = useState<BridgeState>("connecting");
  const [micOk, setMicOk] = useState<boolean | null>(null);
  const voiceRef = useRef(opts.voice ?? true);
  voiceRef.current = opts.voice ?? true;
  const ctxRef = useRef(opts.context);
  ctxRef.current = opts.context;
  const ws = useRef<WebSocket | null>(null);
  const rec = useRef<any>(null);
  const wakeRef = useRef(false);

  const patchLast = useCallback((fn: (m: Msg) => void) => {
    setMsgs((p) => { const n = [...p]; const last = n[n.length - 1]; if (last?.role === "jarvis") fn(last); return n; });
  }, []);

  const speak = useCallback((text: string) => {
    if (!voiceRef.current || typeof speechSynthesis === "undefined" || !text) { setState("idle"); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, ""));
    u.rate = 1.02; u.pitch = 0.9;
    const v = speechSynthesis.getVoices().find((x) => /en-GB|Daniel|Google UK English Male/i.test(`${x.lang} ${x.name}`));
    if (v) u.voice = v;
    u.onstart = () => setState("speaking");
    u.onend = () => setState("idle");
    u.onerror = () => setState("idle");
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
          if (m.type === "delta") patchLast((l) => { l.text += m.text; });
          else if (m.type === "tool") patchLast((l) => { l.tools = [...(l.tools ?? []), m.name]; });
          else if (m.type === "done") { patchLast((l) => { l.text = m.text || l.text; l.brain = "bridge"; }); speak(m.text); }
          else if (m.type === "error") setMsgs((p) => [...p, { role: "jarvis", text: m.text, brain: "bridge" }]);
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
      if (continuous) { if (WAKE.test(t)) { const q = t.replace(WAKE, "").replace(/^[,.\s]+/, "").trim(); ask(q.length > 2 ? q : BRIEF); } }
      else ask(t);
    };
    try { r.start(); rec.current = r; } catch { setState("idle"); }
  }, [ask]);

  const stopListening = useCallback(() => { rec.current?.stop(); }, []);
  const setWake = useCallback((on: boolean) => { wakeRef.current = on; if (on) listen(true); else { rec.current?.stop(); rec.current = null; } }, [listen]);

  return { state, msgs, bridge, micOk, ask, forget, listen, stopListening, setWake, brief: () => ask(BRIEF) };
}
