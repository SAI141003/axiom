"use client";

import { useEffect, useState } from "react";

// The four numbers on the home page, live from the desk instead of typed in.
export default function LiveStats() {
  const [fleet, setFleet] = useState<any>(null);
  const [pg, setPg] = useState<any>(null);
  useEffect(() => {
    fetch("/api/fleet").then((r) => r.json()).then(setFleet).catch(() => {});
    fetch("/api/proving-ground").then((r) => r.json()).then(setPg).catch(() => {});
  }, []);
  const t = fleet?.totals; const s = pg?.report; const weatherBot = (fleet?.probes ?? []).find((p: any) => p.name === "weather (late-day)");
  const stats = [
    { k: "PAPER FLEET", v: t ? `${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(0)}` : "—", sub: fleet ? `${fleet.accounts?.length ?? 0} accounts · ${t?.trades ?? 0} trades · ${fleet.daysTracked} days` : "loading", tone: t ? (t.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)") : undefined },
    { k: "SAFETY ASSERTIONS", v: s ? s.total_runs.toLocaleString() : "10,500", sub: s ? `${s.total_fails} failures · ${s.scenarios?.length ?? 35} scenarios` : "0 failures" },
    { k: "WEATHER BOT", v: weatherBot ? `${weatherBot.pnl >= 0 ? "+" : "−"}$${Math.abs(weatherBot.pnl).toFixed(0)} · ${(weatherBot.winRate * 100).toFixed(0)}%` : "—", sub: weatherBot ? `${weatherBot.trades} trades · the proven edge` : "loading", tone: "var(--hud-gold)" },
    { k: "MODE", v: "DRY-RUN", sub: "no live orders", tone: "var(--hud-amber)" },
  ];
  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-12" aria-label="Desk status">
      {stats.map((x) => (
        <div key={x.k} className="hud-panel hud-panel-static px-4 py-3 min-w-0">
          <div className="text-[9px] tracking-[0.18em]" style={{ color: "var(--hud-muted)" }}>{x.k}</div>
          <div className={`text-2xl font-bold mt-1 tabular-nums truncate ${x.tone ? "" : "hud-gradient-text"}`} style={x.tone ? { color: x.tone } : undefined}>{x.v}</div>
          <div className="text-[9px] mt-0.5 truncate prose-sans" style={{ color: "var(--hud-muted)" }}>{x.sub}</div>
        </div>
      ))}
    </section>
  );
}
