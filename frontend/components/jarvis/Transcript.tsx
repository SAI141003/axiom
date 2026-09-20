"use client";

import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { Msg, JarvisState } from "@/lib/jarvis";

export function Transcript({ msgs, state, suggestions, onPick, className = "" }: { msgs: Msg[]; state: JarvisState; suggestions?: string[]; onPick?: (s: string) => void; className?: string }) {
  const bottom = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); }, [msgs, state, reduced]);
  return (
    <div className={`flex flex-col gap-3 overflow-y-auto min-w-0 ${className}`} role="log" aria-live="polite" aria-label="JARVIS transcript">
      {msgs.length === 0 && suggestions && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button key={s} onClick={() => onPick?.(s)} className="hud-btn text-left">{s}</button>
          ))}
        </div>
      )}
      {msgs.map((m, i) => (
        <motion.div key={i} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}
                    className={`max-w-[92%] ${m.role === "you" ? "self-end" : "self-start"}`}>
          <div className="text-[9px] tracking-widest mb-1 font-mono" style={{ color: m.role === "you" ? "var(--hud-muted)" : "var(--hud-accent)" }}>
            {m.role === "you" ? "YOU" : "JARVIS"}{m.brain === "local" ? " · LOCAL" : ""}{m.tools?.length ? ` · ${m.tools.join(" → ")}` : ""}
          </div>
          <div className="prose-sans text-[13px] leading-relaxed break-words whitespace-pre-wrap rounded-xl px-3.5 py-2.5"
               style={{ background: m.role === "you" ? "var(--hud-accent-soft)" : "rgba(255,255,255,0.035)", color: "var(--hud-text)", border: "1px solid " + (m.role === "you" ? "rgba(124,154,255,0.22)" : "var(--hud-border)") }}>
            {m.text || (state === "thinking" ? <span className="inline-flex gap-1" aria-label="thinking"><Dot /><Dot d={0.15} /><Dot d={0.3} /></span> : "")}
          </div>
        </motion.div>
      ))}
      <div ref={bottom} />
    </div>
  );
}

function Dot({ d = 0 }: { d?: number }) {
  return <motion.span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: "var(--hud-accent)" }} animate={{ opacity: [0.2, 1, 0.2] }} transition={{ repeat: Infinity, duration: 0.9, delay: d }} />;
}
