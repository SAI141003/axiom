"use client";

/**
 * MiroFish — Agent Brain as a living dot-net.
 *
 * Canvas particle network (60fps):
 *   - agent + strategy dots hold their positions but drift gently (sine noise)
 *   - trade/suggestion dots SPAWN with a glow burst when they arrive,
 *     float near their strategy, and fade out as newer events replace them
 *   - proximity lines connect nearby dots (classic particle-net), synapse
 *     lines tie the rings to the core
 *   - every resolved trade pops a rising "+$x.xx" / "-$x.xx" under its dot
 * Every dot is REAL: Redis heartbeats, daemon process checks, dry-run logs,
 * live NegRisk lines from the bot log. Nothing simulated.
 */

import { useEffect, useRef, useState } from "react";
import { useToggle } from "@/lib/toggles";

interface Agent { id: string; label: string; group: string; alive: boolean; ageS: number | null }
interface BrainEvent {
  id: string; kind: string; strategy: string; label: string;
  side?: string; pnl?: number | null; ts: number;
}

const COLOR: Record<string, string> = {
  data: "#5fb8c9", signal: "#7c9aff", execution: "#3ecf8e",
  risk: "#f47174", strategy: "#e2b158", core: "#e8ecf4",
  win: "#3ecf8e", loss: "#f47174", suggest: "#e2b158",
};
const GROUP_LABEL: Record<string, string> = {
  data: "DATA", signal: "SIGNAL / AI", execution: "EXECUTION",
  risk: "RISK", strategy: "STRATEGIES", win: "WIN", loss: "LOSS", suggest: "SUGGESTION",
};

interface Dot {
  id: string; kind: "core" | "agent" | "strategy" | "event";
  ax: number; ay: number;          // anchor
  x: number; y: number;            // rendered (anchor + drift)
  r: number; color: string; label: string; sub?: string;
  alive: boolean; born: number;    // ms — drives spawn burst
  phase: number; drift: number;    // motion personality
  strategy?: string;
}
interface Popup { x: number; y: number; text: string; color: string; born: number }

export default function MiroFishDashboard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<Map<string, Dot>>(new Map());
  const popupsRef = useRef<Popup[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [feed, setFeed] = useState<BrainEvent[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const seenRef = useRef<Set<string>>(new Set());
  const autoRefresh = useToggle("mirofish.autoRefresh");

  // ── data → dots ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const layout = (agentsIn: Agent[], events: BrainEvent[]) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const W = cv.clientWidth, H = cv.clientHeight;
      const CX = W / 2, CY = H / 2;
      const dots = dotsRef.current;
      const now = performance.now();

      const upsert = (d: Omit<Dot, "x" | "y" | "phase" | "drift" | "born"> & Partial<Dot>) => {
        const prev = dots.get(d.id);
        dots.set(d.id, {
          phase: prev?.phase ?? Math.random() * Math.PI * 2,
          drift: prev?.drift ?? 4 + Math.random() * 5,
          born: prev?.born ?? now,
          x: prev?.x ?? d.ax, y: prev?.y ?? d.ay,
          ...d,
        } as Dot);
      };

      upsert({ id: "core", kind: "core", ax: CX, ay: CY, r: 22,
               color: COLOR.core, label: "CORE", alive: true });

      const workers = agentsIn.filter((a) => a.group !== "strategy");
      workers.forEach((a, i) => {
        const ang = (i / Math.max(1, workers.length)) * Math.PI * 2 - Math.PI / 2;
        upsert({ id: `a-${a.id}`, kind: "agent",
                 ax: CX + Math.cos(ang) * Math.min(130, W * 0.17),
                 ay: CY + Math.sin(ang) * Math.min(110, H * 0.2),
                 r: 9, color: COLOR[a.group] ?? COLOR.signal,
                 label: a.label, sub: a.alive ? `${a.ageS ?? 0}s` : "down", alive: a.alive });
      });

      const strats = agentsIn.filter((a) => a.group === "strategy");
      if (!strats.find((s) => s.id === "negrisk"))
        strats.push({ id: "negrisk", label: "negrisk arb", group: "strategy",
                      alive: workers.some((w) => w.alive), ageS: null });
      const stratPos: Record<string, { x: number; y: number }> = {};
      strats.forEach((a, i) => {
        const ang = (i / strats.length) * Math.PI * 2 - Math.PI / 2 + Math.PI / strats.length;
        const x = CX + Math.cos(ang) * Math.min(250, W * 0.34);
        const y = CY + Math.sin(ang) * Math.min(200, H * 0.36);
        stratPos[a.id] = { x, y };
        upsert({ id: `s-${a.id}`, kind: "strategy", ax: x, ay: y, r: 12,
                 color: COLOR.strategy, label: a.label, alive: a.alive });
      });

      // events — newest ~7 per strategy stay; new ids spawn + popup
      const byStrat: Record<string, BrainEvent[]> = {};
      for (const e of events) (byStrat[e.strategy] ??= []).push(e);
      const keep = new Set<string>(["core", ...workers.map((a) => `a-${a.id}`),
                                    ...strats.map((s) => `s-${s.id}`)]);
      for (const [sid, evs] of Object.entries(byStrat)) {
        const anchor = stratPos[sid];
        if (!anchor) continue;
        evs.slice(-7).forEach((e, i, arr) => {
          const id = `e-${e.id}`;
          keep.add(id);
          const baseAng = Math.atan2(anchor.y - CY, anchor.x - CX);
          const ang = baseAng - Math.PI * 0.7 + (i / Math.max(3, arr.length)) * Math.PI * 1.4;
          const color = e.pnl != null ? (e.pnl >= 0 ? COLOR.win : COLOR.loss) : COLOR.suggest;
          upsert({ id, kind: "event", strategy: sid,
                   ax: anchor.x + Math.cos(ang) * 58, ay: anchor.y + Math.sin(ang) * 52,
                   r: e.pnl != null ? 5.5 : 4.5, color,
                   label: e.label.slice(0, 14), alive: true });
          if (!seenRef.current.has(id)) {
            seenRef.current.add(id);
            const d = dots.get(id)!;
            d.born = now;                                   // glow burst
            if (e.pnl != null) {
              popupsRef.current.push({
                x: d.ax, y: d.ay,
                text: `${e.pnl >= 0 ? "+" : "−"}$${Math.abs(e.pnl).toFixed(2)}`,
                color, born: now,
              });
            }
          }
        });
      }
      // drop dots no longer reported
      for (const id of Array.from(dots.keys())) if (!keep.has(id)) dots.delete(id);
    };

    const tick = async () => {
      try {
        const res = await fetch("/api/brain");
        if (!res.ok) return;
        const d = await res.json();
        setAgents(d.agents ?? []);
        setFeed((d.events ?? []).slice().reverse().slice(0, 16));
        setStats(d.stats ?? {});
        layout(d.agents ?? [], d.events ?? []);
      } catch {}
    };
    tick();
    const id = setInterval(() => { if (autoRefresh) tick(); }, 5000);
    return () => clearInterval(id);
  }, [autoRefresh]);

  // ── render loop — 60fps canvas ──────────────────────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    let raf = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    let lastFrame = 0;
    const FRAME_MS = 33;   // cap ~30fps + pause when tab hidden — halves CPU/fan
    const draw = (t: number) => {
      if (document.hidden || t - lastFrame < FRAME_MS) { raf = requestAnimationFrame(draw); return; }
      lastFrame = t;
      const W = cv.clientWidth, H = cv.clientHeight;
      ctx.clearRect(0, 0, W, H);
      const dots = Array.from(dotsRef.current.values());
      const core = dotsRef.current.get("core");

      // gentle fixed-place drift
      for (const d of dots) {
        if (d.kind === "core") { d.x = d.ax; d.y = d.ay; continue; }
        d.x = d.ax + Math.sin(t / 1400 + d.phase) * d.drift;
        d.y = d.ay + Math.cos(t / 1700 + d.phase * 1.3) * d.drift * 0.8;
      }

      // proximity net between event dots (+ strategy dots)
      const netDots = dots.filter((d) => d.kind === "event" || d.kind === "strategy");
      ctx.lineWidth = 0.6;
      for (let i = 0; i < netDots.length; i++) {
        for (let j = i + 1; j < netDots.length; j++) {
          const a = netDots[i], b = netDots[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 95) {
            ctx.strokeStyle = a.color;
            ctx.globalAlpha = 0.22 * (1 - dist / 95);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      // synapses to core
      if (core) {
        for (const d of dots) {
          if (d.kind === "agent" || d.kind === "strategy") {
            ctx.strokeStyle = d.color;
            ctx.globalAlpha = d.alive ? 0.16 : 0.05;
            ctx.lineWidth = d.alive ? 1 : 0.5;
            ctx.beginPath(); ctx.moveTo(core.x, core.y); ctx.lineTo(d.x, d.y); ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;

      // dots with glow; spawn burst for ~1.6s after arrival
      for (const d of dots) {
        const age = t - d.born;
        const burst = age < 1600 ? (1 - age / 1600) : 0;
        const pulse = d.alive ? 0.5 + 0.5 * Math.sin(t / 600 + d.phase) : 0;
        ctx.shadowColor = d.color;
        ctx.shadowBlur = 6 + pulse * 6 + burst * 26;
        ctx.globalAlpha = d.alive ? 1 : 0.35;
        ctx.fillStyle = d.kind === "core" || d.kind === "agent" || d.kind === "strategy"
          ? "#12151c" : d.color;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r + burst * 3, 0, Math.PI * 2);
        ctx.fill();
        if (d.kind !== "event") {          // ring stroke for anchors
          ctx.strokeStyle = d.color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.shadowBlur = 0;

        // labels
        ctx.font = "600 9px JetBrains Mono, monospace";
        ctx.textAlign = "center";
        if (d.kind === "agent" || d.kind === "strategy") {
          ctx.fillStyle = d.alive ? d.color : "#8b93a7";
          ctx.fillText(d.label, d.x, d.y - d.r - 6);
          if (d.sub) { ctx.fillStyle = "#8b93a7"; ctx.font = "8px JetBrains Mono, monospace";
                       ctx.fillText(d.sub, d.x, d.y + d.r + 11); }
        } else if (d.kind === "core") {
          ctx.fillStyle = "#e8ecf4"; ctx.fillText("AXIOM", d.x, d.y - 2);
          ctx.fillStyle = "#8b93a7"; ctx.font = "8px JetBrains Mono, monospace";
          ctx.fillText("CORE", d.x, d.y + 9);
        } else if (burst > 0.2) {          // new event: show its name briefly
          ctx.fillStyle = d.color; ctx.globalAlpha = burst;
          ctx.fillText(d.label, d.x, d.y - d.r - 5);
        }
        ctx.globalAlpha = 1;
      }

      // P&L popups — rise and fade under/over the dot
      popupsRef.current = popupsRef.current.filter((p) => t - p.born < 2600);
      for (const p of popupsRef.current) {
        const a = (t - p.born) / 2600;
        ctx.globalAlpha = 1 - a;
        ctx.fillStyle = p.color;
        ctx.font = "bold 12px JetBrains Mono, monospace";
        ctx.textAlign = "center";
        ctx.shadowColor = p.color; ctx.shadowBlur = 10;
        ctx.fillText(p.text, p.x, p.y + 16 - a * 34);
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);

  const aliveCount = agents.filter((a) => a.alive).length;
  const evColor = (e: BrainEvent) =>
    e.pnl != null ? (e.pnl >= 0 ? COLOR.win : COLOR.loss) : COLOR.suggest;

  return (
    <div className="min-h-screen font-mono" style={{ background: "var(--hud-bg)", color: "var(--hud-text)" }}>
      <main className="max-w-6xl mx-auto p-6">
        <div className="flex items-end justify-between flex-wrap gap-2 mb-4">
          <div>
            <h1 className="text-xl font-bold tracking-[0.2em]">MIROFISH · AGENT BRAIN</h1>
            <p className="text-xs mt-1" style={{ color: "var(--hud-muted)" }}>
              {aliveCount}/{agents.length} agents live · trades arrive as glowing dots,
              P&L pops beneath them · nothing simulated
            </p>
          </div>
          <div className="flex gap-4 text-xs tabular-nums">
            <span>trades <b style={{ color: "var(--hud-accent)" }}>{stats.cryptoTrades ?? "—"}</b></span>
            <span>wins <b style={{ color: "var(--hud-green)" }}>{stats.cryptoWins ?? "—"}</b></span>
            <span>P&L <b style={{ color: (stats.cryptoPnl ?? 0) >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
              {stats.cryptoPnl != null ? `$${stats.cryptoPnl}` : "—"}</b></span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_290px] gap-4">
          <div className="hud-panel hud-panel-static overflow-hidden">
            <canvas ref={canvasRef} style={{ width: "100%", height: 560, display: "block" }} />
            <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 pb-3 text-[10px]" style={{ color: "var(--hud-muted)" }}>
              {(["data", "signal", "execution", "risk", "strategy", "win", "loss", "suggest"] as const).map((g) => (
                <span key={g} className="flex items-center gap-1.5">
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: COLOR[g],
                                 boxShadow: `0 0 6px ${COLOR[g]}`, display: "inline-block" }} />
                  {GROUP_LABEL[g]}
                </span>
              ))}
            </div>
          </div>

          <div className="hud-panel hud-panel-static p-4 overflow-hidden">
            <div className="text-[10px] tracking-[0.18em] mb-3" style={{ color: "var(--hud-muted)" }}>
              LIVE ACTIVITY
            </div>
            <div className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 540 }}>
              {feed.length === 0 && <span className="text-xs" style={{ color: "var(--hud-muted)" }}>waiting…</span>}
              {feed.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-[11px]">
                  <span style={{ width: 7, height: 7, borderRadius: 99, background: evColor(e),
                                 boxShadow: `0 0 5px ${evColor(e)}`, flexShrink: 0 }} />
                  <span className="uppercase text-[9px] w-16 flex-shrink-0" style={{ color: "var(--hud-muted)" }}>
                    {e.strategy}
                  </span>
                  <span className="flex-1 truncate">{e.label}</span>
                  {e.pnl != null ? (
                    <span className="tabular-nums font-bold flex-shrink-0"
                          style={{ color: e.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                      {e.pnl >= 0 ? "+" : "−"}${Math.abs(e.pnl).toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-[9px] flex-shrink-0" style={{ color: COLOR.suggest }}>
                      {e.kind === "suggestion" ? "SUGGEST" : "OPEN"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <p className="text-[10px] mt-4 pb-8" style={{ color: "var(--hud-muted)" }}>
          Sources: Redis heartbeats · daemon process checks · dry-run trade logs · live NegRisk scanner.
          Dots drift in place; new arrivals burst and connect to nearby activity.
        </p>
      </main>
    </div>
  );
}
