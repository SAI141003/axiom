"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

export default function MemeBotPage() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/meme-bot").then((r) => r.json()).then(setD).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, []);
  const open: any[] = d?.open ?? [];
  const a = d?.account;
  const recent: any[] = a?.recent ?? [];

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">🐕 MEME BOT</h1>
        <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
          meme-coin momentum · buy the pump (1h+24h strength) · bail on the reversal · liquid coins only · $100 paper, zero real money
        </p>

        {a && (
          <div className="hud-panel hud-panel-static px-4 py-3 mb-4 flex items-center justify-between flex-wrap gap-3"
               style={{ borderColor: a.pnl >= 0 ? "rgba(52,211,153,0.45)" : "rgba(248,113,113,0.4)" }}>
            <div>
              <div className="text-[10px] tracking-widest font-bold" style={{ color: "var(--hud-cyan)" }}>$100 PAPER ACCOUNT — HIGH-RISK CASINO TEST</div>
              <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>{a.trades} resolved · momentum chase · $20/bet · CoinGecko live data</div>
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

        <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>OPEN POSITIONS — live momentum + entry</div>
        <div className="flex flex-col gap-2">
          {open.length === 0 && <div className="text-[11px] py-4 text-center" style={{ color: "var(--hud-muted)" }}>no open positions — the bot only buys real pumps. all red = it sits out (that&apos;s the discipline)</div>}
          {open.map((p, i) => (
            <div key={i} className="hud-panel hud-panel-static p-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <span className="text-[14px] font-bold" style={{ color: "var(--hud-text)" }}>{p.sym}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ color: "#0a0e17", background: "var(--hud-green)" }}>LONG</span>
                  <span className="text-[11px] tabular-nums" style={{ color: "var(--hud-muted)" }}>@ ${p.entry}</span>
                </div>
                <span className="text-[10px] font-bold tabular-nums" style={{ color: "var(--hud-cyan)" }}>score {p.score}</span>
              </div>
              <div className="flex items-center gap-4 mt-1 text-[10px] tabular-nums flex-wrap" style={{ color: "var(--hud-muted)" }}>
                <span>1h <b style={{ color: p.m1h >= 0 ? "var(--hud-green)" : "#f87171" }}>{p.m1h >= 0 ? "+" : ""}{p.m1h}%</b></span>
                <span>24h <b style={{ color: p.m24h >= 0 ? "var(--hud-green)" : "#f87171" }}>{p.m24h >= 0 ? "+" : ""}{p.m24h}%</b></span>
                <span style={{ color: "var(--hud-cyan)" }}>→ ride until 1h turns down (−1.5%) or 12h max hold</span>
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
          Honest framing: chasing meme-coin momentum is <b style={{ color: "var(--hud-amber)" }}>near-casino</b> — you buy near local tops and pumps snap back.
          This $100 paper account is the proof before a single real cent is at risk. NO wallet, NO real money, established liquid coins only
          (DOGE/SHIB/PEPE/WIF/BONK…), never fresh micro-caps where the rug pulls live. Watch the win rate over the coming days — if it bleeds, that&apos;s the lesson that saves your real money.
        </div>
      </main>
    </div>
  );
}
