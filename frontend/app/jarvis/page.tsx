"use client";

import { useState } from "react";
import { Mic, Send, Volume2, VolumeX, Radio, RotateCcw, Sparkles } from "lucide-react";
import TopNav from "@/components/TopNav";
import { useJarvis, BRIEF } from "@/lib/jarvis";
import { Reactor, toneFor } from "@/components/jarvis/Reactor";
import { Transcript } from "@/components/jarvis/Transcript";

const SUGGESTIONS = [
  "How is the fleet doing?",
  "What's in the news that matters to our positions?",
  "Which bot is winning?",
  "Is the desk safe?",
  "What did the backtest say?",
  "Forecast NVDA for a month",
  "Try a momentum + RSI blend and judge it honestly",
  "Where can we trade from Canada?",
];

export default function JarvisPage() {
  const [voice, setVoice] = useState(true);
  const [wake, setWakeUi] = useState(false);
  const [input, setInput] = useState("");
  const j = useJarvis({ voice });
  const tone = toneFor(j.state);
  const toggleWake = () => { const on = !wake; setWakeUi(on); j.setWake(on); };

  return (
    <div className="hud-bg min-h-screen relative">
      <div className="hud-ambient" aria-hidden />
      <TopNav />
      <main className="relative max-w-6xl mx-auto px-6 py-10">
        <div className="grid lg:grid-cols-[340px_1fr] gap-10 items-start">
          <section className="flex flex-col items-center gap-5" aria-label="JARVIS controls">
            <Reactor state={j.state} size={280} onClick={() => (j.state === "listening" ? j.stopListening() : j.listen(false))} />
            <div className="text-[11px] tracking-[0.35em] font-bold font-mono" style={{ color: tone }} aria-live="polite">{j.state.toUpperCase()}</div>
            <p className="prose-sans text-[12px] text-center" style={{ color: "var(--hud-muted)" }}>Tap the reactor to talk, or type. Say <em>“hey Jarvis”</em> alone and you get the briefing.</p>
            <div className="w-full flex flex-col gap-1.5">
              <Row icon={Sparkles} label="Brain" value={j.bridge === "online" ? (j.brainName || "platform AI") : j.bridge === "connecting" ? "connecting…" : "local fallback"} tone={j.bridge === "online" ? "var(--hud-green)" : j.bridge === "connecting" ? "var(--hud-muted)" : "var(--hud-amber)"} />
              <Toggle icon={voice ? Volume2 : VolumeX} label="Voice out" on={voice} onChange={setVoice} />
              <Toggle icon={Radio} label="Wake word “hey Jarvis”" on={wake} onChange={toggleWake} />
            </div>
            {j.micOk === false && <p className="prose-sans text-[11px] text-center" style={{ color: "var(--hud-red)" }}>Microphone unavailable — use Chrome or Edge in a real window and allow the mic.</p>}
            {j.bridge === "offline" && (
              <div className="hud-panel hud-panel-static p-3 prose-sans text-[11px] leading-relaxed" style={{ color: "var(--hud-muted)" }}>
                Full JARVIS runs on the platform&apos;s own AI (Groq / NVIDIA): <code className="font-mono" style={{ color: "var(--hud-text)" }}>cd jarvis && npm start</code>. Until then I answer from the desk&apos;s data files.
              </div>
            )}
          </section>

          <section className="min-w-0" aria-label="Conversation">
            <h1 className="text-xl font-bold tracking-[0.3em] font-mono glow-cyan">J.A.R.V.I.S.</h1>
            <p className="prose-sans text-[13px] mt-1 mb-5 max-w-[60ch]" style={{ color: "var(--hud-muted)" }}>
              Every page, every news outlet, the fleet&apos;s controls, the code to read — answered from the data, spoken aloud, remembered across restarts.
            </p>
            <div className="hud-panel hud-panel-static p-4 h-[56vh] min-h-[380px] flex flex-col">
              <Transcript msgs={j.msgs} state={j.state} suggestions={SUGGESTIONS} onPick={j.ask} className="flex-1" />
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button onClick={() => j.ask(BRIEF)} disabled={j.state === "thinking"} className="hud-btn hud-btn-accent"><Sparkles size={13} aria-hidden /> Brief me</button>
              <button onClick={j.forget} className="hud-btn" title="start a fresh thread; memory notes are kept"><RotateCcw size={13} aria-hidden /> New thread</button>
              <span className="prose-sans text-[11px]" style={{ color: "var(--hud-muted)" }}>⌘J opens JARVIS on any page · ⌘K jumps or asks</span>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); j.ask(input); setInput(""); }} className="flex items-center gap-2 mt-3">
              <button type="button" onClick={() => (j.state === "listening" ? j.stopListening() : j.listen(false))} aria-label={j.state === "listening" ? "stop listening" : "talk"} aria-pressed={j.state === "listening"}
                      className="hud-icon-btn" style={{ color: j.state === "listening" ? "var(--hud-green)" : undefined }}><Mic size={18} /></button>
              <label htmlFor="jarvis-input" className="sr-only">Ask JARVIS</label>
              <input id="jarvis-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ask the desk anything…" autoComplete="off" className="hud-input flex-1 min-w-0 prose-sans" />
              <button type="submit" disabled={j.state === "thinking" || !input.trim()} className="hud-btn hud-btn-accent" style={{ minHeight: 44 }}><Send size={14} aria-hidden /> Ask</button>
            </form>
          </section>
        </div>
      </main>
    </div>
  );
}

function Row({ icon: Icon, label, value, tone }: { icon: any; label: string; value: string; tone: string }) {
  return (
    <div className="flex items-center gap-2 px-3 min-h-[40px] rounded-lg prose-sans text-[12px]" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--hud-border)" }}>
      <Icon size={14} aria-hidden style={{ color: "var(--hud-muted)" }} /><span style={{ color: "var(--hud-muted)" }}>{label}</span><span className="flex-1" /><span className="truncate font-mono text-[11px]" style={{ color: tone }}>{value}</span>
    </div>
  );
}
function Toggle({ icon: Icon, label, on, onChange }: { icon: any; label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} role="switch" aria-checked={on} className="flex items-center gap-2 px-3 min-h-[44px] rounded-lg prose-sans text-[12px] text-left cursor-pointer transition-colors"
            style={{ background: on ? "var(--hud-accent-soft)" : "rgba(255,255,255,0.03)", border: `1px solid ${on ? "rgba(56,189,248,0.35)" : "var(--hud-border)"}` }}>
      <Icon size={14} aria-hidden style={{ color: on ? "var(--hud-accent)" : "var(--hud-muted)" }} /><span style={{ color: "var(--hud-text)" }}>{label}</span><span className="flex-1" />
      <span className="relative inline-block w-9 h-5 rounded-full transition-colors" style={{ background: on ? "var(--hud-accent)" : "var(--hud-border-2)" }} aria-hidden>
        <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform" style={{ transform: on ? "translateX(18px)" : "translateX(2px)" }} />
      </span>
    </button>
  );
}
