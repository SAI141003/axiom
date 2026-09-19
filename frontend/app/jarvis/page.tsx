"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import TopNav from "@/components/TopNav";

type Msg = { role: "you" | "jarvis"; text: string; tools?: string[]; brain?: "bridge" | "local" };
type State = "idle" | "listening" | "thinking" | "speaking";
const BRIDGE = "ws://127.0.0.1:8788";
const WAKE = /\b(hey|ok|okay)\s+jarvis\b/i;

const SUGGESTIONS = [
  "How is the fleet doing?",
  "Which bot is winning?",
  "Is the desk safe?",
  "What did the backtest say?",
  "Forecast NVDA for a month",
  "Where can we trade from Canada?",
];

export default function JarvisPage() {
  const [state, setState] = useState<State>("idle");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [bridge, setBridge] = useState<"connecting" | "online" | "offline">("connecting");
  const [voice, setVoice] = useState(true);
  const [wake, setWake] = useState(false);
  const [micOk, setMicOk] = useState<boolean | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const rec = useRef<any>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, state]);

  // Bridge connection — retried quietly; the page works without it.
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
          if (m.type === "delta") setMsgs((p) => { const n = [...p]; const last = n[n.length - 1]; if (last?.role === "jarvis") last.text += m.text; return n; });
          else if (m.type === "tool") setMsgs((p) => { const n = [...p]; const last = n[n.length - 1]; if (last?.role === "jarvis") last.tools = [...(last.tools ?? []), m.name]; return n; });
          else if (m.type === "done") finish(m.text);
          else if (m.type === "error") setMsgs((p) => [...p, { role: "jarvis", text: m.text, brain: "bridge" }]);
        };
        ws.current = s;
      } catch { setBridge("offline"); }
    };
    connect();
    return () => { alive = false; clearTimeout(timer); ws.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const speak = useCallback((text: string) => {
    if (!voice || typeof speechSynthesis === "undefined" || !text) { setState("idle"); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, ""));
    u.rate = 1.02; u.pitch = 0.9;
    const v = speechSynthesis.getVoices().find((x) => /en-GB|Daniel|Google UK English Male/i.test(`${x.lang} ${x.name}`));
    if (v) u.voice = v;
    u.onstart = () => setState("speaking");
    u.onend = () => setState("idle");
    u.onerror = () => setState("idle");
    speechSynthesis.speak(u);
  }, [voice]);

  const finish = useCallback((text: string) => {
    setMsgs((p) => { const n = [...p]; const last = n[n.length - 1]; if (last?.role === "jarvis") { last.text = text || last.text; last.brain = "bridge"; } return n; });
    speak(text);
  }, [speak]);

  const ask = useCallback(async (raw: string) => {
    const text = raw.trim(); if (!text || state === "thinking") return;
    setInput("");
    setMsgs((p) => [...p, { role: "you", text }, { role: "jarvis", text: "" }]);
    setState("thinking");
    if (ws.current && ws.current.readyState === WebSocket.OPEN) { ws.current.send(JSON.stringify({ type: "ask", text })); return; }
    try {
      const r = await fetch("/api/jarvis", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const d = await r.json();
      setMsgs((p) => { const n = [...p]; const last = n[n.length - 1]; if (last?.role === "jarvis") { last.text = d.text; last.brain = "local"; } return n; });
      speak(d.text);
    } catch { setMsgs((p) => { const n = [...p]; n[n.length - 1] = { role: "jarvis", text: "The desk is not answering." }; return n; }); setState("idle"); }
  }, [state, speak]);

  // Speech recognition — browser-native, no key. Wake mode listens continuously
  // for "hey Jarvis"; push-to-talk listens for one utterance.
  const startRec = useCallback((continuous: boolean) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setMicOk(false); return; }
    rec.current?.stop();
    const r = new SR(); r.lang = "en-US"; r.continuous = continuous; r.interimResults = false;
    r.onstart = () => { setMicOk(true); setState("listening"); };
    r.onerror = (e: any) => { if (e.error === "not-allowed") setMicOk(false); setState("idle"); };
    r.onend = () => { if (continuous && wake) { try { r.start(); } catch {} } else setState((s) => (s === "listening" ? "idle" : s)); };
    r.onresult = (e: any) => {
      const t = Array.from(e.results).slice(e.resultIndex).map((x: any) => x[0].transcript).join(" ").trim();
      if (!t) return;
      if (continuous) { if (WAKE.test(t)) { const q = t.replace(WAKE, "").trim(); if (q) ask(q); } }
      else ask(t);
    };
    try { r.start(); rec.current = r; } catch { setState("idle"); }
  }, [ask, wake]);

  useEffect(() => { if (wake) startRec(true); else { rec.current?.stop(); rec.current = null; } }, [wake, startRec]);

  const ring = state === "listening" ? "#34d399" : state === "thinking" ? "#fbbf24" : state === "speaking" ? "var(--hud-accent-2)" : "var(--hud-accent)";

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-5xl mx-auto px-6 py-8 font-mono">
        <div className="grid md:grid-cols-[320px_1fr] gap-8 items-start">
          {/* Reactor */}
          <div className="flex flex-col items-center gap-4">
            <Reactor color={ring} state={state} onClick={() => (state === "listening" ? rec.current?.stop() : startRec(false))} />
            <div className="text-[10px] tracking-[0.3em] font-bold" style={{ color: ring }}>{state.toUpperCase()}</div>
            <div className="text-[9px] tracking-widest text-center" style={{ color: "var(--hud-muted)" }}>
              tap the reactor to talk · or type below
            </div>
            <div className="flex flex-col gap-2 w-full text-[10px]">
              <Row label="BRAIN" value={bridge === "online" ? "Claude Code bridge" : bridge === "connecting" ? "connecting…" : "local fallback"}
                   tone={bridge === "online" ? "#34d399" : bridge === "connecting" ? "var(--hud-muted)" : "#fbbf24"} />
              <Toggle label="VOICE OUT" on={voice} onChange={setVoice} />
              <Toggle label={'WAKE WORD  "hey jarvis"'} on={wake} onChange={setWake} />
              {micOk === false && <div className="text-[9px] break-words" style={{ color: "#f87171" }}>microphone unavailable — use Chrome or Edge in a real window and allow the mic</div>}
              {bridge === "offline" && (
                <div className="text-[9px] leading-relaxed break-words hud-panel hud-panel-static p-2" style={{ color: "var(--hud-muted)" }}>
                  Full JARVIS runs on your Claude Code login: <code style={{ color: "var(--hud-text)" }}>cd jarvis && npm install && npm start</code>. Until then I answer from the desk&apos;s data files.
                </div>
              )}
            </div>
          </div>

          {/* Transcript */}
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan">J.A.R.V.I.S.</h1>
            <p className="text-[11px] mt-1 mb-4 break-words" style={{ color: "var(--hud-muted)" }}>
              the desk&apos;s voice — every account, backtest, scenario and venue, answered from the data, spoken aloud
            </p>
            <div className="hud-panel hud-panel-static p-4 min-h-[380px] max-h-[56vh] overflow-y-auto flex flex-col gap-3">
              {msgs.length === 0 && (
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => ask(s)} className="text-[10px] px-3 py-1.5 rounded border hover:opacity-80 text-left"
                            style={{ borderColor: "var(--hud-border)", color: "var(--hud-muted)" }}>{s}</button>
                  ))}
                </div>
              )}
              {msgs.map((m, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                            className={`max-w-[92%] ${m.role === "you" ? "self-end" : "self-start"}`}>
                  <div className="text-[8px] tracking-widest mb-0.5" style={{ color: m.role === "you" ? "var(--hud-muted)" : "var(--hud-accent)" }}>
                    {m.role === "you" ? "YOU" : "JARVIS"}{m.brain === "local" ? " · local" : ""}
                    {m.tools?.length ? ` · ${m.tools.join(" → ")}` : ""}
                  </div>
                  <div className="text-[12px] leading-relaxed break-words whitespace-pre-wrap rounded px-3 py-2"
                       style={{ background: m.role === "you" ? "var(--hud-accent-soft)" : "rgba(255,255,255,0.03)", color: "var(--hud-text)" }}>
                    {m.text || (state === "thinking" ? <span className="animate-pulse">…</span> : "")}
                  </div>
                </motion.div>
              ))}
              <div ref={bottom} />
            </div>
            <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="flex gap-2 mt-3">
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="ask the desk anything…"
                     className="flex-1 min-w-0 px-4 py-3 text-sm rounded border bg-transparent"
                     style={{ borderColor: "var(--hud-border)", color: "var(--hud-text)" }} />
              <button type="submit" disabled={state === "thinking"} className="px-5 py-3 text-sm rounded border font-bold shrink-0"
                      style={{ borderColor: "var(--hud-accent)", color: state === "thinking" ? "var(--hud-muted)" : "var(--hud-accent)" }}>ASK</button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

function Reactor({ color, state, onClick }: { color: string; state: State; onClick: () => void }) {
  const spin = state === "thinking" ? 2.2 : state === "speaking" ? 6 : 14;
  return (
    <button onClick={onClick} aria-label="talk to JARVIS" className="relative w-[260px] h-[260px] rounded-full outline-none"
            style={{ background: "radial-gradient(circle, rgba(124,154,255,0.10) 0%, rgba(10,12,17,0) 70%)" }}>
      <motion.svg viewBox="0 0 200 200" className="absolute inset-0 w-full h-full" animate={{ rotate: 360 }} transition={{ repeat: Infinity, ease: "linear", duration: spin }}>
        <circle cx="100" cy="100" r="92" fill="none" stroke={color} strokeWidth="1" strokeDasharray="6 10" opacity="0.5" />
        <circle cx="100" cy="100" r="78" fill="none" stroke={color} strokeWidth="2" strokeDasharray="40 24" opacity="0.8" />
      </motion.svg>
      <motion.svg viewBox="0 0 200 200" className="absolute inset-0 w-full h-full" animate={{ rotate: -360 }} transition={{ repeat: Infinity, ease: "linear", duration: spin * 1.6 }}>
        <circle cx="100" cy="100" r="62" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="14 8" opacity="0.7" />
        {Array.from({ length: 12 }).map((_, i) => (
          <line key={i} x1="100" y1="30" x2="100" y2="38" stroke={color} strokeWidth="2" opacity="0.6" transform={`rotate(${i * 30} 100 100)`} />
        ))}
      </motion.svg>
      <motion.div className="absolute rounded-full" style={{ inset: 82, background: color, boxShadow: `0 0 40px ${color}, 0 0 90px ${color}` }}
                  animate={{ scale: state === "listening" ? [1, 1.18, 1] : state === "speaking" ? [1, 1.08, 0.96, 1] : [1, 1.04, 1] }}
                  transition={{ repeat: Infinity, duration: state === "speaking" ? 0.5 : 1.8, ease: "easeInOut" }} />
      <svg viewBox="0 0 64 64" className="absolute inset-0 m-auto w-9 h-9" aria-hidden="true">
        <path d="M14 49 L32 15 L50 49" fill="none" stroke="#0a0c11" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M18 39 H46" stroke="#0a0c11" strokeWidth="5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex justify-between gap-2 px-2 py-1 rounded" style={{ background: "rgba(255,255,255,0.02)" }}>
      <span style={{ color: "var(--hud-muted)" }}>{label}</span><span className="truncate" style={{ color: tone }}>{value}</span>
    </div>
  );
}
function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className="flex justify-between gap-2 px-2 py-1 rounded text-left" style={{ background: "rgba(255,255,255,0.02)" }} aria-pressed={on}>
      <span style={{ color: "var(--hud-muted)" }}>{label}</span><span style={{ color: on ? "#34d399" : "var(--hud-muted)" }}>{on ? "ON" : "OFF"}</span>
    </button>
  );
}
