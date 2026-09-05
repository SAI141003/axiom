"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";
import { getToggle } from "@/lib/toggles";

interface Result {
  symbol: string; price: number; preMarketPx: number | null; prevClose: number;
  gapPct: number; avgDailyRange: number; yzVolPct: number; ret5dPct: number;
  first20: { avgAbsMove: number; days: number; gapContinuationPct: number };
  forecast: { p10: number; p50: number; p90: number; direction: string; n: number };
  styleScore: number;
  plan: {
    direction: "LONG" | "SHORT"; shares: number; entry: number; target: number;
    stop: number; exitBy: string; expectedProfit: number; maxLoss: number;
  };
}

export default function PreMarketPage() {
  const [budget, setBudget] = useState("1000");
  const [results, setResults] = useState<Result[]>([]);
  const [meta, setMeta] = useState({ universeSize: 0, scanned: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = async (b = budget) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/premarket?budget=${encodeURIComponent(b)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResults(data.results ?? []);
      setMeta({ universeSize: data.universeSize, scanned: data.scanned });
      setUpdated(new Date());
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Live price ticks every 10s — updates prices + gap in place, no rescan
  useEffect(() => {
    if (results.length === 0) return;
    const syms = results.map((r) => r.symbol).join(",");
    const tick = async () => {
      try {
        const res = await fetch(`/api/quotes?symbols=${syms}`);
        if (!res.ok) return;
        const rows: { symbol: string; price: number | null; prevClose: number | null }[] = await res.json();
        setResults((prev) => prev.map((r) => {
          const q = rows.find((x) => x.symbol === r.symbol);
          if (!q?.price) return r;
          const prevC = q.prevClose ?? r.prevClose;
          return {
            ...r,
            preMarketPx: q.price,
            prevClose: prevC,
            gapPct: +(((q.price - prevC) / prevC) * 100).toFixed(2),
          };
        }));
        setUpdated(new Date());
      } catch { /* next tick */ }
    };
    const id = setInterval(() => { if (getToggle("premarket.liveTicks")) tick(); }, 10_000);
    return () => clearInterval(id);
  }, [results.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const dirColor = (d: string) => (d === "LONG" ? "var(--hud-green)" : "var(--hud-red)");
  const top = results.slice(0, 3);
  const rest = results.slice(3);

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <div className="flex items-end justify-between flex-wrap gap-3 mb-2">
          <div>
            <h1 className="text-xl font-bold tracking-[0.2em] glow-green">◭ PRE-MARKET SCANNER</h1>
            <p className="text-xs mt-1 flex items-center gap-2" style={{ color: "var(--hud-muted)" }}>
              <span className="hud-led inline-block" style={{ color: "var(--hud-green)", background: "var(--hud-green)", width: 6, height: 6 }} />
              LIVE — prices tick every 10s, no refresh needed.
              Your style: ${budget}/trade · under-$10 · first-20-min exits.
              {updated && ` Last tick ${updated.toLocaleTimeString()}.`}
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="text-[10px] tracking-widest block mb-1" style={{ color: "var(--hud-muted)" }}>BUDGET $</label>
              <input value={budget} onChange={(e) => setBudget(e.target.value)}
                     className="w-24 px-3 py-2 text-xs outline-none tabular-nums"
                     style={{ background: "rgba(6,9,19,0.8)", border: "1px solid var(--hud-border)", color: "var(--hud-text)" }} />
            </div>
            <button onClick={() => load()} disabled={loading}
                    className="hud-chip hud-nav-active"
                    style={{ cursor: loading ? "wait" : "pointer", height: 34 }}>
              {loading ? "⟳ SCANNING…" : "↻ RESCAN"}
            </button>
          </div>
        </div>
        <div className="text-[10px] mb-5" style={{ color: "var(--hud-muted)" }}>
          Universe: {meta.universeSize} liquid under-$10 names from live screeners · deep-scanned top {meta.scanned} by volume ·
          research: Yang-Zhang vol + first-20-min stats (real 5-min candles, 5 days) + TimesFM-style quantile forecast + gap continuation
        </div>

        {error && <div className="hud-panel hud-panel-static p-4 mb-4 text-xs" style={{ color: "var(--hud-red)" }}>⚠ {error}</div>}
        {loading && results.length === 0 && (
          <div className="text-center py-20 text-sm" style={{ color: "var(--hud-muted)" }}>
            Scanning live screeners + 5-min history…
          </div>
        )}

        {/* TOP PICKS */}
        {top.length > 0 && (
          <>
            <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-amber)" }}>
              ★ TOP PICKS FOR THE OPEN (by style-fit score)
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
              {top.map((r, i) => (
                <div key={r.symbol} className="hud-panel hud-panel-static p-4"
                     style={i === 0 ? { borderColor: "rgba(251,191,36,0.5)" } : undefined}>
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-bold">{i === 0 && "★ "}{r.symbol}</span>
                    <span className="hud-chip font-bold" style={{ color: dirColor(r.plan.direction) }}>
                      {r.plan.direction}
                    </span>
                  </div>
                  <div className="tabular-nums text-sm mt-1">
                    ${(r.preMarketPx ?? r.price).toFixed(2)}
                    <span className="text-[10px] ml-2" style={{ color: r.gapPct >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                      gap {r.gapPct >= 0 ? "+" : ""}{r.gapPct}%
                    </span>
                    <span className="text-[10px] ml-2" style={{ color: "var(--hud-muted)" }}>
                      score {r.styleScore}
                    </span>
                  </div>

                  <div className="mt-3 p-2.5 text-[11px] tabular-nums"
                       style={{ background: "rgba(6,9,19,0.6)", border: `1px solid ${dirColor(r.plan.direction)}44` }}>
                    <div className="font-bold mb-1" style={{ color: dirColor(r.plan.direction) }}>
                      {r.plan.direction} {r.plan.shares} shares @ ${r.plan.entry}
                    </div>
                    <div>target <span style={{ color: "var(--hud-green)" }}>${r.plan.target}</span> ·
                         stop <span style={{ color: "var(--hud-red)" }}>${r.plan.stop}</span></div>
                    <div>exit by <span style={{ color: "var(--hud-amber)" }}>{r.plan.exitBy}</span></div>
                    <div className="mt-1">
                      expected <span style={{ color: "var(--hud-green)" }}>+${r.plan.expectedProfit}</span> /
                      max loss <span style={{ color: "var(--hud-red)" }}>-${r.plan.maxLoss}</span>
                    </div>
                  </div>

                  <div className="mt-2 text-[10px] leading-relaxed" style={{ color: "var(--hud-muted)" }}>
                    range ${r.avgDailyRange}/day · 1st-20-min avg ${r.first20.avgAbsMove} ({r.first20.days}d) ·
                    gap-continue {r.first20.gapContinuationPct}% ·
                    forecast p10 {r.forecast.p10} / p50 {r.forecast.p50} / p90 {r.forecast.p90}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Rest of universe */}
        {rest.length > 0 && (
          <div className="hud-panel hud-panel-static overflow-x-auto">
            <table className="w-full text-[11px] tabular-nums">
              <thead>
                <tr style={{ background: "rgba(12,18,34,0.9)", color: "var(--hud-muted)" }}>
                  <th className="text-left px-3 py-2">SYM</th>
                  <th className="text-right px-3 py-2">PRICE</th>
                  <th className="text-right px-3 py-2">GAP%</th>
                  <th className="text-right px-3 py-2">$/DAY</th>
                  <th className="text-right px-3 py-2">1ST-20M</th>
                  <th className="text-right px-3 py-2">GAP-CONT</th>
                  <th className="text-right px-3 py-2">P50</th>
                  <th className="text-right px-3 py-2">SCORE</th>
                  <th className="text-left px-3 py-2">PLAN</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((r) => (
                  <tr key={r.symbol} className="hud-row">
                    <td className="px-3 py-1.5 font-bold">{r.symbol}</td>
                    <td className="text-right px-3 py-1.5">${(r.preMarketPx ?? r.price).toFixed(2)}</td>
                    <td className="text-right px-3 py-1.5"
                        style={{ color: r.gapPct >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                      {r.gapPct >= 0 ? "+" : ""}{r.gapPct}%
                    </td>
                    <td className="text-right px-3 py-1.5">${r.avgDailyRange}</td>
                    <td className="text-right px-3 py-1.5">${r.first20.avgAbsMove}</td>
                    <td className="text-right px-3 py-1.5">{r.first20.gapContinuationPct}%</td>
                    <td className="text-right px-3 py-1.5">{r.forecast.p50}</td>
                    <td className="text-right px-3 py-1.5 font-bold">{r.styleScore}</td>
                    <td className="px-3 py-1.5" style={{ color: dirColor(r.plan.direction) }}>
                      {r.plan.direction} {r.plan.shares}sh → ${r.plan.target}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[10px] mt-5 pb-8" style={{ color: "var(--hud-muted)" }}>
          All data live from Yahoo (screeners, 5-min candles incl. pre-market). A forward-test daemon logs every
          morning&apos;s picks and scores them against the real first-20-minutes — results in the dry-run analyzer.
          Educational only, not financial advice.
        </p>
      </main>
    </div>
  );
}
