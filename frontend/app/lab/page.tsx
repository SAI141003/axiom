"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import PageHeader from "@/components/PageHeader";
import { FlaskConical } from "lucide-react";
import { Card, Kpi, DonutChart, CompareBars, Lines, Tabs, pct, usd } from "@/components/charts";
import BacktestPanel from "@/components/lab/BacktestPanel";
import ProvingGroundPanel from "@/components/lab/ProvingGroundPanel";
import ScenarioPanel from "@/components/lab/ScenarioPanel";
import BenchmarkPanel from "@/components/lab/BenchmarkPanel";
import DataDeskPanel from "@/components/lab/DataDeskPanel";

const TABS = [
  { id: "overview", label: "OVERVIEW" },
  { id: "backtest", label: "BACKTEST" },
  { id: "proving", label: "PROVING GROUND" },
  { id: "scenario", label: "SCENARIO" },
  { id: "benchmark", label: "BENCHMARKS" },
  { id: "data", label: "DATA DESK" },
];

export default function LabPage() {
  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <Suspense fallback={null}><Lab /></Suspense>
    </div>
  );
}

function Lab() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") ?? "overview";
  const setTab = (id: string) => router.replace(id === "overview" ? "/lab" : `/lab?tab=${id}`, { scroll: false });

  return (
    <main className="max-w-6xl mx-auto p-6 font-mono">
      <PageHeader icon={FlaskConical} title="RESEARCH LAB">backtests · fault-injection proving ground · scenario forecasts · model benchmarks · macro data — one desk</PageHeader>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === "overview" && <Overview />}
      {tab === "backtest" && <BacktestPanel />}
      {tab === "proving" && <ProvingGroundPanel />}
      {tab === "scenario" && <ScenarioPanel />}
      {tab === "benchmark" && <BenchmarkPanel />}
      {tab === "data" && <DataDeskPanel />}
    </main>
  );
}

function Overview() {
  const [bt, setBt] = useState<any>(null);
  const [pg, setPg] = useState<any>(null);
  const [sc, setSc] = useState<any>(null);
  useEffect(() => {
    fetch("/api/backtest-lab").then((r) => r.json()).then(setBt).catch(() => {});
    fetch("/api/proving-ground").then((r) => r.json()).then(setPg).catch(() => {});
    fetch("/api/scenario").then((r) => r.json()).then(setSc).catch(() => {});
  }, []);

  const report = bt?.report, batch = bt?.batch, opt = bt?.optimize, exp = bt?.experiments;
  const m = report?.metrics;
  const scen = pg?.report;

  const grid: any[] = batch?.grid ?? [];
  const edgeCells = grid.filter((c) => c.edge).length;
  const donutEdge = [{ name: "edge (beats B&H out-of-sample)", value: edgeCells }, { name: "no edge", value: Math.max(0, grid.length - edgeCells) }];

  const gridBars = grid.map((c) => ({ name: `${c.symbol.split("/")[0]} ${c.timeframe}`, strategy: c.total_return, buyhold: c.buyhold_return }));

  const variants = Object.entries<any>(exp?.variants ?? {}).map(([name, v]) => ({
    name: name.replace("+orderflow+volprofile", "+volprofile"), return: v.mean_return, sharpe: v.mean_sharpe,
  }));

  const overfit = opt ? [
    { name: "default", train: opt.default?.train?.sharpe, holdout: opt.default?.holdout?.sharpe },
    { name: "tuned", train: opt.tuned?.train?.sharpe, holdout: opt.tuned?.holdout?.sharpe },
  ] : [];

  const curve: any[] = (report?.equity_curve ?? []).map((v: number, i: number) => ({ i, equity: Math.round(v * 100) / 100 }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="SAFETY ASSERTIONS" value={scen ? scen.total_runs.toLocaleString() : "—"} tone={scen && scen.total_fails === 0 ? "good" : "bad"} sub={scen ? `${scen.total_fails} failures · ${scen.scenarios?.length ?? 0} scenarios` : ""} />
        <Kpi label="BACKTEST RETURN" value={m ? pct(m.total_return) : "—"} tone={m && m.total_return > 0 ? "good" : "bad"} sub={m ? `vs B&H ${pct(m.buyhold_return)} · ${report.symbol} ${report.timeframe}` : ""} />
        <Kpi label="SHARPE" value={m ? String(m.sharpe) : "—"} sub={m ? `max DD ${pct(m.max_drawdown)}` : ""} />
        <Kpi label="EDGE CELLS" value={grid.length ? `${edgeCells} / ${grid.length}` : "—"} tone={edgeCells > 0 ? "good" : "neutral"} sub="daily only — intraday loses" />
        <Kpi label="SCENARIO SKILL" value={sc?.brier != null ? `Brier ${sc.brier}` : "—"} tone={sc?.brier != null && sc.brier < 0.25 ? "good" : "neutral"} sub={sc ? `${sc.resolved} resolved · ${sc.verdict}` : ""} />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <Card title="WHERE THE EDGE IS" sub="9 symbol × timeframe cells, walk-forward validated">
          <DonutChart data={donutEdge} valueLabel={(v) => `${v} cells`} />
        </Card>
        <Card title="STRATEGY VARIANTS — OUT-OF-SAMPLE" sub="mean return across BTC/ETH/SOL daily; only the winner shipped" className="md:col-span-2">
          <CompareBars data={variants} keys={[{ key: "return", label: "mean return" }, { key: "sharpe", label: "mean Sharpe" }]} format={(v) => v.toFixed(2)} signed />
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card title="GRID — STRATEGY VS BUY & HOLD" sub="total return per cell · 720 candles · fees 10bps + slippage 5bps">
          <CompareBars data={gridBars} keys={[{ key: "strategy", label: "strategy" }, { key: "buyhold", label: "buy & hold" }]} format={pct} signed />
        </Card>
        <Card title="THE ANTI-OVERFIT TEST" sub={opt?.outcome ?? "400-iteration weight search, judged on the holdout"}>
          <CompareBars data={overfit} keys={[{ key: "train", label: "train Sharpe" }, { key: "holdout", label: "holdout Sharpe" }]} format={(v) => v.toFixed(2)} signed />
        </Card>
      </div>

      <Card title="EQUITY CURVE" sub={report ? `${report.symbol} ${report.timeframe} · ${report.strategy} · start $${report.start_cash}` : ""}>
        <Lines data={curve} keys={["equity"]} xKey="i" format={(v) => `$${v}`} refY={report?.start_cash} />
      </Card>

      {scen && (
        <Card title="FAULT SCENARIOS" sub={`${scen.rounds} rounds · ${scen.seconds}s · every invariant holds across Hyperliquid, Solana and CCXT`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[10px]">
            {scen.scenarios.map((s: any) => (
              <div key={s.name} className="flex justify-between gap-2 px-2 py-1 rounded min-w-0" style={{ background: "rgba(255,255,255,0.02)" }}>
                <span className="truncate" style={{ color: "var(--hud-text)" }}>{s.name}</span>
                <span className="shrink-0" style={{ color: s.fails === 0 ? "#34d399" : "#f87171" }}>{s.fails === 0 ? "✓" : `✗ ${s.fails}`}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="text-[10px] pb-6 leading-relaxed break-words" style={{ color: "var(--hud-muted)" }}>
        Every figure here is written by a command you can run: <code>backtest.octobot_engine</code>, <code>backtest.batch</code>,{" "}
        <code>backtest.optimize</code>, <code>backtest.experiments</code>, <code>execution/scenario_sim.py</code>. The
        safety proof is deterministic; the backtest fetches live candles, so its window moves.
      </div>
    </div>
  );
}
