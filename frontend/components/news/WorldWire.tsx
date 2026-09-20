"use client";

import { useEffect, useState } from "react";
import { Globe, Sparkles } from "lucide-react";

const ago = (t: number) => { if (!t) return ""; const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

// Every market, every region: World Monitor's full catalog, 574 feeds in 48
// categories, read on demand. "All" is the market core merged freshest-first.
export default function WorldWire() {
  const [cat, setCat] = useState("all");
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; setBusy(true); fetch(`/api/world?cat=${cat}`).then((r) => r.json()).then((x) => { if (alive) setD(x); }).catch(() => {}).finally(() => alive && setBusy(false)); const t = setInterval(() => fetch(`/api/world?cat=${cat}`).then((r) => r.json()).then((x) => alive && setD(x)).catch(() => {}), 5 * 60_000); return () => { alive = false; clearInterval(t); }; }, [cat]);
  const catalog: Record<string, number> = d?.catalog ?? {};
  const labels: Record<string, string> = d?.labels ?? {};
  const items: any[] = d?.items ?? [];
  return (
    <section aria-label="World wire" className="hud-panel hud-panel-static overflow-hidden mb-8 min-w-0">
      <div className="flex items-center gap-3 px-4 h-11 border-b" style={{ borderColor: "var(--hud-border)" }}>
        <Globe size={14} style={{ color: "var(--hud-accent)" }} aria-hidden />
        <span className="text-[10px] tracking-[0.22em] font-bold font-mono" style={{ color: "var(--hud-accent)" }}>WORLD WIRE</span>
        <span className="prose-sans text-[12px] truncate" style={{ color: "var(--hud-muted)" }}>{d ? `${d.total_feeds} feeds · ${Object.keys(catalog).length} categories · showing ${items.length} from ${d.feeds} feed${d.feeds === 1 ? "" : "s"}${busy ? " · refreshing…" : ""}` : "reading the world…"}</span>
      </div>
      <div className="flex gap-1 px-3 py-2 overflow-x-auto border-b" style={{ borderColor: "var(--hud-border)", scrollbarWidth: "none" }} role="tablist" aria-label="Category">
        <button role="tab" aria-selected={cat === "all"} onClick={() => setCat("all")} className="hud-btn shrink-0" style={{ color: cat === "all" ? "var(--hud-gold)" : undefined, borderColor: cat === "all" ? "var(--hud-gold)" : "var(--hud-border)" }}>All markets</button>
        {Object.keys(catalog).map((c) => (
          <button key={c} role="tab" aria-selected={cat === c} onClick={() => setCat(c)} className="hud-btn shrink-0"
                  style={{ color: cat === c ? "var(--hud-accent)" : undefined, borderColor: cat === c ? "var(--hud-accent)" : "var(--hud-border)" }}>{labels[c] ?? c} · {catalog[c]}</button>
        ))}
      </div>
      <ul className="max-h-[70vh] overflow-y-auto">
        {items.map((it: any, i: number) => (
          <li key={i} className="flex items-center gap-3 px-4 min-h-[44px] py-2 hud-row">
            <span className="text-[10px] font-mono w-8 shrink-0 text-right" style={{ color: "var(--hud-muted)" }}>{ago(it.when)}</span>
            {cat === "all" && <span className="hud-chip shrink-0 hidden md:inline-flex" style={{ padding: "1px 8px" }}>{labels[it.cat] ?? it.cat}</span>}
            <a href={it.link} target="_blank" rel="noreferrer" className="prose-sans text-[13px] flex-1 min-w-0 truncate hover:underline" style={{ color: "var(--hud-text)" }}>{it.title}</a>
            <span className="text-[10px] font-mono shrink-0 truncate max-w-[9rem]" style={{ color: "var(--hud-muted)" }}>{it.source}</span>
            <button onClick={() => window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: `What does this headline mean for our positions, in two sentences: "${it.title}" (${it.source})` }))} className="hud-icon-btn shrink-0" aria-label="ask JARVIS about this" title="ask JARVIS"><Sparkles size={13} /></button>
          </li>
        ))}
        {!items.length && <li className="px-4 py-6 text-center prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}>{busy ? "reading feeds…" : "nothing fresh in this category right now"}</li>}
      </ul>
    </section>
  );
}
