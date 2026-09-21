"use client";

import { useState } from "react";
import { Mic, Send, Volume2, VolumeX, Radio, RotateCcw, Sparkles, MessageSquare, Brain } from "lucide-react";
import TopNav from "@/components/TopNav";
import { useJarvis, BRIEF } from "@/lib/jarvis";
import { toneFor } from "@/components/jarvis/Reactor";
import { Transcript } from "@/components/jarvis/Transcript";
import MindScene from "@/components/jarvis/MindScene";

const SUGGESTIONS = [
  "How is the fleet doing?",
  "What's in the news that matters for our positions?",
  "Which bot is winning?",
  "Is the desk safe?",
  "What did the backtest say?",
  "Forecast NVDA for a month",
  "Try a momentum + RSI blend and judge it honestly",
  "Create a bot that trades ETH daily on momentum",
];

// AXIOM is the mind of the desk, and the mind is the stage: the anatomical
// brain with the six real feeds docking at its edges and the swarm orbiting
// it. The conversation floats over it. The old /brain page lives here now --
// one AXIOM, one brain, no confusion.
export default function JarvisPage() {
  const [voice, setVoice] = useState(true);
  const [input, setInput] = useState("");
  const [panel, setPanel] = useState(true);
  const j = useJarvis({ voice });
  const tone = toneFor(j.state);

  return (
    <div className="hud-bg min-h-screen relative">
      <TopNav />
      <div className="relative">
        <MindScene />
        <div className="absolute top-4 right-4 z-20 flex flex-col items-end gap-2" style={{ width: "min(440px, calc(100vw - 2rem))" }}>
          <div className="flex items-center gap-2">
            <span className="hud-chip" style={{ color: tone }}>{j.state}</span>
            <span className="hud-chip" style={{ color: j.bridge === "online" ? "var(--hud-green)" : "var(--hud-amber)" }}>{j.bridge === "online" ? (j.brainName || "platform AI") : j.bridge === "connecting" ? "connecting" : "local"}</span>
            <button onClick={() => setPanel((p) => !p)} className="hud-icon-btn" aria-label={panel ? "hide conversation" : "show conversation"} aria-pressed={panel} style={{ background: "rgba(7,10,18,0.7)" }}>{panel ? <Brain size={16} /> : <MessageSquare size={16} />}</button>
          </div>
          {panel && (
            <section aria-label="Conversation" className="hud-glass rounded-2xl w-full flex flex-col" style={{ height: "min(70vh, 640px)" }}>
              <header className="flex items-center gap-3 px-4 h-11 border-b shrink-0" style={{ borderColor: "var(--hud-border)" }}>
                <Sparkles size={14} style={{ color: tone }} aria-hidden />
                <h1 className="text-[11px] font-bold tracking-[0.3em] font-mono m-0" style={{ color: "var(--hud-text)" }}>A.X.I.O.M.</h1>
                <span className="prose-sans text-[11px] truncate" style={{ color: "var(--hud-muted)" }}>say “hey Axiom” from anywhere</span>
                <span className="flex-1" />
                <button onClick={() => j.ask(BRIEF)} disabled={j.state === "thinking"} className="hud-btn hud-btn-accent">Brief</button>
                <button onClick={j.forget} className="hud-icon-btn" aria-label="new thread" title="new thread; memory kept"><RotateCcw size={14} /></button>
              </header>
              <Transcript msgs={j.msgs} state={j.state} suggestions={SUGGESTIONS} onPick={j.ask} className="flex-1 p-4" />
              <form onSubmit={(e) => { e.preventDefault(); j.ask(input); setInput(""); }} className="flex items-center gap-2 p-3 border-t shrink-0" style={{ borderColor: "var(--hud-border)" }}>
                <button type="button" onClick={() => (j.state === "listening" ? j.stopListening() : j.listen(false))} aria-label={j.state === "listening" ? "stop listening" : "talk"} aria-pressed={j.state === "listening"} className="hud-icon-btn" style={{ color: j.state === "listening" ? "var(--hud-green)" : undefined }}><Mic size={16} /></button>
                <label htmlFor="jarvis-input" className="sr-only">Ask AXIOM</label>
                <input id="jarvis-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ask the desk anything…" autoComplete="off" className="hud-input flex-1 min-w-0 prose-sans" style={{ minHeight: 40 }} />
                <button type="submit" disabled={j.state === "thinking" || !input.trim()} className="hud-icon-btn hud-icon-btn-accent" aria-label="send"><Send size={16} /></button>
              </form>
              <div className="flex items-center gap-2 px-3 pb-3 text-[10px] font-mono" style={{ color: "var(--hud-muted)" }}>
                <button onClick={() => setVoice((v) => !v)} className="hud-btn" aria-pressed={voice} style={{ minHeight: 28 }}>{voice ? <Volume2 size={11} aria-hidden /> : <VolumeX size={11} aria-hidden />} voice {voice ? "on" : "off"}</button>
                <span className="inline-flex items-center gap-1"><Radio size={11} aria-hidden style={{ color: j.wakeOn ? "var(--hud-green)" : "var(--hud-muted)" }} /> {j.wakeOn ? "always listening" : "wake word off"}</span>
                {j.micOk === false && <span style={{ color: "var(--hud-red)" }}>mic blocked — allow it in the browser</span>}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
