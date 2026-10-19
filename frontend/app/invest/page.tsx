"use client";

import { Fragment, useEffect, useState } from "react";
import TopNav from "@/components/TopNav";
import { PiggyBank, ChevronDown } from "lucide-react";
import SipPlanner, { type Market, pc, big, tone, Spark } from "@/components/invest/SipPlanner";

// INVEST — the long-term side of the desk. The 20 largest ETFs in the US and
// Canada from live data, a monthly-SIP planner that back-tests and projects
// the plan, and a watch on the funds it picks: live chart, a tested buy/sell
// rule with exact dates and times, and their news.

export default function InvestPage() {
  const [market, setMarket] = useState<Market>("us");
  const [uni, setUni] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    setUni(null);
    fetch(`/api/invest/universe?market=${market}`).then((r) => r.json()).then(setUni).catch(() => setUni({ etfs: [] }));
  }, [market]);

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 font-mono">
        <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
          <div>
            <h1 className="text-xl font-bold tracking-[0.2em] flex items-center gap-2"><PiggyBank size={20} aria-hidden /> INVEST</h1>
            <p className="prose-sans text-xs mt-1" style={{ color: "var(--hud-muted)" }}>
              Monthly SIP planner and the 20 largest ETFs — live prices, dividends included, every number computed from real history. A plan, not advice.
            </p>
          </div>
          <div className="flex gap-2" role="tablist" aria-label="Market">
            {([["us", "🇺🇸 UNITED STATES"], ["ca", "🇨🇦 CANADA"]] as const).map(([m, l]) => (
              <button key={m} role="tab" aria-selected={market === m} onClick={() => setMarket(m)}
                      className={`hud-chip ${market === m ? "hud-nav-active" : ""}`} style={{ cursor: "pointer", color: market === m ? undefined : "var(--hud-muted)" }}>{l}</button>
            ))}
          </div>
        </div>

        <SipPlanner market={market} uni={uni} />

        {/* ── the 20 largest ETFs ── */}
        <section className="hud-panel hud-panel-static p-0 mb-6 overflow-hidden" aria-label="Top 20 ETFs">
          <div className="px-4 pt-4 pb-2 flex items-baseline justify-between flex-wrap gap-2">
            <h2 className="text-[11px] tracking-[0.25em] font-bold m-0" style={{ color: "var(--hud-accent)" }}>TOP 20 ETFs · {market === "us" ? "UNITED STATES" : "CANADA"} · BY ASSETS</h2>
            <span className="prose-sans text-[11px]" style={{ color: "var(--hud-muted)" }}>returns are yearly averages with dividends reinvested · tap a row for what it holds</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] tabular-nums">
              <thead>
                <tr style={{ color: "var(--hud-muted)" }}>
                  {["ETF", "SIZE", "FEE", "1 YR", "5 YR", "10 YR", "WORST FALL", "10-YR CHART", ""].map((h) => <th key={h} className="text-left px-3 py-2 font-normal tracking-widest text-[9px]">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {!uni && <tr><td colSpan={9} className="px-3 py-6" style={{ color: "var(--hud-muted)" }}>Loading live fund data…</td></tr>}
                {uni?.etfs?.map((e: any) => (
                  <Fragment key={e.symbol}>
                    <tr className="hud-row cursor-pointer" onClick={() => setOpen(open === e.symbol ? null : e.symbol)} aria-expanded={open === e.symbol}
                        style={{ borderTop: "1px solid var(--hud-border)" }}>
                      <td className="px-3 py-2 min-w-[180px]"><div className="font-bold">{e.symbol.replace(".TO", "")}</div>
                        <div className="prose-sans text-[10px] truncate max-w-[220px]" style={{ color: "var(--hud-muted)" }}>{e.name}</div></td>
                      <td className="px-3 py-2">{big(e.aum)}</td>
                      <td className="px-3 py-2">{e.expense != null ? `${(e.expense * 100).toFixed(2)}%` : "—"}</td>
                      <td className="px-3 py-2" style={{ color: tone(e.r1) }}>{pc(e.r1)}</td>
                      <td className="px-3 py-2" style={{ color: tone(e.r5) }}>{pc(e.r5)}</td>
                      <td className="px-3 py-2" style={{ color: tone(e.r10) }}>{pc(e.r10)}</td>
                      <td className="px-3 py-2" style={{ color: "var(--hud-red)" }}>{pc(e.maxDD, 0)}</td>
                      <td className="px-3 py-2"><Spark data={e.spark} /></td>
                      <td className="px-3 py-2"><ChevronDown size={12} style={{ transform: open === e.symbol ? "rotate(180deg)" : undefined }} aria-hidden /></td>
                    </tr>
                    {open === e.symbol && (
                      <tr><td colSpan={9} className="px-3 pb-3">
                        <div className="grid md:grid-cols-3 gap-3 text-[11px]">
                          <div><div className="text-[9px] tracking-widest mb-1" style={{ color: "var(--hud-accent)" }}>BIGGEST HOLDINGS</div>
                            {e.holdings.length ? e.holdings.map((h: any) => <div key={h.name} className="flex justify-between gap-2"><span className="truncate prose-sans">{h.name}</span><span>{pc(h.weight)}</span></div>)
                              : <span style={{ color: "var(--hud-muted)" }}>bonds / bullion — no single company</span>}</div>
                          <div><div className="text-[9px] tracking-widest mb-1" style={{ color: "var(--hud-accent)" }}>SECTORS</div>
                            {e.sectors.map((s: any) => <div key={s.name} className="flex justify-between gap-2"><span className="capitalize prose-sans">{s.name}</span><span>{pc(s.weight)}</span></div>)}
                            <div className="mt-1" style={{ color: "var(--hud-muted)" }}>{pc(e.stock, 0)} stocks · {pc(e.bond, 0)} bonds · yield {pc(e.yield, 2)}</div></div>
                          <div><div className="text-[9px] tracking-widest mb-1" style={{ color: "var(--hud-accent)" }}>HOW IT CONNECTS</div>
                            <p className="prose-sans leading-snug m-0">
                              {e.twin ? <>Moves almost exactly with <b>{e.twin.replace(".TO", "")}</b> — owning both doubles up, pick the cheaper one. </> : null}
                              {e.corr != null && <>Moves {Math.round(e.corr * 100)}% in step with the {market === "us" ? "S&P 500 (SPY)" : "TSX (XIC)"}{e.corr < 0.5 ? " — a real diversifier" : e.corr < 0.85 ? " — partly diversifying" : ""}. </>}
                              Swings about {pc(e.vol, 0)} a year; Sharpe {e.sharpe?.toFixed(2) ?? "—"}.
                            </p></div>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <p className="prose-sans text-[10px] mb-8" style={{ color: "var(--hud-muted)" }}>
          Data: Yahoo Finance (prices, fund profiles, holdings) and Yahoo's news feeds, refreshed every 6 hours. Past returns do not promise future ones; this is a research tool, not financial advice.
        </p>
      </main>
    </div>
  );
}

