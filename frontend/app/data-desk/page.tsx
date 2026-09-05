"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

function CurveChart({ curve }: { curve: { tenor: string; rate: number }[] }) {
  if (!curve?.length) return null;
  const W = 620, H = 130, pad = 26;
  const rates = curve.map((c) => c.rate);
  const lo = Math.min(...rates) - 0.15, hi = Math.max(...rates) + 0.15;
  const x = (i: number) => pad + (i / (curve.length - 1)) * (W - 2 * pad);
  const y = (r: number) => H - pad - ((r - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const path = curve.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c.rate).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }}>
      <path d={path} fill="none" stroke="var(--hud-accent)" strokeWidth="2" />
      {curve.map((c, i) => (
        <g key={c.tenor}>
          <circle cx={x(i)} cy={y(c.rate)} r="2.5" fill="var(--hud-accent)" />
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="9" fill="var(--hud-muted)">{c.tenor}</text>
          <text x={x(i)} y={y(c.rate) - 7} textAnchor="middle" fontSize="9" fill="var(--hud-text)">{c.rate}</text>
        </g>
      ))}
    </svg>
  );
}

export default function DataDeskPage() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/data-desk").then((r) => r.json()).then(setD).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, []);
  const eq: any[] = d?.equities ?? [];
  const cx: any[] = d?.crypto ?? [];
  const tr = d?.treasury;
  const news: any[] = d?.news ?? [];
  const ts = d?.ts ? new Date(d.ts * 1000).toLocaleString() : null;

  const Quote = ({ q }: { q: any }) => (
    <div className="hud-panel hud-panel-static px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-bold" style={{ color: "var(--hud-text)" }}>{q.symbol}</span>
        <span className="text-[11px] font-bold tabular-nums"
              style={{ color: (q.changePct ?? 0) >= 0 ? "var(--hud-green)" : "#f87171" }}>
          {(q.changePct ?? 0) >= 0 ? "+" : ""}{q.changePct}%
        </span>
      </div>
      <div className="text-[14px] font-bold tabular-nums" style={{ color: "var(--hud-text)" }}>${q.price}</div>
    </div>
  );

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-5xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">🛰 DATA DESK</h1>
        <p className="text-[11px] mt-1 mb-1 text-center" style={{ color: "var(--hud-muted)" }}>
          powered by <b style={{ color: "var(--hud-accent)" }}>OpenBB</b> — the Open Data Platform · equities · crypto · rates · inflation · news · keyless, refreshed every 15 min
        </p>
        {ts && <p className="text-[9px] mb-5 text-center" style={{ color: "var(--hud-muted)" }}>snapshot {ts}</p>}

        {/* Macro banner */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-5">
          <div className="hud-panel hud-panel-static p-4 lg:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] tracking-widest" style={{ color: "var(--hud-muted)" }}>US TREASURY YIELD CURVE</div>
              {tr?.spread_2s10s != null && (
                <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>
                  2s10s <b style={{ color: tr.spread_2s10s >= 0 ? "var(--hud-green)" : "#f87171" }}>
                    {tr.spread_2s10s >= 0 ? "+" : ""}{tr.spread_2s10s}
                  </b> {tr.spread_2s10s < 0 && "(inverted)"}
                </div>
              )}
            </div>
            {tr?.curve ? <CurveChart curve={tr.curve} /> : <div className="text-[11px] py-8 text-center" style={{ color: "var(--hud-muted)" }}>loading…</div>}
          </div>
          <div className="hud-panel hud-panel-static p-4 flex flex-col justify-center">
            <div className="text-[10px] tracking-widest" style={{ color: "var(--hud-muted)" }}>US CPI · YEAR-OVER-YEAR</div>
            <div className="text-4xl font-bold tabular-nums mt-2 hud-gradient-text">{d?.cpi_yoy ?? "—"}%</div>
            <div className="text-[9px] mt-1" style={{ color: "var(--hud-muted)" }}>OECD via OpenBB · inflation gauge</div>
          </div>
        </div>

        {/* Crypto */}
        {cx.length > 0 && (
          <>
            <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>CRYPTO</div>
            <div className="grid grid-cols-3 gap-2 mb-5">{cx.map((q) => <Quote key={q.symbol} q={q} />)}</div>
          </>
        )}

        {/* Equities */}
        <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>EQUITIES &amp; ETFs — live quotes</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-5">
          {eq.length === 0 && <div className="text-[11px] py-4 col-span-full text-center" style={{ color: "var(--hud-muted)" }}>loading OpenBB snapshot…</div>}
          {eq.map((q) => <Quote key={q.symbol} q={q} />)}
        </div>

        {/* News */}
        {news.length > 0 && (
          <>
            <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>MARKET NEWS</div>
            <div className="flex flex-col gap-1 mb-6">
              {news.map((n, i) => (
                <a key={i} href={n.url} target="_blank" rel="noreferrer"
                   className="hud-panel hud-panel-static px-3 py-2 flex items-center justify-between gap-3 group">
                  <span className="text-[11px] truncate group-hover:text-[color:var(--hud-accent)]" style={{ color: "var(--hud-text)" }}>{n.title}</span>
                  <span className="text-[9px] whitespace-nowrap" style={{ color: "var(--hud-muted)" }}>{n.symbol} · {n.source}</span>
                </a>
              ))}
            </div>
          </>
        )}

        <div className="text-[10px] pb-8 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
          One SDK, keyless. OpenBB unifies equities, crypto, rates, macro, filings and news across 29 provider extensions — this desk shows the free tier live.
          Add provider keys (FMP, Intrinio, FRED, Benzinga…) to unlock fundamentals, deeper options chains and premium feeds. It&apos;s also a clean data source the backtester and bots can draw on.
        </div>
      </main>
    </div>
  );
}
