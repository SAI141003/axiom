"use client";

import { useEffect, useState } from "react";
import { Globe, ExternalLink } from "lucide-react";
import TopNav from "@/components/TopNav";
import PageHeader from "@/components/PageHeader";
import SituationMap from "@/components/world/SituationMap";
import LiveSummary from "@/components/news/LiveSummary";

const WM = "http://127.0.0.1:3100/";

// The world, ours: AXIOM's own situation map and live summary, built from
// free data so nothing here depends on anyone else's dashboard. World Monitor
// (self-hosted, optional) is offered underneath for the layers we do not
// build ourselves -- AIS, flights, cables.
export default function WorldPage() {
  const [wm, setWm] = useState<boolean | null>(null);
  const [showWm, setShowWm] = useState(false);
  useEffect(() => { fetch(WM, { mode: "no-cors", cache: "no-store" }).then(() => setWm(true)).catch(() => setWm(false)); }, []);
  return (
    <div className="hud-bg min-h-screen relative">
      <div className="hud-ambient" aria-hidden />
      <TopNav />
      <main className="relative max-w-7xl mx-auto p-6 font-mono">
        <PageHeader icon={Globe} title="WORLD">exchanges open now · chokepoints · earthquakes · where the headlines are coming from — our own map, free data, nothing borrowed at runtime</PageHeader>
        <div className="grid lg:grid-cols-[1fr_340px] gap-4 items-start mb-6">
          <SituationMap />
          <LiveSummary />
        </div>
        <section className="hud-panel hud-panel-static overflow-hidden">
          <div className="flex items-center gap-3 px-4 h-11 flex-wrap">
            <span className="text-[10px] tracking-[0.22em] font-bold font-mono" style={{ color: "var(--hud-muted)" }}>OPTIONAL · WORLD MONITOR</span>
            <span className="prose-sans text-[12px] truncate" style={{ color: "var(--hud-muted)" }}>self-hosted koala73/worldmonitor (AGPL-3.0) for the layers we do not build: AIS shipping, flights, undersea cables, sanctions</span>
            <span className="flex-1" />
            <span className="hud-led" style={{ background: wm ? "var(--hud-green)" : "var(--hud-border-2)", color: wm ? "var(--hud-green)" : "transparent", width: 6, height: 6 }} aria-hidden />
            <button onClick={() => setShowWm((s) => !s)} disabled={!wm} className="hud-btn" style={{ minHeight: 30 }}>{showWm ? "Hide" : wm ? "Show" : "not running"}</button>
            <a href={WM} target="_blank" rel="noreferrer" className="hud-icon-btn" aria-label="open World Monitor in a new tab" style={{ width: 30, height: 30, minHeight: 30 }}><ExternalLink size={12} /></a>
          </div>
          {showWm && wm && <iframe src={WM} title="World Monitor" className="w-full border-0" style={{ height: "80vh", background: "#05070c" }} allow="autoplay; fullscreen" referrerPolicy="no-referrer" />}
        </section>
      </main>
    </div>
  );
}
