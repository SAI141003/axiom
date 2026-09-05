"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import TopNav from "@/components/TopNav";
import { useToggle } from "@/lib/toggles";

interface Opp { source: string; label: string; detail: string; ts?: number }
interface JournalEntry {
  ts: number; opportunity: string; risk: string; action: string; lesson: string;
  inputs?: { opps: number; cryptoPnl: number };
}
interface Risk {
  killSwitch: boolean; cryptoRecentPnl: number; cryptoRecentTrades: number;
  optionsDeployed: number; optionsPositions: number; learnerConfig: any;
}

const SRC_COLOR: Record<string, string> = {
  negrisk: "var(--hud-accent)", weather: "var(--hud-amber)",
  premarket: "var(--hud-green)", crypto: "var(--hud-accent)",
};

export default function IntelPage() {
  const [opps, setOpps] = useState<Opp[]>([]);
  const [risk, setRisk] = useState<Risk | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const autoAI = useToggle("intel.autoAnalyze");

  const load = async () => {
    try {
      const res = await fetch("/api/intel");
      if (!res.ok) return;
      const d = await res.json();
      setOpps(d.opportunities ?? []);
      setRisk(d.risk ?? null);
      setJournal(d.journal ?? []);
      setUpdated(new Date());
    } catch {}
  };

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch("/api/intel", { method: "POST" });
      if (res.ok) {
        const d = await res.json();
        setOpps(d.opportunities ?? []);
        setRisk(d.risk ?? null);
        setJournal(d.journal ?? []);
      }
    } finally {
      setAnalyzing(false);
    }
  };

  useEffect(() => {
    load();
    if (autoAI) analyze();                       // fresh AI review on open (throttled server-side)
    const li = setInterval(load, 20_000);        // live data every 20s
    const ai = setInterval(() => { if (autoAI) analyze(); }, 10 * 60_000);
    return () => { clearInterval(li); clearInterval(ai); };
  }, [autoAI]);   // eslint-disable-line react-hooks/exhaustive-deps

  const latest = journal[0];

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <div className="flex items-end justify-between flex-wrap gap-3 mb-6">
          <div>
            <h1 className="text-xl font-bold tracking-[0.2em]">INTELLIGENCE DESK</h1>
            <p className="text-xs mt-1" style={{ color: "var(--hud-muted)" }}>
              Live opportunities from every strategy · AI review every 10 min · journal that learns.
              {updated && ` Updated ${updated.toLocaleTimeString()}.`}
            </p>
          </div>
          <motion.button whileTap={{ scale: 0.96 }} whileHover={{ y: -1 }}
            onClick={analyze} disabled={analyzing}
            className="hud-chip hud-nav-active" style={{ height: 34, cursor: "pointer" }}>
            {analyzing ? "⟳ ANALYZING…" : "↻ RE-ANALYZE NOW"}
          </motion.button>
        </div>

        {/* Risk strip */}
        {risk && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            {[
              { l: "KILL SWITCH", v: risk.killSwitch ? "ACTIVE" : "clear",
                c: risk.killSwitch ? "var(--hud-red)" : "var(--hud-green)" },
              { l: "CRYPTO P&L (recent)", v: `$${risk.cryptoRecentPnl}`,
                c: risk.cryptoRecentPnl >= 0 ? "var(--hud-green)" : "var(--hud-red)" },
              { l: "CRYPTO TRADES", v: String(risk.cryptoRecentTrades), c: "var(--hud-accent)" },
              { l: "OPTIONS DEPLOYED", v: `$${risk.optionsDeployed.toLocaleString()}`, c: "var(--hud-accent)" },
              { l: "OPTIONS POSITIONS", v: String(risk.optionsPositions), c: "var(--hud-muted)" },
            ].map((s) => (
              <div key={s.l} className="hud-panel hud-panel-static px-4 py-3">
                <div className="text-[9px] tracking-[0.16em]" style={{ color: "var(--hud-muted)" }}>{s.l}</div>
                <div className="text-lg font-bold tabular-nums mt-0.5" style={{ color: s.c }}>{s.v}</div>
              </div>
            ))}
          </motion.div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Live opportunities */}
          <div className="hud-panel hud-panel-static p-4">
            <div className="text-[10px] tracking-[0.18em] mb-3" style={{ color: "var(--hud-muted)" }}>
              LIVE OPPORTUNITIES · EVERY ANGLE
            </div>
            <div className="flex flex-col gap-1.5 overflow-y-auto" style={{ maxHeight: 380 }}>
              <AnimatePresence initial={false}>
                {opps.map((o, i) => (
                  <motion.div key={`${o.source}-${o.label}-${i}`}
                    initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }} transition={{ delay: i * 0.02 }}
                    className="flex items-center gap-2 text-[11px] py-1">
                    <span style={{ width: 7, height: 7, borderRadius: 99,
                                   background: SRC_COLOR[o.source] ?? "var(--hud-muted)",
                                   boxShadow: `0 0 5px ${SRC_COLOR[o.source] ?? "transparent"}`, flexShrink: 0 }} />
                    <span className="uppercase text-[9px] w-16 flex-shrink-0" style={{ color: "var(--hud-muted)" }}>
                      {o.source}
                    </span>
                    <span className="flex-1 truncate">{o.label}</span>
                    <span className="flex-shrink-0 tabular-nums" style={{ color: "var(--hud-muted)" }}>{o.detail}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {opps.length === 0 && <span className="text-xs" style={{ color: "var(--hud-muted)" }}>scanning…</span>}
            </div>
          </div>

          {/* Latest AI review */}
          <div className="hud-panel hud-panel-static p-4">
            <div className="text-[10px] tracking-[0.18em] mb-3" style={{ color: "var(--hud-muted)" }}>
              AI DESK REVIEW {latest && `· ${new Date(latest.ts).toLocaleTimeString()}`}
            </div>
            {latest ? (
              <motion.div key={latest.ts} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                          className="flex flex-col gap-3 text-[11px] leading-relaxed">
                <div>
                  <div className="text-[9px] tracking-[0.16em] mb-1" style={{ color: "var(--hud-green)" }}>OPPORTUNITY</div>
                  <p>{latest.opportunity}</p>
                </div>
                <div>
                  <div className="text-[9px] tracking-[0.16em] mb-1" style={{ color: "var(--hud-red)" }}>RISK</div>
                  <p>{latest.risk}</p>
                </div>
                <div>
                  <div className="text-[9px] tracking-[0.16em] mb-1" style={{ color: "var(--hud-accent)" }}>ACTION · NEXT HOUR</div>
                  <p className="font-bold">{latest.action}</p>
                </div>
              </motion.div>
            ) : (
              <span className="text-xs" style={{ color: "var(--hud-muted)" }}>
                {analyzing ? "first analysis running…" : "no review yet"}
              </span>
            )}
          </div>
        </div>

        {/* Journal — what the desk has learned */}
        <div className="hud-panel hud-panel-static p-4 mt-4">
          <div className="text-[10px] tracking-[0.18em] mb-3" style={{ color: "var(--hud-muted)" }}>
            JOURNAL · LESSONS THE DESK REMEMBERS (fed back into every analysis)
          </div>
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {journal.map((j) => (
                <motion.div key={j.ts}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-3 text-[11px]">
                  <span className="tabular-nums flex-shrink-0 text-[10px] w-24" style={{ color: "var(--hud-muted)" }}>
                    {new Date(j.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="flex-1" style={{ color: "var(--hud-text)" }}>
                    {j.lesson || j.action}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
            {journal.length === 0 && <span className="text-xs" style={{ color: "var(--hud-muted)" }}>journal empty — first lesson lands after the first review</span>}
          </div>
        </div>

        <p className="text-[10px] mt-4 pb-8" style={{ color: "var(--hud-muted)" }}>
          Inputs: live NegRisk scanner · weather station edges · pre-market picks · dry-run P&L ·
          options book · learner config · Redis kill state. Every review receives the prior lessons —
          the journal is the desk&apos;s memory.
        </p>
      </main>
    </div>
  );
}
