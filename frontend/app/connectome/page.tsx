"use client";

import { useEffect, useMemo, useState } from "react";
import { Network, Sparkles } from "lucide-react";
import TopNav from "@/components/TopNav";
import PageHeader from "@/components/PageHeader";
import { usd } from "@/components/charts";

const LAYER_LABEL: Record<string, string> = { sensor: "SENSES", signal: "SIGNALS", research: "RESEARCH", execution: "EXECUTION", bot: "BOTS", book: "BOOKS", mind: "MIND" };
const W = 1320, H = 720, PAD = 40;

// The desk's nervous system, drawn from the code itself: every module is a
// node, every import a wire, every feed a sense, every paper book an organ.
// Wires that carried today's activity glow. After the fly connectome: see the
// wiring, then watch it fire.
export default function ConnectomePage() {
  const [d, setD] = useState<any>(null);
  const [pick, setPick] = useState<any>(null);
  const [onlyLit, setOnlyLit] = useState(false);
  useEffect(() => { fetch("/api/connectome").then((r) => r.json()).then(setD).catch(() => {}); }, []);

  const layout = useMemo(() => {
    if (!d) return null;
    const layers: string[] = d.layers; const cols = layers.length;
    const byLayer: Record<string, any[]> = {}; for (const n of d.nodes) (byLayer[n.layer] ??= []).push(n);
    const pos: Record<string, [number, number]> = {};
    layers.forEach((L, i) => {
      const list = (byLayer[L] ?? []).sort((a, b) => Number(b.lit) - Number(a.lit) || a.label.localeCompare(b.label));
      const x = PAD + (i + 0.5) * ((W - 2 * PAD) / cols);
      list.forEach((n, j) => { pos[n.id] = [x, PAD + (j + 0.5) * ((H - 2 * PAD) / Math.max(list.length, 1))]; });
    });
    return { pos, byLayer };
  }, [d]);

  const nodes: any[] = d?.nodes ?? []; const edges: any[] = d?.edges ?? [];
  const neigh = useMemo(() => { const s = new Set<string>(); if (pick) for (const e of edges) { if (e.from === pick.id) s.add(e.to); if (e.to === pick.id) s.add(e.from); } return s; }, [pick, edges]);
  const visible = (x: any) => !onlyLit || x.lit;

  return (
    <div className="hud-bg min-h-screen relative">
      <div className="hud-ambient" aria-hidden />
      <TopNav />
      <main className="relative max-w-7xl mx-auto p-6 font-mono">
        <PageHeader icon={Network} title="CONNECTOME">
          the desk&apos;s nervous system, read from the code: {d ? `${d.stats.nodes} nodes · ${d.stats.edges} wires · ${d.stats.sensors} senses · ${d.stats.lit_nodes} lit by the last 24 hours` : "scanning…"}
        </PageHeader>
        <div className="flex items-center gap-2 mb-3">
          <button onClick={() => setOnlyLit((v) => !v)} aria-pressed={onlyLit} className="hud-btn" style={{ color: onlyLit ? "var(--hud-gold)" : undefined, borderColor: onlyLit ? "var(--hud-gold)" : undefined }}>{onlyLit ? "showing: what fired today" : "show only what fired today"}</button>
          <span className="prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}>click a node to trace its wires · wires in gold carried today&apos;s activity, sense to book</span>
        </div>
        <div className="grid xl:grid-cols-[1fr_280px] gap-4 items-start">
          <div className="hud-panel hud-panel-static overflow-hidden" style={{ background: "radial-gradient(ellipse at 50% 30%, #0b1626 0%, #05070c 75%)" }}>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="AXIOM connectome graph">
              {layout && (d.layers as string[]).map((L, i) => (
                <text key={L} x={PAD + (i + 0.5) * ((W - 2 * PAD) / d.layers.length)} y={18} textAnchor="middle" style={{ fontSize: 10, letterSpacing: 3, fill: "#93a0b8", fontFamily: "JetBrains Mono, monospace" }}>{LAYER_LABEL[L] ?? L.toUpperCase()}</text>
              ))}
              {layout && edges.filter(visible).map((e, i) => {
                const a = layout.pos[e.from], b = layout.pos[e.to]; if (!a || !b) return null;
                const hot = pick ? (e.from === pick.id || e.to === pick.id) : false;
                const mx = (a[0] + b[0]) / 2;
                return <path key={i} d={`M${a[0]},${a[1]} C${mx},${a[1]} ${mx},${b[1]} ${b[0]},${b[1]}`} fill="none" stroke={hot ? "#7dd3fc" : e.lit ? "#f5b942" : "#1e2f48"} strokeWidth={hot ? 1.6 : e.lit ? 1.1 : 0.6} opacity={pick && !hot ? 0.25 : e.lit ? 0.9 : 0.7} />;
              })}
              {layout && nodes.filter(visible).map((n) => {
                const p = layout.pos[n.id]; if (!p) return null;
                const isPick = pick?.id === n.id, near = neigh.has(n.id);
                const r = n.layer === "book" ? 7 : n.layer === "mind" ? 9 : n.layer === "sensor" ? 5 : 3.5;
                const fill = n.layer === "book" ? (n.pnl > 0 ? "#22c55e" : n.pnl < 0 ? "#ef4444" : "#93a0b8") : n.lit ? "#f5b942" : n.layer === "sensor" ? "#38bdf8" : "#2c3a4f";
                return (
                  <g key={n.id} transform={`translate(${p[0]},${p[1]})`} onClick={() => setPick(isPick ? null : n)} style={{ cursor: "pointer" }} opacity={pick && !isPick && !near ? 0.3 : 1}>
                    <circle r={r + (isPick ? 3 : 0)} fill={fill} stroke={isPick ? "#ffffff" : "#05070c"} strokeWidth={isPick ? 1.5 : 0.8} style={n.lit || isPick ? { filter: `drop-shadow(0 0 4px ${fill})` } : undefined} />
                    {(n.layer !== "signal" && n.layer !== "research" || isPick || near) && <text x={r + 4} y={3} style={{ fontSize: 8.5, fill: isPick ? "#ffffff" : "#c7d0e0", fontFamily: "JetBrains Mono, monospace" }}>{n.label}</text>}
                  </g>
                );
              })}
            </svg>
          </div>
          <aside className="hud-glass rounded-2xl p-4 flex flex-col gap-3 min-w-0 lg:sticky lg:top-20">
            {!pick && <p className="prose-sans text-[12.5px] leading-relaxed" style={{ color: "var(--hud-muted)" }}>Senses on the left, the mind on the right. Gold is what fired in the last 24 hours — the pathway from a feed through the signal modules to a book that traded. Click anything to trace it. This is built from the real imports and the real logs, so it can only show what exists.</p>}
            {pick && (
              <>
                <div className="text-[10px] tracking-widest" style={{ color: "var(--hud-accent)" }}>{(LAYER_LABEL[pick.layer] ?? pick.layer).toUpperCase()}</div>
                <div className="prose-sans text-[14px] font-semibold break-words" style={{ color: "var(--hud-text)" }}>{pick.label}</div>
                {pick.id.includes("/") && <a href={`https://github.com/SAI141003/axiom/blob/main/${pick.id}`} target="_blank" rel="noreferrer" className="text-[10px] hover:underline" style={{ color: "var(--hud-accent)" }}>{pick.id}{pick.lines ? ` · ${pick.lines} lines` : ""}</a>}
                {pick.layer === "book" && pick.account != null && <div className="text-[12px] tabular-nums" style={{ color: "var(--hud-text)" }}>book {usd(pick.account)} · P&L <b style={{ color: pick.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>{pick.pnl >= 0 ? "+" : ""}{usd(pick.pnl)}</b>{pick.win_rate != null ? ` · win ${(pick.win_rate * 100).toFixed(0)}%` : ""}{pick.events_24h != null ? ` · ${pick.events_24h} events today` : ""}</div>}
                <div className="text-[10px] tracking-widest mt-1" style={{ color: "var(--hud-muted)" }}>WIRED TO · {neigh.size}</div>
                <ul className="flex flex-col gap-1 max-h-[40vh] overflow-y-auto">{[...neigh].map((id) => { const n = nodes.find((x) => x.id === id); return n ? <li key={id} className="text-[11px] cursor-pointer hover:underline" style={{ color: n.lit ? "var(--hud-gold)" : "var(--hud-text)" }} onClick={() => setPick(n)}>{n.label} <span style={{ color: "var(--hud-muted)" }}>· {LAYER_LABEL[n.layer]?.toLowerCase()}</span></li> : null; })}</ul>
                <button onClick={() => window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: `On the connectome I picked "${pick.label}" (${pick.id}). What does it do, what feeds it, and is it earning its keep? Three sentences.` }))} className="hud-btn hud-btn-accent self-start mt-1"><Sparkles size={12} aria-hidden /> Ask JARVIS</button>
              </>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
