"use client";

import { useEffect, useState } from "react";
import { Tv, Volume2, VolumeX, Maximize2, LayoutGrid } from "lucide-react";

export const CHANNELS = [
  { id: "UCIALMKvObZNtJ6AmdCLP7Lg", name: "Bloomberg", tag: "markets" },
  { id: "UCvJJ_dzjViJCoLf5uKUTwoA", name: "CNBC", tag: "markets" },
  { id: "UCEAZeUIeJs0IjQiqTCdVSIg", name: "Yahoo Finance", tag: "markets" },
  { id: "UCoMdktPbSTixAyNGwb-UYkQ", name: "Sky News", tag: "world" },
  { id: "UCNye-wNBqNL5ZzHSJj3l8Bg", name: "Al Jazeera", tag: "world" },
  { id: "UCknLrEdhRCp1aegoMqRaCZg", name: "DW News", tag: "world" },
  { id: "UCQfwfsi5VrQ8yKZ-UWmAEFg", name: "France 24", tag: "world" },
  { id: "UCBi2mrWuNuyYy4gbM6fU18Q", name: "ABC News", tag: "world" },
  { id: "UChqUTb7kYRX8-EiaN3XFrSQ", name: "Reuters", tag: "wire" },
  { id: "UCupvZG-5ko_eiXAupbDfxWw", name: "CNN", tag: "world" },
];
const LAYOUTS = [1, 2, 4, 6] as const;

// A multiview wall: several channels on one page, all live. Every tile is
// muted (browsers require it for autoplay); click a tile's speaker to hear
// that one, click its corner to make it the big one. Layout and channel
// choices are remembered per browser.
export default function VideoWall() {
  const [n, setN] = useState<number>(4);
  const [slots, setSlots] = useState<string[]>(CHANNELS.slice(0, 6).map((c) => c.id));
  const [audio, setAudio] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => { try { const s = JSON.parse(localStorage.getItem("axiom.wall") || "null"); if (s?.n) setN(s.n); if (s?.slots?.length) setSlots(s.slots); } catch {} }, []);
  useEffect(() => { try { localStorage.setItem("axiom.wall", JSON.stringify({ n, slots })); } catch {} }, [n, slots]);

  const tiles = slots.slice(0, n);
  const cols = n === 1 ? 1 : n === 2 ? 2 : n === 4 ? 2 : 3;
  const src = (id: string) => `https://www.youtube.com/embed/live_stream?channel=${id}&autoplay=1&mute=${audio === id ? 0 : 1}&rel=0&modestbranding=1&playsinline=1`;
  const nameOf = (id: string) => CHANNELS.find((c) => c.id === id)?.name ?? "";

  return (
    <section aria-label="Video wall" className="hud-panel hud-panel-static overflow-hidden min-w-0">
      <div className="flex items-center gap-3 px-4 h-11 border-b flex-wrap" style={{ borderColor: "var(--hud-border)" }}>
        <Tv size={14} style={{ color: "var(--hud-accent)" }} aria-hidden />
        <span className="text-[10px] tracking-[0.22em] font-bold font-mono" style={{ color: "var(--hud-accent)" }}>LIVE WALL</span>
        <span className="hud-led" style={{ background: "var(--hud-red)", color: "var(--hud-red)", width: 6, height: 6 }} aria-hidden />
        <span className="prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}>{n} channel{n > 1 ? "s" : ""} live · {audio ? `sound: ${nameOf(audio)}` : "all muted — tap a speaker"}</span>
        <span className="flex-1" />
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Layout">
          <LayoutGrid size={13} style={{ color: "var(--hud-muted)" }} aria-hidden />
          {LAYOUTS.map((k) => (
            <button key={k} role="radio" aria-checked={n === k} onClick={() => { setN(k); setFocus(null); }} className="hud-btn" style={{ minHeight: 30, padding: "0 10px", color: n === k ? "var(--hud-accent)" : undefined, borderColor: n === k ? "var(--hud-accent)" : undefined }}>{k}</button>
          ))}
        </div>
      </div>
      <div className="grid gap-1 p-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, background: "#05070c" }}>
        {tiles.map((id, i) => {
          const big = focus === id;
          return (
            <div key={i} className="relative min-w-0" style={{ gridColumn: big ? `span ${cols}` : undefined, aspectRatio: "16 / 9", background: "#05070c" }}>
              <iframe key={src(id)} src={src(id)} title={`${nameOf(id)} live`} className="absolute inset-0 w-full h-full" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" referrerPolicy="strict-origin-when-cross-origin" />
              <div className="absolute top-1.5 left-1.5 right-1.5 flex items-center gap-1">
                <select value={id} onChange={(e) => setSlots(slots.map((s, j) => (j === i ? e.target.value : s)))} aria-label={`channel for tile ${i + 1}`}
                        className="text-[11px] font-mono rounded px-2 min-h-[28px] cursor-pointer" style={{ background: "rgba(7,10,18,0.85)", color: "var(--hud-text)", border: "1px solid var(--hud-border-2)" }}>
                  {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <span className="flex-1" />
                <button onClick={() => setAudio(audio === id ? null : id)} aria-label={audio === id ? "mute" : "unmute this channel"} aria-pressed={audio === id} className="hud-icon-btn" style={{ width: 32, height: 32, minHeight: 32, background: "rgba(7,10,18,0.85)", color: audio === id ? "var(--hud-accent)" : "var(--hud-text)" }}>{audio === id ? <Volume2 size={14} /> : <VolumeX size={14} />}</button>
                {n > 1 && <button onClick={() => setFocus(big ? null : id)} aria-label={big ? "shrink" : "make this the big one"} aria-pressed={big} className="hud-icon-btn" style={{ width: 32, height: 32, minHeight: 32, background: "rgba(7,10,18,0.85)", color: big ? "var(--hud-accent)" : "var(--hud-text)" }}><Maximize2 size={14} /></button>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
