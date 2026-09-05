"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

export default function StocksBotPage() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/stocks-bot").then((r) => r.json()).then(setD).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, []);
  const open: any[] = d?.open ?? [];
  const a = d?.account;

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">▦ STOCKS BOT</h1>
        <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
          $100 paper book · multi-factor long/short (12m trend + 5d reversal + Faber + low-vol) · 3-day hold · forward test
        </p>

        {a && (
          <div className="hud-panel hud-panel-static px-4 py-3 mb-4 flex items-center justify-between flex-wrap gap-3"
               style={{ borderColor: a.pnl >= 0 ? "rgba(52,211,153,0.45)" : "rgba(248,113,113,0.4)" }}>
            <div>
              <div className="text-[10px] tracking-widest font-bold" style={{ color: "var(--hud-cyan)" }}>$100 PAPER ACCOUNT</div>
              <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>{a.closed} closed · {a.openCount} open · $10/position</div>
            </div>
            <div className="flex gap-5 tabular-nums text-right">
              <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>ACCOUNT</div>
                <div className="text-2xl font-bold" style={{ color: a.pnl >= 0 ? "var(--hud-green)" : "#f87171" }}>${a.value}</div></div>
              <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>REALIZED P&L</div>
                <div className="text-lg font-bold" style={{ color: a.pnl >= 0 ? "var(--hud-green)" : "#f87171" }}>{a.pnl >= 0 ? "+" : ""}${a.pnl}</div></div>
              <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>WIN RATE</div>
                <div className="text-lg font-bold" style={{ color: "var(--hud-text)" }}>{a.winRate != null ? `${(a.winRate * 100).toFixed(0)}%` : "—"}</div></div>
            </div>
          </div>
        )}

        <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>OPEN POSITIONS — by conviction</div>
        <div className="flex flex-col gap-2">
          {open.length === 0 && <div className="text-[11px] py-4 text-center" style={{ color: "var(--hud-muted)" }}>no open positions</div>}
          {open.map((p, i) => (
            <div key={i} className="hud-panel hud-panel-static p-3 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <span className="text-[14px] font-bold" style={{ color: "var(--hud-text)" }}>{p.symbol}</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ color: "#0a0e17", background: p.side === "LONG" ? "var(--hud-green)" : "var(--hud-amber)" }}>{p.side}</span>
                <span className="text-[11px] tabular-nums" style={{ color: "var(--hud-muted)" }}>@ {p.entry.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-4 text-[10px] tabular-nums" style={{ color: "var(--hud-muted)" }}>
                <span>p(up) <b style={{ color: p.pUp >= 0.5 ? "var(--hud-green)" : "#f87171" }}>{(p.pUp * 100).toFixed(0)}%</b></span>
                <span>conviction {(p.conviction * 100).toFixed(0)}%</span>
              </div>
            </div>
          ))}
        </div>

        <div className="text-[10px] mt-5 pb-8 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
          Honest expectation: stock direction is near-efficient, so this likely lands near break-even (±). The account
          balance over the coming days is the real answer — not a promise. Factors are cited (Moskowitz, Jegadeesh, Faber, Frazzini-Pedersen).
        </div>
      </main>
    </div>
  );
}
