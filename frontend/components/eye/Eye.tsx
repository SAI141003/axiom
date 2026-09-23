"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Plane, Shield, Satellite, Activity, Radio, Rocket, Cable, Server, Waves, Flame, Ship, CloudSun, Landmark, Crosshair, Eye as EyeIcon, Volume2, VolumeX, LocateFixed, Camera } from "lucide-react";

/**
 * GOD'S EYE — the desk's god's-eye view, after bilawalsidhu/gods-eye-view:
 * a globe of live public data, every layer a real feed, a tactical HUD, a
 * contacts roster, sensor modes, click-to-track, and AXIOM's voice on top.
 * No layer is ever simulated: a feed that fails shows its error and its age.
 */
type Layer = { id: string; label: string; icon: any; color: string; on: boolean; every: number; count?: number; age?: number; error?: string; source?: string; needsKey?: string };
const LAYERS: Layer[] = [
  { id: "flights", label: "Flights", icon: Plane, color: "#9be1ff", on: true, every: 20_000 },
  { id: "mil", label: "Military", icon: Shield, color: "#f59e0b", on: true, every: 25_000 },
  { id: "sats", label: "Satellites", icon: Satellite, color: "#ffffff", on: true, every: 2 * 3600_000 },
  { id: "quakes", label: "Earthquakes", icon: Activity, color: "#ef4444", on: true, every: 60_000 },
  { id: "vessels", label: "Vessels", icon: Ship, color: "#22c55e", on: false, every: 30_000, needsKey: "AISSTREAM_API_KEY" },
  { id: "fires", label: "Fires", icon: Flame, color: "#fb923c", on: false, every: 30 * 60_000, needsKey: "FIRMS_MAP_KEY" },
  { id: "radio", label: "Radio", icon: Radio, color: "#a78bfa", on: false, every: 6 * 3600_000 },
  { id: "cameras", label: "Cameras", icon: Camera, color: "#e879f9", on: false, every: 10 * 60_000, needsKey: "WINDY_WEBCAMS_KEY" },
  { id: "launches", label: "Launches", icon: Rocket, color: "#f5b942", on: true, every: 15 * 60_000 },
  { id: "cables", label: "Sub cables", icon: Cable, color: "#1a8fd6", on: false, every: 24 * 3600_000 },
  { id: "datacenters", label: "Datacenters", icon: Server, color: "#4cc9ff", on: false, every: 1e12 },
  { id: "dams", label: "Dams", icon: Waves, color: "#38bdf8", on: false, every: 1e12 },
  { id: "stations", label: "Weather book", icon: CloudSun, color: "#f5b942", on: true, every: 60_000 },
  { id: "markets", label: "Exchanges", icon: Landmark, color: "#22c55e", on: true, every: 60_000 },
];
const SENSORS = ["normal", "crt", "nvg", "flir", "noir"] as const;
type Ent = { layer: string; id: string; label: string; lat: number; lon: number; alt: number; color: string; size: number; meta: Record<string, any> };

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => { const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLon = ((b.lon - a.lon) * Math.PI) / 180; const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const fmtAge = (ms?: number) => (ms == null || ms < 0 ? "—" : ms < 1000 ? "live" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

export default function Eye() {
  const host = useRef<HTMLDivElement>(null);
  const globe = useRef<any>(null);
  const data = useRef<Record<string, any[]>>({});
  const sats = useRef<{ rec: any; name: string; group: string; id: number }[]>([]);
  const cables = useRef<{ cables: any[]; landings: any[] }>({ cables: [], landings: [] });
  const [layers, setLayers] = useState<Layer[]>(LAYERS);
  const layersRef = useRef(layers); layersRef.current = layers;
  const [sensor, setSensor] = useState<(typeof SENSORS)[number]>("normal");
  const [tracked, setTracked] = useState<Ent | null>(null);
  const trackedRef = useRef<Ent | null>(null); trackedRef.current = tracked;
  const [pov, setPov] = useState({ lat: 20, lng: 0, altitude: 2.2 });
  const povRef = useRef(pov); povRef.current = pov;
  const [contacts, setContacts] = useState<Ent[]>([]);
  const [clock, setClock] = useState("");
  const [ready, setReady] = useState(false);
  const [radio, setRadio] = useState<{ name: string; url: string } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [nextLaunch, setNextLaunch] = useState<any>(null);
  const [hud, setHud] = useState(true);

  // ── the globe ──
  useEffect(() => {
    let g: any; let alive = true;
    (async () => {
      const Globe = (await import("globe.gl")).default;
      if (!alive || !host.current) return;
      g = new Globe(host.current)
        .globeImageUrl("/eye/earth-night.jpg").bumpImageUrl("/eye/earth-topology.png").backgroundImageUrl("/eye/night-sky.png")
        .showAtmosphere(true).atmosphereColor("#4cc9ff").atmosphereAltitude(0.18)
        // ground entities: dots (points are cylinders, so height stays near zero)
        .pointsData([]).pointLat("lat").pointLng("lon").pointAltitude(0.003).pointColor("color").pointRadius("size").pointsMerge(false).pointsTransitionDuration(0)
        .pointLabel((d: any) => `<div class="eye-tip"><b>${d.label}</b><br/>${Object.entries(d.meta).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join("<br/>")}</div>`)
        .onPointClick((d: any) => { setTracked(d); })
        // sky entities: particles at their real altitude (aircraft, military, satellites)
        .particlesData([]).particlesList("list").particleLat("lat").particleLng("lon").particleAltitude("alt").particlesSize("size").particlesSizeAttenuation(false).particlesColor("color")
        .particleLabel((d: any) => `<div class="eye-tip"><b>${d.label}</b><br/>${Object.entries(d.meta).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join("<br/>")}</div>`)
        .onParticleClick((d: any) => { setTracked(d); })
        .ringsData([]).ringLat("lat").ringLng("lon").ringColor(() => (t: number) => `rgba(239,68,68,${1 - t})`).ringMaxRadius("r").ringPropagationSpeed(1.2).ringRepeatPeriod(1400)
        .pathsData([]).pathPoints("coords").pathPointLat((p: any) => p[1]).pathPointLng((p: any) => p[0]).pathColor((d: any) => d.color || "#1a8fd6").pathStroke(0.6).pathDashLength(0.02).pathDashGap(0.01).pathDashAnimateTime(30_000).pathTransitionDuration(0)
        .labelsData([]).labelLat("lat").labelLng("lon").labelText("label").labelColor("color").labelSize(0.55).labelDotRadius(0.25).labelResolution(2)
        .onGlobeClick(() => setTracked(null));
      g.pointOfView({ lat: 20, lng: 0, altitude: 2.2 });
      g.controls().autoRotate = true; g.controls().autoRotateSpeed = 0.25;
      globe.current = g; setReady(true);
      const onResize = () => { if (host.current) g.width(host.current.clientWidth).height(host.current.clientHeight); };
      onResize(); window.addEventListener("resize", onResize);
      const povT = setInterval(() => { try { const p = g.pointOfView(); setPov(p); } catch {} }, 500);
      return () => { window.removeEventListener("resize", onResize); clearInterval(povT); };
    })();
    return () => { alive = false; try { g?._destructor?.(); } catch {} };
  }, []);

  // ── redraw everything the layers hold ──
  const redraw = useCallback(() => {
    const g = globe.current; if (!g) return;
    const on = new Set(layersRef.current.filter((l) => l.on).map((l) => l.id));
    const pts: Ent[] = [];
    for (const id of on) for (const e of data.current[id] ?? []) pts.push(e);
    if (on.has("sats")) {
      const now = new Date(); const gmst = (window as any).__satellite?.gstime(now);
      for (const s of sats.current) {
        try { const pv = (window as any).__satellite.propagate(s.rec, now); if (!pv.position) continue; const geo = (window as any).__satellite.eciToGeodetic(pv.position, gmst); const altKm = geo.height; pts.push({ layer: "sats", id: `sat-${s.id}`, label: s.name, lat: (geo.latitude * 180) / Math.PI, lon: (geo.longitude * 180) / Math.PI, alt: Math.min(0.6, altKm / 6371), color: s.group === "stations" ? "#ffffff" : s.group === "gps-ops" ? "#9be1ff" : s.group === "weather" ? "#f5b942" : "#c7d2fe", size: s.group === "stations" ? 0.5 : 0.22, meta: { group: s.group, alt_km: Math.round(altKm), norad: s.id } }); } catch {}
      }
    }
    const SKY = new Set(["flights", "mil", "sats"]);
    g.pointsData(pts.filter((p) => !SKY.has(p.layer)));
    g.particlesData(["flights", "mil", "sats"].filter((id) => on.has(id)).map((id) => ({ id, color: id === "mil" ? "#f59e0b" : id === "sats" ? "#e2e8f0" : "#9be1ff", size: id === "mil" ? 3.2 : id === "sats" ? 2.4 : 2, list: pts.filter((p) => p.layer === id) })));
    g.ringsData(on.has("quakes") ? (data.current.quakes ?? []).filter((q: any) => q.meta.mag >= 4).map((q: any) => ({ lat: q.lat, lon: q.lon, r: Math.max(1, q.meta.mag) * 1.6 })) : []);
    g.pathsData(on.has("cables") ? cables.current.cables : []);
    const labels: any[] = [];
    if (on.has("markets")) for (const e of data.current.markets ?? []) labels.push({ lat: e.lat, lon: e.lon, label: e.label, color: e.color });
    if (on.has("stations")) for (const e of data.current.stations ?? []) if (e.meta.open) labels.push({ lat: e.lat, lon: e.lon, label: e.label, color: e.color });
    g.labelsData(labels);
    // contacts: within 250 km of the tracked entity, else of the camera
    const c = trackedRef.current ?? { lat: povRef.current.lat, lon: povRef.current.lng };
    setContacts(pts.filter((p) => p !== trackedRef.current && km(c, p) <= 250).sort((a, b) => km(c, a) - km(c, b)).slice(0, 14));
  }, []);   // stable on purpose: a redraw that changed identity with the camera re-fetched every feed twice a second

  // ── the feeds ──
  const load = useCallback(async (id: string) => {
    const setMeta = (m: Partial<Layer>) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...m } : l)));
    try {
      if (id === "flights" || id === "mil") {
        const d = await fetch(`/api/eye/flights${id === "mil" ? "?mil=1" : ""}`).then((r) => r.json());
        data.current[id] = (d.items ?? []).map((a: any): Ent => ({ layer: id, id: `${id}-${a.hex}`, label: a.call || a.hex, lat: a.lat, lon: a.lon, alt: Math.min(0.05, a.alt / 300_000 + 0.006), color: id === "mil" ? "#f59e0b" : "#9be1ff", size: id === "mil" ? 0.32 : 0.18, meta: { alt_m: Math.round(a.alt), kts: Math.round(a.gs * 1.944), hdg: Math.round(a.hdg), type: a.type ?? "", reg: a.reg ?? "", src: a.src } }));
        setMeta({ count: data.current[id].length, age: d.age, error: d.error, source: d.source });
      } else if (id === "sats") {
        const sat = await import("@/lib/sgp4"); (window as any).__satellite = sat;
        const d = await fetch("/api/eye/satellites").then((r) => r.json());
        sats.current = (d.items ?? []).map((s: any) => { try { return { rec: sat.json2satrec(s), name: s.OBJECT_NAME, group: s.group, id: s.NORAD_CAT_ID }; } catch { return null; } }).filter(Boolean);
        setMeta({ count: sats.current.length, age: d.age, error: d.error, source: d.source });
      } else if (id === "quakes") {
        const d = await fetch("/api/eye/quakes").then((r) => r.json());
        data.current.quakes = (d.items ?? []).map((q: any): Ent => ({ layer: id, id: q.id, label: `M${q.mag?.toFixed(1)} ${q.place}`, lat: q.lat, lon: q.lon, alt: 0.01, color: q.mag >= 5 ? "#ef4444" : q.mag >= 3 ? "#f59e0b" : "#fca5a5", size: Math.max(0.15, (q.mag ?? 1) * 0.12), meta: { mag: q.mag, depth_km: Math.round(q.depth), when: new Date(q.time).toUTCString().slice(5, 22) } }));
        setMeta({ count: data.current.quakes.length, age: d.age, error: d.error, source: d.source });
      } else if (id === "cameras") {
        const d = await fetch("/api/eye/cameras").then((r) => r.json());
        data.current.cameras = (d.items ?? []).map((c: any): Ent => ({ layer: id, id: c.id, label: c.title || c.city || "camera", lat: c.lat, lon: c.lon, alt: 0.01, size: 0.22, color: "#e879f9", meta: c }));
        setMeta({ count: data.current.cameras.length, age: d.age, error: d.error ?? (d.configured === false ? d.note : undefined), source: d.source });
      } else if (id === "radio") {
        const d = await fetch("/api/eye/radio").then((r) => r.json());
        data.current.radio = (d.items ?? []).map((s: any): Ent => ({ layer: id, id: s.id, label: s.name, lat: s.lat, lon: s.lon, alt: 0.008, color: "#a78bfa", size: 0.16, meta: { country: s.country, tags: s.tags, codec: s.codec, url: s.url } }));
        setMeta({ count: data.current.radio.length, age: d.age, error: d.error, source: d.source });
      } else if (id === "launches") {
        const d = await fetch("/api/eye/launches").then((r) => r.json());
        data.current.launches = (d.items ?? []).map((l: any): Ent => ({ layer: id, id: l.id, label: l.name, lat: l.lat, lon: l.lon, alt: 0.012, color: l.phase === "upcoming" ? "#f5b942" : "#94a3b8", size: l.phase === "upcoming" ? 0.35 : 0.2, meta: { when: l.net?.slice(0, 16).replace("T", " ") + "Z", status: l.status, provider: l.provider, pad: l.pad, mission: l.mission } }));
        setNextLaunch((d.items ?? []).filter((l: any) => l.phase === "upcoming").sort((a: any, b: any) => a.net.localeCompare(b.net))[0] ?? null);
        setMeta({ count: data.current.launches.length, age: d.age, error: d.error, source: d.source });
      } else if (id === "cables") {
        const d = await fetch("/api/eye/cables").then((r) => r.json());
        cables.current = { cables: d.cables ?? [], landings: d.landings ?? [] };
        data.current.cables = (d.landings ?? []).map((p: any): Ent => ({ layer: id, id: `lp-${p.id}`, label: p.name, lat: p.lat, lon: p.lon, alt: 0.006, color: "#1a8fd6", size: 0.12, meta: { kind: "landing point" } }));
        setMeta({ count: cables.current.cables.length, age: d.age, error: d.error, source: d.source });
      } else if (id === "datacenters" || id === "dams") {
        const d = await fetch(`/eye/${id}.json`).then((r) => r.json());
        data.current[id] = (d.items ?? []).map((p: any, i: number): Ent => ({ layer: id, id: `${id}-${i}`, label: p.n, lat: p.lat, lon: p.lon, alt: 0.005, color: id === "dams" ? "#38bdf8" : "#4cc9ff", size: 0.1, meta: { operator: p.o ?? "", source: d.attribution } }));
        setMeta({ count: data.current[id].length, age: 0, source: d.attribution });
      } else if (id === "fires" || id === "vessels") {
        const d = await fetch(`/api/eye/${id}`).then((r) => r.json());
        if (!d.configured) { setMeta({ count: 0, error: d.note, source: d.source }); data.current[id] = []; }
        else { data.current[id] = (d.items ?? []).map((x: any, i: number): Ent => id === "fires" ? ({ layer: id, id: `f-${i}`, label: `fire ${x.frp} MW`, lat: x.lat, lon: x.lon, alt: 0.004, color: "#fb923c", size: 0.1, meta: { frp: x.frp, conf: x.conf, when: x.when } }) : ({ layer: id, id: `v-${x.mmsi}`, label: x.name || String(x.mmsi), lat: x.lat, lon: x.lon, alt: 0.004, color: "#22c55e", size: 0.14, meta: { sog: x.sog, cog: x.cog, mmsi: x.mmsi } })); setMeta({ count: data.current[id].length, age: d.age, error: d.error, source: d.source }); }
      } else if (id === "stations" || id === "markets") {
        const d = await fetch("/api/eye/layers").then((r) => r.json());
        data.current.stations = (d.stations ?? []).map((s: any): Ent => ({ layer: "stations", id: `st-${s.city}`, label: s.open.length ? `${s.city} · ${s.open.length} open` : s.city, lat: s.lat, lon: s.lon, alt: 0.01, color: s.open.length ? "#f5b942" : "#8a9bb5", size: s.open.length ? 0.4 : 0.15, meta: { open: s.open.length, positions: s.open.map((o: any) => `${o.side} ${o.q?.slice(0, 40)} @${o.entry}`).join(" · ") || "none", country: s.country } }));
        data.current.markets = [...(d.exchanges ?? []).map((e: any): Ent => ({ layer: "markets", id: `ex-${e.name}`, label: `${e.name} ${e.open ? "OPEN" : "closed"}`, lat: e.lat, lon: e.lon, alt: 0.012, color: e.open ? "#22c55e" : "#4b5b73", size: 0.3, meta: { session: e.session, local: e.local } })), ...(d.chokepoints ?? []).map((c: any): Ent => ({ layer: "markets", id: `cp-${c.name}`, label: c.name, lat: c.lat, lon: c.lon, alt: 0.008, color: "#ef4444", size: 0.22, meta: { kind: "chokepoint", note: c.note ?? "" } }))];
        setLayers((ls) => ls.map((l) => (l.id === "stations" ? { ...l, count: data.current.stations.length, age: 0, source: "desk weather book" } : l.id === "markets" ? { ...l, count: data.current.markets.length, age: 0, source: "desk" } : l)));
      }
    } catch (e: any) { setMeta({ error: String(e?.message ?? e).slice(0, 80) }); }
    redraw();
  }, [redraw]);

  useEffect(() => {
    if (!ready) return;
    const timers: any[] = [];
    // the globe first, then the feeds in order of weight: light ones now, the heavy ones a beat later
    const order = ["markets", "stations", "quakes", "launches", "mil", "flights", "sats", "cables", "radio", "cameras", "datacenters", "dams", "fires", "vessels"];
    order.forEach((idd, i) => setTimeout(() => load(idd), i < 5 ? 0 : 400 * (i - 4)));
    for (const l of LAYERS) if (l.every < 1e11) timers.push(setInterval(() => { if (layersRef.current.find((x) => x.id === l.id)?.on) load(l.id); }, l.every));
    timers.push(setInterval(redraw, 1000));   // satellites move
    timers.push(setInterval(() => setClock(new Date().toISOString().slice(11, 19) + "Z"), 1000));
    return () => timers.forEach(clearInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => { redraw(); }, [layers, redraw]);

  // ── tracking: the camera follows what you clicked ──
  useEffect(() => {
    const g = globe.current; if (!g) return;
    if (!tracked) { g.controls().autoRotate = true; return; }
    g.controls().autoRotate = false;
    g.pointOfView({ lat: tracked.lat, lng: tracked.lon, altitude: tracked.layer === "sats" ? 1.2 : 0.35 }, 900);
    const t = setInterval(() => { const live = (data.current[tracked.layer] ?? []).find((e) => e.id === tracked.id); if (live) { setTracked(live); g.pointOfView({ lat: live.lat, lng: live.lon }, 800); } }, 4000);
    return () => clearInterval(t);
  }, [tracked?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── sensor modes: the whole desk, not just the globe ──
  useEffect(() => { document.documentElement.dataset.sensor = sensor; try { localStorage.setItem("axiom.sensor", sensor); } catch {} }, [sensor]);
  useEffect(() => { try { const s = localStorage.getItem("axiom.sensor") as any; if (s && SENSORS.includes(s)) setSensor(s); } catch {} }, []);

  // ── AXIOM's voice: focus, layers, track, sensor ──
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {}; const g = globe.current; if (!g) return;
      if (d.focus) g.pointOfView({ lat: d.focus.lat, lng: d.focus.lon, altitude: d.focus.alt ?? 0.6 }, 1200);
      if (d.layer) setLayers((ls) => ls.map((l) => (l.id === d.layer.id || l.label.toLowerCase() === String(d.layer.id).toLowerCase() ? { ...l, on: d.layer.on ?? !l.on } : l)));
      if (d.sensor && SENSORS.includes(d.sensor)) setSensor(d.sensor);
      if (d.track) { const q = String(d.track).toLowerCase(); const hit = Object.values(data.current).flat().find((x: any) => x.label?.toLowerCase().includes(q)); if (hit) setTracked(hit as Ent); }
      if (d.untrack) setTracked(null);
    };
    window.addEventListener("axiom:eye", h); return () => window.removeEventListener("axiom:eye", h);
  }, []);

  const play = (e: Ent) => { if (audio.current) { audio.current.pause(); audio.current = null; } if (radio?.url === e.meta.url) { setRadio(null); return; } const a = new Audio(e.meta.url); a.volume = 0.6; a.play().catch(() => {}); audio.current = a; setRadio({ name: e.label, url: e.meta.url }); };
  const toggle = (id: string) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, on: !l.on } : l)));
  const total = layers.filter((l) => l.on).reduce((s, l) => s + (l.count ?? 0), 0);

  return (
    <div className="eye">
      <div ref={host} className="eye-globe" />
      {hud && (<>
        {/* top-left: readouts */}
        <div className="eye-panel eye-tl">
          <div className="eye-title"><EyeIcon size={13} /> GOD'S EYE · LIVE</div>
          <div className="eye-row"><span>UTC</span><b>{clock}</b></div>
          <div className="eye-row"><span>CAM</span><b>{pov.lat.toFixed(2)}° {pov.lng.toFixed(2)}° · {(pov.altitude * 6371).toFixed(0)} km</b></div>
          <div className="eye-row"><span>TRACKS</span><b>{total.toLocaleString()}</b></div>
          {nextLaunch && <div className="eye-row"><span>NEXT LAUNCH</span><b title={nextLaunch.name}>{nextLaunch.name.slice(0, 26)} · {nextLaunch.net.slice(5, 16).replace("T", " ")}Z</b></div>}
          <div className="eye-row"><span>SENSOR</span><b>{SENSORS.map((s) => <button key={s} onClick={() => setSensor(s)} className="eye-chip" data-on={s === sensor || undefined}>{s.toUpperCase()}</button>)}</b></div>
        </div>
        {/* left: layers */}
        <div className="eye-panel eye-l">
          <div className="eye-title">LAYERS</div>
          {layers.map((l) => { const I = l.icon; return (
            <button key={l.id} onClick={() => toggle(l.id)} className="eye-layer" data-on={l.on || undefined} title={l.error ?? l.source ?? ""}>
              <I size={12} style={{ color: l.on ? l.color : "var(--hud-muted)" }} /><span className="eye-layer-name">{l.label}</span>
              <span className="eye-layer-n" style={{ color: l.error ? "var(--hud-red)" : "var(--hud-muted)" }}>{l.error ? (l.needsKey ? "key" : "err") : l.count != null ? `${l.count.toLocaleString()} · ${fmtAge(l.age)}` : "…"}</span>
            </button>); })}
        </div>
        {/* right: tracked + contacts */}
        <div className="eye-panel eye-r">
          <div className="eye-title"><Crosshair size={12} /> {tracked ? "TRACKING" : "CONTACTS · 250 KM"}</div>
          {tracked && (
            <div className="eye-track">
              <div className="eye-track-name" style={{ color: tracked.color }}>{tracked.label}</div>
              <div className="eye-row"><span>POS</span><b>{tracked.lat.toFixed(3)}, {tracked.lon.toFixed(3)}</b></div>
              {/* a camera is worth watching, not reading: the live player if
                  the feed offers one, the current still if it does not */}
              {tracked.layer === "cameras" && (tracked.meta.live ? (
                <iframe src={tracked.meta.live} title={tracked.label} allow="autoplay; fullscreen"
                        className="w-full rounded mt-1" style={{ aspectRatio: "16/9", border: "1px solid var(--hud-border)", background: "#000" }} />
              ) : tracked.meta.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={tracked.meta.thumb} alt={tracked.label} className="w-full rounded mt-1" style={{ border: "1px solid var(--hud-border)" }} />
              ) : null)}
              {Object.entries(tracked.meta).filter(([k, v]) => v !== "" && v != null && !["live", "thumb"].includes(k)).slice(0, 7).map(([k, v]) => <div key={k} className="eye-row"><span>{k.toUpperCase()}</span><b className="truncate" title={String(v)}>{String(v).slice(0, 60)}</b></div>)}
              <div className="flex gap-1 mt-1">
                {tracked.layer === "radio" && <button onClick={() => play(tracked)} className="eye-chip">{radio?.url === tracked.meta.url ? <><VolumeX size={11} /> stop</> : <><Volume2 size={11} /> listen</>}</button>}
                <button onClick={() => setTracked(null)} className="eye-chip">release</button>
                <button onClick={() => window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: `I'm tracking ${tracked.label} (${tracked.layer}) at ${tracked.lat.toFixed(2)}, ${tracked.lon.toFixed(2)}. What is it and does it matter to the desk?` }))} className="eye-chip">ask AXIOM</button>
              </div>
            </div>
          )}
          {contacts.map((c) => <button key={c.id} onClick={() => setTracked(c)} className="eye-contact"><span className="eye-dot" style={{ background: c.color }} /><span className="truncate">{c.label}</span><span style={{ color: "var(--hud-muted)" }}>{km(tracked ?? { lat: pov.lat, lon: pov.lng }, c).toFixed(0)} km</span></button>)}
          {!contacts.length && !tracked && <div className="eye-muted">nothing within 250 km of the camera — zoom in or click a track</div>}
        </div>
        {radio && <div className="eye-panel eye-bl"><Radio size={12} /> <span className="truncate">{radio.name}</span><button onClick={() => { audio.current?.pause(); setRadio(null); }} className="eye-chip">stop</button></div>}
      </>)}
      {/* bottom-right chips, like the original */}
      <div className="eye-chips">
        <button onClick={() => setHud((h) => !h)} className="eye-chip" data-on={hud || undefined}>HUD</button>
        <button onClick={() => { globe.current?.pointOfView({ lat: 49.28, lng: -123.12, altitude: 0.5 }, 1200); }} className="eye-chip"><LocateFixed size={11} /> home</button>
        <button onClick={() => window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: "Give me the situation on God's Eye: what's live in the sky, on the ground and in our weather book right now. Three sentences." }))} className="eye-chip eye-chip-accent">ask AXIOM</button>
      </div>
    </div>
  );
}
