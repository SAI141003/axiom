"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie,
  XAxis, YAxis, Tooltip, ReferenceLine, Cell,
} from "recharts";
import TopNav from "@/components/TopNav";

/**
 * SYSTEM JOURNAL — trading-journal dashboard over the brain's real record:
 * OVERALL SUMMARY (net P&L, distribution of gains/losses, win-loss ratios) ·
 * PERFORMANCE (equity curve, daily bars) · TRADE ANALYTICS (streaks, drawdown,
 * expectancy, last 20) · P&L CALENDAR · the brain's lessons + daily notes.
 * Every number traces to resolved paper trades. Nothing is a forecast.
 */

const GREEN = "rgba(52,211,153,0.85)", RED = "rgba(248,113,113,0.85)";
const fadeUp = { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 } };
const panel = "hud-panel hud-panel-static p-4";
const heading = (t: string) => (
  <div className="text-[10px] tracking-[0.25em] font-bold mb-3 text-center"
       style={{ color: "var(--hud-muted)" }}>{t}</div>
);

const verdictColor = (v: string) =>
  v?.startsWith("ROBUST") ? "var(--hud-green)"
  : v === "MARGINAL" ? "var(--hud-amber)"
  : v === "NO DATA" ? "var(--hud-muted)" : "#f87171";

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between text-[11px] py-0.5 border-b" style={{ borderColor: "rgba(35,40,56,0.5)" }}>
      <span style={{ color: "var(--hud-muted)" }}>{label}</span>
      <span className="tabular-nums font-bold" style={{ color: color ?? "var(--hud-text)" }}>{value}</span>
    </div>
  );
}

function Donut({ a, b, label, ratio }: { a: number; b: number; label: string; ratio: string }) {
  const data = [{ v: a }, { v: b }];
  return (
    <div className="relative" style={{ width: 110, height: 110 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie data={data} dataKey="v" innerRadius={36} outerRadius={50}
               startAngle={90} endAngle={-270} stroke="none">
            <Cell fill={GREEN} /><Cell fill={RED} />
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div className="text-xs font-bold tabular-nums" style={{ color: "var(--hud-text)" }}>{ratio}</div>
        <div className="text-[8px]" style={{ color: "var(--hud-muted)" }}>{label}</div>
      </div>
    </div>
  );
}

export default function JournalPage() {
  const [data, setData] = useState<any>(null);
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return { y: n.getUTCFullYear(), m: n.getUTCMonth() };
  });

  useEffect(() => {
    const load = () => fetch("/api/journal").then((r) => r.json()).then(setData).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const a = data?.analytics;
  const strategies = Object.entries<any>(data?.strategies ?? {}).sort((x, y) => y[1].pnl - x[1].pnl);

  // calendar grid for the selected month
  const cal = useMemo(() => {
    const first = new Date(Date.UTC(month.y, month.m, 1));
    const start = first.getUTCDay();
    const daysIn = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate();
    const cells: ({ day: number; key: string } | null)[] = Array(start).fill(null);
    for (let d = 1; d <= daysIn; d++) {
      cells.push({ day: d, key: `${month.y}-${String(month.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
    }
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [month]);
  const monthLabel = new Date(Date.UTC(month.y, month.m, 1))
    .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-7xl mx-auto p-5 font-mono">

        {/* ── header strip ── */}
        <motion.div {...fadeUp} transition={{ duration: 0.4 }}
                    className="hud-panel hud-panel-static px-5 py-3 mb-4 flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="text-sm font-bold tracking-[0.25em] glow-cyan">▤ SYSTEM JOURNAL</div>
            <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>paper record · written by the brain · nothing forecast</div>
          </div>
          {[
            { l: "NET P&L", v: a ? `$${a.netPnl}` : "—", c: a?.netPnl >= 0 ? GREEN : RED },
            { l: "TRADES", v: a?.trades ?? "—", c: "var(--hud-text)" },
            { l: "WIN RATE", v: a ? `${(a.winRate * 100).toFixed(1)}%` : "—", c: "var(--hud-text)" },
            { l: "PROFIT FACTOR", v: a?.profitFactor ?? "—", c: (a?.profitFactor ?? 0) >= 1 ? GREEN : RED },
            { l: "EXPECTANCY/TRADE", v: a ? `$${a.expectancy}` : "—", c: (a?.expectancy ?? 0) >= 0 ? GREEN : RED },
            { l: "MAX DRAWDOWN", v: a ? `$${a.maxDrawdown}` : "—", c: RED },
          ].map((s) => (
            <div key={s.l} className="text-right">
              <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>{s.l}</div>
              <div className="text-base font-bold tabular-nums" style={{ color: s.c as string }}>{s.v}</div>
            </div>
          ))}
        </motion.div>

        {/* ── LIVE ENGINES (current config — the numbers that matter) ── */}
        {data?.engines && Object.keys(data.engines).length > 0 && (
          <div className="mb-5">
            <div className="text-[10px] tracking-[0.25em] font-bold mb-2 text-center" style={{ color: "var(--hud-cyan)" }}>
              ⚡ LIVE ENGINES — CURRENT CONFIG (lifetime table below includes pre-fix eras)
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              {Object.entries<any>(data.engines).map(([name, e]) => (
                <div key={name} className="hud-panel hud-panel-static p-4"
                     style={{ borderColor: e.win_rate >= 0.6 ? "rgba(52,211,153,0.45)" : "var(--hud-border)" }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold" style={{ color: "var(--hud-text)" }}>{name}</span>
                    <span className="text-2xl font-bold tabular-nums"
                          style={{ color: e.win_rate >= 0.6 ? "var(--hud-green)" : "var(--hud-amber)" }}>
                      {(e.win_rate * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="text-[11px] mt-1 tabular-nums" style={{ color: "var(--hud-text)" }}>
                    {e.wins}/{e.trades} won · <span style={{ color: e.pnl >= 0 ? GREEN : RED }}>${e.pnl >= 0 ? "+" : ""}{e.pnl}</span> fee-true
                  </div>
                  <div className="text-[9px] mt-1" style={{ color: "var(--hud-muted)" }}>{e.config}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── OVERALL SUMMARY ── */}
        {heading("O V E R A L L   S U M M A R Y")}
        <div className="grid md:grid-cols-4 gap-3 mb-5">
          <motion.div {...fadeUp} transition={{ delay: 0.05 }} className={panel}>
            <div className="text-[9px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>OVERALL PERFORMANCE</div>
            <Stat label="Gross gains" value={`+$${a?.grossWin ?? 0}`} color={GREEN} />
            <Stat label="Gross losses" value={`−$${a?.grossLoss ?? 0}`} color={RED} />
            <Stat label="Net" value={`$${a?.netPnl ?? 0}`} color={(a?.netPnl ?? 0) >= 0 ? GREEN : RED} />
            <Stat label="Avg win" value={`$${a?.avgWin ?? 0}`} color={GREEN} />
            <Stat label="Avg loss" value={`$${a?.avgLoss ?? 0}`} color={RED} />
            <Stat label="Largest win" value={`$${a?.largestWin ?? 0}`} color={GREEN} />
            <Stat label="Largest loss" value={`$${a?.largestLoss ?? 0}`} color={RED} />
          </motion.div>

          <motion.div {...fadeUp} transition={{ delay: 0.1 }} className={`${panel} md:col-span-2`}>
            <div className="text-[9px] tracking-widest mb-1" style={{ color: "var(--hud-muted)" }}>DISTRIBUTION OF GAINS AND LOSSES ($/trade)</div>
            <div style={{ height: 168 }}>
              <ResponsiveContainer>
                <BarChart data={a?.histogram ?? []}>
                  <XAxis dataKey="label" tick={{ fontSize: 7, fill: "#556" }} tickLine={false} axisLine={false} interval={0} angle={-38} height={34} textAnchor="end" />
                  <YAxis tick={{ fontSize: 8, fill: "#556" }} tickLine={false} axisLine={false} width={30} />
                  <Tooltip contentStyle={{ background: "#12151c", border: "1px solid #232838", fontSize: 11 }} />
                  <Bar dataKey="n" radius={[2, 2, 0, 0]}>
                    {(a?.histogram ?? []).map((b: any, i: number) => (
                      <Cell key={i} fill={b.mid >= 0 ? GREEN : RED} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          <motion.div {...fadeUp} transition={{ delay: 0.15 }} className={`${panel} flex flex-col items-center justify-center gap-2`}>
            <div className="text-[9px] tracking-widest" style={{ color: "var(--hud-muted)" }}>OVERALL TRADE STATISTICS</div>
            <div className="flex gap-2">
              <Donut a={a?.wins ?? 0} b={a?.losses ?? 1} label="WIN : LOSS"
                     ratio={a ? `${(a.wins / Math.max(1, a.losses)).toFixed(2)} : 1` : "—"} />
              <Donut a={a?.grossWin ?? 0} b={a?.grossLoss ?? 1} label="PROFIT : LOSS"
                     ratio={a?.profitFactor != null ? `${a.profitFactor} : 1` : "—"} />
            </div>
            <div className="grid grid-cols-2 gap-x-6 text-[10px] tabular-nums w-full px-2">
              <div className="text-center"><span style={{ color: GREEN }}>{a?.wins ?? 0}</span> <span style={{ color: "var(--hud-muted)" }}>wins</span></div>
              <div className="text-center"><span style={{ color: RED }}>{a?.losses ?? 0}</span> <span style={{ color: "var(--hud-muted)" }}>losses</span></div>
            </div>
          </motion.div>
        </div>

        {/* ── PERFORMANCE ── */}
        {heading("P E R F O R M A N C E")}
        <div className="grid md:grid-cols-2 gap-3 mb-5">
          <motion.div {...fadeUp} transition={{ delay: 0.2 }} className={panel}>
            <div className="text-[9px] tracking-widest mb-1" style={{ color: "var(--hud-muted)" }}>CUMULATIVE EQUITY ($, paper)</div>
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <LineChart data={data?.equity ?? []}>
                  <XAxis dataKey="day" tick={{ fontSize: 8, fill: "#556" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 8, fill: "#556" }} tickLine={false} axisLine={false} width={42} />
                  <Tooltip contentStyle={{ background: "#12151c", border: "1px solid #232838", fontSize: 11 }} />
                  <ReferenceLine y={0} stroke="#232838" />
                  <Line type="monotone" dataKey="equity" stroke="var(--hud-accent)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
          <motion.div {...fadeUp} transition={{ delay: 0.25 }} className={panel}>
            <div className="text-[9px] tracking-widest mb-1" style={{ color: "var(--hud-muted)" }}>DAILY P&L ($)</div>
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <BarChart data={data?.days ?? []}>
                  <XAxis dataKey="day" tick={{ fontSize: 8, fill: "#556" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 8, fill: "#556" }} tickLine={false} axisLine={false} width={42} />
                  <Tooltip contentStyle={{ background: "#12151c", border: "1px solid #232838", fontSize: 11 }} />
                  <ReferenceLine y={0} stroke="#232838" />
                  <Bar dataKey="total" radius={[3, 3, 0, 0]}>
                    {(data?.days ?? []).map((d: any, i: number) => (
                      <Cell key={i} fill={d.total >= 0 ? GREEN : RED} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        </div>

        {/* ── TRADE ANALYTICS ── */}
        {heading("T R A D E   A N A L Y T I C S")}
        <div className="grid md:grid-cols-3 gap-3 mb-5">
          <motion.div {...fadeUp} transition={{ delay: 0.3 }} className={panel}>
            <div className="text-[9px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>DRAWDOWN AND STREAKS</div>
            <Stat label="Max drawdown" value={`$${a?.maxDrawdown ?? 0}`} color={RED} />
            <Stat label="Max consecutive wins" value={`${a?.maxConsecWins ?? 0}`} color={GREEN} />
            <Stat label="Max consecutive losses" value={`${a?.maxConsecLosses ?? 0}`} color={RED} />
            <Stat label="Expectancy per trade" value={`$${a?.expectancy ?? 0}`} color={(a?.expectancy ?? 0) >= 0 ? GREEN : RED} />
            <Stat label="Breakeven win% needed" value={a && (a.avgWin + a.avgLoss) > 0 ? `${((a.avgLoss / (a.avgWin + a.avgLoss)) * 100).toFixed(1)}%` : "—"} />
          </motion.div>

          <motion.div {...fadeUp} transition={{ delay: 0.35 }} className={panel}>
            <div className="text-[9px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>SECTION PERFORMANCE (MC verdicts)</div>
            {strategies.map(([name, s]) => (
              <div key={name} className="flex items-center justify-between text-[10px] py-1 border-b" style={{ borderColor: "rgba(35,40,56,0.5)" }}>
                <span style={{ color: "var(--hud-text)" }}>{name}</span>
                <span className="tabular-nums" style={{ color: s.pnl >= 0 ? GREEN : RED }}>${s.pnl}</span>
                <span className="text-[9px] font-bold" style={{ color: verdictColor(s.mcVerdict) }}>{s.mcVerdict}</span>
              </div>
            ))}
          </motion.div>

          <motion.div {...fadeUp} transition={{ delay: 0.4 }} className={panel}>
            <div className="text-[9px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>LAST 20 TRADES</div>
            <div className="max-h-44 overflow-y-auto">
              {(a?.last20 ?? []).slice().reverse().map((t: any, i: number) => (
                <div key={i} className="flex justify-between text-[10px] py-0.5">
                  <span style={{ color: "var(--hud-muted)" }}>{t.s}</span>
                  <span style={{ color: "var(--hud-muted)" }}>{new Date(t.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                  <span className="tabular-nums font-bold" style={{ color: t.pnl >= 0 ? GREEN : RED }}>
                    {t.pnl >= 0 ? "+" : ""}{t.pnl}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>

        {/* ── STREAM CORRELATIONS (Dalio's Holy Grail) ── */}
        {heading("S T R E A M   C O R R E L A T I O N S")}
        <motion.div {...fadeUp} transition={{ delay: 0.42 }} className={`${panel} mb-5`}>
          <div className="text-[9px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
            DAILY P&L CORRELATION BETWEEN STRATEGIES — the portfolio&apos;s value is LOW correlation
            (uncorrelated streams cut risk without cutting return)
          </div>
          {(() => {
            const c = data?.correlations ?? {};
            const names = Object.keys(c);
            if (names.length < 2) return <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>needs 2+ strategies with 3+ shared days</div>;
            const cellBg = (v: number | null) => v == null ? "transparent"
              : v > 0 ? `rgba(248,113,113,${Math.min(0.55, Math.abs(v) * 0.55)})`
                      : `rgba(52,211,153,${Math.min(0.55, Math.abs(v) * 0.55)})`;
            return (
              <div className="overflow-x-auto">
                <table className="text-[9px] tabular-nums">
                  <thead><tr><th />{names.map((n) => (
                    <th key={n} className="px-2 py-1 font-normal" style={{ color: "var(--hud-muted)" }}>{n.slice(0, 8)}</th>
                  ))}</tr></thead>
                  <tbody>
                    {names.map((r) => (
                      <tr key={r}>
                        <td className="pr-2 py-0.5" style={{ color: "var(--hud-muted)" }}>{r.slice(0, 12)}</td>
                        {names.map((col) => {
                          const v = c[r]?.[col] ?? null;
                          return (
                            <td key={col} className="px-2 py-1 text-center rounded"
                                style={{ background: r === col ? "rgba(35,40,56,0.6)" : cellBg(v),
                                         color: "var(--hud-text)" }}>
                              {v == null ? "—" : v.toFixed(2)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="text-[8px] mt-1" style={{ color: "var(--hud-muted)" }}>
                  green = uncorrelated/negative (good diversification) · red = correlated (redundant risk)
                </div>
              </div>
            );
          })()}
        </motion.div>

        {/* ── P&L CALENDAR ── */}
        {heading("P & L   C A L E N D A R")}
        <motion.div {...fadeUp} transition={{ delay: 0.45 }} className={`${panel} mb-5`}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold" style={{ color: "var(--hud-text)" }}>{monthLabel}</div>
            <div className="flex gap-1">
              <button onClick={() => setMonth((m) => m.m === 0 ? { y: m.y - 1, m: 11 } : { y: m.y, m: m.m - 1 })}
                      className="px-2 py-0.5 text-xs rounded border" style={{ borderColor: "var(--hud-border)", color: "var(--hud-text)" }}>‹</button>
              <button onClick={() => { const n = new Date(); setMonth({ y: n.getUTCFullYear(), m: n.getUTCMonth() }); }}
                      className="px-2 py-0.5 text-[10px] rounded border" style={{ borderColor: "var(--hud-border)", color: "var(--hud-text)" }}>Today</button>
              <button onClick={() => setMonth((m) => m.m === 11 ? { y: m.y + 1, m: 0 } : { y: m.y, m: m.m + 1 })}
                      className="px-2 py-0.5 text-xs rounded border" style={{ borderColor: "var(--hud-border)", color: "var(--hud-text)" }}>›</button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[9px] mb-1" style={{ color: "var(--hud-muted)" }}>
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cal.map((c, i) => {
              const rec = c ? data?.calendar?.[c.key] : null;
              // vivid, clearly-separated profit(green)/loss(red) shading + matching border
              const intensity = rec ? Math.min(0.6, 0.22 + Math.abs(rec.pnl) / 220) : 0;
              const win = rec && rec.pnl >= 0;
              const bg = rec ? (win ? `rgba(52,211,153,${intensity})` : `rgba(248,113,113,${intensity})`)
                             : "rgba(23,27,36,0.35)";
              const border = rec ? (win ? "rgba(52,211,153,0.65)" : "rgba(248,113,113,0.65)")
                                  : "rgba(35,40,56,0.6)";
              return (
                <div key={i} className="rounded p-1.5 min-h-[58px] border"
                     style={{ background: c ? bg : "transparent", borderColor: c ? border : "transparent",
                              boxShadow: rec ? `inset 0 0 0 1px ${win ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)"}` : "none" }}>
                  {c && (
                    <>
                      <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>{c.day}</div>
                      {rec && (
                        <>
                          <div className="text-[11px] font-bold tabular-nums" style={{ color: win ? "#6ee7b7" : "#fca5a5" }}>
                            {win ? "+" : ""}{rec.pnl}
                          </div>
                          <div className="text-[8px]" style={{ color: "var(--hud-muted)" }}>{rec.trades} tr</div>
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </motion.div>

        {/* ── BRAIN NOTES ── */}
        {heading("B R A I N   N O T E S")}
        <div className="grid md:grid-cols-2 gap-3 mb-8">
          <motion.div {...fadeUp} transition={{ delay: 0.5 }} className={panel}>
            <div className="text-[9px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>STABLE LESSONS (where wins/losses live)</div>
            <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
              {(data?.lessons ?? []).filter((l: any) => l.stable).map((l: any, i: number) => (
                <div key={i} className="text-[10px] flex gap-2">
                  <span style={{ color: l.kind === "EDGE" ? GREEN : RED }}>{l.kind === "EDGE" ? "▲" : "▼"}</span>
                  <span style={{ color: "var(--hud-text)" }}>{l.note}</span>
                </div>
              ))}
            </div>
          </motion.div>
          <motion.div {...fadeUp} transition={{ delay: 0.55 }} className={panel}>
            <div className="text-[9px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>DAILY NOTES (one per day, by the brain)</div>
            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
              {(data?.notes ?? []).map((n: any, i: number) => (
                <div key={i} className="border-l-2 pl-2" style={{ borderColor: "var(--hud-accent)" }}>
                  <div className="text-[10px] font-bold" style={{ color: "var(--hud-accent)" }}>{n.day}</div>
                  {Object.entries<any>(n.summary ?? {}).map(([s, r]) => (
                    <div key={s} className="text-[9px] tabular-nums" style={{ color: "var(--hud-text)" }}>
                      {s}: {r.trades}tr · {r.wins}W · ${r.pnl >= 0 ? "+" : ""}{r.pnl} · P(win) {(r.win_prob * 100).toFixed(0)}%
                    </div>
                  ))}
                  {(n.actions ?? []).map((ac: string, j: number) => (
                    <div key={j} className="text-[9px] font-bold" style={{ color: "var(--hud-amber)" }}>⚙ {ac}</div>
                  ))}
                </div>
              ))}
              {(data?.notes ?? []).length === 0 && (
                <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>first note lands after the next overnight pass</div>
              )}
            </div>
          </motion.div>
        </div>
      </main>
    </div>
  );
}
