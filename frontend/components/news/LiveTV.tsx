"use client";

import { useEffect, useState } from "react";
import { Tv, Volume2, ExternalLink } from "lucide-react";

// Live world news, free: the 24/7 YouTube streams of the major channels,
// embedded by channel so the page always points at whatever they are airing
// now. No key, no scraping. If a channel is between broadcasts YouTube says so
// inside the frame, and the picker moves on.
const CHANNELS = [
  { id: "UCIALMKvObZNtJ6AmdCLP7Lg", name: "Bloomberg", tag: "markets", region: "US" },
  { id: "UCvJJ_dzjViJCoLf5uKUTwoA", name: "CNBC", tag: "markets", region: "US" },
  { id: "UCEAZeUIeJs0IjQiqTCdVSIg", name: "Yahoo Finance", tag: "markets", region: "US" },
  { id: "UCoMdktPbSTixAyNGwb-UYkQ", name: "Sky News", tag: "world", region: "UK" },
  { id: "UCNye-wNBqNL5ZzHSJj3l8Bg", name: "Al Jazeera", tag: "world", region: "QA" },
  { id: "UCknLrEdhRCp1aegoMqRaCZg", name: "DW News", tag: "world", region: "DE" },
  { id: "UCQfwfsi5VrQ8yKZ-UWmAEFg", name: "France 24", tag: "world", region: "FR" },
  { id: "UCBi2mrWuNuyYy4gbM6fU18Q", name: "ABC News", tag: "world", region: "US" },
  { id: "UChqUTb7kYRX8-EiaN3XFrSQ", name: "Reuters", tag: "wire", region: "UK" },
  { id: "UCupvZG-5ko_eiXAupbDfxWw", name: "CNN", tag: "world", region: "US" },
];

export default function LiveTV() {
  const [active, setActive] = useState(CHANNELS[0]);
  const [muted, setMuted] = useState(true);
  useEffect(() => { try { const s = localStorage.getItem("axiom.tv"); const c = CHANNELS.find((x) => x.id === s); if (c) setActive(c); } catch {} }, []);
  const pick = (c: typeof CHANNELS[0]) => { setActive(c); try { localStorage.setItem("axiom.tv", c.id); } catch {} };
  const src = `https://www.youtube.com/embed/live_stream?channel=${active.id}&autoplay=1&mute=${muted ? 1 : 0}&rel=0&modestbranding=1`;

  return (
    <section aria-label="Live television" className="grid lg:grid-cols-[1fr_260px] gap-4 mb-8">
      <div className="hud-panel hud-panel-static overflow-hidden min-w-0">
        <div className="flex items-center gap-3 px-4 h-11 border-b" style={{ borderColor: "var(--hud-border)" }}>
          <Tv size={14} style={{ color: "var(--hud-accent)" }} aria-hidden />
          <span className="text-[10px] tracking-[0.22em] font-bold font-mono" style={{ color: "var(--hud-accent)" }}>LIVE TV</span>
          <span className="prose-sans text-[12px] truncate" style={{ color: "var(--hud-text)" }}>{active.name}</span>
          <span className="hud-led" style={{ background: "var(--hud-red)", color: "var(--hud-red)", width: 6, height: 6 }} aria-hidden />
          <span className="flex-1" />
          <button onClick={() => setMuted((m) => !m)} className="hud-btn" aria-pressed={!muted}><Volume2 size={12} aria-hidden /> {muted ? "Unmute" : "Mute"}</button>
          <a href={`https://www.youtube.com/channel/${active.id}/live`} target="_blank" rel="noreferrer" className="hud-icon-btn" aria-label="open on YouTube"><ExternalLink size={14} /></a>
        </div>
        <div className="relative w-full" style={{ aspectRatio: "16 / 9", background: "#05070c" }}>
          <iframe key={src} src={src} title={`${active.name} live`} className="absolute inset-0 w-full h-full" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" referrerPolicy="strict-origin-when-cross-origin" />
        </div>
      </div>
      <div className="hud-panel hud-panel-static p-2 flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible" role="tablist" aria-label="Channels">
        {CHANNELS.map((c) => {
          const on = c.id === active.id;
          return (
            <button key={c.id} role="tab" aria-selected={on} onClick={() => pick(c)} className="flex items-center gap-3 px-3 min-h-[44px] rounded-lg text-left shrink-0 lg:shrink transition-colors cursor-pointer"
                    style={{ background: on ? "var(--hud-accent-soft)" : "transparent", boxShadow: on ? "inset 0 0 0 1px rgba(56,189,248,0.28)" : "none" }}>
              <span className="text-[9px] font-mono w-6" style={{ color: "var(--hud-muted)" }}>{c.region}</span>
              <span className="prose-sans text-[13px] font-medium" style={{ color: on ? "var(--hud-accent)" : "var(--hud-text)" }}>{c.name}</span>
              <span className="flex-1" />
              <span className="hud-chip" style={{ padding: "1px 8px" }}>{c.tag}</span>
            </button>
          );
        })}
        <p className="prose-sans text-[10px] px-3 py-2 hidden lg:block" style={{ color: "var(--hud-muted)" }}>Free 24/7 streams. If a channel is between broadcasts the frame says so — pick another.</p>
      </div>
    </section>
  );
}
