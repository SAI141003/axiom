"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";
import { getToggle } from "@/lib/toggles";

interface Bucket {
  question: string;
  low: number; high: number;
  marketYes: number; modelProb: number; edge: number;
}

interface CityReport {
  slug: string; title: string; city: string; station: string;
  obsSource?: string; metarN?: number; gridObserved?: number | null;
  probSource?: string; nMembers?: number;
  forecastMax: number | null; observedMax: number | null;
  hoursElapsed: number; sigma: number;
  buckets: Bucket[]; bestPlay: string | null; endDate: string | null;
  unit: "C" | "F";
}

export default function WeatherPage() {
  const [reports, setReports] = useState<CityReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "plays" | "station">("all");

  const load = async () => {
    try {
      const res = await fetch("/api/weather");
      if (res.ok) {
        const data = await res.json();
        setReports(data.reports ?? []);
        setUpdated(new Date());
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(() => { if (getToggle("weather.autoRefresh")) load(); }, 120_000);
    return () => clearInterval(t);
  }, []);

  const shown = reports.filter((r) =>
    filter === "plays" ? !!r.bestPlay
    : filter === "station" ? r.obsSource === "metar"
    : true);
  const plays = reports.filter((r) => r.bestPlay).length;

  const maxEdge = (r: CityReport) =>
    Math.max(...r.buckets.map((b) => Math.abs(b.edge)), 0);

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
          <div>
            <h1 className="text-xl font-bold tracking-[0.2em]">WEATHER EDGE SCANNER</h1>
            <p className="text-xs mt-1" style={{ color: "var(--hud-muted)" }}>
              {loading ? "Scanning…" : `${reports.length} cities live`} · station METAR + 82-member
              ensembles vs market buckets. {updated && `Updated ${updated.toLocaleTimeString()}.`}
            </p>
          </div>
          <div className="flex gap-2">
            {([["all", `ALL (${reports.length})`], ["plays", `PLAYS (${plays})`], ["station", "📡 STATION"]] as const)
              .map(([f, label]) => (
              <button key={f} onClick={() => setFilter(f)}
                      className={`hud-chip ${filter === f ? "hud-nav-active" : ""}`}
                      style={{ color: filter === f ? undefined : "var(--hud-muted)", cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {loading && reports.length === 0 ? (
          <div className="text-center py-20 text-sm" style={{ color: "var(--hud-muted)" }}>
            Scanning cities… (Gamma + METAR + ensembles)
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {shown.map((r) => {
              const edge = maxEdge(r);
              const isOpen = expanded === r.slug;
              return (
                <div key={r.slug}
                     className="hud-panel hud-panel-static p-3 cursor-pointer"
                     style={r.bestPlay ? { borderColor: "rgba(62,207,142,0.45)" } : undefined}
                     onClick={() => setExpanded(isOpen ? null : r.slug)}>
                  {/* header row */}
                  <div className="flex items-center justify-between">
                    <span className="font-bold uppercase text-[13px] truncate">{r.city}</span>
                    <span className="flex items-center gap-1.5 flex-shrink-0">
                      {r.obsSource === "metar" && (
                        <span className="text-[9px]" title={`${r.metarN} station readings`}
                              style={{ color: "var(--hud-green)" }}>📡</span>
                      )}
                      {r.probSource === "ensemble" && (
                        <span className="text-[9px]" title={`${r.nMembers}-member ensemble`}
                              style={{ color: "var(--hud-accent)" }}>⛅{r.nMembers}</span>
                      )}
                      <span className="text-[10px]" style={{ color: "var(--hud-muted)" }}>
                        {isOpen ? "▲" : "▼"}
                      </span>
                    </span>
                  </div>

                  {/* key numbers */}
                  <div className="flex items-baseline gap-3 mt-1.5 tabular-nums">
                    <span className="text-lg font-bold" style={{ color: "var(--hud-text)" }}>
                      {r.observedMax != null ? `${r.observedMax}°` : "—"}
                    </span>
                    <span className="text-[10px]" style={{ color: "var(--hud-muted)" }}>
                      obs · fc {r.forecastMax?.toFixed(0)}°{r.unit} · {r.hoursElapsed}h
                    </span>
                    <span className="ml-auto text-[11px] font-bold"
                          style={{ color: edge > 0.08 ? "var(--hud-green)" : "var(--hud-muted)" }}>
                      {edge > 0 ? `${(edge * 100).toFixed(0)}% edge` : "—"}
                    </span>
                  </div>

                  {/* play line */}
                  {r.bestPlay && (
                    <div className="mt-2 px-2 py-1.5 text-[10px] font-bold leading-snug"
                         style={{ background: "rgba(62,207,142,0.08)", border: "1px solid rgba(62,207,142,0.3)",
                                  color: "var(--hud-green)", borderRadius: 8 }}>
                      ⚡ {r.bestPlay.length > 96 ? r.bestPlay.slice(0, 96) + "…" : r.bestPlay}
                    </div>
                  )}

                  {/* expanded buckets */}
                  {isOpen && (
                    <div className="mt-3 grid gap-y-0.5" style={{ gridTemplateColumns: "1fr 64px 64px 64px" }}
                         onClick={(e) => e.stopPropagation()}>
                      <div className="text-[9px] tracking-widest" style={{ color: "var(--hud-muted)" }}>BUCKET</div>
                      <div className="text-[9px] tracking-widest text-right" style={{ color: "var(--hud-muted)" }}>MKT</div>
                      <div className="text-[9px] tracking-widest text-right" style={{ color: "var(--hud-muted)" }}>MODEL</div>
                      <div className="text-[9px] tracking-widest text-right" style={{ color: "var(--hud-muted)" }}>EDGE</div>
                      {r.buckets.map((b, i) => {
                        const dead = r.observedMax != null && b.high + 0.5 < r.observedMax - 1;
                        const hot = Math.abs(b.edge) > 0.08;
                        return (
                          <div key={i} className="contents">
                            <div className="text-[10px] py-0.5"
                                 style={{ color: dead ? "#3d4a66" : "var(--hud-text)",
                                          textDecoration: dead ? "line-through" : "none" }}>
                              {b.low <= -999 ? `≤${b.high}°` : b.high >= 999 ? `≥${b.low}°`
                               : b.low === b.high ? `${b.low}°` : `${b.low}-${b.high}°`}
                            </div>
                            <div className="text-[10px] text-right tabular-nums py-0.5" style={{ color: "var(--hud-muted)" }}>
                              {(b.marketYes * 100).toFixed(0)}¢
                            </div>
                            <div className="text-[10px] text-right tabular-nums py-0.5" style={{ color: "var(--hud-accent)" }}>
                              {(b.modelProb * 100).toFixed(0)}%
                            </div>
                            <div className="text-[10px] text-right tabular-nums py-0.5 font-bold"
                                 style={{ color: hot ? (b.edge > 0 ? "var(--hud-green)" : "var(--hud-red)") : "var(--hud-muted)" }}>
                              {b.edge > 0 ? "+" : ""}{(b.edge * 100).toFixed(0)}%
                            </div>
                          </div>
                        );
                      })}
                      <div className="col-span-4 text-[9px] mt-1" style={{ color: "var(--hud-muted)" }}>
                        {r.station} · σ={r.sigma}°
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && !loading && (
              <div className="col-span-full text-center py-16 text-sm" style={{ color: "var(--hud-muted)" }}>
                No cities match this filter right now.
              </div>
            )}
          </div>
        )}

        <p className="text-[10px] mt-5 pb-8" style={{ color: "var(--hud-muted)" }}>
          Click any city for its full bucket board. 📡 = resolution-station METAR data ·
          ⛅N = ensemble members · struck-through buckets are already impossible.
          Auto-Bot 2 trades these edges automatically — see the Bot 2 page.
        </p>
      </main>
    </div>
  );
}
