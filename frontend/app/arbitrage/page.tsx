"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

interface ArbPair {
  polyQuestion: string;
  polySlug: string;
  kalshiTitle: string;
  kalshiTicker: string;
  similarity: number;
  polyYesAsk: number;
  polyNoAsk: number;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  executable: boolean;
  basket: { cost: number; edge: number; legs: string } | null;
}

interface ArbResponse {
  generated: number;
  polyCount: number;
  kalshiCount: number;
  kalshiQuotes: boolean;
  pairs: ArbPair[];
}

export default function ArbitragePage() {
  const [data, setData] = useState<ArbResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/arb");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d: ArbResponse = await res.json();
      setData(d);
      setError(d.kalshiQuotes ? "" :
        `Kalshi lists ${d.kalshiCount} markets but strips bid/ask without API credentials — pairs below are CANDIDATES (no edge is computable). Add Kalshi keys in /settings to price them.`);
    } catch {
      setError("Failed to fetch /api/arb");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const pairs = data?.pairs ?? [];
  const actionable = pairs.filter((p) => p.executable && (p.basket?.edge ?? 0) > 0.01);

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.2em] glow-cyan">⇄ CROSS-VENUE ARBITRAGE</h1>
        <p className="text-xs mt-1 mb-6" style={{ color: "var(--hud-muted)" }}>
          Complete baskets priced at EXECUTABLE asks, net of both venues&apos; fee curves —
          a pair is an arb only if YES on one venue + NO on the other costs &lt; $1.
          Refreshes every 60s.
        </p>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: "POLYMARKET MARKETS", value: data?.polyCount ?? 0, color: "var(--hud-violet)" },
            { label: "KALSHI MARKETS", value: data?.kalshiCount ?? 0, color: "var(--hud-cyan)" },
            { label: "MATCHED PAIRS", value: pairs.length, color: "var(--hud-violet)" },
            { label: "TRUE ARBS (>1% NET)", value: actionable.length, color: actionable.length > 0 ? "var(--hud-green)" : "var(--hud-muted)" },
          ].map((c) => (
            <div key={c.label} className="hud-panel hud-panel-static px-4 py-3">
              <div className="text-[10px] tracking-widest" style={{ color: "var(--hud-muted)" }}>{c.label}</div>
              <div className="text-2xl font-bold tabular-nums mt-1" style={{ color: c.color }}>{c.value}</div>
            </div>
          ))}
        </div>

        {error && (
          <div className="rounded border px-4 py-3 mb-4 text-xs"
               style={{ borderColor: "#7c2d12", background: "#7c2d1222", color: "#fdba74" }}>
            ⚠ {error}
          </div>
        )}

        {loading ? (
          <div className="text-center py-20 text-sm" style={{ color: "var(--hud-muted)" }}>
            Scanning both venues…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {pairs.slice(0, 30).map((p, i) => {
              const edge = p.basket?.edge ?? null;
              const isArb = p.executable && edge !== null && edge > 0.01;
              return (
                <div key={i} className="hud-panel hud-panel-static p-4"
                     style={isArb ? {
                       borderColor: "rgba(52,211,153,0.5)",
                       boxShadow: "0 0 18px rgba(52,211,153,0.1)",
                     } : undefined}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate" style={{ color: "var(--hud-text)" }}>
                        <span style={{ color: "var(--hud-accent)" }}>POLY</span> {p.polyQuestion}
                      </div>
                      <div className="text-xs truncate mt-1" style={{ color: "var(--hud-muted)" }}>
                        <span style={{ color: "var(--hud-accent)" }}>KALSHI</span> {p.kalshiTitle}
                        <span className="ml-2 text-[10px]" style={{ color: "var(--hud-muted)" }}>
                          ({p.kalshiTicker} · sim {(p.similarity * 100).toFixed(0)}%)
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 flex-shrink-0 tabular-nums text-xs">
                      <div className="text-center">
                        <div style={{ color: "var(--hud-muted)" }} className="text-[10px]">POLY ASK Y/N</div>
                        <div className="font-bold" style={{ color: "var(--hud-accent)" }}>
                          {(p.polyYesAsk * 100).toFixed(0)}¢/{(p.polyNoAsk * 100).toFixed(0)}¢
                        </div>
                      </div>
                      <div className="text-center">
                        <div style={{ color: "var(--hud-muted)" }} className="text-[10px]">KALSHI ASK Y/N</div>
                        <div className="font-bold" style={{ color: "var(--hud-accent)" }}>
                          {p.kalshiYesAsk != null ? `${(p.kalshiYesAsk * 100).toFixed(0)}¢/${((p.kalshiNoAsk ?? 0) * 100).toFixed(0)}¢` : "—"}
                        </div>
                      </div>
                      <div className="text-center">
                        <div style={{ color: "var(--hud-muted)" }} className="text-[10px]">BASKET EDGE</div>
                        <div className="font-bold text-sm"
                             style={{ color: isArb ? "var(--hud-green)" : edge !== null && edge > 0 ? "var(--hud-amber)" : "var(--hud-muted)" }}>
                          {edge !== null ? `${(edge * 100).toFixed(2)}%` : "candidate"}
                        </div>
                      </div>
                    </div>
                  </div>
                  {isArb && p.basket && (
                    <div className="mt-2 text-[11px] font-bold" style={{ color: "var(--hud-green)" }}>
                      → {p.basket.legs} · total cost ${p.basket.cost.toFixed(3)} → locked ${(1 - p.basket.cost).toFixed(3)}/contract
                    </div>
                  )}
                </div>
              );
            })}
            {pairs.length === 0 && !error && (
              <div className="text-center py-16 text-sm" style={{ color: "var(--hud-muted)" }}>
                No cross-venue matches found right now. Both venues need overlapping events
                (elections, Fed rates, sports championships are the usual overlap).
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
