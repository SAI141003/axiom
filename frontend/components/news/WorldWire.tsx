"use client";

import { useEffect, useState } from "react";
import { Globe, ExternalLink } from "lucide-react";

const ago = (t: number) => { if (!t) return ""; const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

// The world, by category, freshest first — the World Monitor feed catalog read
// directly. Click a headline to open it; ask JARVIS about any of it.
export default function WorldWire() {
  const [d, setD] = useState<any>(null);
  const [cat, setCat] = useState<string>("markets");
  useEffect(() => { const load = () => fetch("/api/world").then((r) => r.json()).then(setD).catch(() => {}); load(); const t = setInterval(load, 4 * 60_000); return () => clearInterval(t); }, []);
  const cats: any[] = d?.categories ?? [];
  const active = cats.find((c) => c.id === cat) ?? cats[0];
  return (
    <section aria-label="World wire" className="hud-panel hud-panel-static overflow-hidden mb-8 min-w-0">
      <div className="flex items-center gap-3 px-4 h-11 border-b" style={{ borderColor: "var(--hud-border)" }}>
        <Globe size={14} style={{ color: "var(--hud-accent)" }} aria-hidden />
        <span className="text-[10px] tracking-[0.22em] font-bold font-mono" style={{ color: "var(--hud-accent)" }}>WORLD WIRE</span>
        <span className="prose-sans text-[12px] truncate" style={{ color: "var(--hud-muted)" }}>{d ? `${d.items} headlines from ${d.feeds} feeds · refreshed every 4 min` : "reading the world…"}</span>
      </div>
      <div className="flex gap-1 px-3 py-2 overflow-x-auto border-b" style={{ borderColor: "var(--hud-border)", scrollbarWidth: "none" }} role="tablist">
        {cats.map((c) => (
          <button key={c.id} role="tab" aria-selected={active?.id === c.id} onClick={() => setCat(c.id)} className="hud-btn shrink-0"
                  style={{ color: active?.id === c.id ? "var(--hud-accent)" : undefined, borderColor: active?.id === c.id ? "var(--hud-accent)" : "var(--hud-border)" }}>{c.label} · {c.items.length}</button>
        ))}
      </div>
      <ul className="divide-y" style={{ borderColor: "var(--hud-border)" }}>
        {(active?.items ?? []).map((it: any, i: number) => (
          <li key={i} className="flex items-center gap-3 px-4 min-h-[44px] py-2 hud-row">
            <span className="text-[10px] font-mono w-8 shrink-0 text-right" style={{ color: "var(--hud-muted)" }}>{ago(it.when)}</span>
            <a href={it.link} target="_blank" rel="noreferrer" className="prose-sans text-[13px] flex-1 min-w-0 truncate hover:underline" style={{ color: "var(--hud-text)" }}>{it.title}</a>
            <span className="text-[10px] font-mono shrink-0 truncate max-w-[9rem]" style={{ color: "var(--hud-muted)" }}>{it.source}</span>
            <button onClick={() => window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: `What does this headline mean for our positions, in two sentences: "${it.title}" (${it.source})` }))} className="hud-icon-btn shrink-0" aria-label="ask JARVIS about this" title="ask JARVIS"><ExternalLink size={13} /></button>
          </li>
        ))}
        {!active && <li className="px-4 py-6 text-center prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}>reading feeds…</li>}
      </ul>
    </section>
  );
}
