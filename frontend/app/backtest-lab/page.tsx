"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

function Curve({ strat, bench }: { strat: number[]; bench: number[] }) {
  if (!strat?.length) return null;
  const W = 720, H = 200, pad = 4;
  const all = [...strat, ...bench];
  const lo = Math.min(...all), hi = Math.max(...all);
  const x = (i: number, n: number) => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const path = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"}${x(i, arr.length).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }}>
      <path d={path(bench)} fill="none" stroke="var(--hud-muted)" strokeWidth="1.5" opacity="0.5" strokeDasharray="4 3" />
      <path d={path(strat)} fill="none" stroke="var(--hud-green)" strokeWidth="2" />
    </svg>
  );
}

export default function BacktestLabPage() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/backtest-lab").then((r) => r.json()).then(setD).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, []);
  const r = d?.report;
  const m = r?.metrics;
  const ccxt = d?.ccxt;
  const batch = d?.batch;
  const opt = d?.optimize;
  const exp = d?.experiments;
  const ps = d?.perSymbol;
  const fwd = d?.forward;
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  const beat = m && m.total_return > m.buyhold_return;

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">🧪 BACKTEST LAB</h1>
        <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
          OctoBot-style engine · real OHLCV via CCXT · fees + slippage + no look-ahead · walk-forward validated. Measurement, not trading.
        </p>

        {!r && <div className="text-[11px] py-8 text-center" style={{ color: "var(--hud-muted)" }}>no report yet — run <span style={{ color: "var(--hud-cyan)" }}>python backtest/octobot_engine.py BTC/USD 1d</span></div>}

        {r && m && (
          <>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
              <div className="text-[13px] font-bold" style={{ color: "var(--hud-text)" }}>
                {r.symbol} · {r.timeframe} · {r.exchange} <span style={{ color: "var(--hud-muted)" }} className="text-[10px]">({r.candles} candles, fees {r.fees_bps}bps, slip {r.slippage_bps}bps)</span>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ color: "#0a0e17", background: beat ? "var(--hud-green)" : "var(--hud-amber)" }}>
                {beat ? "BEATS BUY & HOLD" : "TRAILS BUY & HOLD"}
              </span>
            </div>

            <div className="hud-panel hud-panel-static p-3 mb-2">
              <Curve strat={r.equity_curve} bench={r.bench_curve} />
              <div className="flex items-center gap-4 text-[9px] mt-1" style={{ color: "var(--hud-muted)" }}>
                <span className="flex items-center gap-1"><span style={{ width: 14, height: 2, background: "var(--hud-green)", display: "inline-block" }} /> strategy ({r.strategy})</span>
                <span className="flex items-center gap-1"><span style={{ width: 14, height: 2, background: "var(--hud-muted)", display: "inline-block", opacity: 0.5 }} /> buy &amp; hold</span>
              </div>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
              {[
                ["RETURN", pct(m.total_return), m.total_return >= 0],
                ["BUY&HOLD", pct(m.buyhold_return), m.buyhold_return >= 0],
                ["SHARPE", m.sharpe.toFixed(2), m.sharpe >= 0],
                ["MAX DD", `${(m.max_drawdown * 100).toFixed(0)}%`, false],
                ["WIN RATE", m.win_rate != null ? `${(m.win_rate * 100).toFixed(0)}%` : "—", true],
                ["EXPOSURE", `${(m.exposure * 100).toFixed(0)}%`, true],
              ].map(([k, v, good], i) => (
                <div key={i} className="hud-panel hud-panel-static px-2 py-2 text-center">
                  <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>{k as string}</div>
                  <div className="text-[14px] font-bold tabular-nums" style={{ color: good ? "var(--hud-text)" : "#fca5a5" }}>{v as string}</div>
                </div>
              ))}
            </div>

            {/* walk-forward */}
            <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
              WALK-FORWARD — {r.wf_folds_beating_bh}/{r.walk_forward?.length} folds beat buy &amp; hold (out-of-sample robustness)
            </div>
            <div className="flex flex-col gap-1 mb-4">
              {r.walk_forward?.map((f: any, i: number) => (
                <div key={i} className="hud-panel hud-panel-static px-3 py-1.5 flex items-center justify-between text-[10px] tabular-nums">
                  <span className="flex items-center gap-2">
                    <span style={{ color: f.beat_bh ? "var(--hud-green)" : "var(--hud-muted)" }}>{f.beat_bh ? "✓" : "·"}</span>
                    <span style={{ color: "var(--hud-text)" }}>fold {f.fold}</span>
                    <span style={{ color: "var(--hud-muted)" }}>({f.bars} bars, {f.trades} trades)</span>
                  </span>
                  <span className="flex gap-4">
                    <span style={{ color: f.total_return >= 0 ? "var(--hud-green)" : "#fca5a5" }}>strat {pct(f.total_return)}</span>
                    <span style={{ color: "var(--hud-muted)" }}>b&amp;h {pct(f.buyhold_return)}</span>
                    <span style={{ color: "var(--hud-muted)" }}>Sharpe {f.sharpe >= 0 ? "+" : ""}{f.sharpe}</span>
                  </span>
                </div>
              ))}
            </div>

            {/* strategy components */}
            <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>STRATEGY — evaluator blend (OctoBot-style)</div>
            <div className="flex flex-wrap gap-2 mb-4">
              {r.components?.map((c: any, i: number) => (
                <span key={i} className="hud-chip text-[10px]" style={{ color: "var(--hud-text)" }}>{c.name} <b style={{ color: "var(--hud-cyan)" }}>×{c.weight}</b></span>
              ))}
            </div>
          </>
        )}

        {/* batch matrix — where the edge actually is */}
        {batch?.grid && (
          <>
            <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
              BATCH MATRIX — {batch.edge_cells}/{batch.total_cells} cells show edge (beats b&amp;h + positive Sharpe + majority of folds)
            </div>
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-[10px] border-collapse">
                <thead>
                  <tr style={{ color: "var(--hud-muted)" }} className="text-left tracking-widest">
                    <th className="py-1 pr-3">PAIR</th><th className="py-1 pr-3">TF</th>
                    <th className="py-1 pr-3">STRAT</th><th className="py-1 pr-3">B&amp;H</th>
                    <th className="py-1 pr-3">SHARPE</th><th className="py-1 pr-3">DD</th>
                    <th className="py-1 pr-3">WF</th><th className="py-1">EDGE</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.grid.map((c: any, i: number) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--hud-border)", background: c.edge ? "rgba(52,211,153,0.06)" : "transparent" }} className="tabular-nums">
                      <td className="py-1 pr-3 font-bold" style={{ color: "var(--hud-text)" }}>{c.symbol}</td>
                      <td className="py-1 pr-3" style={{ color: "var(--hud-muted)" }}>{c.timeframe}</td>
                      <td className="py-1 pr-3" style={{ color: c.total_return >= 0 ? "var(--hud-green)" : "#fca5a5" }}>{c.total_return >= 0 ? "+" : ""}{(c.total_return * 100).toFixed(1)}%</td>
                      <td className="py-1 pr-3" style={{ color: "var(--hud-muted)" }}>{c.buyhold_return >= 0 ? "+" : ""}{(c.buyhold_return * 100).toFixed(1)}%</td>
                      <td className="py-1 pr-3" style={{ color: c.sharpe >= 0 ? "var(--hud-text)" : "#fca5a5" }}>{c.sharpe >= 0 ? "+" : ""}{c.sharpe}</td>
                      <td className="py-1 pr-3" style={{ color: "var(--hud-muted)" }}>{(c.max_drawdown * 100).toFixed(0)}%</td>
                      <td className="py-1 pr-3" style={{ color: "var(--hud-muted)" }}>{c.wf_beat}/{c.wf_total}</td>
                      <td className="py-1" style={{ color: c.edge ? "var(--hud-green)" : "var(--hud-muted)" }}>{c.edge ? "★" : "·"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* optimizer verdict — honesty about tuning */}
        {opt && (
          <div className="hud-panel hud-panel-static p-3 mb-4" style={{ borderColor: opt.shipped ? "rgba(52,211,153,0.4)" : "rgba(124,154,255,0.35)" }}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-[11px] font-bold" style={{ color: "var(--hud-text)" }}>WEIGHT OPTIMIZER — {opt.iterations} candidates, daily</span>
              <span className="text-[9px] font-bold px-2 py-0.5 rounded" style={{ color: "#0a0e17", background: opt.shipped ? "var(--hud-green)" : "var(--hud-amber)" }}>
                {opt.shipped ? "TUNED SHIPPED (won OOS)" : "KEPT DEFAULT (no overfit shipped)"}
              </span>
            </div>
            <div className="text-[10px] mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 tabular-nums" style={{ color: "var(--hud-muted)" }}>
              <span>DEFAULT · train Sharpe <b style={{ color: "var(--hud-text)" }}>{opt.default?.train?.sharpe}</b> → holdout <b style={{ color: "var(--hud-text)" }}>{opt.default?.holdout?.sharpe}</b></span>
              {opt.tuned && <span>TUNED · train Sharpe <b style={{ color: "var(--hud-text)" }}>{opt.tuned?.train?.sharpe}</b> → holdout <b style={{ color: "var(--hud-text)" }}>{opt.tuned?.holdout?.sharpe}</b></span>}
            </div>
            <div className="text-[9px] mt-2" style={{ color: "var(--hud-cyan)" }}>→ {opt.outcome}</div>
          </div>
        )}

        {/* edge experiments — b (regime) + c (order-flow) bake-off */}
        {exp?.variants && (
          <>
            <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
              EDGE EXPERIMENTS — daily bake-off (b regime-switch · c order-flow vs default)
            </div>
            <div className="overflow-x-auto mb-2">
              <table className="w-full text-[10px] border-collapse">
                <thead>
                  <tr style={{ color: "var(--hud-muted)" }} className="text-left tracking-widest">
                    <th className="py-1 pr-3">VARIANT</th><th className="py-1 pr-3">BEAT B&amp;H</th>
                    <th className="py-1 pr-3">MEAN RET</th><th className="py-1 pr-3">MEAN SHARPE</th>
                    <th className="py-1 pr-3">WF BEATS</th><th className="py-1">PICK</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(exp.variants).map(([name, v]: [string, any], i: number) => {
                    const win = name === exp.winner;
                    return (
                      <tr key={i} style={{ borderTop: "1px solid var(--hud-border)", background: win ? "rgba(52,211,153,0.06)" : "transparent" }} className="tabular-nums">
                        <td className="py-1 pr-3 font-bold" style={{ color: "var(--hud-text)" }}>{name}</td>
                        <td className="py-1 pr-3" style={{ color: "var(--hud-muted)" }}>{v.cells_beating_bh}/{v.cells.length}</td>
                        <td className="py-1 pr-3" style={{ color: v.mean_return >= 0 ? "var(--hud-green)" : "#fca5a5" }}>{v.mean_return >= 0 ? "+" : ""}{(v.mean_return * 100).toFixed(1)}%</td>
                        <td className="py-1 pr-3" style={{ color: v.mean_sharpe >= 0 ? "var(--hud-text)" : "#fca5a5" }}>{v.mean_sharpe >= 0 ? "+" : ""}{v.mean_sharpe}</td>
                        <td className="py-1 pr-3" style={{ color: "var(--hud-muted)" }}>{v.wf_beats}/{v.wf_total}</td>
                        <td className="py-1" style={{ color: win ? "var(--hud-green)" : "var(--hud-muted)" }}>{win ? "★" : "·"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="text-[9px] mb-2" style={{ color: "var(--hud-cyan)" }}>→ {exp.verdict} <span style={{ color: "var(--hud-muted)" }}>(order-flow adopted; regime-switch rejected — it gave back gains in pullbacks.)</span></div>
            {ps?.holdout && (
              <div className="text-[9px] mb-4 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
                <b style={{ color: ps.shipped ? "var(--hud-green)" : "var(--hud-amber)" }}>per-symbol routing:</b> {ps.shipped ? "shipped" : "tested & REJECTED (overfit)"} — holdout mean return:
                global-orderflow <b style={{ color: "var(--hud-text)" }}>{(ps.holdout["global-orderflow"].mean_return * 100).toFixed(1)}%</b> &gt;
                per-symbol <b style={{ color: "var(--hud-text)" }}>{(ps.holdout["per-symbol"].mean_return * 100).toFixed(1)}%</b> &gt;
                global-default <b style={{ color: "var(--hud-text)" }}>{(ps.holdout["global-default"].mean_return * 100).toFixed(1)}%</b>.
                Routing per symbol didn&apos;t generalize; global order-flow is confirmed best out-of-sample.
              </div>
            )}
          </>
        )}

        {/* forward scoreboard — real days, no cherry-picking */}
        {fwd?.latest?.accounts && (
          <>
            <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
              FORWARD SCOREBOARD — real paper P&amp;L · {fwd.days_tracked} day{fwd.days_tracked === 1 ? "" : "s"} tracked (the honest out-of-sample test)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
              {Object.entries(fwd.latest.accounts).map(([k, v]: [string, any], i: number) => (
                <div key={i} className="hud-panel hud-panel-static px-2 py-2">
                  <div className="text-[9px] truncate" style={{ color: "var(--hud-muted)" }}>{k.replace(" ($100 acct)", "")}</div>
                  <div className="text-[15px] font-bold tabular-nums" style={{ color: (v.pnl ?? 0) >= 0 ? "var(--hud-green)" : "#f87171" }}>${v.account}</div>
                  <div className="text-[9px] tabular-nums" style={{ color: "var(--hud-muted)" }}>{(v.pnl ?? 0) >= 0 ? "+" : ""}{v.pnl} · {v.trades}t · {v.win_rate != null ? `${(v.win_rate * 100).toFixed(0)}%` : "—"}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* CCXT exchange status */}
        {ccxt && (
          <div className="hud-panel hud-panel-static p-3 mb-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-[11px] font-bold" style={{ color: "var(--hud-text)" }}>CCXT unified exchange · {ccxt.exchange}</span>
              <span className="text-[9px] font-bold px-2 py-0.5 rounded" style={{ color: "#0a0e17", background: ccxt.dryRun ? "var(--hud-amber)" : "var(--hud-green)" }}>
                {ccxt.dryRun ? "PAPER (DRY-RUN)" : "LIVE-ARMED"}
              </span>
            </div>
            <div className="text-[9px] mt-1" style={{ color: "var(--hud-muted)" }}>
              one gated door to 100+ exchanges · non-custodial (keys stay with you) · max/order ${ccxt.maxOrder} · daily cap ${ccxt.dailyCap} · slippage {ccxt.slippageBps}bps · key {ccxt.configured ? "set" : "not set"}
            </div>
          </div>
        )}

        <div className="text-[10px] pb-8 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
          Adopted from OctoBot&apos;s three pillars — <b style={{ color: "var(--hud-text)" }}>exchange</b> (CCXT, 100+ venues),
          <b style={{ color: "var(--hud-text)" }}> strategy</b> (evaluator→strategy→trading-mode), and <b style={{ color: "var(--hud-text)" }}>backtest</b> (this engine) —
          rebuilt native, behind the same scenario-proven safety floor. No look-ahead, real fees/slippage, walk-forward folds so a one-window fluke can&apos;t masquerade as edge.
          Re-run: <span style={{ color: "var(--hud-cyan)" }}>python backtest/octobot_engine.py ETH/USD 4h</span>.
        </div>
      </main>
    </div>
  );
}
