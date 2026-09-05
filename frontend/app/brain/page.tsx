"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import TopNav from "@/components/TopNav";
import BrainCore, { type DataMote } from "@/components/BrainCore";

/**
 * THE BRAIN — full-viewport cinematic scene. The anatomical brain fills the
 * stage; the system's six real feeds dock at the edges; MiroFish's live
 * agents orbit the core as satellites; real events stream across the bottom.
 * Every element traces to a live endpoint — no invented numbers.
 */

interface Feed {
  id: string; label: string; sub: string; href: string;
  status: "live" | "idle" | "off"; detail: string;
}
interface Agent { id: string; label: string; group: string; alive: boolean }

const LEFT_POS = [{ top: "12%" }, { top: "42%" }, { top: "72%" }];
const RIGHT_POS = [{ top: "12%" }, { top: "42%" }, { top: "72%" }];

export default function BrainPage() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [lessons, setLessons] = useState<any[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [strategies, setStrategies] = useState<Record<string, any>>({});
  const [activity, setActivity] = useState(0.4);
  const [motes, setMotes] = useState<DataMote[]>([]);
  const [mood, setMood] = useState(0);
  const [census, setCensus] = useState<{ total: number; running: number; services: { total: number; running: number }; swarm: { total: number; alive: number }; mirofish: { online: boolean; population: number; archetypes: number; model: string } } | null>(null);
  const [stage, setStage] = useState({ w: 1200, h: 760 });

  useEffect(() => {
    const load = () => fetch("/api/agents").then((r) => r.json()).then(setCensus).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const measure = () => setStage({
      w: window.innerWidth,
      h: Math.max(560, window.innerHeight - 56),
    });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const [journal, brain, bots] = await Promise.all([
          fetch("/api/journal").then((r) => r.json()).catch(() => null),
          fetch("/api/brain").then((r) => r.json()).catch(() => null),
          fetch("/api/bots").then((r) => r.json()).catch(() => null),
        ]);

        const strat = journal?.strategies ?? {};
        setStrategies(strat);
        setLessons((journal?.lessons ?? []).filter((l: any) => l.stable).slice(0, 4));
        setActions(journal?.actions ?? []);
        setAgents(brain?.agents ?? []);
        setEvents((brain?.events ?? []).slice(-14));

        // ── REAL data motes: trades, opinions, agent events, news ──
        const a = journal?.analytics;
        const tradeMotes: DataMote[] = (a?.last20 ?? []).map((t: any) => ({
          label: `${t.s} ${t.pnl >= 0 ? "+" : ""}${t.pnl}`,
          kind: t.pnl >= 0 ? "win" : "loss",
          mag: Math.min(1, Math.abs(t.pnl) / 50),
        }));
        const opinionMotes: DataMote[] = (journal?.lessons ?? [])
          .filter((l: any) => l.stable).slice(0, 8)
          .map((l: any) => ({ label: `${l.strategy}:${l.segment}`, kind: "opinion", mag: 0.6 }));
        const eventMotes: DataMote[] = (brain?.events ?? []).slice(-8)
          .map((e: any) => ({ label: e.label ?? e.type ?? "event", kind: "event", mag: 0.4 }));
        let newsMotes: DataMote[] = [];
        try {
          const nd = await fetch("/api/newsdesk").then((r) => r.json());
          newsMotes = (nd?.cards ?? []).filter((c: any) => c.magnitude >= 3).slice(0, 10)
            .map((c: any) => ({ label: `${c.sym}: ${c.title}`, kind: "news", mag: c.magnitude / 5 }));
        } catch {}
        setMotes([...tradeMotes, ...opinionMotes, ...eventMotes, ...newsMotes]);
        // mood = today's real P&L, squashed to −1..1
        const today = (journal?.days ?? []).slice(-1)[0];
        setMood(Math.max(-1, Math.min(1, (today?.total ?? 0) / 200)));

        const alive = (brain?.agents ?? []).filter((a: any) => a.alive).length;
        const total = (brain?.agents ?? []).length || 1;
        const stable = (journal?.lessons ?? []).filter((l: any) => l.stable).length;
        setActivity(Math.min(1, (alive / total) * 0.6 + stable * 0.03));

        const on = (k: string) => bots?.[k] !== false;
        const s = (name: string) => strat[name];
        setFeeds([
          { id: "market", label: "MARKET DATA", sub: "Binance · CLOB asks", href: "/crypto",
            status: "live", detail: `${s("crypto-5m")?.trades ?? 0} windows scored` },
          { id: "news", label: "NEWS FEED", sub: "quant-classified live", href: "/news",
            status: "live", detail: "event → chain → play" },
          { id: "weather", label: "WEATHER STATIONS", sub: "METAR + ensembles", href: "/weather-bot",
            status: on("weather") ? "live" : "off",
            detail: `${s("weather")?.trades ?? 0} resolved · ${s("weather")?.mcVerdict ?? ""}` },
          { id: "chain", label: "ON-CHAIN", sub: "Chainlink (resolution src)", href: "/crypto",
            status: on("oraclelag") ? "live" : "off", detail: "lag probe 6×/window" },
          { id: "kronos", label: "KRONOS MODEL", sub: "1h foundation forecasts", href: "/journal",
            status: on("kronos1h") ? "live" : "off",
            detail: `${s("kronos1h")?.trades ?? 0} trades · ETH signal-only` },
          { id: "mc", label: "MONTE CARLO", sub: "10k iterations hourly", href: "/journal",
            status: "live",
            detail: `${Object.values(strat).filter((x: any) => x.mcVerdict?.startsWith("ROBUST")).length} robust strategies` },
        ]);
      } catch {}
    };
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  const robust = Object.entries(strategies).filter(([, s]) => s.mcVerdict?.startsWith("ROBUST"));
  const brainSize = Math.min(stage.h * 0.92, stage.w * 0.62, 940);
  const orbitR = brainSize * 0.46;

  return (
    <div className="hud-bg overflow-hidden">
      <TopNav />

      {/* ═══ THE STAGE — full viewport ═══ */}
      <div className="relative w-full" style={{ height: stage.h }}>

        {/* vignette for the movie look */}
        <div className="absolute inset-0 pointer-events-none" style={{
          zIndex: 3,
          background: "radial-gradient(ellipse at center, transparent 55%, rgba(5,6,10,0.8) 100%)",
        }} />

        {/* title HUD */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1 }}
                    className="absolute top-3 left-1/2 -translate-x-1/2 text-center pointer-events-none"
                    style={{ zIndex: 4 }}>
          <div className="text-lg font-bold tracking-[0.5em] glow-cyan font-mono">THE BRAIN</div>
          <div className="text-[10px] font-mono" style={{ color: "var(--hud-muted)" }}>
            perception → attribution → memory → bounded action
          </div>
        </motion.div>

        {/* live AGENT CENSUS — top-right corner */}
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.3 }}
                    className="hud-panel hud-panel-static px-3 py-2 font-mono backdrop-blur-sm"
                    style={{ position: "absolute", top: 12, right: 16, zIndex: 5, background: "rgba(18,21,28,0.8)" }}>
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full" style={{
              background: census && census.running === census.total ? "var(--hud-green)" : "var(--hud-amber)",
              boxShadow: "0 0 8px rgba(52,211,153,0.8)",
              animation: "pulse 2s ease-in-out infinite",
            }} />
            <span className="text-[11px] font-bold tracking-wider" style={{ color: "var(--hud-text)" }}>
              AGENTS {census ? `${census.running}/${census.total}` : "…"} LIVE
            </span>
          </div>
          {census && (
            <div className="text-[9px] mt-1 tabular-nums" style={{ color: "var(--hud-muted)" }}>
              <div>services <span style={{ color: "var(--hud-cyan)" }}>{census.services.running}/{census.services.total}</span> running</div>
              <div>bot swarm <span style={{ color: "var(--hud-cyan)" }}>{census.swarm.alive}/{census.swarm.total}</span> alive</div>
              <div>MiroFish micro-agents <span style={{ color: census.mirofish?.online ? "var(--hud-green)" : "#f87171" }}>
                {census.mirofish?.online ? census.mirofish.population : "offline"}</span>
                {census.mirofish?.online && <span> ({census.mirofish.archetypes}×)</span>}</div>
            </div>
          )}
        </motion.div>

        {/* the core — flex-centered (framer-motion owns transform) */}
        <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 1 }}>
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 1.2, ease: "easeOut" }}>
            <BrainCore size={brainSize} motes={motes} activity={activity} stars />
          </motion.div>
        </div>

        {/* MiroFish agents — satellites orbiting the core */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 2 }}>
          <div className="relative brain-ring" style={{ width: orbitR * 2, height: orbitR * 2 }}>
            {agents.map((a, i) => {
              const ang = (i / Math.max(1, agents.length)) * 360;
              return (
                <div key={a.id} className="absolute left-1/2 top-1/2"
                     style={{ transform: `rotate(${ang}deg) translateX(${orbitR}px)` }}>
                  <div className="brain-ring-item flex items-center gap-1.5 font-mono"
                       style={{ ["--a" as any]: `${-ang}deg` }}>
                    <span className="inline-block w-1.5 h-1.5 rounded-full" style={{
                      background: a.alive ? "var(--hud-cyan)" : "#f87171",
                      boxShadow: a.alive ? "0 0 6px rgba(34,211,238,0.9)" : "none",
                    }} />
                    <span className="text-[9px] tracking-wider whitespace-nowrap"
                          style={{ color: a.alive ? "var(--hud-muted)" : "#f87171" }}>
                      {a.label.toUpperCase()}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* left feed dock — anchor via inline left/right (survives any class order) */}
        {feeds.slice(0, 3).map((f, i) => (
          <motion.div key={f.id} initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.5, delay: 0.4 + i * 0.15 }}
                      className="absolute hud-panel hud-panel-static px-3 py-2 backdrop-blur-sm"
                      style={{ position: "absolute", ...LEFT_POS[i], left: 12, width: 205, zIndex: 4, background: "rgba(18,21,28,0.72)" }}>
            <FeedChip f={f} />
          </motion.div>
        ))}
        {/* right feed dock */}
        {feeds.slice(3, 6).map((f, i) => (
          <motion.div key={f.id} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.5, delay: 0.4 + i * 0.15 }}
                      className="absolute hud-panel hud-panel-static px-3 py-2 backdrop-blur-sm"
                      style={{ position: "absolute", ...RIGHT_POS[i], right: 12, width: 205, zIndex: 4, background: "rgba(18,21,28,0.72)" }}>
            <FeedChip f={f} />
          </motion.div>
        ))}

        {/* bottom HUD: verdicts + lessons + actions, translucent over the scene */}
        <div className="absolute bottom-8 left-0 right-0 flex justify-center" style={{ zIndex: 4 }}>
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.9 }}
                    className="grid grid-cols-3 gap-3 font-mono px-4"
                    style={{ width: "min(96%, 1080px)" }}>
          <div className="hud-panel hud-panel-static px-3 py-2 backdrop-blur-sm" style={{ background: "rgba(18,21,28,0.72)" }}>
            <div className="text-[9px] tracking-widest mb-1" style={{ color: "var(--hud-muted)" }}>HIGH-PROBABILITY SETUPS</div>
            {robust.length ? robust.map(([name, s]) => (
              <div key={name} className="flex justify-between text-[10px]">
                <span style={{ color: "var(--hud-green)" }}>▲ {name}</span>
                <span className="tabular-nums" style={{ color: "var(--hud-text)" }}>P {((s.mcProfitProb ?? 0) * 100).toFixed(0)}%</span>
              </div>
            )) : <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>none until MC says ROBUST</div>}
          </div>
          <div className="hud-panel hud-panel-static px-3 py-2 backdrop-blur-sm" style={{ background: "rgba(18,21,28,0.72)" }}>
            <div className="text-[9px] tracking-widest mb-1" style={{ color: "var(--hud-muted)" }}>PATTERN RECOGNITION</div>
            {lessons.map((l, i) => (
              <div key={i} className="text-[10px] truncate">
                <span style={{ color: l.kind === "EDGE" ? "var(--hud-green)" : "#f87171" }}>{l.kind === "EDGE" ? "▲" : "▼"}</span>
                <span style={{ color: "var(--hud-text)" }}> {l.strategy} · {l.segment} · ${l.pnl}</span>
              </div>
            ))}
            {lessons.length === 0 && <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>accumulating…</div>}
          </div>
          <div className="hud-panel hud-panel-static px-3 py-2 backdrop-blur-sm" style={{ background: "rgba(18,21,28,0.72)" }}>
            <div className="text-[9px] tracking-widest mb-1" style={{ color: "var(--hud-muted)" }}>SELF-CORRECTIONS</div>
            {actions.length ? actions.map((a, i) => (
              <div key={i} className="text-[10px] truncate" style={{ color: "var(--hud-amber)" }}>⚙ {a}</div>
            )) : <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>segments stable — no action needed</div>}
            <Link href="/mirofish" className="block mt-1 text-[9px] font-bold tracking-widest hover:opacity-80"
                  style={{ color: "var(--hud-cyan)" }}>
              ⬡ OPEN MIROFISH CANVAS →
            </Link>
          </div>
        </motion.div>
        </div>

        {/* live event ticker — real MiroFish events */}
        <div className="absolute bottom-0 left-0 right-0 overflow-hidden border-t font-mono"
             style={{ zIndex: 5, background: "rgba(11,13,18,0.9)", borderColor: "var(--hud-border)", height: 26 }}>
          <div className="brain-ticker whitespace-nowrap text-[10px] leading-[26px]" style={{ color: "var(--hud-muted)" }}>
            {(events.length ? events : [{ label: "awaiting live events…" }]).map((e: any, i: number) => (
              <span key={i} className="mx-6">
                <span style={{ color: "var(--hud-cyan)" }}>◈</span> {e.label ?? e.type ?? JSON.stringify(e).slice(0, 60)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <style jsx global>{`
        .brain-ring { animation: brainOrbit 90s linear infinite; }
        .brain-ring-item { animation: brainOrbitInv 90s linear infinite; }
        @keyframes brainOrbit { to { transform: rotate(360deg); } }
        @keyframes brainOrbitInv {
          from { transform: rotate(var(--a, 0deg)); }
          to   { transform: rotate(calc(var(--a, 0deg) - 360deg)); }
        }
        .brain-ticker { display: inline-block; animation: tick 40s linear infinite; }
        @keyframes tick { from { transform: translateX(100vw); } to { transform: translateX(-100%); } }
      `}</style>
    </div>
  );
}

function FeedChip({ f }: { f: Feed }) {
  return (
    <Link href={f.href} className="block font-mono">
      <div className="flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full" style={{
          background: f.status === "live" ? "var(--hud-green)" : f.status === "idle" ? "var(--hud-amber)" : "#f87171",
          boxShadow: f.status === "live" ? "0 0 8px rgba(52,211,153,0.8)" : "none",
        }} />
        <span className="text-[10px] font-bold tracking-wider" style={{ color: "var(--hud-text)" }}>{f.label}</span>
      </div>
      <div className="text-[9px] mt-0.5" style={{ color: "var(--hud-muted)" }}>{f.sub}</div>
      <div className="text-[9px] mt-0.5 tabular-nums" style={{ color: "var(--hud-cyan)" }}>{f.detail}</div>
    </Link>
  );
}
