"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import TopNav from "@/components/TopNav";

/**
 * THE WORKFORCE — live orchestration graph. KRONOS sits at the core; every other
 * agent is a node wired to it, glowing when it's working. Click a node to see
 * exactly what that agent is doing right now (its live log line).
 */

const STATUS: Record<string, string> = {
  working: "#34d399", idle: "#fbbf24", standby: "#64748b", down: "#f87171",
};

function useClock() {
  const [t, setT] = useState("");
  useEffect(() => {
    const tick = () => setT(new Date().toLocaleTimeString("en-US", { hour12: false }));
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, []);
  return t;
}

export default function WorkforcePage() {
  const [data, setData] = useState<any>(null);
  const [sel, setSel] = useState<string>("kronos");
  const [showCouncil, setShowCouncil] = useState(false);
  const clock = useClock();

  useEffect(() => {
    const load = () => fetch("/api/workforce").then((r) => r.json()).then(setData).catch(() => {});
    load(); const t = setInterval(load, 15_000); return () => clearInterval(t);
  }, []);

  const agents: any[] = data?.agents ?? [];
  const kronos = agents.find((a) => a.id === "kronos");
  const others = agents.filter((a) => a.id !== "kronos");
  const selected = agents.find((a) => a.id === sel) ?? kronos;

  // circle layout around the core
  const W = 1000, H = 640, cx = W / 2, cy = H / 2, rx = 380, ry = 250;
  const nodes = useMemo(() => others.map((a, i) => {
    const ang = (i / others.length) * Math.PI * 2 - Math.PI / 2;
    return { ...a, x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) };
  }), [others]);

  const working = agents.filter((a) => a.status === "working").length;

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-6xl mx-auto p-4 font-mono">
        {/* HUD bar */}
        <div className="flex items-center justify-between flex-wrap gap-3 mb-2 px-2">
          <div className="text-[11px] tracking-widest" style={{ color: "var(--hud-cyan)" }}>
            ◉ LIVE ORCHESTRATION · KRONOS CORE
          </div>
          <div className="flex items-center gap-6 tabular-nums text-right">
            <div><div className="text-sm font-bold" style={{ color: "var(--hud-text)" }}>{clock}</div>
                 <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>LOCAL TIME</div></div>
            <div><div className="text-sm font-bold" style={{ color: "var(--hud-green)" }}>{working}/{agents.length}</div>
                 <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>AGENTS ACTIVE</div></div>
            <div><div className="text-sm font-bold" style={{ color: "var(--hud-cyan)" }}>72</div>
                 <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>MICRO-AGENTS</div></div>
          </div>
        </div>

        {/* the graph */}
        <div className="hud-panel hud-panel-static p-0 overflow-hidden" style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
            <defs>
              <radialGradient id="core" cx="50%" cy="50%">
                <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#6d28d9" stopOpacity="0.15" />
              </radialGradient>
              <style>{`
                @keyframes flow { to { stroke-dashoffset: -24; } }
                @keyframes pulse { 0%,100% { opacity:.5 } 50% { opacity:1 } }
                .link { stroke-dasharray: 3 9; animation: flow 1.2s linear infinite; }
                .pulse { animation: pulse 2.4s ease-in-out infinite; }
              `}</style>
            </defs>

            {/* links core → nodes */}
            {nodes.map((n) => {
              const mx = (cx + n.x) / 2, my = (cy + n.y) / 2 - 40;
              const on = n.status === "working";
              return (
                <path key={"l" + n.id} d={`M ${cx} ${cy} Q ${mx} ${my} ${n.x} ${n.y}`}
                      fill="none" stroke={on ? "rgba(52,211,153,0.55)" : "rgba(100,116,139,0.3)"}
                      strokeWidth={on ? 1.4 : 0.8} className={on ? "link" : ""} />
              );
            })}

            {/* core */}
            <circle cx={cx} cy={cy} r={70} fill="url(#core)" className="pulse" />
            <circle cx={cx} cy={cy} r={34} fill="#1a1030" stroke="#a78bfa" strokeWidth={2}
                    style={{ cursor: "pointer" }} onClick={() => setSel("kronos")} />
            <text x={cx} y={cy - 2} textAnchor="middle" fontSize={20} fontWeight="bold" fill="#c4b5fd">K</text>
            <text x={cx} y={cy + 52} textAnchor="middle" fontSize={13} fontWeight="bold" fill="#e5e7eb">KRONOS</text>
            <text x={cx} y={cy + 68} textAnchor="middle" fontSize={9} fill="#8b93a7">Core Orchestrator</text>

            {/* agent nodes */}
            {nodes.map((n) => {
              const c = STATUS[n.status] ?? STATUS.standby;
              const active = n.id === sel;
              return (
                <g key={n.id} style={{ cursor: "pointer" }} onClick={() => { setSel(n.id); if (n.id === "miro") setShowCouncil(true); }}>
                  <circle cx={n.x} cy={n.y} r={active ? 22 : 17} fill="#0e1420" stroke={c}
                          strokeWidth={active ? 2.5 : 1.6}
                          style={{ filter: n.status === "working" ? `drop-shadow(0 0 6px ${c})` : "none" }} />
                  <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={12} fontWeight="bold" fill={c}>
                    {n.name[0]}
                  </text>
                  <text x={n.x} y={n.y + 34} textAnchor="middle" fontSize={11} fontWeight="bold" fill="#e5e7eb">{n.name}</text>
                  <text x={n.x} y={n.y + 47} textAnchor="middle" fontSize={8} fill="#8b93a7">
                    {n.title.length > 22 ? n.title.slice(0, 20) + "…" : n.title}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* selected agent detail */}
        {selected && (
          <div className="hud-panel hud-panel-static p-4 mt-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{selected.emoji}</span>
                <div>
                  <div className="text-sm font-bold" style={{ color: "var(--hud-text)" }}>{selected.name}</div>
                  <div className="text-[10px]" style={{ color: "var(--hud-cyan)" }}>{selected.title}</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full" style={{
                  background: STATUS[selected.status], boxShadow: selected.status === "working" ? `0 0 6px ${STATUS[selected.status]}` : "none" }} />
                <span className="text-[9px] tracking-widest" style={{ color: STATUS[selected.status] }}>{selected.status.toUpperCase()}</span>
              </div>
            </div>
            <div className="text-[9px] mt-3 tracking-widest" style={{ color: "var(--hud-muted)" }}>NOW</div>
            <div className="text-[12px] leading-snug" style={{ color: "var(--hud-text)" }}>{selected.now_task}</div>
            <div className="text-[10px] mt-2 pt-2 border-t leading-snug" style={{ borderColor: "rgba(35,40,56,0.6)", color: "var(--hud-muted)" }}>
              {selected.does}
            </div>
            {selected.id === "miro" && (
              <button onClick={() => setShowCouncil((v) => !v)}
                      className="text-[10px] mt-3 py-1 px-3 rounded border hover:opacity-80"
                      style={{ borderColor: "var(--hud-border)", color: "var(--hud-cyan)" }}>
                {showCouncil ? "▲ hide" : "▼ view"} the 72 council members
              </button>
            )}
          </div>
        )}

        {/* Miro council roster */}
        {showCouncil && (() => {
          const council: any[] = agents.find((a) => a.id === "miro")?.council ?? [];
          return (
            <div className="hud-panel hud-panel-static p-4 mt-3">
              <div className="text-[10px] tracking-widest mb-3" style={{ color: "var(--hud-cyan)" }}>
                🐟 MIRO’S COUNCIL — 72 NAMED MICRO-AGENTS (24 roles × steady/balanced/bold)
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-1">
                {council.map((c) => (
                  <div key={c.name} className="flex items-baseline gap-2 text-[10px] py-0.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full" style={{
                      background: c.temper === "bold" ? "#f472b6" : c.temper === "steady" ? "#60a5fa" : "#34d399" }} />
                    <span className="font-bold" style={{ color: "var(--hud-text)" }}>{c.name}</span>
                    <span style={{ color: "var(--hud-muted)" }}>{c.role}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
}
