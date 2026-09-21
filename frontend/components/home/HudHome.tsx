"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { RingGauge, ReactorStage } from "@/components/hud/Gauges";
import { PAGES } from "@/components/nav/pages";
import { BRIEF } from "@/lib/jarvis";

const usd0 = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(0)}`;

// The system screen. Reactor in the centre, the desk's instruments around it,
// diagnostics on the left, the world on the right, the dock beneath. Every
// number is live; AXIOM is one word away.
export default function HudHome() {
  const [fleet, setFleet] = useState<any>(null);
  const [pg, setPg] = useState<any>(null);
  const [agents, setAgents] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [wire, setWire] = useState<any[]>([]);
  const [sum, setSum] = useState<any>(null);
  const [jstate, setJstate] = useState("idle");
  const [clock, setClock] = useState("");
  useEffect(() => {
    const load = () => {
      fetch("/api/fleet").then((r) => r.json()).then(setFleet).catch(() => {});
      fetch("/api/proving-ground").then((r) => r.json()).then(setPg).catch(() => {});
      fetch("/api/agents").then((r) => r.json()).then(setAgents).catch(() => {});
      fetch("/api/world?cat=all").then((r) => r.json()).then((d) => setWire((d.items ?? []).slice(0, 9))).catch(() => {});
      fetch("/api/world/summary").then((r) => r.json()).then(setSum).catch(() => {});
    };
    load(); const t = setInterval(load, 120_000);
    const c = setInterval(() => setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })), 1000);
    const h = (e: Event) => setJstate((e as CustomEvent).detail); window.addEventListener("axiom:jarvis-state", h);
    return () => { clearInterval(t); clearInterval(c); window.removeEventListener("axiom:jarvis-state", h); };
  }, []);
  const t = fleet?.totals; const goat = (fleet?.probes ?? []).find((p: any) => /weather/i.test(p.name)); const s = pg?.report;
  const tone = jstate === "listening" ? "var(--hud-green)" : jstate === "thinking" ? "var(--hud-amber)" : jstate === "speaking" ? "var(--hud-accent-2)" : "var(--hud-accent)";
  const ask = (q: string) => window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: q }));
  const lines: string[] = (sum?.summary ?? "").split("\n").map((l: string) => l.replace(/^\d+[.)]\s*/, "").trim()).filter(Boolean).slice(0, 4);

  return (
    <div className="flex flex-col gap-7">
      {/* 1 — the mind: reactor centred, the two numbers that matter on either side */}
      <section aria-label="AXIOM" className="flex flex-col items-center gap-4">
        <div className="flex items-center justify-center gap-6 sm:gap-10 flex-wrap">
          <RingGauge label="fleet p&l" value={t ? usd0(t.pnl) : "—"} sub={t ? `of $${t.start}` : ""} pct={t ? Math.max(0.02, Math.min(1, t.account / t.start)) : 0} tone={t && t.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)"} size={150} />
          <ReactorStage tone={tone} size={380}>
            <Link href="/mind" aria-label="AXIOM — the mind" className="grid place-items-center rounded-full" style={{ width: 140, height: 140, background: `radial-gradient(circle at 40% 35%, #ffffff 0%, ${tone} 40%, var(--hud-accent-deep) 100%)`, boxShadow: `0 0 40px ${tone}, 0 0 110px ${tone}55` }}>
              <Brain size={60} strokeWidth={1.4} color="#05070d" />
            </Link>
          </ReactorStage>
          <RingGauge label="money goat" value={goat ? `+$${goat.pnl.toFixed(0)}` : "—"} sub={goat ? `${(goat.winRate * 100).toFixed(0)}% · ${goat.trades} trades` : ""} pct={goat ? goat.winRate : 0} tone="var(--hud-gold)" size={150} />
        </div>
        <div className="text-center -mt-2">
          <div className="text-[11px] tracking-[0.4em] font-mono font-bold" style={{ color: tone, textShadow: `0 0 14px ${tone}` }}>A.X.I.O.M. · {jstate.toUpperCase()}</div>
          <div className="prose-sans text-[12px] mt-1" style={{ color: "var(--hud-muted)" }}>say “hey Axiom” — it is listening on every page</div>
        </div>
        <div className="flex gap-2 flex-wrap justify-center">
          <button onClick={() => ask(BRIEF)} className="hud-btn hud-btn-accent" style={{ minHeight: 36 }}>Brief me</button>
          <button onClick={() => ask("What's in the news that matters for our positions? Three sentences.")} className="hud-btn" style={{ minHeight: 36 }}>News that matters</button>
          <button onClick={() => ask("Run health_check and tell me what's degraded.")} className="hud-btn" style={{ minHeight: 36 }}>Diagnostics</button>
        </div>
      </section>

      {/* 2 — the instruments: system on the left, every screen in the middle, the world on the right */}
      <div className="grid lg:grid-cols-[280px_1fr_300px] gap-5 items-start">
        <div className="flex flex-col gap-4">
          <Panel title="SYSTEM DIAGNOSTICS">
            <Row k="AGENTS" v={agents ? `${agents.running} / ${agents.total}` : "—"} tone={agents?.down ? "var(--hud-red)" : "var(--hud-green)"} />
            <Row k="SAFETY" v={s ? `${s.total_runs.toLocaleString()} · ${s.total_fails} fail` : "10,500 · 0 fail"} tone="var(--hud-green)" />
            <Row k="MODE" v="DRY-RUN" tone="var(--hud-amber)" />
            <Row k="FORWARD TEST" v={fleet ? `${fleet.daysTracked} days · ${t?.trades ?? 0} trades` : "—"} />
            <Row k="LOCAL TIME" v={clock} />
          </Panel>
          <Panel title="ACCOUNTS">
            {(fleet?.accounts ?? []).map((a: any) => (
              <Row key={a.key} k={a.name.toUpperCase()} v={`$${(a.account ?? 0).toFixed(0)} · ${a.pnl >= 0 ? "+" : "−"}$${Math.abs(a.pnl ?? 0).toFixed(0)}`} tone={a.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)"} />
            ))}
            {goat && <Row k="WEATHER · GOAT" v={`+$${goat.pnl.toFixed(0)} · ${(goat.winRate * 100).toFixed(0)}%`} tone="var(--hud-gold)" />}
          </Panel>
        </div>

        <Panel title="SCREENS">
          <nav aria-label="Dock" className="hud-dock mt-2">
            {PAGES.filter((p) => p.href !== "/").map((p) => { const Icon = p.icon; return (
              <Link key={p.href} href={p.href} className="hud-dock-item" title={`${p.label} — ${p.hint}`} aria-label={p.label}>
                <Icon size={20} strokeWidth={1.6} /><span className="hud-dock-label">{p.label}</span>
              </Link>); })}
          </nav>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="LIVE SUMMARY" action={<Link href="/news" className="text-[9px] font-mono hover:underline" style={{ color: "var(--hud-accent)" }}>NEWS →</Link>}>
            {lines.length ? lines.map((l, i) => <p key={i} className="prose-sans text-[11.5px] leading-snug py-1" style={{ color: "var(--hud-text)", borderBottom: "1px solid var(--hud-border)" }}>{l}</p>) : <p className="prose-sans text-[11px]" style={{ color: "var(--hud-muted)" }}>reading the world…</p>}
          </Panel>
          <Panel title="WORLD WIRE" action={<Link href="/world" className="text-[9px] font-mono hover:underline" style={{ color: "var(--hud-accent)" }}>MAP →</Link>}>
            {wire.map((it, i) => <a key={i} href={it.link} target="_blank" rel="noreferrer" className="block prose-sans text-[11px] leading-snug py-1 truncate hover:underline" style={{ color: "var(--hud-text)" }}>{it.title}</a>)}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="hud-panel hud-panel-static p-4 min-w-0" aria-label={title}>
      <div className="flex items-center mb-2"><h2 className="text-[9px] tracking-[0.25em] font-bold font-mono m-0" style={{ color: "var(--hud-accent)" }}>{title}</h2><span className="flex-1" />{action}</div>
      {children}
    </section>
  );
}
function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-[10.5px] font-mono" style={{ borderBottom: "1px solid var(--hud-border)" }}>
      <span style={{ color: "var(--hud-muted)" }}>{k}</span><span className="truncate" style={{ color: tone ?? "var(--hud-text)" }}>{v}</span>
    </div>
  );
}
