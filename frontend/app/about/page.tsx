"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BookOpen, ExternalLink, Search, Github, FlaskConical, Database, Wrench, ShieldCheck } from "lucide-react";
import TopNav from "@/components/TopNav";
import PageHeader from "@/components/PageHeader";
import { REPOS, PAPERS, DATA, VENUE_RESEARCH, LIBS, type Source, type Status } from "./sources";

const STATUS: Record<Status, { label: string; color: string; note: string }> = {
  shipped:   { label: "shipped",   color: "var(--hud-green)",  note: "in the running system" },
  rejected:  { label: "rejected",  color: "var(--hud-red)",    note: "built, measured, lost out-of-sample" },
  benchmark: { label: "benchmark", color: "var(--hud-amber)",  note: "we measure ourselves against it" },
  research:  { label: "research",  color: "var(--hud-accent)", note: "shaped a decision or a roadmap note" },
  data:      { label: "data",      color: "#22d3ee",           note: "a live feed the desk reads" },
  tooling:   { label: "tooling",   color: "var(--hud-muted)",  note: "how it is built and run" },
};

const SECTIONS = [
  { id: "repos", title: "Repositories", icon: Github, items: REPOS, sub: "studied, vendored for reference, or depended on — each with its licence and what AXIOM took from it" },
  { id: "papers", title: "Research papers & models", icon: FlaskConical, items: PAPERS, sub: "the published work behind each signal, sizing rule and scoring rule — and what our tests said" },
  { id: "data", title: "Data sources & APIs", icon: Database, items: DATA, sub: "every live feed, all free or keyless unless noted" },
  { id: "venues", title: "Venue research", icon: ShieldCheck, items: VENUE_RESEARCH, sub: "the citations behind the venue map's reachability and custody claims" },
  { id: "libs", title: "Libraries & infrastructure", icon: Wrench, items: LIBS, sub: "the numerical, persistence and runtime layer, each with the job it does here" },
];

const RESULTS = [
  { k: "Safety proof", v: "10,500 assertions · 0 failures", sub: "35 fault scenarios × 300 runs, three adapters" },
  { k: "Backtest (BTC/USD 1d)", v: "+44.2% vs +1.2% B&H", sub: "Sharpe 1.04 · max DD 17.3% · as of 2026-08-14" },
  { k: "Weather bot", v: "+$122.97 · 84.4% win", sub: "282 trades · the one proven edge" },
  { k: "Upgrades rejected", v: "4 of 5", sub: "tuning, regime, volume profile, per-symbol routing — all overfit" },
  { k: "Order flow", v: "shipped", sub: "the one upgrade that survived holdout" },
  { k: "Options v1", v: "retired at $0", sub: "score<0.5 legs 16% win; puts 0/28 — v2 gates from 2026-09-20" },
];

export default function AboutPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status | "all">("all");
  const all = useMemo(() => SECTIONS.flatMap((s) => s.items), []);
  const total = all.length;
  const counts = useMemo(() => Object.fromEntries((Object.keys(STATUS) as Status[]).map((k) => [k, all.filter((x) => x.status === k).length])), [all]);
  const match = (x: Source) => (status === "all" || x.status === status) && (!q.trim() || `${x.name} ${x.by ?? ""} ${x.what} ${x.how} ${x.where.join(" ")} ${x.result ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="hud-bg min-h-screen relative">
      <div className="hud-ambient" aria-hidden />
      <TopNav />
      <main className="relative max-w-6xl mx-auto p-6 font-mono">
        <PageHeader icon={BookOpen} title="ABOUT AXIOM">
          Everything this desk is built from — {total} sources across {REPOS.length} repositories, {PAPERS.length} papers and models, {DATA.length} live data feeds, {VENUE_RESEARCH.length} venue citations and {LIBS.length} libraries — with where each one is used in the code and what came of it.
        </PageHeader>

        <section aria-label="Results" className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
          {RESULTS.map((r) => (
            <div key={r.k} className="hud-panel hud-panel-static px-4 py-3 min-w-0">
              <div className="text-[9px] tracking-widest" style={{ color: "var(--hud-muted)" }}>{r.k.toUpperCase()}</div>
              <div className="text-[15px] font-bold mt-1 break-words" style={{ color: "var(--hud-text)" }}>{r.v}</div>
              <div className="prose-sans text-[11px] mt-0.5" style={{ color: "var(--hud-muted)" }}>{r.sub}</div>
            </div>
          ))}
        </section>

        <div className="hud-glass rounded-2xl p-3 mb-8 flex flex-col md:flex-row md:items-center gap-3 sticky top-16 z-20">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Search size={15} style={{ color: "var(--hud-muted)" }} aria-hidden />
            <label htmlFor="about-q" className="sr-only">Search sources</label>
            <input id="about-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="search a paper, repo, feed, or file path…" className="hud-input flex-1 min-w-0 prose-sans" style={{ minHeight: 40 }} />
          </div>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter by status">
            <button role="tab" aria-selected={status === "all"} onClick={() => setStatus("all")} className="hud-btn" style={{ color: status === "all" ? "var(--hud-accent)" : undefined, borderColor: status === "all" ? "var(--hud-accent)" : undefined }}>all · {total}</button>
            {(Object.keys(STATUS) as Status[]).map((k) => (
              <button key={k} role="tab" aria-selected={status === k} onClick={() => setStatus(status === k ? "all" : k)} className="hud-btn" title={STATUS[k].note}
                      style={{ color: status === k ? STATUS[k].color : undefined, borderColor: status === k ? STATUS[k].color : undefined }}>{STATUS[k].label} · {counts[k]}</button>
            ))}
          </div>
        </div>

        {SECTIONS.map((s) => {
          const items = s.items.filter(match);
          if (!items.length) return null;
          const Icon = s.icon;
          return (
            <section key={s.id} id={s.id} aria-labelledby={`h-${s.id}`} className="mb-10">
              <div className="flex items-center gap-3 mb-1">
                <span className="hud-page-icon" style={{ width: 32, height: 32, borderRadius: 9 }} aria-hidden><Icon size={15} /></span>
                <h2 id={`h-${s.id}`} className="text-[13px] font-bold tracking-[0.22em]" style={{ color: "var(--hud-text)" }}>{s.title.toUpperCase()} <span style={{ color: "var(--hud-muted)" }}>· {items.length}</span></h2>
              </div>
              <p className="prose-sans text-[12px] mb-4 max-w-[70ch]" style={{ color: "var(--hud-muted)" }}>{s.sub}</p>
              <div className="grid md:grid-cols-2 gap-3">
                {items.map((x) => (
                  <article key={x.url + x.name} className="hud-panel hud-panel-static p-4 min-w-0 flex flex-col gap-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <a href={x.url} target="_blank" rel="noreferrer" className="prose-sans text-[14px] font-semibold inline-flex items-center gap-1.5 hover:underline" style={{ color: "var(--hud-text)" }}>
                          {x.name} <ExternalLink size={12} aria-hidden style={{ color: "var(--hud-muted)" }} />
                        </a>
                        {x.by && <div className="text-[10px] mt-0.5" style={{ color: "var(--hud-muted)" }}>{x.by}</div>}
                      </div>
                      <span className="hud-chip shrink-0" style={{ color: STATUS[x.status].color }} title={STATUS[x.status].note}>{STATUS[x.status].label}</span>
                    </div>
                    <p className="prose-sans text-[12px]" style={{ color: "var(--hud-text)" }}><span style={{ color: "var(--hud-muted)" }}>What · </span>{x.what}</p>
                    <p className="prose-sans text-[12px] leading-relaxed" style={{ color: "var(--hud-text)" }}><span style={{ color: "var(--hud-muted)" }}>How · </span>{x.how}</p>
                    {x.result && <p className="prose-sans text-[12px] leading-relaxed rounded-lg px-3 py-2" style={{ color: "var(--hud-text)", background: "rgba(255,255,255,0.03)", border: "1px solid var(--hud-border)" }}><span style={{ color: STATUS[x.status].color }}>Result · </span>{x.result}</p>}
                    <div className="flex flex-wrap gap-1 mt-auto">
                      {x.where.map((w) => (
                        <a key={w} href={`https://github.com/SAI141003/axiom/blob/main/${w}`} target="_blank" rel="noreferrer" className="text-[10px] px-2 py-0.5 rounded hover:underline" style={{ color: "var(--hud-accent)", background: "var(--hud-accent-soft)" }}>{w}</a>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}

        <section className="hud-panel hud-panel-static p-5 mb-8 prose-sans text-[12.5px] leading-relaxed" style={{ color: "var(--hud-muted)" }}>
          <h2 className="text-[12px] font-bold tracking-[0.22em] font-mono mb-2" style={{ color: "var(--hud-text)" }}>HOW THIS PAGE IS KEPT HONEST</h2>
          <p>Every entry names at least one file or document in this repository that cites or uses it, and every path is checked to exist before the page ships. Status words mean what they say: <b style={{ color: STATUS.rejected.color }}>rejected</b> entries were fully built and then lost on data they had never seen; <b style={{ color: STATUS.shipped.color }}>shipped</b> entries are in the running system. Vendored clones (OctoBot, Kronos, RD-Agent, Vibe-Trading, the pipeline) are studied locally under their own licences and are not redistributed here. Results are dated in the <Link href="/lab" className="underline" style={{ color: "var(--hud-accent)" }}>Research Lab</Link>; the safety proof reproduces exactly, the backtest fetches live candles and drifts.</p>
          <p className="mt-2">Built by <a href="https://github.com/SAI141003" className="underline" style={{ color: "var(--hud-accent)" }}>Sai</a> with Claude Code. Source: <a href="https://github.com/SAI141003/axiom" className="underline" style={{ color: "var(--hud-accent)" }}>github.com/SAI141003/axiom</a> · MIT · not financial advice.</p>
        </section>
      </main>
    </div>
  );
}
