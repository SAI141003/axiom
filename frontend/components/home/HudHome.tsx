"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import BrainCore from "@/components/BrainCore";
import BrainNote from "./BrainNote";
import { RingGauge, ReactorStage } from "@/components/hud/Gauges";
import AiHealth from "@/components/hud/AiHealth";
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
  // The brain's motes come from what it has concluded, not from fills: the
  // home page is not the trade tape.
  const [motes, setMotes] = useState<any[]>([]);
  useEffect(() => {
    let live = true;
    const pull = () => fetch("/api/journal", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!live) return;
      setMotes((j?.lessons ?? []).slice(0, 14).map((l: any) => ({
        label: String(l.note ?? "").slice(0, 46),
        kind: l.kind === "EDGE" ? "win" : l.kind === "LEAK" ? "loss" : "opinion",
        mag: l.stable ? 1 : 0.6,
      })));
    }).catch(() => {});
    pull();
    const t = setInterval(pull, 120_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const [clock, setClock] = useState("");
  useEffect(() => {
    const load = () => {
      fetch("/api/fleet").then((r) => r.json()).then(setFleet).catch(() => {});
      fetch("/api/proving-ground").then((r) => r.json()).then(setPg).catch(() => {});
      fetch("/api/agents").then((r) => r.json()).then(setAgents).catch(() => {});
      fetch("/api/world?cat=all").then((r) => r.json()).then((d) => setWire(Array.from(new Map((d.items ?? []).map((it: any) => [it.title, it])).values()).slice(0, 16))).catch(() => {});
      fetch("/api/world/summary").then((r) => r.json()).then(setSum).catch(() => {});
    };
    load(); const t = setInterval(load, 120_000);
    const c = setInterval(() => setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })), 1000);
    const h = (e: Event) => setJstate((e as CustomEvent).detail); window.addEventListener("axiom:jarvis-state", h);
    return () => { clearInterval(t); clearInterval(c); window.removeEventListener("axiom:jarvis-state", h); };
  }, []);
  const t = fleet?.totals; const weatherBot = (fleet?.probes ?? []).find((p: any) => p.name === "weather (late-day)"); const s = pg?.report;
  const tone = jstate === "listening" ? "var(--hud-green)" : jstate === "thinking" ? "var(--hud-amber)" : jstate === "speaking" ? "var(--hud-accent-2)" : "var(--hud-accent)";
  const ask = (q: string) => window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: q }));
  const lines: string[] = (sum?.summary ?? "").split("\n").map((l: string) => l.replace(/^\d+[.)]\s*/, "").trim()).filter(Boolean).slice(0, 4);

  return (
    <div className="hud-screen-grid">
      {/* left: the system */}
      <div className="flex flex-col gap-3 min-h-0 order-2 lg:order-1">
        <Panel title="SYSTEM">
          <Row k="STATUS" v="ONLINE · PAPER · DRY-RUN" tone="var(--hud-green)" />
          <Row k="AGENTS" v={agents ? `${agents.running} / ${agents.total}` : "—"} tone={agents?.down ? "var(--hud-red)" : "var(--hud-green)"} />
          <Row k="SAFETY" v={s ? `${s.total_runs.toLocaleString()} · ${s.total_fails} fail` : "10,500 · 0 fail"} tone="var(--hud-green)" />
          <Row k="FORWARD TEST" v={fleet ? `${fleet.daysTracked} d · ${t?.trades ?? 0} trades` : "—"} />
          <Row k="LOCAL TIME" v={clock} />
        </Panel>
        <Panel title="ACCOUNTS">
          {(fleet?.accounts ?? []).map((a: any) => (
            <Row key={a.key} k={a.name.toUpperCase()} v={`$${(a.account ?? 0).toFixed(0)} · ${a.pnl >= 0 ? "+" : "−"}$${Math.abs(a.pnl ?? 0).toFixed(0)}`} tone={a.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)"} />
          ))}
          {weatherBot && <Row k="WEATHER BOT" v={`${usd0(weatherBot.pnl)} · ${(weatherBot.winRate * 100).toFixed(0)}%`} tone="var(--hud-gold)" />}
        </Panel>
        <div className="min-h-0 flex-1 overflow-hidden"><AiHealth compact /></div>
      </div>

      {/* centre: the mind and every screen */}
      <div className="flex flex-col items-center justify-center gap-4 min-h-0 order-1 lg:order-2">
        <div className="flex items-center justify-center gap-6 xl:gap-10 w-full">
          <RingGauge label="fleet p&l" value={t ? usd0(t.pnl) : "—"} sub={t ? `of $${t.start}` : ""} pct={t ? Math.max(0.02, Math.min(1, t.account / t.start)) : 0} tone={t && t.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)"} size={136} />
          <ReactorStage tone={tone} size={340}>
            <Link href="/mind" aria-label="AXIOM — the mind" className="grid place-items-center">
              <BrainCore size={248} activity={jstate === "idle" ? 0.4 : 0.85} motes={motes} fps={jstate === "idle" ? 10 : 20} />
            </Link>
          </ReactorStage>
          <RingGauge label="weather bot" value={weatherBot ? usd0(weatherBot.pnl) : "—"} sub={weatherBot ? `${(weatherBot.winRate * 100).toFixed(0)}% · ${weatherBot.trades} trades` : ""} pct={weatherBot ? weatherBot.winRate : 0} tone="var(--hud-gold)" size={136} />
        </div>
        <div className="text-center -mt-1">
          <div className="text-[11px] tracking-[0.4em] font-mono font-bold" style={{ color: tone, textShadow: `0 0 14px ${tone}` }}>A.X.I.O.M. · {jstate.toUpperCase()}</div>
          <div className="prose-sans text-[11.5px] mt-0.5" style={{ color: "var(--hud-muted)" }}>say “hey Axiom” — or just “hey buddy”; it is listening on every page</div>
          <div className="mt-1.5"><BrainNote /></div>
        </div>
        <div className="flex gap-2 flex-wrap justify-center">
          <button onClick={() => ask(BRIEF)} className="hud-btn hud-btn-accent" style={{ minHeight: 32 }}>Brief me</button>
          <button onClick={() => ask("What's in the news that matters for our positions? Three sentences.")} className="hud-btn" style={{ minHeight: 32 }}>News that matters</button>
          <button onClick={() => ask("Run health_check and tell me what's degraded.")} className="hud-btn" style={{ minHeight: 32 }}>Diagnostics</button>
        </div>
        <nav aria-label="Dock" className="hud-dock hud-dock-tight">
          {PAGES.filter((p) => p.href !== "/").map((p) => { const Icon = p.icon; return (
            <Link key={p.href} href={p.href} prefetch={false} className="hud-dock-item" title={`${p.label} — ${p.hint}`} aria-label={p.label}>
              <Icon size={18} strokeWidth={1.6} /><span className="hud-dock-label">{p.label}</span>
            </Link>); })}
        </nav>
      </div>

      {/* right: the world */}
      <div className="flex flex-col gap-3 min-h-0 order-3">
        <Panel title="LIVE SUMMARY" action={<Link href="/news" className="text-[9px] font-mono hover:underline" style={{ color: "var(--hud-accent)" }}>NEWS →</Link>}>
          {lines.length ? lines.slice(0, 3).map((l, i) => <p key={i} className="prose-sans text-[11px] leading-snug py-1 hud-clamp3" style={{ color: "var(--hud-text)", borderBottom: "1px solid var(--hud-border)" }}>{l}</p>) : <p className="prose-sans text-[11px]" style={{ color: "var(--hud-muted)" }}>reading the world…</p>}
        </Panel>
        <Panel title="WORLD WIRE" action={<Link href="/world" className="text-[9px] font-mono hover:underline" style={{ color: "var(--hud-accent)" }}>MAP →</Link>} grow>
          {wire.map((it, i) => <a key={i} href={it.link} target="_blank" rel="noreferrer" className="block prose-sans text-[11px] leading-snug py-[3px] truncate hover:underline" style={{ color: "var(--hud-text)" }}>{it.title}</a>)}
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, action, children, grow }: { title: string; action?: React.ReactNode; children: React.ReactNode; grow?: boolean }) {
  return (
    <section className={`hud-panel hud-panel-static p-3 min-w-0 overflow-hidden ${grow ? "flex-1 min-h-0" : ""}`} aria-label={title}>
      <div className="flex items-center mb-1.5"><h2 className="text-[9px] tracking-[0.25em] font-bold font-mono m-0" style={{ color: "var(--hud-accent)" }}>{title}</h2><span className="flex-1" />{action}</div>
      {children}
    </section>
  );
}
function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-3 py-[3px] text-[10.5px] font-mono" style={{ borderBottom: "1px solid var(--hud-border)" }}>
      <span style={{ color: "var(--hud-muted)" }}>{k}</span><span className="truncate" style={{ color: tone ?? "var(--hud-text)" }}>{v}</span>
    </div>
  );
}
