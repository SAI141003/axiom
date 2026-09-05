"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

export default function FlowBotPage() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/flow-bot").then((r) => r.json()).then(setD).catch(() => {});
    load(); const t = setInterval(load, 30_000); return () => clearInterval(t);
  }, []);
  const open: any[] = d?.open ?? [];
  const a = d?.account;
  const recent: any[] = a?.recent ?? [];

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">🌊 FLOW BOT</h1>
        <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
          reads the live tape the pros read · Cumulative Delta + Big Trades + DOM · buys strong buy-flow, exits on the flip · intraday · $100 paper, no keys
        </p>

        {a && (
          <div className="hud-panel hud-panel-static px-4 py-3 mb-4 flex items-center justify-between flex-wrap gap-3"
               style={{ borderColor: a.pnl >= 0 ? "rgba(52,211,153,0.45)" : "rgba(248,113,113,0.4)" }}>
            <div>
              <div className="text-[10px] tracking-widest font-bold" style={{ color: "var(--hud-cyan)" }}>$100 PAPER ACCOUNT — LIVE ORDER-FLOW (FORWARD TEST)</div>
              <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>{a.trades} resolved · CVD+big-trades+DOM · 10-min cadence · $30/pos · 8bps/side · NOT backtestable</div>
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

        <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>OPEN POSITIONS — order-flow at entry</div>
        <div className="flex flex-col gap-2">
          {open.length === 0 && <div className="text-[11px] py-4 text-center" style={{ color: "var(--hud-muted)" }}>flat — waiting for strong buy-flow (bias &gt; +0.25). No imbalance = it holds.</div>}
          {open.map((p, i) => (
            <div key={i} className="hud-panel hud-panel-static p-3 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <span className="text-[14px] font-bold" style={{ color: "var(--hud-text)" }}>{p.sym}</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ color: "#0a0e17", background: "var(--hud-green)" }}>LONG</span>
                <span className="text-[11px] tabular-nums" style={{ color: "var(--hud-muted)" }}>@ ${p.entry} · ${p.stake}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] tabular-nums" style={{ color: "var(--hud-muted)" }}>
                <span>CVD <b style={{ color: "var(--hud-green)" }}>{p.cvdRatio >= 0 ? "+" : ""}{(p.cvdRatio * 100).toFixed(0)}%</b></span>
                <span>{p.bigTrades} big</span>
                <span style={{ color: "var(--hud-cyan)" }}>bias {p.bias >= 0 ? "+" : ""}{p.bias}</span>
              </div>
            </div>
          ))}
        </div>

        {recent.length > 0 && (
          <>
            <div className="text-[10px] tracking-widest mb-2 mt-5" style={{ color: "var(--hud-muted)" }}>RECENT CLOSES</div>
            <div className="flex flex-col gap-1">
              {recent.map((r, i) => (
                <div key={i} className="flex items-center justify-between text-[11px] tabular-nums px-3 py-1.5 hud-panel hud-panel-static">
                  <span className="font-bold" style={{ color: "var(--hud-text)" }}>{r.sym}</span>
                  <span style={{ color: "var(--hud-muted)" }}>{r.reason}</span>
                  <span className="font-bold" style={{ color: r.pnl >= 0 ? "var(--hud-green)" : "#f87171" }}>{r.pnl >= 0 ? "+" : ""}${r.pnl}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="text-[10px] mt-5 pb-8 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
          Inspired by the tools of Imre Gams, Patrick Nill &amp; co. — <b style={{ color: "var(--hud-text)" }}>order flow</b> is a real short-horizon edge
          (Cont-Kukanov-Stoikov 2014). But it <b style={{ color: "var(--hud-amber)" }}>can&apos;t be backtested for free</b> (no tick history), so this account earns trust the
          only honest way: forward-testing in the open, no real money. Retail latency is a real handicap vs the pros&apos; co-located feeds — this $100 book is how we find out if the edge survives it.
        </div>
      </main>
    </div>
  );
}
