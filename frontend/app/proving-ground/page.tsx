"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

type Scen = { name: string; runs: number; fails: number; pass_rate: number; first_fail: string };

export default function ProvingGroundPage() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/proving-ground").then((r) => r.json()).then(setD).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, []);
  const rep = d?.report;
  const scen: Scen[] = rep?.scenarios ?? [];
  const adapters: any[] = d?.adapters ?? [];
  const perfect = rep?.perfect;

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-5xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">🛡 PROVING GROUND</h1>
        <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
          both bots run every fault — fills, rejects, slippage, timeouts, liquidations, rug-pulls, cap breaches — until every safety invariant holds. Full hands, hard floor.
        </p>

        {/* verdict banner */}
        {rep && (
          <div className="hud-panel hud-panel-static px-4 py-3 mb-5 flex items-center justify-between flex-wrap gap-3"
               style={{ borderColor: perfect ? "rgba(52,211,153,0.5)" : "rgba(248,113,113,0.5)" }}>
            <div>
              <div className="text-[13px] font-bold" style={{ color: perfect ? "var(--hud-green)" : "#f87171" }}>
                {perfect ? "★ PERFECT — every invariant holds" : "✗ NOT PERFECT — failures present"}
              </div>
              <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>
                {rep.total_runs?.toLocaleString()} assertions · {rep.rounds} rounds · {rep.seconds}s · a bot can&apos;t blow past the caps
              </div>
            </div>
            <div className="flex gap-5 tabular-nums text-right">
              <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>ASSERTIONS</div>
                <div className="text-xl font-bold" style={{ color: "var(--hud-text)" }}>{rep.total_runs?.toLocaleString()}</div></div>
              <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>FAILURES</div>
                <div className="text-xl font-bold" style={{ color: rep.total_fails ? "#f87171" : "var(--hud-green)" }}>{rep.total_fails}</div></div>
            </div>
          </div>
        )}

        {/* adapter status */}
        <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>LIVE ADAPTER STATUS — honest gate state</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          {adapters.map((a, i) => (
            <div key={i} className="hud-panel hud-panel-static p-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-[12px] font-bold" style={{ color: "var(--hud-text)" }}>{a.venue}</span>
                <span className="text-[9px] font-bold px-2 py-0.5 rounded"
                      style={{ color: "#0a0e17", background: a.dryRun ? "var(--hud-amber)" : "var(--hud-green)" }}>
                  {a.dryRun ? "PAPER (DRY-RUN)" : "LIVE-ARMED"}
                </span>
              </div>
              <div className="text-[9px] mt-1 mb-2" style={{ color: "var(--hud-muted)" }}>{a.custody}</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] tabular-nums" style={{ color: "var(--hud-muted)" }}>
                <span>max/order <b style={{ color: "var(--hud-text)" }}>${a.maxOrder}</b></span>
                <span>daily cap <b style={{ color: "var(--hud-text)" }}>${a.dailyCap}</b></span>
                {a.maxLeverage != null && <span>max lev <b style={{ color: "var(--hud-text)" }}>{a.maxLeverage}x</b></span>}
                <span>slippage <b style={{ color: "var(--hud-text)" }}>{a.slippageBps}bps</b></span>
                <span>today <b style={{ color: "var(--hud-text)" }}>${a.todayCommitted}</b></span>
                <span>key <b style={{ color: a.configured ? "var(--hud-green)" : "var(--hud-muted)" }}>{a.configured ? "set" : "not set"}</b></span>
              </div>
            </div>
          ))}
        </div>

        {/* scenario matrix */}
        <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>SCENARIO MATRIX — {scen.length} invariants</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
          {scen.map((s, i) => (
            <div key={i} className="flex items-center justify-between text-[10px] py-1" style={{ borderBottom: "1px solid var(--hud-border)" }}>
              <span className="flex items-center gap-2">
                <span style={{ color: s.fails === 0 ? "var(--hud-green)" : "#f87171" }}>{s.fails === 0 ? "✓" : "✗"}</span>
                <span style={{ color: "var(--hud-text)" }}>{s.name}</span>
              </span>
              <span className="tabular-nums" style={{ color: "var(--hud-muted)" }}>
                {s.runs} · <b style={{ color: s.fails === 0 ? "var(--hud-green)" : "#f87171" }}>{(s.pass_rate * 100).toFixed(0)}%</b>
              </span>
            </div>
          ))}
        </div>

        <div className="text-[10px] mt-5 pb-8 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
          Why the caps stay: a trade-only key + a per-order cap + a daily cap means the <b style={{ color: "var(--hud-text)" }}>worst</b> a bot can do in a day is bounded, and a liquidation
          or rug can only lose the capital committed to that one position — proven above, {rep?.total_runs?.toLocaleString?.() ?? "many"} times over. That hard floor is exactly what lets
          the bot run with full hands. Re-run any time: <span style={{ color: "var(--hud-cyan)" }}>python execution/scenario_sim.py 25</span>.
          Nothing here is live until you set a key and flip DRY-RUN off — and even then, the caps hold.
        </div>
      </main>
    </div>
  );
}
