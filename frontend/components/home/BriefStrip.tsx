"use client";

import { useState } from "react";
import { Sparkles, ArrowRight } from "lucide-react";
import { BRIEF } from "@/lib/jarvis";

// The first thing on the desk: one button, and JARVIS tells you what happened
// while you were away. It opens the dock with the briefing already running.
export default function BriefStrip() {
  const [asked, setAsked] = useState(false);
  const brief = () => { setAsked(true); window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: BRIEF })); };
  const [q, setQ] = useState("");
  return (
    <section aria-label="Ask JARVIS" className="hud-glass rounded-2xl p-4 mb-10 flex flex-col md:flex-row md:items-center gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <span className="hud-page-icon" style={{ width: 40, height: 40 }} aria-hidden><Sparkles size={18} /></span>
        <div className="min-w-0">
          <div className="text-[11px] font-bold tracking-[0.22em] font-mono" style={{ color: "var(--hud-text)" }}>JARVIS</div>
          <div className="prose-sans text-[12px] truncate" style={{ color: "var(--hud-muted)" }}>{asked ? "briefing you in the dock →" : "what happened since yesterday, the bots, the news that matters — spoken"}</div>
        </div>
      </div>
      <form className="flex-1 flex items-center gap-2 min-w-0" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: q.trim() })); setQ(""); } }}>
        <label htmlFor="home-ask" className="sr-only">Ask JARVIS</label>
        <input id="home-ask" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ask anything about the desk…" autoComplete="off" className="hud-input flex-1 min-w-0 prose-sans" style={{ minHeight: 40 }} />
        <button type="submit" disabled={!q.trim()} className="hud-icon-btn hud-icon-btn-accent" aria-label="ask"><ArrowRight size={16} /></button>
      </form>
      <button onClick={brief} className="hud-btn hud-btn-accent" style={{ minHeight: 40 }}><Sparkles size={13} aria-hidden /> Brief me</button>
    </section>
  );
}
