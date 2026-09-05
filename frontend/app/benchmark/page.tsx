"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

/**
 * MODEL BENCHMARK — every engine vs. the right baseline + published research.
 * Honest by design: shows where we beat, tie, or sit below the baseline.
 */
export default function BenchmarkPage() {
  const [d, setD] = useState<any>(null);
  const [mkt, setMkt] = useState<any>(null);
  const [vol, setVol] = useState<any>(null);
  const [ind, setInd] = useState<any>(null);
  const [kro, setKro] = useState<any>(null);
  useEffect(() => {
    fetch("/api/benchmark").then((r) => r.json()).then(setD).catch(() => {});
    fetch("/api/benchmark/market").then((r) => r.json()).then(setMkt).catch(() => {});
    fetch("/api/benchmark/vol").then((r) => r.json()).then(setVol).catch(() => {});
    fetch("/api/benchmark/industry").then((r) => r.json()).then(setInd).catch(() => {});
    fetch("/api/benchmark/kronos").then((r) => r.json()).then(setKro).catch(() => {});
  }, []);
  const rows: any[] = d?.rows ?? [];

  const vColor = (v: string) =>
    v === "BEATS baseline" ? "var(--hud-green)" : v === "below baseline" ? "#f87171"
      : v === "pending" ? "var(--hud-muted)" : "var(--hud-amber)";

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-5xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">▤ MODEL BENCHMARK</h1>
        <p className="text-[11px] mt-1 mb-2 text-center" style={{ color: "var(--hud-muted)" }}>
          every engine vs. the baseline it must beat + the relevant research · real records, self-scored
        </p>
        {d?.summary && (
          <div className="hud-panel hud-panel-static p-3 mb-5 text-[11px] text-center" style={{ color: "var(--hud-text)" }}>
            {d.summary}
          </div>
        )}

        {/* HERO: full comparison vs the models big finance actually uses */}
        {ind?.rows?.length > 0 && (
          <div className="hud-panel hud-panel-static p-4 mb-6" style={{ borderColor: "var(--hud-accent)" }}>
            <div className="text-[12px] tracking-widest font-bold mb-1" style={{ color: "var(--hud-accent)" }}>
              ⚔ US vs THE MODELS BIG FINANCE ACTUALLY USES
            </div>
            {ind.headline && <div className="text-[10px] mb-3" style={{ color: "var(--hud-text)" }}>{ind.headline}</div>}
            <div style={{ overflowX: "auto" }}>
              <table className="w-full text-[11px] tabular-nums" style={{ minWidth: 640 }}>
                <thead>
                  <tr style={{ color: "var(--hud-muted)", borderBottom: "1px solid var(--hud-border)" }}>
                    <th className="text-left py-1.5 pr-2">MODEL</th>
                    <th className="text-left pr-2">USED BY</th>
                    <th className="text-left pr-2">TASK</th>
                    <th className="text-right pr-2">THEIRS</th>
                    <th className="text-right pr-2">OURS</th>
                    <th className="text-right">EDGE</th>
                  </tr>
                </thead>
                <tbody>
                  {ind.rows.map((r: any, i: number) => (
                    <tr key={i} style={{ background: r.is_ours ? "rgba(52,211,153,0.10)" : r.we_win ? "rgba(52,211,153,0.04)" : "transparent",
                                          borderBottom: "1px solid rgba(35,40,56,0.5)" }}>
                      <td className="py-1.5 pr-2" style={{ color: r.is_ours ? "var(--hud-green)" : "var(--hud-text)" }}>
                        <div className="font-bold">{r.model}</div>
                        {r.definition && <div className="text-[8px] font-normal" style={{ color: "var(--hud-muted)" }}>= {r.definition}</div>}
                        {r.cite && (
                          <a href={r.cite} target="_blank" rel="noreferrer" className="text-[8px] hover:underline" style={{ color: "var(--hud-cyan)" }}>
                            📄 {r.cite_label ?? "source"} ↗
                          </a>
                        )}
                      </td>
                      <td className="pr-2 text-[9px]" style={{ color: "var(--hud-muted)" }}>{r.used_by}</td>
                      <td className="pr-2 text-[9px]" style={{ color: "var(--hud-muted)" }}>{r.task}</td>
                      <td className="text-right pr-2" style={{ color: "var(--hud-muted)" }}>{r.their_score ?? "—"}{r.metric === "accuracy" ? "%" : ""}</td>
                      <td className="text-right pr-2 font-bold" style={{ color: "var(--hud-text)" }}>{r.our_score ?? "—"}{r.metric === "accuracy" ? "%" : ""}</td>
                      <td className="text-right text-[10px] font-bold" style={{ color: r.we_win ? "var(--hud-green)" : r.edge.includes("ADOPTED") ? "var(--hud-cyan)" : "var(--hud-muted)" }}>{r.edge}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {ind.summary?.map((s: string, i: number) => (
              <div key={i} className="text-[10px] mt-2" style={{ color: "var(--hud-cyan)" }}>▸ {s}</div>
            ))}
            {ind.honesty && <div className="text-[9px] mt-2 leading-relaxed" style={{ color: "var(--hud-muted)" }}>{ind.honesty}</div>}
          </div>
        )}

        {/* HEAD-TO-HEAD vs real financial models */}
        {mkt?.ranking?.length > 0 && (
          <div className="hud-panel hud-panel-static p-4 mb-6" style={{ borderColor: "rgba(52,211,153,0.4)" }}>
            <div className="text-[11px] tracking-widest font-bold mb-1" style={{ color: "var(--hud-green)" }}>
              ⚔ HEAD-TO-HEAD vs REAL FINANCIAL MODELS
            </div>
            <div className="text-[9px] mb-1" style={{ color: "var(--hud-muted)" }}>
              {mkt.task} · {mkt.predictions} out-of-sample predictions · {mkt.tickers} tickers
            </div>
            <div className="text-[9px] mb-2" style={{ color: "var(--hud-cyan)" }}>
              sorted by ACCURACY (being right) · two scoreboards: #{mkt.our_acc_rank} of {mkt.models} by accuracy · #{mkt.our_brier_rank} by Brier calibration
            </div>
            <table className="w-full text-[11px] tabular-nums">
              <thead><tr style={{ color: "var(--hud-muted)" }}>
                <th className="text-left py-1">MODEL</th>
                <th className="text-right pr-2">ACC-RANK</th>
                <th className="text-right pr-2">ACCURACY</th>
                <th className="text-right">BRIER (rank)</th>
              </tr></thead>
              <tbody>
                {mkt.ranking.map((r: any, i: number) => {
                  const ours = r.model === "our_model";
                  const win = ours ? false : (mkt.ranking.find((x: any) => x.model === "our_model")?.accuracy ?? 0) > r.accuracy + 0.005;
                  return (
                    <tr key={i} style={{ background: ours ? "rgba(52,211,153,0.10)" : win ? "rgba(52,211,153,0.03)" : "transparent" }}>
                      <td className="py-1 font-bold" style={{ color: ours ? "var(--hud-green)" : "var(--hud-text)" }}>
                        {r.model.replace(/_/g, " ")}{ours ? "  ← OURS" : ""}
                        {r.note ? <span className="text-[8px]" style={{ color: "var(--hud-muted)" }}> ({r.note})</span> : ""}
                      </td>
                      <td className="text-right pr-2 font-bold" style={{ color: r.acc_rank <= 2 ? "var(--hud-green)" : "var(--hud-muted)" }}>#{r.acc_rank}</td>
                      <td className="text-right pr-2 font-bold" style={{ color: ours ? "var(--hud-green)" : "var(--hud-text)" }}>{(r.accuracy * 100).toFixed(1)}%</td>
                      <td className="text-right" style={{ color: "var(--hud-muted)" }}>{r.brier ?? "—"}{r.brier_rank ? ` (#${r.brier_rank})` : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {mkt.verdict && <div className="text-[10px] mt-2" style={{ color: "var(--hud-cyan)" }}>▸ {mkt.verdict}</div>}
            {mkt.honesty && <div className="text-[9px] mt-1 leading-relaxed" style={{ color: "var(--hud-muted)" }}>{mkt.honesty}</div>}
          </div>
        )}

        {/* KRONOS foundation model head-to-head */}
        {kro?.rows?.length > 0 && (
          <div className="hud-panel hud-panel-static p-4 mb-6" style={{ borderColor: "rgba(167,139,250,0.4)" }}>
            <div className="text-[11px] tracking-widest font-bold mb-1" style={{ color: "#a78bfa" }}>
              🧠 FOUNDATION MODEL vs US — KRONOS-BASE (102M, 12B candles)
            </div>
            <div className="text-[9px] mb-3" style={{ color: "var(--hud-muted)" }}>
              {kro.task} · {kro.predictions} out-of-sample predictions · {kro.tickers} tickers
            </div>
            <table className="w-full text-[11px] tabular-nums">
              <thead><tr style={{ color: "var(--hud-muted)" }}>
                <th className="text-left py-1">MODEL</th><th className="text-right">ACCURACY</th><th className="text-right">BRIER</th>
              </tr></thead>
              <tbody>
                {kro.rows.map((r: any, i: number) => {
                  const ours = r.key === "ours";
                  return (
                    <tr key={i} style={{ background: ours ? "rgba(52,211,153,0.08)" : "transparent" }}>
                      <td className="py-1 font-bold" style={{ color: ours ? "var(--hud-green)" : "var(--hud-text)" }}>{r.model}{ours ? "  ← OURS" : ""}</td>
                      <td className="text-right font-bold" style={{ color: ours ? "var(--hud-green)" : "var(--hud-text)" }}>{(r.accuracy * 100).toFixed(1)}%</td>
                      <td className="text-right" style={{ color: ours ? "var(--hud-green)" : "var(--hud-muted)" }}>{r.brier}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {kro.verdict && <div className="text-[10px] mt-2 leading-relaxed" style={{ color: "var(--hud-cyan)" }}>▸ {kro.verdict}</div>}
          </div>
        )}

        {/* VOLATILITY head-to-head: ours vs GARCH vs EWMA */}
        {vol?.ranking?.length > 0 && (
          <div className="hud-panel hud-panel-static p-4 mb-6" style={{ borderColor: "rgba(34,211,238,0.35)" }}>
            <div className="text-[11px] tracking-widest font-bold mb-1" style={{ color: "var(--hud-cyan)" }}>
              📈 VOLATILITY FORECAST vs GARCH / EWMA
            </div>
            <div className="text-[9px] mb-3" style={{ color: "var(--hud-muted)" }}>
              {vol.task} · {vol.predictions} OOS predictions · {vol.tickers} tickers
            </div>
            <table className="w-full text-[11px] tabular-nums">
              <thead><tr style={{ color: "var(--hud-muted)" }}>
                <th className="text-left py-1">MODEL</th><th className="text-right">QLIKE (lower=better)</th>
              </tr></thead>
              <tbody>
                {vol.ranking.map((r: any, i: number) => {
                  const ours = r.model === "realized_ours";
                  return (
                    <tr key={i} style={{ background: ours ? "rgba(34,211,238,0.08)" : "transparent" }}>
                      <td className="py-1 font-bold" style={{ color: ours ? "var(--hud-cyan)" : "var(--hud-text)" }}>
                        {r.model.replace(/_/g, " ")}{ours ? "  ← OURS (MC input)" : ""}
                      </td>
                      <td className="text-right" style={{ color: ours ? "var(--hud-cyan)" : "var(--hud-muted)" }}>{r.qlike}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {vol.verdict && <div className="text-[10px] mt-2" style={{ color: "var(--hud-green)" }}>▸ {vol.verdict} — now the MC sizes off GARCH.</div>}
            {vol.honesty && <div className="text-[9px] mt-1 leading-relaxed" style={{ color: "var(--hud-muted)" }}>{vol.honesty}</div>}
          </div>
        )}

        <div className="flex flex-col gap-3">
          {rows.map((r, i) => (
            <div key={i} className="hud-panel hud-panel-static p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="text-[13px] font-bold" style={{ color: "var(--hud-text)" }}>{r.model}</div>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded whitespace-nowrap"
                      style={{ color: "#0a0e17", background: vColor(r.verdict) }}>
                  {r.verdict.toUpperCase()}
                </span>
              </div>
              <div className="flex items-center gap-5 mt-2 tabular-nums flex-wrap">
                <div>
                  <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>OURS</div>
                  <div className="text-xl font-bold" style={{ color: vColor(r.verdict) }}>{r.ours ?? "—"}</div>
                </div>
                <div className="text-[13px]" style={{ color: "var(--hud-muted)" }}>vs</div>
                <div>
                  <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>BASELINE</div>
                  <div className="text-xl font-bold" style={{ color: "var(--hud-text)" }}>{r.baseline}</div>
                  <div className="text-[8px]" style={{ color: "var(--hud-muted)" }}>{r.baseline_name}</div>
                </div>
                <div className="text-[10px] ml-auto self-end" style={{ color: "var(--hud-muted)" }}>
                  {r.metric}{r.n ? ` · n=${r.n}` : ""}
                </div>
              </div>
              <div className="text-[10px] mt-2 pt-2 border-t" style={{ color: "var(--hud-muted)", borderColor: "rgba(35,40,56,0.6)" }}>
                📚 {r.research}
              </div>
              {r.note && <div className="text-[10px] mt-1" style={{ color: "var(--hud-cyan)" }}>▸ {r.note}</div>}
            </div>
          ))}
        </div>

        {d?.disclaimer && (
          <div className="text-[10px] mt-5 pb-8 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
            {d.disclaimer}
          </div>
        )}
      </main>
    </div>
  );
}
