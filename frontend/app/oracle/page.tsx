"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import TopNav from "@/components/TopNav";

/**
 * THE ORACLE — ask anything, get an exact verdict + probability + why.
 * A superforecaster pipeline: outside-view base rate → live simulation →
 * 72-agent swarm → behavior → extremized fusion. Earnings questions route to
 * a dedicated cited engine (PEAD / dispersion / revisions / implied move).
 * Every forecast is logged and Brier-scored against reality — the track record
 * is shown up top, because a forecaster you can't audit is just a vibe.
 */

const EXAMPLES = [
  "Will TSLA go up today?",
  "Will NVDA beat earnings?",
  "Will AAPL go up after earnings?",
  "Will a subscription app for AI meal planning succeed?",
];

const STAGE_LABELS: Record<string, string> = {
  outside_view: "OUTSIDE VIEW",
  simulation: "SIMULATION",
  swarm: "SWARM",
  behavior: "BEHAVIOR",
};

function pct(v: number) { return `${(v * 100).toFixed(0)}%`; }

export default function OraclePage() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState("");
  const [track, setTrack] = useState<any>(null);

  useEffect(() => {
    const load = () => fetch("/api/oracle/track").then((x) => x.json()).then(setTrack).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true); setErr(""); setR(null);
    try {
      const res = await fetch("/api/oracle", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const d = await res.json();
      if (d.error) setErr(d.error); else setR(d);
    } catch { setErr("oracle unreachable"); }
    setBusy(false);
  };

  const positive = r && ["UP", "BEAT", "PASS", "YES"].includes(r.verdict);
  const verdictColor = r ? (positive ? "var(--hud-green)" : "#f87171") : "";
  const isEarnings = r?.engine === "earnings";
  const e = r?.earnings;

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">◈ THE ORACLE</h1>
          <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
            outside-view base rate → simulation → 72-agent swarm → extremized verdict · every call Brier-scored
          </p>
        </motion.div>

        {/* ── LIVE TRACK RECORD — the differentiator ── */}
        <TrackBadge track={track} />

        <form onSubmit={(ev) => { ev.preventDefault(); ask(q); }} className="flex gap-2 mb-3">
          <input value={q} onChange={(ev) => setQ(ev.target.value)}
                 placeholder="Will TSLA go up today? · Will NVDA beat earnings? · Will my startup idea work?"
                 className="flex-1 px-4 py-3 text-sm rounded border bg-transparent"
                 style={{ borderColor: "var(--hud-border)", color: "var(--hud-text)" }} />
          <button type="submit" disabled={busy}
                  className="px-6 py-3 text-sm rounded border font-bold"
                  style={{ borderColor: "var(--hud-accent)", color: busy ? "var(--hud-muted)" : "var(--hud-accent)" }}>
            {busy ? "THINKING…" : "ASK"}
          </button>
        </form>
        <div className="flex gap-2 flex-wrap mb-8">
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => { setQ(ex); ask(ex); }}
                    className="text-[10px] px-2 py-1 rounded border hover:opacity-80"
                    style={{ borderColor: "var(--hud-border)", color: "var(--hud-muted)" }}>
              {ex}
            </button>
          ))}
        </div>

        {busy && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      className="text-center py-14 text-sm" style={{ color: "var(--hud-muted)" }}>
            <div className="animate-pulse">outside view → simulation → 72 agents deliberating…</div>
            <div className="text-[10px] mt-2">(~30–60s for the swarm; instant for earnings)</div>
          </motion.div>
        )}
        {err && <div className="text-center py-8 text-sm" style={{ color: "#f87171" }}>⚠ {err}</div>}

        {r && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4">
            {/* verdict card */}
            <div className="hud-panel hud-panel-static p-6 text-center">
              <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
                {String(r.type).replace("_", " ").toUpperCase()} · {r.symbol ?? "—"}
                {isEarnings && r.nextEarnings ? ` · reports ${r.nextEarnings}` : ` · ${r.horizon}`}
                {isEarnings && <span style={{ color: "var(--hud-cyan)" }}> · CITED ENGINE</span>}
              </div>
              <div className="text-5xl font-bold tracking-widest" style={{ color: verdictColor }}>
                {r.verdict}
              </div>
              <div className="text-2xl font-bold tabular-nums mt-2" style={{ color: "var(--hud-text)" }}>
                {pct(r.probability)}
              </div>
              <div className="text-[11px] mt-1" style={{ color: "var(--hud-muted)" }}>
                {r.conviction} conviction{r.extremized ? " · extremized" : ""}
              </div>
              <div className="mt-3 h-2 rounded mx-auto" style={{ maxWidth: 420, background: "#1c2130" }}>
                <div className="h-full rounded" style={{ width: pct(r.probability), background: verdictColor }} />
              </div>
            </div>

            {/* ── EARNINGS TWIN-GAUGE (beat vs reaction) ── */}
            {isEarnings && e && (
              <div className="grid md:grid-cols-2 gap-4">
                <Gauge label="P(BEAT CONSENSUS)" p={e.pBeat} verdict={e.verdictBeat}
                       sub={`streak ${e.beatStreak} · ${e.nAnalysts ?? "?"} analysts · exp surprise ${e.expectedSurprise >= 0 ? "+" : ""}${(e.expectedSurprise * 100).toFixed(1)}%`} />
                <Gauge label="P(STOCK UP AFTER)" p={e.pUpAfter} verdict={e.verdictDirection}
                       sub={`capped near 50% — reaction is near-efficient`} capped />
                <div className="hud-panel hud-panel-static p-4 md:col-span-2 grid grid-cols-3 gap-3 text-center tabular-nums">
                  <Stat label="DISPERSION" value={e.dispersion ?? "—"}
                        hint={e.dispersion > 0.3 ? "high — analysts split (bearish, DMS 2002)" : "tight consensus"} />
                  <Stat label="IMPLIED MOVE" value={e.impliedMove != null ? `±${(e.impliedMove * 100).toFixed(1)}%` : "—"}
                        hint="ATM straddle / spot" />
                  <Stat label="REVISIONS 7d" value={`↑${e.revisions?.up7d ?? 0} ↓${e.revisions?.down30d ?? 0}`}
                        hint={e.confidence === "thin-data" ? "thin data — low confidence" : "revision momentum"} />
                </div>
              </div>
            )}

            {/* ── SUPERFORECASTER PIPELINE (non-earnings) ── */}
            {!isEarnings && r.stages && (
              <div className="hud-panel hud-panel-static p-4">
                <div className="text-[10px] tracking-widest mb-3" style={{ color: "var(--hud-muted)" }}>
                  THE PIPELINE — each stage's probability, fused into the verdict
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {["outside_view", "simulation", "swarm", "behavior"].map((k, i) => {
                    const v = r.stages[k];
                    return (
                      <div key={k} className="flex items-center gap-1">
                        <div className="flex flex-col items-center px-2 py-1 rounded border min-w-[84px]"
                             style={{ borderColor: v == null ? "#2a2f3e" : "var(--hud-border)", opacity: v == null ? 0.4 : 1 }}>
                          <span className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>{STAGE_LABELS[k]}</span>
                          <span className="text-base font-bold tabular-nums"
                                style={{ color: v == null ? "var(--hud-muted)" : v >= 0.5 ? "var(--hud-green)" : "#f87171" }}>
                            {v == null ? "n/a" : pct(v)}
                          </span>
                        </div>
                        {i < 3 && <span style={{ color: "var(--hud-muted)" }}>→</span>}
                      </div>
                    );
                  })}
                  <span style={{ color: "var(--hud-cyan)" }} className="px-1">⇒</span>
                  <div className="flex flex-col items-center px-3 py-1 rounded border min-w-[84px]"
                       style={{ borderColor: verdictColor }}>
                    <span className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>VERDICT</span>
                    <span className="text-base font-bold tabular-nums" style={{ color: verdictColor }}>{pct(r.probability)}</span>
                  </div>
                </div>
                {r.baseRateDesc && (
                  <div className="text-[9px] mt-2" style={{ color: "var(--hud-muted)" }}>
                    outside view = reference class “{r.referenceClass}” ({r.baseRateDesc})
                  </div>
                )}
              </div>
            )}

            {/* why */}
            <div className="hud-panel hud-panel-static p-4">
              <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>WHY — THE DRIVERS</div>
              {r.drivers.map((d: string, i: number) => (
                <div key={i} className="text-[12px] py-1 flex gap-2">
                  <span style={{ color: "var(--hud-cyan)" }}>▸</span>
                  <span style={{ color: "var(--hud-text)" }}>{d}</span>
                </div>
              ))}
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              {r.simulation && (
                <div className="hud-panel hud-panel-static p-4">
                  <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
                    {r.simulation.nPaths.toLocaleString()} SCENARIO SIMULATIONS (realized vol)
                  </div>
                  {Object.entries(r.simulation.scenarios).map(([k, v]: [string, any]) => (
                    <div key={k} className="flex items-center gap-2 py-0.5">
                      <span className="text-[10px] w-24" style={{ color: "var(--hud-muted)" }}>{k}</span>
                      <div className="flex-1 h-3 rounded" style={{ background: "#1c2130" }}>
                        <div className="h-full rounded" style={{
                          width: pct(v),
                          background: k.startsWith("up") ? "rgba(52,211,153,0.7)" : k.startsWith("down") ? "rgba(248,113,113,0.7)" : "rgba(148,163,184,0.5)",
                        }} />
                      </div>
                      <span className="text-[10px] tabular-nums w-10 text-right" style={{ color: "var(--hud-text)" }}>{pct(v)}</span>
                    </div>
                  ))}
                </div>
              )}
              {r.swarm && (
                <div className="hud-panel hud-panel-static p-4">
                  <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
                    SWARM · {r.swarm.agents} AGENTS · disagreement {r.swarm.disagreement}
                  </div>
                  {r.swarm.voices.map((v: any, i: number) => (
                    <div key={i} className="text-[10px] py-0.5">
                      <span style={{ color: v.p > 0.5 ? "var(--hud-green)" : "#f87171" }}>
                        {v.name} {pct(v.p)}
                      </span>{" "}
                      <span style={{ color: "var(--hud-muted)" }}>{v.why?.slice(0, 70)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {r.evidence && (
              <div className="hud-panel hud-panel-static p-4 flex gap-6 flex-wrap text-[11px] tabular-nums">
                <span style={{ color: "var(--hud-text)" }}>${r.evidence.price}</span>
                <span style={{ color: r.evidence.chgPct >= 0 ? "var(--hud-green)" : "#f87171" }}>
                  {r.evidence.chgPct >= 0 ? "+" : ""}{r.evidence.chgPct}% today
                </span>
                <span style={{ color: "var(--hud-muted)" }}>vol {r.evidence.dailyVolPct}%/day</span>
                <span style={{ color: "var(--hud-muted)" }}>mom20 {r.evidence.mom20Pct}%</span>
                <span style={{ color: "var(--hud-muted)" }}>up-day rate {pct(r.evidence.upDayBaseRate)}</span>
                <span style={{ color: "var(--hud-muted)" }}>
                  {r.evidence.marketOpen ? `session ${pct(r.evidence.sessionFrac)} done` : "market closed"}
                </span>
              </div>
            )}
            <div className="text-[10px] text-center pb-8" style={{ color: "var(--hud-muted)" }}>{r.honesty}</div>
          </motion.div>
        )}
      </main>
    </div>
  );
}

function TrackBadge({ track }: { track: any }) {
  if (!track) return null;
  const o = track.oracle, en = track.earnings;
  const cells: { label: string; big: string; sub: string; good?: boolean }[] = [];
  if (o) cells.push({
    label: "DIRECTION CALLS", big: `${(o.accuracy * 100).toFixed(0)}%`,
    sub: `${o.resolved} scored · Brier ${o.brier}`, good: o.brier < 0.25,
  });
  if (en?.beat) cells.push({
    label: "EARNINGS BEATS", big: `${(en.beat.accuracy * 100).toFixed(0)}%`,
    sub: `${en.beat.n} scored · Brier ${en.beat.brier}`, good: en.beat.brier < 0.25,
  });
  if (en?.direction) cells.push({
    label: "POST-EARNINGS DIR", big: `${(en.direction.accuracy * 100).toFixed(0)}%`,
    sub: `${en.direction.n} scored · Brier ${en.direction.brier}`, good: en.direction.brier < 0.25,
  });

  return (
    <div className="hud-panel hud-panel-static px-4 py-2 mb-4 flex items-center justify-between flex-wrap gap-3">
      <div>
        <div className="text-[10px] tracking-widest font-bold" style={{ color: "var(--hud-cyan)" }}>
          ⊙ TRACKED ACCURACY — SCORED vs REALITY
        </div>
        <div className="text-[8px]" style={{ color: "var(--hud-muted)" }}>
          Brier &lt; 0.25 = skill beyond a coin flip · {track.pending ?? 0} forecasts awaiting resolution
        </div>
      </div>
      <div className="flex gap-4 tabular-nums">
        {cells.length === 0 && (
          <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>
            building record — forecasts resolve as their dates arrive
          </div>
        )}
        {cells.map((c) => (
          <div key={c.label} className="text-right">
            <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>{c.label}</div>
            <div className="text-lg font-bold" style={{ color: c.good ? "var(--hud-green)" : "var(--hud-amber)" }}>{c.big}</div>
            <div className="text-[8px]" style={{ color: "var(--hud-muted)" }}>{c.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Gauge({ label, p, verdict, sub, capped }: { label: string; p: number; verdict: string; sub: string; capped?: boolean }) {
  const good = ["BEAT", "UP", "PASS"].includes(verdict);
  const color = good ? "var(--hud-green)" : "#f87171";
  return (
    <div className="hud-panel hud-panel-static p-4">
      <div className="text-[10px] tracking-widest mb-1" style={{ color: "var(--hud-muted)" }}>{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums" style={{ color }}>{pct(p)}</span>
        <span className="text-sm font-bold" style={{ color }}>{verdict}</span>
      </div>
      <div className="mt-2 h-2 rounded" style={{ background: "#1c2130" }}>
        <div className="h-full rounded" style={{ width: pct(p), background: color }} />
        {capped && <div className="relative" style={{ left: "50%", top: -8, width: 1, height: 8, background: "var(--hud-muted)" }} />}
      </div>
      <div className="text-[9px] mt-1" style={{ color: "var(--hud-muted)" }}>{sub}</div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: any; hint: string }) {
  return (
    <div>
      <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>{label}</div>
      <div className="text-lg font-bold" style={{ color: "var(--hud-text)" }}>{value}</div>
      <div className="text-[8px]" style={{ color: "var(--hud-muted)" }}>{hint}</div>
    </div>
  );
}
