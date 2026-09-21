"use client";

import { useEffect, useState } from "react";
import { Sparkles, RefreshCw } from "lucide-react";

const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? "just now" : `${m} min ago`; };

// The live summary that sits beside the wall: the freshest headlines from 76
// feeds condensed into six lines, the last one about the desk. Refreshes
// itself every five minutes; the button forces it.
export default function LiveSummary() {
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = async (force = false) => { setBusy(true); try { setD(await (await fetch(`/api/world/summary${force ? "?refresh=1" : ""}`)).json()); } catch {} setBusy(false); };
  useEffect(() => { load(); const t = setInterval(() => load(), 5 * 60_000); return () => clearInterval(t); }, []);
  const lines: string[] = (d?.summary ?? "").split("\n").map((l: string) => l.trim()).filter(Boolean);
  return (
    <aside aria-label="Live summary" className="hud-glass rounded-2xl p-4 flex flex-col gap-3 min-w-0 lg:sticky lg:top-20">
      <div className="flex items-center gap-2">
        <Sparkles size={14} style={{ color: "var(--hud-gold)" }} aria-hidden />
        <span className="text-[10px] tracking-[0.22em] font-bold font-mono" style={{ color: "var(--hud-gold)" }}>LIVE SUMMARY</span>
        <span className="flex-1" />
        <button onClick={() => load(true)} disabled={busy} className="hud-icon-btn" aria-label="refresh summary" style={{ width: 32, height: 32, minHeight: 32 }}><RefreshCw size={13} className={busy ? "animate-spin" : ""} /></button>
      </div>
      {!d && <p className="prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}>reading the world…</p>}
      {d?.summary && (
        <ol className="flex flex-col gap-2.5">
          {lines.map((l, i) => {
            const desk = /^(\d+[.)]\s*)?for the desk/i.test(l);
            return (
              <li key={i} className="prose-sans text-[12.5px] leading-relaxed rounded-lg px-3 py-2" style={{ color: "var(--hud-text)", background: desk ? "var(--hud-gold-soft)" : "rgba(255,255,255,0.03)", border: `1px solid ${desk ? "rgba(245,185,66,0.35)" : "var(--hud-border)"}` }}>
                {l.replace(/^\d+[.)]\s*/, "")}
              </li>
            );
          })}
        </ol>
      )}
      {d && !d.summary && (
        <ul className="flex flex-col gap-2">
          {(d.digest ?? []).map((x: any) => (
            <li key={x.label} className="prose-sans text-[12px] leading-snug" style={{ color: "var(--hud-text)" }}><span className="font-mono text-[10px]" style={{ color: "var(--hud-accent)" }}>{x.label.toUpperCase()} · </span>{x.top} <span style={{ color: "var(--hud-muted)" }}>— {x.source}</span></li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between text-[10px] font-mono" style={{ color: "var(--hud-muted)" }}>
        <span>{d ? `${d.headlines} headlines · ${d.brain === "llm" ? "condensed by the desk's LLM" : "top headline per category"}` : ""}</span>
        <span>{d ? ago(d.generated) : ""}</span>
      </div>
      <button onClick={() => window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: "Given the live world summary on the news desk, what should I watch on our positions today? Three sentences." }))} className="hud-btn hud-btn-accent self-start"><Sparkles size={12} aria-hidden /> Ask AXIOM what it means</button>
    </aside>
  );
}
