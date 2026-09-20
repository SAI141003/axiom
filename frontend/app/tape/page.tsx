"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import TopNav from "@/components/TopNav";
import PageHeader from "@/components/PageHeader";
import { Activity } from "lucide-react";
import { Card, Kpi, Lines, CompareBars } from "@/components/charts";

const fmtT = (ts: number) => new Date(ts * 1000).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function TapePage() {
  const [d, setD] = useState<any>(null);
  const [sym, setSym] = useState<string>("");
  const [i, setI] = useState(0);
  const [play, setPlay] = useState(false);
  const timer = useRef<any>(null);

  useEffect(() => {
    const load = () => fetch("/api/tape").then((r) => r.json()).then((x) => { setD(x); if (!sym && x.symbols?.[0]) setSym(x.symbols[0]); }).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frames: any[] = useMemo(() => (d?.frames ?? []).filter((f: any) => f.sym === sym), [d, sym]);
  const events: any[] = useMemo(() => (d?.events ?? []).filter((e: any) => e.sym === sym), [d, sym]);
  useEffect(() => { setI(Math.max(0, frames.length - 1)); }, [frames.length, sym]);

  useEffect(() => {
    if (!play) { clearInterval(timer.current); return; }
    timer.current = setInterval(() => setI((x) => (x + 1 >= frames.length ? (setPlay(false), x) : x + 1)), 350);
    return () => clearInterval(timer.current);
  }, [play, frames.length]);

  const f = frames[i];
  const thr = d?.thresholds ?? { enter: 0.25, exit: -0.1 };
  const series = frames.map((x, k) => ({ i: k, t: fmtT(x.ts), bias: x.bias, cvd: x.cvd_ratio, obi: x.obi ?? 0 }));
  const bigBars = f ? [{ name: "big buy", v: f.big_buy }, { name: "big sell", v: f.big_sell }] : [];
  const bias = f?.bias ?? 0;
  const tone = bias > thr.enter ? "#34d399" : bias < thr.exit ? "#f87171" : "var(--hud-text)";
  const decisionColor = f?.decision === "enter" ? "#34d399" : f?.decision === "exit" ? "#f87171" : "var(--hud-muted)";

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <PageHeader icon={Activity} title="TAPE REPLAY">what the flow bot saw and what it did, frame by frame · CVD, block trades, book imbalance · the way hftbacktest replays a session</PageHeader>

        <div className="flex flex-wrap items-center gap-2 mb-4">
          {(d?.symbols ?? []).map((s: string) => (
            <button key={s} onClick={() => { setSym(s); setPlay(false); }} className="text-[10px] tracking-widest font-bold px-3 py-1.5 rounded border"
                    style={{ borderColor: sym === s ? "var(--hud-accent)" : "var(--hud-border)", color: sym === s ? "var(--hud-accent)" : "var(--hud-muted)" }}>{s}</button>
          ))}
          <div className="flex-1" />
          <button onClick={() => setPlay((p) => !p)} disabled={!frames.length} className="text-[10px] font-bold px-3 py-1.5 rounded border"
                  style={{ borderColor: "var(--hud-accent)", color: "var(--hud-accent)" }}>{play ? "❚❚ PAUSE" : "▶ REPLAY"}</button>
          <button onClick={() => setI(Math.max(0, frames.length - 1))} className="text-[10px] px-3 py-1.5 rounded border" style={{ borderColor: "var(--hud-border)", color: "var(--hud-muted)" }}>LIVE</button>
        </div>

        {!frames.length && (
          <div className="hud-panel hud-panel-static p-6 text-[11px] text-center" style={{ color: "var(--hud-muted)" }}>
            no frames yet — the flow bot writes one per symbol every cycle to <code>logs/flow_tape.jsonl</code> once it is running
          </div>
        )}

        {f && (
          <>
            <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={i} onChange={(e) => { setPlay(false); setI(Number(e.target.value)); }}
                   className="w-full mb-1" aria-label="frame" />
            <div className="flex justify-between text-[9px] mb-4 tabular-nums" style={{ color: "var(--hud-muted)" }}>
              <span>frame {i + 1} / {frames.length}</span><span>{fmtT(f.ts)}</span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
              <Kpi label="BIAS" value={`${bias >= 0 ? "+" : ""}${bias.toFixed(3)}`} tone={bias > thr.enter ? "good" : bias < thr.exit ? "bad" : "neutral"} sub={`enter > ${thr.enter} · exit < ${thr.exit}`} />
              <Kpi label="CVD RATIO" value={`${(f.cvd_ratio * 100).toFixed(0)}%`} tone={f.cvd_ratio >= 0 ? "good" : "bad"} sub="net delta / volume" />
              <Kpi label="BOOK IMBALANCE" value={f.obi != null ? `${f.obi >= 0 ? "+" : ""}${f.obi.toFixed(3)}` : "—"} tone={f.obi >= 0 ? "good" : "bad"} sub="bid − ask depth" />
              <Kpi label="BLOCK TRADES" value={String(f.big_trades)} sub={`of ${f.trades} · ≥5× median`} />
              <Kpi label="INTENSITY" value={`${f.intensity}/s`} sub="trade arrival rate" />
              <div className="hud-panel hud-panel-static px-4 py-3 min-w-0">
                <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>DECISION</div>
                <div className="text-xl font-bold tracking-widest" style={{ color: decisionColor }}>{String(f.decision).toUpperCase()}</div>
                <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>{f.held ? "position open" : "flat"}</div>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-4">
              <Card title="BIAS OVER TIME" sub="the signal the bot trades · dashed lines are the entry and exit thresholds" className="md:col-span-2">
                <Lines data={series} keys={["bias", "cvd", "obi"]} xKey="t" format={(v) => v.toFixed(2)} refY={thr.enter} height={280} />
              </Card>
              <Card title="BLOCK FLOW — THIS FRAME" sub="aggregate size of ≥5× median trades, buy vs sell">
                <CompareBars data={bigBars} keys={[{ key: "v", label: "size" }]} format={(v) => v.toFixed(1)} height={280} />
              </Card>
            </div>

            <Card title="WHAT IT DID" sub={`${events.length} entries and exits for ${sym}, newest first`} className="mt-4">
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead><tr className="text-[9px] tracking-widest" style={{ color: "var(--hud-muted)" }}>
                    <th className="text-left py-1">TIME</th><th className="text-left">ACTION</th><th className="text-right">PRICE</th><th className="text-right">BIAS</th><th className="text-right">P&L</th><th className="text-left pl-3">REASON</th>
                  </tr></thead>
                  <tbody>
                    {[...events].reverse().map((e, k) => (
                      <tr key={k} className="hud-row" style={{ color: "var(--hud-text)" }}>
                        <td className="py-1 whitespace-nowrap">{fmtT(e.ts)}</td>
                        <td style={{ color: e.type === "fentry" ? "#34d399" : "#f87171" }}>{e.type === "fentry" ? "BUY" : "EXIT"}</td>
                        <td className="text-right">${e.price}</td>
                        <td className="text-right">{e.bias >= 0 ? "+" : ""}{e.bias}</td>
                        <td className="text-right font-bold" style={{ color: e.pnl == null ? "var(--hud-muted)" : e.pnl >= 0 ? "#34d399" : "#f87171" }}>{e.pnl == null ? "—" : `${e.pnl >= 0 ? "+" : ""}$${e.pnl}`}</td>
                        <td className="pl-3 truncate max-w-[10rem]" style={{ color: "var(--hud-muted)" }}>{e.reason ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        <div className="text-[10px] mt-5 pb-8 leading-relaxed break-words" style={{ color: "var(--hud-muted)" }}>
          After <b style={{ color: "var(--hud-text)" }}>hftengine</b>: a backtest you cannot watch is a backtest you cannot debug. Every frame here is a real read of the
          Kraken tape at the moment the bot made its call. What is modelled: fills at the last price, 8bps a side. What is not shown: queue position and
          latency — a retail feed, not a co-located one.
        </div>
      </main>
    </div>
  );
}
