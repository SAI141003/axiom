"use client";

import { useEffect, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import TopNav from "@/components/TopNav";
import EngineBanner from "@/components/EngineBanner";
import { useToggle } from "@/lib/toggles";

interface WTrade {
  tid: string; slug: string; city: string; q: string; side: "YES" | "NO";
  entry: number; model: number; market: number; edge: number; stake: number;
  obs_source: string; prob_source: string; hours_elapsed: number; ts: number;
  status: "open" | "won" | "lost"; pnl: number | null;
}
interface Stats { placed: number; open: number; resolved: number; wins: number; winRate: number; totalPnl: number }

export default function WeatherBotPage() {
  const [trades, setTrades] = useState<WTrade[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [curve, setCurve] = useState<{ ts: number; pnl: number }[]>([]);
  const [updated, setUpdated] = useState<Date | null>(null);
  const autoRefresh = useToggle("weatherbot.autoRefresh");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/weather-trades");
        if (!res.ok) return;
        const d = await res.json();
        setTrades(d.trades ?? []);
        setStats(d.stats ?? null);
        setCurve(d.curve ?? []);
        setUpdated(new Date());
      } catch {}
    };
    load();
    const id = setInterval(() => { if (autoRefresh) load(); }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh]);

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <EngineBanner engine="weather (late-day)" />
        <WeatherPicks />
        <h1 className="text-xl font-bold tracking-[0.2em]">AUTO-BOT 2 · WEATHER</h1>
        <p className="text-xs mt-1 mb-6" style={{ color: "var(--hud-muted)" }}>
          Trades server-side 24/7 — no browser needed. One $10 paper trade per flagged edge at the
          real market price (station METAR + 82-member ensemble model). Resolves on official
          Wunderground station data. {updated && `Updated ${updated.toLocaleTimeString()}.`}
        </p>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
            {[
              { l: "TOTAL P&L", v: `${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl}`,
                c: stats.totalPnl >= 0 ? "var(--hud-green)" : "var(--hud-red)" },
              { l: "PLACED", v: String(stats.placed), c: "var(--hud-accent)" },
              { l: "OPEN", v: String(stats.open), c: "var(--hud-amber)" },
              { l: "RESOLVED", v: String(stats.resolved), c: "var(--hud-muted)" },
              { l: "WINS", v: String(stats.wins), c: "var(--hud-green)" },
              { l: "WIN RATE", v: `${(stats.winRate * 100).toFixed(0)}%`,
                c: stats.winRate >= 0.4 ? "var(--hud-green)" : "var(--hud-amber)" },
            ].map((s) => (
              <div key={s.l} className="hud-panel hud-panel-static px-4 py-3">
                <div className="text-[9px] tracking-[0.16em]" style={{ color: "var(--hud-muted)" }}>{s.l}</div>
                <div className="text-lg font-bold tabular-nums mt-0.5" style={{ color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>
        )}

        {/* Equity curve */}
        <div className="hud-panel hud-panel-static p-4 mb-6">
          <div className="text-[10px] tracking-[0.18em] mb-2" style={{ color: "var(--hud-muted)" }}>
            EQUITY CURVE (RESOLVED TRADES)
          </div>
          {curve.length > 0 ? (
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={curve}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--hud-border)" />
                <XAxis dataKey="ts" tickFormatter={(v) => new Date(v * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}
                       tick={{ fill: "#8b93a7", fontSize: 9 }} />
                <YAxis tick={{ fill: "#8b93a7", fontSize: 9 }} />
                <Tooltip contentStyle={{ background: "#12151c", border: "1px solid #232936", fontSize: 11 }}
                         labelFormatter={(v) => new Date((v as number) * 1000).toLocaleString()} />
                <ReferenceLine y={0} stroke="#8b93a7" strokeDasharray="4 2" />
                <Area type="monotone" dataKey="pnl" stroke="#3ecf8e" fill="#3ecf8e22" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-xs py-8 text-center" style={{ color: "var(--hud-muted)" }}>
              No resolved trades yet — weather markets settle the next local day.
            </div>
          )}
        </div>

        {/* Trades table */}
        <div className="hud-panel hud-panel-static overflow-x-auto">
          <table className="w-full text-[11px] tabular-nums">
            <thead>
              <tr style={{ background: "var(--hud-panel)", color: "var(--hud-muted)" }}>
                <th className="text-left px-3 py-2">PLACED</th>
                <th className="text-left px-3 py-2">CITY</th>
                <th className="text-left px-3 py-2">BUCKET</th>
                <th className="text-left px-3 py-2">SIDE</th>
                <th className="text-right px-3 py-2">ENTRY</th>
                <th className="text-right px-3 py-2">MODEL</th>
                <th className="text-right px-3 py-2">GAP</th>
                <th className="text-left px-3 py-2">DATA</th>
                <th className="text-left px-3 py-2">STATUS</th>
                <th className="text-right px-3 py-2">P&L</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.tid} className="hud-row">
                  <td className="px-3 py-1.5" style={{ color: "var(--hud-muted)" }}>
                    {new Date(t.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="px-3 py-1.5 font-bold capitalize">{t.city}</td>
                  <td className="px-3 py-1.5 max-w-56 truncate" style={{ color: "var(--hud-muted)" }}>
                    {t.q?.replace("Will the highest temperature in ", "").slice(0, 42)}
                  </td>
                  <td className="px-3 py-1.5 font-bold"
                      style={{ color: t.side === "YES" ? "var(--hud-green)" : "var(--hud-red)" }}>{t.side}</td>
                  <td className="text-right px-3 py-1.5">{(t.entry * 100).toFixed(1)}¢</td>
                  <td className="text-right px-3 py-1.5" style={{ color: "var(--hud-accent)" }}>
                    {(t.model * 100).toFixed(0)}%
                  </td>
                  <td className="text-right px-3 py-1.5 font-bold"
                      style={{ color: "var(--hud-amber)" }}>{(t.edge * 100).toFixed(0)}%</td>
                  <td className="px-3 py-1.5 text-[9px]" style={{ color: t.obs_source === "metar" ? "var(--hud-green)" : "var(--hud-muted)" }}>
                    {t.obs_source === "metar" ? "📡 STATION" : "grid"}
                  </td>
                  <td className="px-3 py-1.5">
                    {t.status === "open" && <span style={{ color: "var(--hud-amber)" }}>OPEN</span>}
                    {t.status === "won" && <span style={{ color: "var(--hud-green)" }}>WON</span>}
                    {t.status === "lost" && <span style={{ color: "var(--hud-red)" }}>LOST</span>}
                  </td>
                  <td className="text-right px-3 py-1.5 font-bold"
                      style={{ color: (t.pnl ?? 0) >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                    {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "—"}
                  </td>
                </tr>
              ))}
              {trades.length === 0 && (
                <tr><td colSpan={10} className="text-center py-10" style={{ color: "var(--hud-muted)" }}>
                  No trades yet — the daemon places one per flagged edge each 30-min scan.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[10px] mt-4 pb-8" style={{ color: "var(--hud-muted)" }}>
          Architecture note: unlike Auto-Bot 1 (crypto, trades while its page is open), this bot lives in
          the weather daemon — launchd-managed, survives reboots, trades whether or not you&apos;re watching.
          GAP column = model-minus-market disagreement at entry; the win rate on these measures whether
          our station-grade model truly beats the market.
        </p>
      </main>
    </div>
  );
}

// ── LIVE PICKS: the exact markets the bot's edge flags, with full names ───────
function WeatherPicks() {
  const [d, setD] = useState<any>(null);
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/weather/picks").then((r) => r.json()).then(setD).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);
  const picks: any[] = d?.picks ?? [];

  const copy = (p: any, i: number, ev: React.MouseEvent) => {
    ev.preventDefault(); ev.stopPropagation();       // don't follow the row link
    const text = `${p.question}\nBUY ${p.side} · bucket ${p.bucket} · pay ~${p.entry} · edge ${p.edge >= 0 ? "+" : ""}${p.edge}\n${p.url}`;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(i);
      setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500);
    }).catch(() => {});
  };
  return (
    <div className="hud-panel hud-panel-static p-4 mb-4"
         style={{ borderColor: "rgba(52,211,153,0.45)" }}>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] tracking-widest font-bold" style={{ color: "var(--hud-green)" }}>
          🎯 LIVE PICKS — BUY THESE EXACTLY
        </div>
        <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>
          gate entry≥{d?.gate?.min ?? "…"} · edge≤{d?.gate?.max ?? "…"} · refreshes 60s
        </div>
      </div>
      <div className="text-[9px] mb-3" style={{ color: "var(--hud-muted)" }}>
        The exact Polymarket markets the bot's edge flags right now — full name, side, and price.
        Review before acting; venue access is your call.
      </div>
      {picks.length === 0 && (
        <div className="text-[11px] py-3 text-center" style={{ color: "var(--hud-muted)" }}>
          no qualifying picks in the last 48h — the bot only flags strong late-day favorites
        </div>
      )}
      <div className="flex flex-col gap-2">
        {picks.map((p, i) => (
          <a key={i} href={p.url} target="_blank" rel="noreferrer"
             className="block px-3 py-2 rounded border hover:opacity-90 transition-opacity"
             style={{ borderColor: "var(--hud-border)", background: "rgba(10,14,23,0.5)" }}>
            <div className="flex items-start justify-between gap-3">
              <div className="text-[12px]" style={{ color: "var(--hud-text)" }}>{p.question}</div>
              <div className="text-[10px] whitespace-nowrap" style={{ color: "var(--hud-muted)" }}>{p.hoursAgo}h ago ↗</div>
            </div>
            <div className="flex items-center gap-3 mt-1 text-[11px] tabular-nums flex-wrap">
              <span className="font-bold px-2 py-0.5 rounded"
                    style={{ color: "#0a0e17", background: p.side === "YES" ? "var(--hud-green)" : "var(--hud-amber)" }}>
                BUY {p.side}
              </span>
              <span style={{ color: "var(--hud-text)" }}>bucket {p.bucket}</span>
              <span style={{ color: "var(--hud-cyan)" }}>pay ~{p.entry}</span>
              <span style={{ color: "var(--hud-muted)" }}>edge {p.edge >= 0 ? "+" : ""}{p.edge}</span>
              <span style={{ color: "var(--hud-muted)" }}>· {p.city}</span>
              <button onClick={(ev) => copy(p, i, ev)}
                      className="ml-auto text-[10px] px-2 py-0.5 rounded border hover:opacity-80"
                      style={{ borderColor: copied === i ? "var(--hud-green)" : "var(--hud-border)",
                               color: copied === i ? "var(--hud-green)" : "var(--hud-muted)" }}>
                {copied === i ? "✓ copied" : "⧉ copy"}
              </button>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
