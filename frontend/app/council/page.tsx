"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

/**
 * THE COUNCIL — pixel-terminal deliberation room, two modes:
 *   ASK     you pose a question → the Oracle forecasts it (base rate + sim +
 *           earnings) AND the named heads debate it → one merged ruling.
 *   REVIEW  end of day, the council convenes over every real loss → root cause,
 *           gap, and a concrete fix per strategy, KRONOS closing the day.
 */

const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
const EXAMPLES = [
  "Will BTC be higher one week from now?",
  "Will NVDA beat earnings?",
  "Will the Fed cut at the next meeting?",
];

export default function CouncilPage() {
  const [tab, setTab] = useState<"ask" | "review" | "tuner">("ask");
  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.3em] text-center glow-cyan"
            style={{ textShadow: "0 0 2px #22d3ee" }}>▚ THE COUNCIL ▞</h1>
        <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
          oracle + named agents · deliberate · vote · one ruling
        </p>

        {/* pixel tab switch */}
        <div className="flex justify-center gap-0 mb-6">
          {(["ask", "review", "tuner"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className="px-5 py-2 text-[11px] tracking-widest font-bold border"
              style={{
                borderColor: tab === t ? "var(--hud-cyan)" : "var(--hud-border)",
                color: tab === t ? "#0a0e17" : "var(--hud-muted)",
                background: tab === t ? "var(--hud-cyan)" : "transparent",
                imageRendering: "pixelated",
              }}>
              {t === "ask" ? "◈ ASK" : t === "review" ? "⬡ END-OF-DAY REVIEW" : "⚙ AUTO-FIX"}
            </button>
          ))}
        </div>

        {tab === "ask" ? <AskMode /> : tab === "review" ? <ReviewMode /> : <TunerMode />}
      </main>
    </div>
  );
}

// ── deliberation brain graph ─────────────────────────────────────────────────
// KRONOS core; 7 named heads inner ring; 24 named micro-agents outer ring.
// Node colour = its vote (green YES / red NO). Animated edges = the agents
// talking to each other + to the core.
function DeliberationGraph({ heads, micro, decision }: { heads: any[]; micro: any[]; decision: string }) {
  const W = 1000, H = 720, cx = W / 2, cy = H / 2;
  const vc = (p: number) => (p >= 0.5 ? "#34d399" : "#f87171");
  const inner = heads.map((h, i) => {
    const a = (i / heads.length) * Math.PI * 2 - Math.PI / 2;
    return { ...h, x: cx + 210 * Math.cos(a), y: cy + 155 * Math.sin(a), a };
  });
  const outer = micro.map((m, i) => {
    const a = (i / Math.max(micro.length, 1)) * Math.PI * 2 - Math.PI / 2;
    return { ...m, x: cx + 450 * Math.cos(a), y: cy + 330 * Math.sin(a) };
  });
  return (
    <div className="p-0 overflow-hidden" style={{ border: "2px solid var(--hud-border)", background: "rgba(10,14,23,0.6)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
        <defs>
          <radialGradient id="cc" cx="50%" cy="50%">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#6d28d9" stopOpacity="0.1" />
          </radialGradient>
          <style>{`
            @keyframes flow { to { stroke-dashoffset: -20; } }
            @keyframes pu { 0%,100%{opacity:.4} 50%{opacity:1} }
            .talk { stroke-dasharray: 2 8; animation: flow 1s linear infinite; }
            .pu { animation: pu 2s ease-in-out infinite; }
          `}</style>
        </defs>

        {/* micro ring → core (faint) */}
        {outer.map((m, i) => (
          <line key={"mo" + i} x1={m.x} y1={m.y} x2={cx} y2={cy}
                stroke={vc(m.p)} strokeOpacity={0.10} strokeWidth={0.6} />
        ))}
        {/* heads talking to each other (cross-talk) */}
        {inner.map((h, i) => {
          const n = inner[(i + 1) % inner.length], n2 = inner[(i + 3) % inner.length];
          return (
            <g key={"t" + i}>
              <path d={`M ${h.x} ${h.y} Q ${cx} ${cy} ${n.x} ${n.y}`} fill="none"
                    stroke="rgba(34,211,238,0.35)" strokeWidth={0.8} className="talk" />
              <path d={`M ${h.x} ${h.y} Q ${cx} ${cy} ${n2.x} ${n2.y}`} fill="none"
                    stroke="rgba(34,211,238,0.2)" strokeWidth={0.6} className="talk" />
            </g>
          );
        })}
        {/* heads → core */}
        {inner.map((h, i) => (
          <line key={"hc" + i} x1={h.x} y1={h.y} x2={cx} y2={cy}
                stroke={vc(h.round2.p)} strokeOpacity={0.5} strokeWidth={1.3} className="talk" />
        ))}

        {/* micro nodes — all 72, coloured by vote (labels in the roster below) */}
        {outer.map((m, i) => (
          <circle key={"m" + i} cx={m.x} cy={m.y} r={4} fill="#0e1420" stroke={vc(m.p)} strokeWidth={1.1} className="pu" />
        ))}

        {/* core */}
        <circle cx={cx} cy={cy} r={60} fill="url(#cc)" className="pu" />
        <circle cx={cx} cy={cy} r={30} fill="#1a1030" stroke="#a78bfa" strokeWidth={2} />
        <text x={cx} y={cy - 1} textAnchor="middle" fontSize={17} fontWeight="bold" fill="#c4b5fd">K</text>
        <text x={cx} y={cy + 46} textAnchor="middle" fontSize={12} fontWeight="bold" fill="#e5e7eb">KRONOS</text>
        <text x={cx} y={cy + 60} textAnchor="middle" fontSize={9} fill={decision === "YES" ? "#34d399" : "#f87171"}>
          rules {decision}
        </text>

        {/* head nodes */}
        {inner.map((h, i) => {
          const c = vc(h.round2.p);
          return (
            <g key={"h" + i}>
              {h.changed && <circle cx={h.x} cy={h.y} r={22} fill="none" stroke="#fbbf24" strokeWidth={1.4} className="pu" />}
              <circle cx={h.x} cy={h.y} r={16} fill="#0e1420" stroke={c} strokeWidth={2}
                      style={{ filter: `drop-shadow(0 0 5px ${c})` }} />
              <text x={h.x} y={h.y + 4} textAnchor="middle" fontSize={11} fontWeight="bold" fill={c}>{h.name[0]}</text>
              <text x={h.x} y={h.y + 32} textAnchor="middle" fontSize={11} fontWeight="bold" fill="#e5e7eb">{h.name}</text>
              <text x={h.x} y={h.y + 44} textAnchor="middle" fontSize={9} fill={c}>
                {h.round2.vote} {pct(h.round2.p)}{h.changed ? " ⟲" : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="text-[9px] px-3 py-1.5 flex gap-4 flex-wrap" style={{ borderTop: "1px solid var(--hud-border)", color: "var(--hud-muted)" }}>
        <span><span style={{ color: "#34d399" }}>●</span> voting YES</span>
        <span><span style={{ color: "#f87171" }}>●</span> voting NO</span>
        <span><span style={{ color: "#fbbf24" }}>◌</span> changed mind ⟲</span>
        <span>inner: 7 heads · outer: {micro.length} named micro-agents · center: KRONOS</span>
      </div>
    </div>
  );
}

// ── pixel card shell ─────────────────────────────────────────────────────────
function Pixel({ children, accent, className = "" }: { children: React.ReactNode; accent?: string; className?: string }) {
  return (
    <div className={`p-4 ${className}`} style={{
      border: `2px solid ${accent ?? "var(--hud-border)"}`,
      boxShadow: `3px 3px 0 0 ${accent ? accent + "40" : "rgba(35,40,56,0.5)"}`,
      background: "rgba(10,14,23,0.6)",
    }}>{children}</div>
  );
}

// ── ASK (Oracle + Council merged) ────────────────────────────────────────────
function AskMode() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [council, setCouncil] = useState<any>(null);
  const [oracle, setOracle] = useState<any>(null);
  const [err, setErr] = useState("");
  const [elapsed, setElapsed] = useState(0);     // live seconds while deliberating
  const [tookMs, setTookMs] = useState<number | null>(null);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true); setErr(""); setCouncil(null); setOracle(null); setTookMs(null);
    const t0 = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
    try {
      const [c, o] = await Promise.all([
        fetch("/api/council", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) }).then((r) => r.json()),
        fetch("/api/oracle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) }).then((r) => r.json()).catch(() => null),
      ]);
      if (c.error) setErr(c.error); else setCouncil(c);
      if (o && !o.error) setOracle(o);
    } catch { setErr("council unreachable"); }
    clearInterval(timer);
    setTookMs(Date.now() - t0);
    setBusy(false);
  };

  const yes = council && council.decision === "YES";
  const color = council ? (yes ? "var(--hud-green)" : "#f87171") : "";
  const e = oracle?.earnings;

  return (
    <>
      <form onSubmit={(ev) => { ev.preventDefault(); ask(q); }} className="flex gap-2 mb-3">
        <input value={q} onChange={(ev) => setQ(ev.target.value)}
          placeholder="Put a question to the council…"
          className="flex-1 px-4 py-3 text-sm bg-transparent" style={{ border: "2px solid var(--hud-border)", color: "var(--hud-text)" }} />
        <button type="submit" disabled={busy} className="px-6 py-3 text-sm font-bold"
          style={{ border: "2px solid var(--hud-accent)", color: busy ? "var(--hud-muted)" : "var(--hud-accent)" }}>
          {busy ? "DEBATING…" : "CONVENE"}
        </button>
      </form>
      <div className="flex gap-2 flex-wrap mb-6">
        {EXAMPLES.map((ex) => (
          <button key={ex} onClick={() => { setQ(ex); ask(ex); }} className="text-[10px] px-2 py-1 hover:opacity-80"
            style={{ border: "1px solid var(--hud-border)", color: "var(--hud-muted)" }}>{ex}</button>
        ))}
      </div>

      {busy && <DebatingAnimation elapsed={elapsed} />}
      {err && <div className="text-center py-8 text-sm" style={{ color: "#f87171" }}>⚠ {err}</div>}

      {council && (
        <div className="flex flex-col gap-4">
          {/* merged ruling */}
          <Pixel accent={color} className="text-center">
            <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>COUNCIL RULING</div>
            <div className="text-5xl font-bold tracking-widest" style={{ color, textShadow: `0 0 6px ${color}` }}>{council.decision}</div>
            <div className="text-2xl font-bold tabular-nums mt-1" style={{ color: "var(--hud-text)" }}>{pct(council.probability)}</div>
            <div className="text-[11px] mt-1" style={{ color: "var(--hud-muted)" }}>
              {council.tally.for} for · {council.tally.against} against{council.tally.dissent?.length ? ` · dissent: ${council.tally.dissent.join(", ")}` : ""}
            </div>
            {tookMs != null && (
              <div className="text-[10px] mt-1 tabular-nums" style={{ color: "var(--hud-cyan)" }}>
                ⏱ deliberated in {(tookMs / 1000).toFixed(1)}s
              </div>
            )}
            {oracle && (
              <div className="text-[10px] mt-2 pt-2 flex justify-center gap-4 flex-wrap" style={{ borderTop: "1px dashed rgba(35,40,56,0.8)", color: "var(--hud-muted)" }}>
                <span>🔮 Oracle: <b style={{ color: "var(--hud-text)" }}>{oracle.verdict} {pct(oracle.probability)}</b></span>
                {oracle.baseRate != null && <span>base rate {pct(oracle.baseRate)}</span>}
                {oracle.simulation && <span>sim {pct(oracle.simulation.pUp)}</span>}
                {council.swarm?.probability != null && <span>crowd {pct(council.swarm.probability)}</span>}
              </div>
            )}
            <div className="text-[12px] mt-3 leading-snug" style={{ color: "var(--hud-text)" }}>
              <span style={{ color: "var(--hud-cyan)" }}>🧠 KRONOS: </span>{council.chair}
            </div>
          </Pixel>

          {/* Bull vs Bear adversarial debate (TradingAgents) */}
          {council.research && (
            <div className="grid sm:grid-cols-2 gap-4">
              <Pixel accent="#34d399">
                <div className="text-[10px] tracking-widest mb-1" style={{ color: "#34d399" }}>🐂 TAURUS · BULL CASE</div>
                <div className="text-[11px] leading-snug" style={{ color: "var(--hud-text)" }}>{council.research.bull}</div>
              </Pixel>
              <Pixel accent="#f87171">
                <div className="text-[10px] tracking-widest mb-1" style={{ color: "#f87171" }}>🐻 URSA · BEAR CASE</div>
                <div className="text-[11px] leading-snug" style={{ color: "var(--hud-text)" }}>{council.research.bear}</div>
              </Pixel>
            </div>
          )}

          {/* Risk panel */}
          {council.risk?.length > 0 && (
            <Pixel>
              <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>RISK PANEL — how to size it</div>
              <div className="grid grid-cols-3 gap-3">
                {council.risk.map((x: any) => {
                  const col = x.stance === "SIZE UP" ? "#34d399" : x.stance?.startsWith("TRIM") ? "#f87171" : "#fbbf24";
                  return (
                    <div key={x.lens} className="text-center">
                      <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>{x.lens.toUpperCase()}</div>
                      <div className="text-[12px] font-bold" style={{ color: col }}>{x.stance}</div>
                      <div className="text-[9px] mt-0.5 leading-tight" style={{ color: "var(--hud-muted)" }}>{x.note}</div>
                    </div>
                  );
                })}
              </div>
            </Pixel>
          )}

          {/* Sentinel — the critic / red-team */}
          {council.critic && (
            <Pixel accent={council.critic.overconfident ? "#fbbf24" : "var(--hud-border)"}>
              <div className="text-[10px] tracking-widest mb-1" style={{ color: council.critic.overconfident ? "#fbbf24" : "var(--hud-muted)" }}>
                🛡️ SENTINEL · CRITIC {council.critic.overconfident ? "· ⚠ FLAGGED OVERCONFIDENT" : "· ✓ no overconfidence flag"}
              </div>
              <div className="text-[11px] leading-snug" style={{ color: "var(--hud-text)" }}>
                <span style={{ color: "var(--hud-muted)" }}>blind spot: </span>{council.critic.blindspot}
              </div>
              {council.calibration?.tempered && (
                <div className="text-[9px] mt-1.5 pt-1.5" style={{ borderTop: "1px dashed rgba(35,40,56,0.6)", color: "var(--hud-muted)" }}>
                  ⚖ calibrated: raw vote {pct(council.calibration.raw)} → {pct(council.calibration.calibrated)} confidence
                  (tempered for head disagreement {council.calibration.disagreement})
                </div>
              )}
            </Pixel>
          )}

          {/* the deliberation, visualized as a living brain */}
          {council.heads && (
            <DeliberationGraph heads={council.heads} micro={council.swarm?.micro ?? []} decision={council.decision} />
          )}

          {/* EVERY decision — all 7 heads + 72 micro-agents */}
          {council.swarm?.micro?.length > 0 && (
            <Pixel>
              <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
                EVERY DECISION · {7 + council.swarm.micro.length} AGENTS
              </div>
              <div className="text-[9px] mb-1 tracking-widest" style={{ color: "var(--hud-cyan)" }}>HEADS</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 mb-3">
                {council.heads.map((h: any) => (
                  <div key={h.id} className="flex items-baseline gap-1 text-[10px]">
                    <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: h.round2.p >= 0.5 ? "#34d399" : "#f87171" }} />
                    <span className="font-bold" style={{ color: "var(--hud-text)" }}>{h.name}</span>
                    <span style={{ color: h.round2.p >= 0.5 ? "#34d399" : "#f87171" }}>{h.round2.vote} {pct(h.round2.p)}</span>
                  </div>
                ))}
              </div>
              <div className="text-[9px] mb-1 tracking-widest" style={{ color: "var(--hud-cyan)" }}>MICRO-AGENTS ({council.swarm.micro.length})</div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-x-2 gap-y-0.5">
                {council.swarm.micro.map((m: any) => (
                  <div key={m.name} className="flex items-baseline gap-1 text-[9px]" title={m.role}>
                    <span className="inline-block w-1 h-1 rounded-full" style={{ background: m.p >= 0.5 ? "#34d399" : "#f87171" }} />
                    <span style={{ color: "var(--hud-text)" }}>{m.name}</span>
                    <span style={{ color: "var(--hud-muted)" }}>{pct(m.p)}</span>
                  </div>
                ))}
              </div>
            </Pixel>
          )}

          {/* earnings twin-gauge when applicable */}
          {e && (
            <div className="grid sm:grid-cols-2 gap-4">
              <Pixel accent="var(--hud-border)">
                <div className="text-[10px] tracking-widest mb-1" style={{ color: "var(--hud-muted)" }}>P(BEAT CONSENSUS)</div>
                <div className="text-3xl font-bold" style={{ color: "var(--hud-green)" }}>{pct(e.pBeat)}</div>
                <div className="text-[9px] mt-1" style={{ color: "var(--hud-muted)" }}>streak {e.beatStreak} · exp surprise {e.expectedSurprise >= 0 ? "+" : ""}{(e.expectedSurprise * 100).toFixed(1)}%</div>
              </Pixel>
              <Pixel accent="var(--hud-border)">
                <div className="text-[10px] tracking-widest mb-1" style={{ color: "var(--hud-muted)" }}>P(UP AFTER)</div>
                <div className="text-3xl font-bold" style={{ color: e.pUpAfter >= 0.5 ? "var(--hud-green)" : "#f87171" }}>{pct(e.pUpAfter)}</div>
                <div className="text-[9px] mt-1" style={{ color: "var(--hud-muted)" }}>capped — reaction is near-efficient · disp {e.dispersion}</div>
              </Pixel>
            </div>
          )}

          {/* the debate */}
          <Pixel>
            <div className="text-[10px] tracking-widest mb-3" style={{ color: "var(--hud-muted)" }}>THE DEBATE — view, then revision after hearing the room</div>
            <div className="flex flex-col gap-2">
              {council.heads.map((h: any) => {
                const fy = h.round2.p >= 0.5;
                return (
                  <div key={h.id} className="pb-2" style={{ borderBottom: "1px dashed rgba(35,40,56,0.6)" }}>
                    <div className="flex items-center justify-between">
                      <div className="text-[12px] font-bold" style={{ color: "var(--hud-text)" }}>
                        {h.name} <span className="font-normal text-[10px]" style={{ color: "var(--hud-cyan)" }}>· {h.role}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] tabular-nums">
                        <span style={{ color: "var(--hud-muted)" }}>{h.round1.vote} {pct(h.round1.p)} →</span>
                        <span className="font-bold" style={{ color: fy ? "var(--hud-green)" : "#f87171" }}>{h.round2.vote} {pct(h.round2.p)}</span>
                        {h.changed && <span className="text-[8px] px-1" style={{ background: "rgba(251,191,36,0.2)", color: "#fbbf24" }}>CHANGED</span>}
                      </div>
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: "var(--hud-text)" }}>{h.round1.argument}</div>
                    {h.round2.reaction && <div className="text-[10px] mt-0.5 italic" style={{ color: "var(--hud-muted)" }}>↳ {h.round2.reaction}</div>}
                  </div>
                );
              })}
            </div>
          </Pixel>

          {council.swarm?.probability != null && (
            <Pixel>
              <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>THE 72-AGENT CROWD (×{council.swarm.weight}) — P(YES) {pct(council.swarm.probability)}</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {council.swarm.voices.map((v: any, i: number) => (
                  <span key={i} className="text-[10px]" style={{ color: v.p > 0.5 ? "var(--hud-green)" : "#f87171" }}>{v.name} {pct(v.p)}</span>
                ))}
              </div>
            </Pixel>
          )}
        </div>
      )}
    </>
  );
}

// ── END-OF-DAY REVIEW (auto-loop) ────────────────────────────────────────────
function ReviewMode() {
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<any>(null);
  const [actions, setActions] = useState<any[]>([]);
  const [lastRun, setLastRun] = useState<any>(null);
  const [err, setErr] = useState("");

  // auto-load the last REAL auto-run on mount (no manual convene needed)
  useEffect(() => {
    fetch("/api/council/review/latest").then((x) => x.json()).then((d) => {
      if (d.hasRun) { setR(d.review); setActions(d.actions ?? []); setLastRun(d.lastRun); }
    }).catch(() => {});
  }, []);

  const run = async () => {
    setBusy(true); setErr("");
    try {
      const d = await fetch("/api/council/review").then((x) => x.json());
      if (d.error) setErr(d.error); else setR(d);
      const l = await fetch("/api/council/review/latest").then((x) => x.json()).catch(() => null);
      if (l) { setActions(l.actions ?? []); setLastRun(l.lastRun); }
    } catch { setErr("review unreachable"); }
    setBusy(false);
  };

  const scored = actions.filter((a) => a.outcome);
  const helped = scored.filter((a) => a.outcome === "helped").length;

  return (
    <>
      <div className="text-center mb-4">
        <div className="text-[11px]" style={{ color: "var(--hud-cyan)" }}>
          ⟳ AUTONOMOUS DAILY LOOP · runs itself at 16:35 · propose → implement → observe → propose new
        </div>
        <div className="text-[10px] mt-1" style={{ color: "var(--hud-muted)" }}>
          {lastRun ? `last auto-run ${lastRun.date} · ${scored.length} past fixes scored (${helped} helped)` : "no auto-run yet — will populate after the next close"}
        </div>
        <button onClick={run} disabled={busy} className="px-5 py-2 text-[11px] font-bold mt-3"
          style={{ border: "2px solid var(--hud-accent)", color: busy ? "var(--hud-muted)" : "var(--hud-accent)" }}>
          {busy ? "AUTOPSY IN PROGRESS…" : "⬡ RE-RUN NOW"}
        </button>
      </div>

      {busy && <div className="text-center py-10 text-sm animate-pulse" style={{ color: "var(--hud-muted)" }}>
        pulling today’s losses · analysts writing post-mortems · KRONOS closing the day…</div>}
      {err && <div className="text-center py-8 text-sm" style={{ color: "#f87171" }}>⚠ {err}</div>}

      {/* the loop's tracked actions: propose → implement → observe */}
      {actions.length > 0 && (
        <Pixel className="mb-4">
          <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
            TRACKED FIXES — the loop scores whether each actually helped
          </div>
          {actions.slice(-8).reverse().map((a, i) => (
            <div key={i} className="flex items-center gap-2 py-1 text-[10px]" style={{ borderBottom: "1px dashed rgba(35,40,56,0.5)" }}>
              <span className="tabular-nums" style={{ color: "var(--hud-muted)" }}>{a.date}</span>
              <span className="font-bold w-20" style={{ color: "var(--hud-text)" }}>{a.strategy}</span>
              <span className="flex-1" style={{ color: "var(--hud-text)" }}>{(a.recommendation ?? "").slice(0, 70)}</span>
              <span className="text-[8px] px-1" style={{
                background: a.status === "auto_apply" ? "rgba(52,211,153,0.15)" : "rgba(148,163,184,0.15)",
                color: a.status === "auto_apply" ? "#34d399" : "var(--hud-muted)" }}>{a.status}</span>
              {a.outcome && <span className="text-[8px] px-1 font-bold" style={{
                color: a.outcome === "helped" ? "#34d399" : a.outcome === "hurt" ? "#f87171" : "var(--hud-muted)" }}>
                {a.outcome.toUpperCase()}</span>}
            </div>
          ))}
        </Pixel>
      )}

      {r && r.verdicts?.length === 0 && (
        <div className="text-center py-8 text-sm" style={{ color: "var(--hud-green)" }}>
          ✓ {r.chair ?? "No losing trades resolved today — clean session."}
        </div>
      )}

      {r && r.verdicts?.length > 0 && (
        <div className="flex flex-col gap-4">
          <Pixel accent={r.totalLoss < 0 ? "#f87171" : "var(--hud-green)"}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] tracking-widest" style={{ color: "var(--hud-muted)" }}>END-OF-DAY · {r.date}</div>
                <div className="text-2xl font-bold tabular-nums" style={{ color: r.totalLoss < 0 ? "#f87171" : "var(--hud-green)" }}>
                  ${r.totalLoss}
                </div>
                <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>total gross loss · {r.strategiesWithLosses ?? 0} strategies</div>
              </div>
            </div>
            <div className="text-[12px] mt-3 leading-snug" style={{ color: "var(--hud-text)" }}>
              <span style={{ color: "var(--hud-cyan)" }}>🧠 KRONOS: </span>{r.chair}
            </div>
          </Pixel>

          {(r.verdicts ?? []).map((v: any) => (
            <Pixel key={v.strategy} accent="var(--hud-border)">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[13px] font-bold tracking-wide" style={{ color: "var(--hud-text)" }}>{v.strategy.toUpperCase()}</div>
                <div className="text-[11px] tabular-nums" style={{ color: "#f87171" }}>
                  ${v.grossLoss} · {v.losses}L/{v.trades}T · {pct(v.winRate)} win
                </div>
              </div>
              <Row label="ROOT CAUSE" color="#f87171" text={v.rootCause} />
              <Row label="THE GAP" color="#fbbf24" text={v.gap} />
              <Row label="FIX" color="var(--hud-green)" text={v.recommendation} />
            </Pixel>
          ))}
        </div>
      )}
    </>
  );
}

function Row({ label, color, text }: { label: string; color: string; text: string }) {
  return (
    <div className="flex gap-2 py-0.5 text-[11px]">
      <span className="w-20 shrink-0 tracking-widest text-[9px] mt-0.5" style={{ color }}>{label}</span>
      <span style={{ color: "var(--hud-text)" }}>{text}</span>
    </div>
  );
}

// ── AUTO-FIX: the council's autonomous self-tuner (no approval needed) ────────
function TunerMode() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/council/tuner").then((r) => r.json()).then(setD).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!d) return <div className="text-center py-10 text-sm" style={{ color: "var(--hud-muted)" }}>loading…</div>;
  const knobs: any[] = d.knobs ?? [];
  const audit: any[] = d.audit ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div className="hud-panel hud-panel-static p-4">
        <div className="text-[10px] tracking-widest mb-1" style={{ color: "var(--hud-cyan)" }}>
          ⚙ AUTONOMOUS SELF-FIX — no approval required
        </div>
        <div className="text-[10px] mb-3" style={{ color: "var(--hud-muted)" }}>
          Each night the council backtests candidate knob values on real trades, keeps only the
          config positive in BOTH halves, and deploys it live. Reverts on regression. Converges when nothing beats current.
        </div>
        <div className="grid gap-2" style={{ gridTemplateColumns: "1fr" }}>
          {knobs.length === 0 && <div className="text-[11px]" style={{ color: "var(--hud-muted)" }}>no knobs tuned yet</div>}
          {knobs.map((k, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-2 rounded border tabular-nums"
                 style={{ borderColor: "var(--hud-border)", background: "rgba(10,14,23,0.5)" }}>
              <span className="text-[12px]" style={{ color: "var(--hud-text)" }}>
                <span style={{ color: "var(--hud-cyan)" }}>{k.strategy}</span>.{k.knob}
              </span>
              <span className="text-lg font-bold" style={{ color: "var(--hud-accent)" }}>{k.value}</span>
              <span className="text-[10px]" style={{ color: (k.h1 > 0 && k.h2 > 0) ? "var(--hud-green)" : "var(--hud-amber)" }}>
                {k.n} trades · ${k.pnl} · H1 ${k.h1} / H2 ${k.h2} {(k.h1 > 0 && k.h2 > 0) ? "✓ stable" : ""}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="hud-panel hud-panel-static p-4">
        <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>DECISION LOG — self-fixes it made</div>
        {audit.length === 0 && <div className="text-[11px]" style={{ color: "var(--hud-muted)" }}>no changes yet — converged or building data</div>}
        {audit.map((a, i) => (
          <div key={i} className="text-[11px] py-1 flex gap-2" style={{ color: "var(--hud-text)" }}>
            <span style={{ color: "var(--hud-cyan)" }}>▸</span>
            <span>
              <b>{a.strategy}.{a.knob}</b>: {a.from ?? "initial"} → <b style={{ color: "var(--hud-accent)" }}>{a.to}</b>
              <span style={{ color: "var(--hud-muted)" }}> — {a.reason}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── live deliberation animation + elapsed timer (shown while the council thinks) ─
function DebatingAnimation({ elapsed }: { elapsed: number }) {
  const N = 24;
  const stage = elapsed < 8 ? "Oracle forecasting" : elapsed < 20 ? "Heads debating (round 1)"
    : elapsed < 40 ? "72-agent crowd voting" : "Deliberating (round 2) & extremizing";
  return (
    <div className="flex flex-col items-center py-12 gap-5">
      <style>{`@keyframes agentpulse{0%,100%{opacity:.2;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}`}</style>
      {/* ring of agent dots lighting up in sequence = the swarm deliberating */}
      <div style={{ position: "relative", width: 160, height: 160 }}>
        {Array.from({ length: N }).map((_, i) => {
          const a = (i / N) * Math.PI * 2 - Math.PI / 2;
          const x = 80 + 70 * Math.cos(a), y = 80 + 70 * Math.sin(a);
          return (
            <span key={i} style={{
              position: "absolute", left: x - 4, top: y - 4, width: 8, height: 8, borderRadius: "50%",
              background: i % 2 ? "var(--hud-green)" : "var(--hud-cyan)",
              animation: `agentpulse 1.4s ease-in-out ${(i / N) * 1.4}s infinite`,
            }} />
          );
        })}
        <div style={{
          position: "absolute", inset: 0, display: "grid", placeItems: "center",
          flexDirection: "column",
        }}>
          <div className="tabular-nums font-bold" style={{ fontSize: 28, color: "var(--hud-accent)" }}>
            {elapsed.toFixed(1)}<span style={{ fontSize: 13 }}>s</span>
          </div>
        </div>
      </div>
      <div className="text-[12px] tracking-wide" style={{ color: "var(--hud-cyan)" }}>{stage}…</div>
      <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>
        72 agents · 2 deliberation rounds · influence-weighted + extremized
      </div>
    </div>
  );
}
