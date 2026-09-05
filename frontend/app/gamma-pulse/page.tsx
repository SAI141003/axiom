"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

export default function GammaPulsePage() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/gamma-pulse").then((r) => r.json()).then(setD).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, []);
  const open: any[] = d?.open ?? [];
  const a = d?.account;

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">◭ GAMMA PULSE</h1>
        <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
          dealer-gamma regime for stocks &amp; options · above zero-γ dampens (revert) · below amplifies (momentum) · $100 paper test
        </p>

        {a && (
          <div className="hud-panel hud-panel-static px-4 py-3 mb-4 flex items-center justify-between flex-wrap gap-3"
               style={{ borderColor: a.pnl >= 0 ? "rgba(52,211,153,0.45)" : "rgba(248,113,113,0.4)" }}>
            <div>
              <div className="text-[10px] tracking-widest font-bold" style={{ color: "var(--hud-cyan)" }}>$100 PAPER ACCOUNT — FORWARD TEST</div>
              <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>{a.trades} resolved · dealer-gamma regime edge · $10/bet</div>
            </div>
            <div className="flex gap-5 tabular-nums text-right">
              <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>ACCOUNT</div>
                <div className="text-2xl font-bold" style={{ color: a.pnl >= 0 ? "var(--hud-green)" : "#f87171" }}>${a.value}</div></div>
              <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>P&amp;L</div>
                <div className="text-lg font-bold" style={{ color: a.pnl >= 0 ? "var(--hud-green)" : "#f87171" }}>{a.pnl >= 0 ? "+" : ""}${a.pnl}</div></div>
              <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>WIN RATE</div>
                <div className="text-lg font-bold" style={{ color: "var(--hud-text)" }}>{a.winRate != null ? `${(a.winRate * 100).toFixed(0)}%` : "—"}</div></div>
            </div>
          </div>
        )}

        <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>OPEN POSITIONS — live gamma read + the bet</div>
        <div className="flex flex-col gap-2">
          {open.length === 0 && <div className="text-[11px] py-4 text-center" style={{ color: "var(--hud-muted)" }}>no open positions — new bets place on the hourly market-hours scan</div>}
          {open.map((p, i) => (
            <div key={i} className="hud-panel hud-panel-static p-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <span className="text-[14px] font-bold" style={{ color: "var(--hud-text)" }}>{p.symbol}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ color: "#0a0e17", background: p.side === "LONG" ? "var(--hud-green)" : "var(--hud-amber)" }}>{p.side}</span>
                  <span className="text-[11px] tabular-nums" style={{ color: "var(--hud-muted)" }}>@ {p.entry}</span>
                </div>
                <span className="text-[10px] font-bold" style={{ color: p.shortGamma ? "var(--hud-cyan)" : "var(--hud-amber)" }}>{p.regime}</span>
              </div>
              <div className="flex items-center gap-4 mt-1 text-[10px] tabular-nums flex-wrap" style={{ color: "var(--hud-muted)" }}>
                <span>support <b style={{ color: "var(--hud-green)" }}>{p.putWall}</b></span>
                <span>resist <b style={{ color: "#f87171" }}>{p.callWall}</b></span>
                <span>flip {p.zeroGamma}</span>
                <span>5d {p.recent5d >= 0 ? "+" : ""}{(p.recent5d * 100).toFixed(1)}%</span>
                <span style={{ color: "var(--hud-cyan)" }}>{p.shortGamma ? "→ momentum (follow)" : "→ mean-revert (fade)"}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="text-[10px] mt-5 pb-8 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
          Grounded in real research (Barbon-Buraschi &quot;Gamma Fragility&quot;; SqueezeMetrics GEX; Ni-Pearson-Poteshman pinning).
          Honest status: UNPROVEN — this $100 account is the forward test. Watch the win rate over the coming days before trusting it.
        </div>
      </main>
    </div>
  );
}
