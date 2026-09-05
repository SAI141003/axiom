"use client";

import { useEffect, useState } from "react";

/**
 * LIVE ENGINE BANNER — the CURRENT-CONFIG record for a bot page, straight
 * from .data/engine_status.json (computed fee-true by the brain, refreshed
 * hourly + on every brain run). No dead data: polls every 30s.
 */
export default function EngineBanner({ engine }: { engine: string }) {
  const [e, setE] = useState<any>(null);

  useEffect(() => {
    const load = () => fetch("/api/journal")
      .then((r) => r.json())
      .then((d) => setE(d?.engines?.[engine] ?? null))
      .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [engine]);

  if (!e) return null;
  const good = e.win_rate >= 0.6;
  const today = e.today ?? { trades: 0, wins: 0, pnl: 0 };
  const daily: any[] = e.daily ?? [];
  const maxAbs = Math.max(1, ...daily.map((d) => Math.abs(d.pnl)));
  return (
    <div className="hud-panel hud-panel-static px-4 py-3 mb-4 font-mono"
         style={{ borderColor: good ? "rgba(52,211,153,0.45)" : "var(--hud-border)" }}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] tracking-widest font-bold" style={{ color: "var(--hud-cyan)" }}>
            ⚡ LIVE ENGINE — {engine.toUpperCase()}
          </div>
          <div className="text-[9px] mt-0.5" style={{ color: "var(--hud-muted)" }}>{e.config}</div>
        </div>
        <div className="flex items-center gap-5 tabular-nums">
          <div className="text-right">
            <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>WIN RATE</div>
            <div className="text-2xl font-bold" style={{ color: good ? "var(--hud-green)" : "var(--hud-amber)" }}>
              {(e.win_rate * 100).toFixed(0)}%
            </div>
          </div>
          <div className="text-right">
            <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>RECORD</div>
            <div className="text-sm font-bold" style={{ color: "var(--hud-text)" }}>{e.wins}/{e.trades}</div>
          </div>
          <div className="text-right">
            <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>TODAY</div>
            <div className="text-sm font-bold" style={{ color: today.pnl >= 0 ? "var(--hud-green)" : "#f87171" }}>
              {today.wins}/{today.trades} · {today.pnl >= 0 ? "+" : ""}${today.pnl}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>TOTAL (fee-true)</div>
            <div className="text-sm font-bold" style={{ color: e.pnl >= 0 ? "var(--hud-green)" : "#f87171" }}>
              {e.pnl >= 0 ? "+" : ""}${e.pnl}
            </div>
          </div>
        </div>
      </div>
      {daily.length > 0 && (
        <div className="flex items-end gap-2 mt-2 pt-2 border-t" style={{ borderColor: "rgba(35,40,56,0.6)" }}>
          {daily.map((d) => (
            <div key={d.day} className="flex flex-col items-center" title={`${d.day}: ${d.wins}/${d.trades} · $${d.pnl}`}>
              <div className="w-7 flex flex-col justify-end" style={{ height: 26 }}>
                <div className="rounded-sm" style={{
                  height: Math.max(3, (Math.abs(d.pnl) / maxAbs) * 24),
                  background: d.pnl >= 0 ? "rgba(52,211,153,0.75)" : "rgba(248,113,113,0.75)",
                }} />
              </div>
              <div className="text-[8px] tabular-nums" style={{ color: d.pnl >= 0 ? "var(--hud-green)" : "#f87171" }}>
                {d.pnl >= 0 ? "+" : ""}{Math.round(d.pnl)}
              </div>
              <div className="text-[7px]" style={{ color: "var(--hud-muted)" }}>
                {d.day.slice(5)} · {d.wins}/{d.trades}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
