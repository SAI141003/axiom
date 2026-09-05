"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";
import EngineBanner from "@/components/EngineBanner";
import { getToggle } from "@/lib/toggles";

interface Contract {
  strike: number; bid: number; ask: number; mid: number;
  iv: number; oi: number; volume: number; delta: number; spreadPct: number;
}

interface Result {
  symbol: string; price: number;
  metrics: {
    yangZhangRv: number; atmIv: number; ivPremiumPct: number;
    ret1mPct: number; ret3mPct: number; aboveSma50: boolean; score: number;
  };
  expiry: string; dte: number;
  direction: "CALL" | "PUT" | "SKIP";
  recommendation: { type: string; strike: number; mid: number; bid: number; ask: number; delta: number; iv: number; oi: number; spreadPct: number } | null;
  sizing: { contracts: number; costPerContract: number; totalCost: number; maxLossUsd: number; breakeven: number; breakevenMovePct: number; riskPctOfBankroll: number; note: string | null } | null;
  montecarlo: { paths: number; method: string; horizonDays: number; p10: number; p50: number; p90: number; pGain: number; meanTerminal: number } | null;
  mcContract: { paths: number; pITM: number; pProfit: number; mcFair: number; mcEdgePct: number; expectedPnlPerContract: number } | null;
  pennyPicks: {
    strike: number; mid: number; bid: number; ask: number; delta: number; oi: number; iv: number;
    expiry: string; dte: number;
    deltaPerDollar: number; contracts: number; totalCost: number;
    breakeven: number; breakevenMovePct: number; approxWinProb: number;
  }[];
  chain: { calls: Contract[]; puts: Contract[] };
}

const DEFAULT_SYMBOLS = "NVDA,TSLA,AAPL,MSFT,AMD,GOOGL,META,MU";

function BudgetFinder() {
  const [budget, setBudget] = useState("100");
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState("");

  const find = async () => {
    const b = Math.max(10, parseFloat(budget) || 100);
    setRunning(true); setErr(""); setRows([]);
    try {
      // bankroll set so the desk's 2% risk cap equals the user's budget
      const res = await fetch(`/api/options?symbols=${DEFAULT_SYMBOLS}&bankroll=${b / 0.02}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "scan failed");
      const out: any[] = [];
      for (const r of d.results ?? []) {
        if (r.direction === "SKIP") continue;
        const rec = r.recommendation, mc = r.mcContract;
        if (rec && rec.ask * 100 <= b) {
          out.push({
            kind: "main", symbol: r.symbol, type: rec.type, strike: rec.strike,
            expiry: r.expiry, dte: r.dte, ask: rec.ask, delta: rec.delta,
            cost: +(rec.ask * 100).toFixed(0),
            contracts: Math.max(1, Math.floor(b / (rec.ask * 100))),
            pProfit: mc ? mc.pProfit : null, mcEdge: mc ? mc.mcEdgePct : null,
            rank: mc ? mc.pProfit * 100 + Math.max(0, mc.mcEdgePct) / 10 : 0,
          });
        }
        for (const p of r.pennyPicks ?? []) {
          if (p.ask * 100 <= b) {
            out.push({
              kind: "penny", symbol: r.symbol, type: r.direction, strike: p.strike,
              expiry: p.expiry, dte: p.dte, ask: p.ask, delta: p.delta,
              cost: +(p.ask * 100).toFixed(0),
              contracts: Math.min(50, Math.floor(b / (p.ask * 100))),
              pProfit: p.approxWinProb / 100, mcEdge: null,
              rank: p.approxWinProb + p.deltaPerDollar * 20,
            });
          }
        }
      }
      out.sort((a, b2) => b2.rank - a.rank);
      setRows(out.slice(0, 10));
      if (!out.length) setErr(`nothing liquid fits $${b} right now — try a larger budget`);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setRunning(false); }
  };

  return (
    <div className="hud-panel hud-panel-static p-4 mb-6">
      <div className="text-[10px] tracking-[0.18em] mb-1" style={{ color: "var(--hud-green)" }}>
        💰 BUDGET FINDER — NO TICKER NEEDED
      </div>
      <p className="text-[10px] mb-3" style={{ color: "var(--hud-muted)" }}>
        Enter only your money. The desk scans the universe and ranks every contract that fits —
        by Monte-Carlo P(profit) and edge, mains and pennies together.
      </p>
      <div className="flex gap-2 mb-3">
        <input value={budget} onChange={(e) => setBudget(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && !running && find()}
               className="w-28 px-3 py-2 text-xs outline-none tabular-nums"
               placeholder="$ budget"
               style={{ background: "rgba(11,13,18,0.7)", border: "1px solid var(--hud-border)",
                        color: "var(--hud-text)", borderRadius: 8 }} />
        <button onClick={find} disabled={running} className="hud-chip hud-nav-active"
                style={{ height: 34, cursor: "pointer" }}>
          {running ? "⟳ SCANNING UNIVERSE…" : "▶ FIND BEST IN BUDGET"}
        </button>
      </div>
      {err && <div className="text-[11px]" style={{ color: "var(--hud-amber)" }}>⚠ {err}</div>}
      {rows.length > 0 && (
        <table className="w-full text-[11px] tabular-nums">
          <thead>
            <tr style={{ color: "var(--hud-muted)" }}>
              <th className="text-left px-2 py-1">CONTRACT</th>
              <th className="text-right px-2 py-1">COST</th>
              <th className="text-right px-2 py-1">FITS</th>
              <th className="text-right px-2 py-1">P(PROFIT)</th>
              <th className="text-right px-2 py-1">MC EDGE</th>
              <th className="text-left px-2 py-1">KIND</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="hud-row">
                <td className="px-2 py-1.5 font-bold">
                  <span style={{ color: r.type === "CALL" ? "var(--hud-green)" : "var(--hud-red)" }}>
                    {r.symbol} ${r.strike} {r.type}
                  </span>
                  <span className="ml-2 font-normal text-[10px]" style={{ color: "var(--hud-muted)" }}>
                    {r.expiry} ({r.dte}d) δ{r.delta}
                  </span>
                </td>
                <td className="text-right px-2 py-1.5">${r.cost}</td>
                <td className="text-right px-2 py-1.5" style={{ color: "var(--hud-accent)" }}>{r.contracts}x</td>
                <td className="text-right px-2 py-1.5 font-bold"
                    style={{ color: (r.pProfit ?? 0) >= 0.35 ? "var(--hud-green)" : "var(--hud-amber)" }}>
                  {r.pProfit != null ? `${(r.pProfit * 100).toFixed(0)}%` : "—"}
                </td>
                <td className="text-right px-2 py-1.5"
                    style={{ color: (r.mcEdge ?? 0) >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                  {r.mcEdge != null ? `${r.mcEdge >= 0 ? "+" : ""}${r.mcEdge}%` : "—"}
                </td>
                <td className="px-2 py-1.5 text-[9px]" style={{ color: r.kind === "penny" ? "var(--hud-amber)" : "var(--hud-muted)" }}>
                  {r.kind === "penny" ? "🪙 PENNY" : "MAIN"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function OptionsPage() {
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS);
  const [bankroll, setBankroll] = useState("10000");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [lastTick, setLastTick] = useState<Date | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      const res = await fetch(
        `/api/options?symbols=${encodeURIComponent(symbols)}&bankroll=${encodeURIComponent(bankroll)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResults(data.results ?? []);
      setFailed(data.failed ?? []);
      if (data.results?.length) setExpanded(data.results[0].symbol);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  // Live underlying ticks every 15s once a scan exists — no refresh needed
  useEffect(() => {
    if (results.length === 0) return;
    const syms = results.map((r) => r.symbol).join(",");
    const tick = async () => {
      try {
        const res = await fetch(`/api/quotes?symbols=${syms}`);
        if (!res.ok) return;
        const rows: { symbol: string; price: number | null }[] = await res.json();
        setResults((prev) => prev.map((r) => {
          const q = rows.find((x) => x.symbol === r.symbol);
          return q?.price ? { ...r, price: q.price } : r;
        }));
        setLastTick(new Date());
      } catch { /* next tick */ }
    };
    const id = setInterval(() => { if (getToggle("options.liveTicks")) tick(); }, 15_000);
    return () => clearInterval(id);
  }, [results.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const dirColor = (d: string) =>
    d === "CALL" ? "var(--hud-green)" : d === "PUT" ? "var(--hud-red)" : "var(--hud-muted)";

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.2em] glow-violet">⬙ OPTIONS DESK</h1>
        <p className="text-xs mt-1 mb-6 flex items-center gap-2" style={{ color: "var(--hud-muted)" }}>
          {results.length > 0 && (
            <span className="hud-led inline-block" style={{ color: "var(--hud-green)", background: "var(--hud-green)", width: 6, height: 6 }} />
          )}
          Live chains + Yang-Zhang realized vol vs implied vol + momentum/trend scoring →
          CALL/PUT pick with Robust-Kelly sizing. Analysis only — you place the trade yourself.
          {lastTick && ` Underlying prices tick every 15s — last ${lastTick.toLocaleTimeString()}.`}
        </p>

        <EngineBanner engine="options ($100 acct)" />

        <BudgetFinder />

        {/* Controls */}
        <div className="hud-panel hud-panel-static p-4 mb-6 flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-64">
            <label className="text-[10px] tracking-widest block mb-1" style={{ color: "var(--hud-muted)" }}>
              TICKERS OR COMPANY NAMES (comma-separated, e.g. NVDA, palantir, ford)
            </label>
            <input value={symbols} onChange={(e) => setSymbols(e.target.value)}
                   className="w-full px-3 py-2 text-xs outline-none"
                   style={{ background: "rgba(6,9,19,0.8)", border: "1px solid var(--hud-border)", color: "var(--hud-text)" }} />
          </div>
          <div>
            <label className="text-[10px] tracking-widest block mb-1" style={{ color: "var(--hud-muted)" }}>
              BANKROLL $
            </label>
            <input value={bankroll} onChange={(e) => setBankroll(e.target.value)}
                   className="w-32 px-3 py-2 text-xs outline-none tabular-nums"
                   style={{ background: "rgba(6,9,19,0.8)", border: "1px solid var(--hud-border)", color: "var(--hud-text)" }} />
          </div>
          <button onClick={run} disabled={running}
                  className="hud-chip hud-nav-active"
                  style={{ cursor: running ? "wait" : "pointer", height: 36, opacity: running ? 0.6 : 1 }}>
            {running ? "⟳ SCANNING LIVE CHAINS…" : "▶ RUN QUANT SCAN"}
          </button>
        </div>

        {error && (
          <div className="hud-panel hud-panel-static p-4 mb-6 text-xs" style={{ color: "var(--hud-red)" }}>⚠ {error}</div>
        )}
        {failed.length > 0 && (
          <div className="text-[11px] mb-4" style={{ color: "var(--hud-amber)" }}>
            ⚠ no data for: {failed.join(", ")}
          </div>
        )}

        {/* Results ranked by |score| */}
        <div className="flex flex-col gap-4">
          {results.map((r) => (
            <div key={r.symbol} className="hud-panel hud-panel-static p-4">
              {/* Header row */}
              <div className="flex flex-wrap items-center gap-4 cursor-pointer"
                   onClick={() => setExpanded(expanded === r.symbol ? null : r.symbol)}>
                <span className="text-lg font-bold w-16">{r.symbol}</span>
                <span className="tabular-nums text-sm">${r.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
                <span className="hud-chip font-bold" style={{ color: dirColor(r.direction) }}>
                  {r.direction === "SKIP" ? "— SKIP" : `▶ BUY ${r.direction}`}
                </span>
                <span className="text-[11px] tabular-nums" style={{ color: "var(--hud-muted)" }}>
                  score {r.metrics.score >= 0 ? "+" : ""}{r.metrics.score} ·
                  RV {r.metrics.yangZhangRv}% vs IV {r.metrics.atmIv}%
                  <span style={{ color: r.metrics.ivPremiumPct < 0 ? "var(--hud-green)" : "var(--hud-amber)" }}>
                    {" "}({r.metrics.ivPremiumPct >= 0 ? "+" : ""}{r.metrics.ivPremiumPct}% prem)
                  </span>
                  {" "}· 1m {r.metrics.ret1mPct >= 0 ? "+" : ""}{r.metrics.ret1mPct}%
                </span>
                <span className="ml-auto text-xs" style={{ color: "var(--hud-muted)" }}>
                  {expanded === r.symbol ? "▲" : "▼"}
                </span>
              </div>

              {/* Recommendation */}
              {r.recommendation && r.sizing && (
                <div className="mt-3 p-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs"
                     style={{ background: "rgba(6,9,19,0.6)", border: `1px solid ${dirColor(r.direction)}44` }}>
                  <div>
                    <div className="text-[9px] tracking-widest" style={{ color: "var(--hud-muted)" }}>CONTRACT</div>
                    <div className="font-bold" style={{ color: dirColor(r.direction) }}>
                      {r.symbol} {r.expiry} ${r.recommendation.strike} {r.recommendation.type}
                    </div>
                    <div style={{ color: "var(--hud-muted)" }}>
                      δ {r.recommendation.delta} · IV {r.recommendation.iv}% · OI {r.recommendation.oi.toLocaleString()} · {r.dte}d
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] tracking-widest" style={{ color: "var(--hud-muted)" }}>PRICE</div>
                    <div className="font-bold tabular-nums">${r.recommendation.mid} <span className="text-[10px]" style={{ color: "var(--hud-muted)" }}>({r.recommendation.bid}-{r.recommendation.ask})</span></div>
                    <div style={{ color: "var(--hud-muted)" }}>spread {r.recommendation.spreadPct}%</div>
                  </div>
                  <div>
                    <div className="text-[9px] tracking-widest" style={{ color: "var(--hud-muted)" }}>HOW MUCH (KELLY)</div>
                    <div className="font-bold tabular-nums" style={{ color: r.sizing.contracts > 0 ? "var(--hud-cyan)" : "var(--hud-amber)" }}>
                      {r.sizing.contracts > 0
                        ? `${r.sizing.contracts} contract${r.sizing.contracts > 1 ? "s" : ""} = $${r.sizing.totalCost.toLocaleString()}`
                        : "0 — over risk cap"}
                    </div>
                    <div style={{ color: "var(--hud-muted)" }}>
                      max loss ${r.sizing.maxLossUsd.toLocaleString()} ({r.sizing.riskPctOfBankroll}% bankroll)
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] tracking-widest" style={{ color: "var(--hud-muted)" }}>BREAKEVEN AT EXPIRY</div>
                    <div className="font-bold tabular-nums">${r.sizing.breakeven}</div>
                    <div style={{ color: "var(--hud-muted)" }}>needs {r.sizing.breakevenMovePct >= 0 ? "+" : ""}{r.sizing.breakevenMovePct}% move</div>
                  </div>
                  {r.sizing.note && (
                    <div className="col-span-2 md:col-span-4 text-[10px]" style={{ color: "var(--hud-amber)" }}>
                      ⚠ {r.sizing.note}
                    </div>
                  )}
                  {r.montecarlo && r.mcContract && (
                    <div className="col-span-2 md:col-span-4 pt-2 text-[11px] tabular-nums flex flex-wrap gap-x-5 gap-y-1"
                         style={{ borderTop: "1px solid var(--hud-border)" }}>
                      <span className="text-[9px] tracking-[0.16em] w-full" style={{ color: "var(--hud-accent)" }}>
                        MONTE CARLO · {r.montecarlo.paths.toLocaleString()} PATHS · {r.montecarlo.method}
                      </span>
                      <span>P(profit at expiry) <b style={{ color: r.mcContract.pProfit >= 0.4 ? "var(--hud-green)" : "var(--hud-amber)" }}>
                        {(r.mcContract.pProfit * 100).toFixed(0)}%</b></span>
                      <span>P(ITM) <b>{(r.mcContract.pITM * 100).toFixed(0)}%</b></span>
                      <span>MC fair <b>${r.mcContract.mcFair}</b> vs ask
                        <b style={{ color: r.mcContract.mcEdgePct >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                          {" "}{r.mcContract.mcEdgePct >= 0 ? "+" : ""}{r.mcContract.mcEdgePct}%</b></span>
                      <span>E[P&L]/contract <b style={{ color: r.mcContract.expectedPnlPerContract >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                        ${r.mcContract.expectedPnlPerContract}</b></span>
                      <span style={{ color: "var(--hud-muted)" }}>
                        underlying @{r.montecarlo.horizonDays}d: p10 ${r.montecarlo.p10} · p50 ${r.montecarlo.p50} · p90 ${r.montecarlo.p90}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {r.direction === "SKIP" && (
                <div className="mt-2 text-[11px]" style={{ color: "var(--hud-muted)" }}>
                  No clear directional edge (|score| below 0.15) — skip rather than force a trade.
                </div>
              )}

              {/* Penny plays */}
              {r.pennyPicks?.length > 0 && (
                <div className="mt-3">
                  <div className="text-[10px] tracking-widest mb-1.5" style={{ color: "var(--hud-amber)" }}>
                    🪙 PENNY PLAYS (≤$1.00 premium · same {r.direction} direction · ranked by δ-per-$)
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    {r.pennyPicks.map((p) => (
                      <div key={`${p.expiry}-${p.strike}`} className="p-2.5 text-[11px]"
                           style={{ background: "rgba(6,9,19,0.6)", border: "1px solid rgba(251,191,36,0.25)" }}>
                        <div className="font-bold" style={{ color: dirColor(r.direction) }}>
                          ${p.strike} {r.direction} @ ${p.mid.toFixed(2)}
                          <span className="ml-2 font-normal text-[10px]" style={{ color: "var(--hud-muted)" }}>
                            ({p.bid.toFixed(2)}-{p.ask.toFixed(2)})
                          </span>
                        </div>
                        <div className="tabular-nums mt-1" style={{ color: "var(--hud-muted)" }}>
                          {p.expiry} ({p.dte}d) · δ {p.delta} · ~{p.approxWinProb}% ITM · OI {p.oi.toLocaleString()}
                        </div>
                        <div className="tabular-nums" style={{ color: "var(--hud-cyan)" }}>
                          {p.contracts}x = ${p.totalCost} · BE {p.breakevenMovePct >= 0 ? "+" : ""}{p.breakevenMovePct}%
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: "var(--hud-amber)" }}>
                    ⚠ Penny options are lottery tickets — {100 - (r.pennyPicks[0]?.approxWinProb ?? 90)}%+ of the time they expire worthless. Size like you expect to lose it.
                  </div>
                </div>
              )}

              {/* Bloomberg OMON-style chain: CALLS | STRIKE | PUTS */}
              {expanded === r.symbol && (() => {
                const strikes = Array.from(new Set([
                  ...r.chain.calls.map((c) => c.strike),
                  ...r.chain.puts.map((c) => c.strike),
                ])).sort((a, b) => a - b);
                const callBy = Object.fromEntries(r.chain.calls.map((c) => [c.strike, c]));
                const putBy = Object.fromEntries(r.chain.puts.map((c) => [c.strike, c]));
                const cell = "text-right px-1.5 py-[3px]";
                const fmt = (v: number | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
                return (
                  <div className="mt-4 overflow-x-auto">
                    <div className="flex items-center justify-between text-[10px] tracking-widest mb-1">
                      <span style={{ color: "var(--hud-green)" }}>◀ CALLS</span>
                      <span style={{ color: "var(--hud-muted)" }}>
                        {r.symbol} OMON · EXP {r.expiry} ({r.dte}D) · SPOT ${r.price.toFixed(2)} ·
                        RV {r.metrics.yangZhangRv}% · ATM IV {r.metrics.atmIv}%
                      </span>
                      <span style={{ color: "var(--hud-red)" }}>PUTS ▶</span>
                    </div>
                    <table className="w-full text-[10px] tabular-nums" style={{ minWidth: 900 }}>
                      <thead>
                        <tr style={{ background: "rgba(12,18,34,0.95)", color: "var(--hud-muted)" }}>
                          {["OI", "VOL", "IV%", "δ", "SPRD%", "BID", "ASK", "MID"].map((h) => (
                            <th key={`c-${h}`} className={cell}>{h}</th>
                          ))}
                          <th className="text-center px-2 py-1 font-bold" style={{ color: "var(--hud-amber)" }}>STRIKE</th>
                          {["MID", "BID", "ASK", "SPRD%", "δ", "IV%", "VOL", "OI"].map((h) => (
                            <th key={`p-${h}`} className={cell}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {strikes.map((k) => {
                          const c = callBy[k], p = putBy[k];
                          const cItm = k < r.price, pItm = k > r.price;
                          const isRecC = r.recommendation && r.direction === "CALL" && k === r.recommendation.strike;
                          const isRecP = r.recommendation && r.direction === "PUT" && k === r.recommendation.strike;
                          const atm = Math.abs(k - r.price) ===
                            Math.min(...strikes.map((s) => Math.abs(s - r.price)));
                          return (
                            <tr key={k} className="hud-row"
                                style={{
                                  background: isRecC || isRecP ? "rgba(129,140,248,0.14)"
                                    : atm ? "rgba(251,191,36,0.06)" : undefined,
                                }}>
                              <td className={cell} style={{ color: cItm ? "var(--hud-text)" : "var(--hud-muted)" }}>{c ? c.oi.toLocaleString() : "—"}</td>
                              <td className={cell} style={{ color: "var(--hud-muted)" }}>{c ? c.volume.toLocaleString() : "—"}</td>
                              <td className={cell}>{c ? (c.iv * 100).toFixed(0) : "—"}</td>
                              <td className={cell} style={{ color: "var(--hud-green)" }}>{c ? c.delta.toFixed(2) : "—"}</td>
                              <td className={cell} style={{ color: (c?.spreadPct ?? 0) > 10 ? "var(--hud-amber)" : "var(--hud-muted)" }}>{c ? c.spreadPct.toFixed(0) : "—"}</td>
                              <td className={cell}>{fmt(c?.bid)}</td>
                              <td className={cell}>{fmt(c?.ask)}</td>
                              <td className={`${cell} font-bold`} style={{ color: cItm ? "var(--hud-green)" : "var(--hud-text)" }}>
                                {isRecC && "▶"}{fmt(c?.mid)}
                              </td>
                              <td className="text-center px-2 py-[3px] font-bold"
                                  style={{ color: atm ? "var(--hud-amber)" : "var(--hud-text)", background: "rgba(12,18,34,0.6)" }}>
                                {k}{atm && " ◈"}
                              </td>
                              <td className={`${cell} font-bold`} style={{ color: pItm ? "var(--hud-red)" : "var(--hud-text)" }}>
                                {isRecP && "▶"}{fmt(p?.mid)}
                              </td>
                              <td className={cell}>{fmt(p?.bid)}</td>
                              <td className={cell}>{fmt(p?.ask)}</td>
                              <td className={cell} style={{ color: (p?.spreadPct ?? 0) > 10 ? "var(--hud-amber)" : "var(--hud-muted)" }}>{p ? p.spreadPct.toFixed(0) : "—"}</td>
                              <td className={cell} style={{ color: "var(--hud-red)" }}>{p ? p.delta.toFixed(2) : "—"}</td>
                              <td className={cell}>{p ? (p.iv * 100).toFixed(0) : "—"}</td>
                              <td className={cell} style={{ color: "var(--hud-muted)" }}>{p ? p.volume.toLocaleString() : "—"}</td>
                              <td className={cell} style={{ color: pItm ? "var(--hud-text)" : "var(--hud-muted)" }}>{p ? p.oi.toLocaleString() : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="text-[9px] mt-1" style={{ color: "var(--hud-muted)" }}>
                      ◈ = ATM strike · ▶ = recommended contract · green mids = ITM calls · red mids = ITM puts ·
                      amber SPRD% = wide market (&gt;10%)
                    </div>
                  </div>
                );
              })()}
            </div>
          ))}
        </div>

        {results.length === 0 && !running && !error && (
          <div className="text-center py-16 text-sm" style={{ color: "var(--hud-muted)" }}>
            Enter tickers and bankroll, then run the scan — live chains, ~35-DTE expiry.
          </div>
        )}

        <p className="text-[10px] mt-6 pb-8" style={{ color: "var(--hud-muted)" }}>
          Method: Yang-Zhang RV vs ATM IV (cheap/expensive premium) + vol-normalized momentum + SMA trend →
          direction score; contract at |δ|≈0.40 (walked down if over budget); sizing via Robust Kelly Eq.4
          capped at 2% of bankroll. Long options can expire worthless — max loss = full premium.
          Educational only, not financial advice.
        </p>
      </main>
    </div>
  );
}
