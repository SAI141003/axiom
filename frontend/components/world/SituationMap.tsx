"use client";

import { useEffect, useMemo, useState } from "react";
import { ComposableMap, Geographies, Geography, Marker, ZoomableGroup } from "react-simple-maps";
import { Activity, Landmark, Anchor, Newspaper, Sparkles } from "lucide-react";

const GEO = "/geo/countries-110m.json";
type Layer = "exchanges" | "chokepoints" | "quakes" | "news";

// AXIOM's own situation map. Built from free data and fixed knowledge, not a
// third-party dashboard: exchanges with live open/closed state, the eight
// chokepoints a trading desk watches, USGS earthquakes from the last day, and
// the World Wire's headline pressure by region. Click anything; ask AXIOM.
export default function SituationMap() {
  const [d, setD] = useState<any>(null);
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ exchanges: true, chokepoints: true, quakes: true, news: true });
  const [pick, setPick] = useState<any>(null);
  useEffect(() => { const load = () => fetch("/api/world/map").then((r) => r.json()).then(setD).catch(() => {}); load(); const t = setInterval(load, 5 * 60_000); return () => clearInterval(t); }, []);
  const toggle = (k: Layer) => setLayers({ ...layers, [k]: !layers[k] });
  const openCount = useMemo(() => (d?.exchanges ?? []).filter((e: any) => e.open).length, [d]);

  return (
    <section aria-label="Situation map" className="hud-panel hud-panel-static overflow-hidden min-w-0">
      <div className="flex items-center gap-2 px-4 h-11 border-b flex-wrap" style={{ borderColor: "var(--hud-border)" }}>
        <span className="text-[10px] tracking-[0.22em] font-bold font-mono" style={{ color: "var(--hud-accent)" }}>SITUATION MAP</span>
        <span className="prose-sans text-[12px] truncate" style={{ color: "var(--hud-muted)" }}>{d ? `${openCount} of ${d.exchanges.length} exchanges open · ${d.quakes.length} quakes M4.5+ (24h) · ${(d.regions ?? []).reduce((s: number, r: any) => s + (r.fresh ?? 0), 0)} fresh regional headlines` : "loading…"}</span>
        <span className="flex-1" />
        {([["exchanges", Landmark, "Exchanges"], ["chokepoints", Anchor, "Chokepoints"], ["quakes", Activity, "Quakes"], ["news", Newspaper, "News"]] as [Layer, any, string][]).map(([k, Icon, label]) => (
          <button key={k} onClick={() => toggle(k)} aria-pressed={layers[k]} className="hud-btn" style={{ minHeight: 30, color: layers[k] ? "var(--hud-accent)" : undefined, borderColor: layers[k] ? "var(--hud-accent)" : undefined }}><Icon size={12} aria-hidden /> {label}</button>
        ))}
      </div>
      <div className="grid lg:grid-cols-[1fr_300px]">
        <div style={{ background: "radial-gradient(ellipse at 50% 40%, #0b1626 0%, #05070c 70%)" }}>
          <ComposableMap projection="geoNaturalEarth1" projectionConfig={{ scale: 150 }} style={{ width: "100%", height: "auto" }} aria-label="World map">
            <ZoomableGroup zoom={1} minZoom={1} maxZoom={6}>
              <Geographies geography={GEO}>
                {({ geographies }) => geographies.map((g) => (
                  <Geography key={g.rsmKey} geography={g} fill="#111a29" stroke="#1e2f48" strokeWidth={0.4} style={{ default: { outline: "none" }, hover: { fill: "#16233a", outline: "none" }, pressed: { outline: "none" } }} />
                ))}
              </Geographies>
              {layers.news && (d?.regions ?? []).map((r: any) => (
                <Marker key={r.id} coordinates={[r.lon, r.lat]} onClick={() => setPick({ kind: "region", ...r })} style={{ default: { cursor: "pointer" } }}>
                  <circle r={6 + Math.min(18, Math.sqrt(r.fresh ?? 0) * 3)} fill="rgba(76,201,255,0.10)" stroke="rgba(76,201,255,0.45)" strokeWidth={0.8} />
                  <text textAnchor="middle" y={-4} style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 7, fill: "#9be1ff" }}>{r.fresh}</text>
                </Marker>
              ))}
              {layers.quakes && (d?.quakes ?? []).map((q: any, i: number) => (
                <Marker key={i} coordinates={[q.lon, q.lat]} onClick={() => setPick({ kind: "quake", ...q })} style={{ default: { cursor: "pointer" } }}>
                  <circle r={Math.max(2, (q.mag - 4) * 3)} fill="rgba(239,68,68,0.25)" stroke="#ef4444" strokeWidth={0.8} />
                </Marker>
              ))}
              {layers.chokepoints && (d?.chokepoints ?? []).map((c: any) => (
                <Marker key={c.name} coordinates={[c.lon, c.lat]} onClick={() => setPick({ kind: "chokepoint", ...c })} style={{ default: { cursor: "pointer" } }}>
                  <path d="M0,-4 L3.5,0 L0,4 L-3.5,0 Z" fill="#f59e0b" stroke="#05070c" strokeWidth={0.6} />
                </Marker>
              ))}
              {layers.exchanges && (d?.exchanges ?? []).map((e: any) => (
                <Marker key={e.name} coordinates={[e.lon, e.lat]} onClick={() => setPick({ kind: "exchange", ...e })} style={{ default: { cursor: "pointer" } }}>
                  <circle r={3} fill={e.open ? "#22c55e" : "#2c3a4f"} stroke={e.open ? "#22c55e" : "#4a5a75"} strokeWidth={0.8} style={e.open ? { filter: "drop-shadow(0 0 3px #22c55e)" } : undefined} />
                </Marker>
              ))}
            </ZoomableGroup>
          </ComposableMap>
          <div className="flex flex-wrap gap-4 px-4 py-2 text-[10px] font-mono border-t" style={{ color: "var(--hud-muted)", borderColor: "var(--hud-border)" }}>
            <span><span style={{ color: "#22c55e" }}>●</span> exchange open</span><span><span style={{ color: "#4a5a75" }}>●</span> closed</span><span><span style={{ color: "#f59e0b" }}>◆</span> chokepoint</span><span><span style={{ color: "#ef4444" }}>●</span> quake M4.5+</span><span><span style={{ color: "#9be1ff" }}>◯</span> fresh headlines by region</span><span className="flex-1" /><span>scroll to zoom · drag to pan</span>
          </div>
        </div>
        <aside className="border-l p-4 min-w-0 flex flex-col gap-3" style={{ borderColor: "var(--hud-border)" }} aria-live="polite">
          {!pick && (
            <>
              <div className="text-[10px] tracking-widest font-mono" style={{ color: "var(--hud-muted)" }}>EXCHANGES NOW</div>
              <ul className="flex flex-col gap-1 text-[11px] font-mono">
                {(d?.exchanges ?? []).map((e: any) => (
                  <li key={e.name} className="flex items-center gap-2 cursor-pointer hud-row px-2 py-1 rounded" onClick={() => setPick({ kind: "exchange", ...e })}>
                    <span className="hud-led" style={{ background: e.open ? "var(--hud-green)" : "var(--hud-border-2)", color: e.open ? "var(--hud-green)" : "transparent", width: 6, height: 6 }} aria-hidden />
                    <span className="flex-1 truncate" style={{ color: "var(--hud-text)" }}>{e.name}</span><span style={{ color: "var(--hud-muted)" }}>{e.local}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {pick && (
            <>
              <div className="flex items-center gap-2"><span className="text-[10px] tracking-widest font-mono" style={{ color: "var(--hud-accent)" }}>{pick.kind.toUpperCase()}</span><span className="flex-1" /><button onClick={() => setPick(null)} className="hud-btn" style={{ minHeight: 28 }}>back</button></div>
              <div className="prose-sans text-[14px] font-semibold" style={{ color: "var(--hud-text)" }}>{pick.name ?? pick.place ?? pick.id}</div>
              {pick.kind === "exchange" && <p className="prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}><span style={{ color: pick.open ? "var(--hud-green)" : "var(--hud-text)" }}>{pick.open ? "Open now" : "Closed"}</span> · local time {pick.local} · session {pick.session}</p>}
              {pick.kind === "chokepoint" && <p className="prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}>{pick.what}</p>}
              {pick.kind === "quake" && <p className="prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}>Magnitude {pick.mag} · {new Date(pick.time).toUTCString()}</p>}
              {pick.kind === "region" && (
                <ul className="flex flex-col gap-1.5">
                  {(pick.items ?? []).map((it: any, i: number) => <li key={i}><a href={it.link} target="_blank" rel="noreferrer" className="prose-sans text-[12px] hover:underline" style={{ color: "var(--hud-text)" }}>{it.title}</a> <span className="text-[10px] font-mono" style={{ color: "var(--hud-muted)" }}>— {it.source}</span></li>)}
                </ul>
              )}
              <button onClick={() => window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: `On the situation map I picked ${pick.kind} "${pick.name ?? pick.place ?? pick.id}". What matters about it for our positions right now? Three sentences.` }))} className="hud-btn hud-btn-accent self-start"><Sparkles size={12} aria-hidden /> Ask AXIOM</button>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
