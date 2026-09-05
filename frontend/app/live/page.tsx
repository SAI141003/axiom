"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

interface GammaMarket {
  question: string;
  category?: string;
  outcomePrices?: string;   // JSON string like '["0.62","0.38"]'
  volume?: string | number;
  volume24hr?: string | number;
  endDate?: string;
  slug?: string;
  liquidity?: string | number;
  noQuotes?: boolean;       // Kalshi unauthenticated: listings without prices
}

const CATEGORIES = ["all", "crypto", "politics", "sports", "science", "other"] as const;

function parsePrice(m: GammaMarket): number {
  try {
    const prices = JSON.parse(m.outcomePrices ?? "[]");
    return parseFloat(prices[0]) || 0.5;
  } catch {
    return 0.5;
  }
}

export default function LiveMarketsPage() {
  const [markets, setMarkets] = useState<GammaMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<string>("all");
  const [venue, setVenue] = useState<"polymarket" | "kalshi">("polymarket");
  const [search, setSearch] = useState("");
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const load = async (v = venue) => {
    try {
      if (v === "polymarket") {
        const res = await fetch("/api/markets?limit=100");
        if (res.ok) setMarkets(await res.json());
      } else {
        const res = await fetch("/api/kalshi?limit=1000");
        if (res.ok) {
          const data = await res.json();
          const rows = Array.isArray(data) ? data : data.markets ?? [];
          setMarkets(rows.map((k: any) => ({
            question: k.title,
            category: k.category || "other",
            outcomePrices: k.yes_price != null
              ? JSON.stringify([String(k.yes_price), String(1 - k.yes_price)])
              : undefined,
            volume: k.volume,
            endDate: k.close_time,
            slug: k.ticker,
            noQuotes: k.yes_price == null,
          })));
        }
      }
      setLastUpdate(new Date());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load(venue);
    const t = setInterval(() => load(venue), 30_000);
    return () => clearInterval(t);
  }, [venue]);   // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = markets.filter((m) => {
    if (category !== "all" && !(m.category ?? "other").toLowerCase().includes(category)) return false;
    if (search && !m.question?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold tracking-[0.2em] glow-green">◉ LIVE MARKETS</h1>
            <p className="text-xs mt-1" style={{ color: "var(--hud-muted)" }}>
              Top markets by volume · auto-refreshes every 30s
              {lastUpdate && ` · updated ${lastUpdate.toLocaleTimeString()}`}
            </p>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="⌕ Search markets…"
            className="px-3 py-2 text-xs w-64 outline-none hud-chip"
            style={{ color: "var(--hud-text)", clipPath: "none", height: 34 }}
          />
        </div>

        {/* Venue toggle */}
        <div className="flex gap-2 mb-3">
          {(["polymarket", "kalshi"] as const).map((v) => (
            <button key={v} onClick={() => setVenue(v)}
                    className={`hud-chip uppercase transition-all ${venue === v ? "hud-nav-active" : ""}`}
                    style={{ color: venue === v ? undefined : "var(--hud-muted)", cursor: "pointer" }}>
              {v === "polymarket" ? "◆ POLYMARKET" : "◇ KALSHI"}
            </button>
          ))}
        </div>

        {venue === "kalshi" && markets.length > 0 && markets.every((m) => m.noQuotes) && (
          <div className="hud-panel hud-panel-static px-4 py-2 mb-3 text-[11px]" style={{ color: "var(--hud-amber)" }}>
            ⚠ Kalshi strips live quotes for unauthenticated API access — listings shown without prices.
            Add Kalshi API credentials to the backend to enable quotes and cross-venue matching.
          </div>
        )}

        {/* Category filter */}
        <div className="flex gap-2 mb-4">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`hud-chip capitalize transition-all ${category === c ? "hud-nav-active" : ""}`}
              style={{ color: category === c ? undefined : "var(--hud-muted)", cursor: "pointer" }}
            >
              {c}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center py-20 text-sm" style={{ color: "var(--hud-muted)" }}>
            Loading live markets…
          </div>
        ) : (
          <div className="hud-panel hud-panel-static overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: "var(--hud-panel)", color: "var(--hud-muted)" }}>
                  <th className="text-left px-4 py-3 font-medium">Market</th>
                  <th className="text-right px-4 py-3 font-medium w-24">YES</th>
                  <th className="text-right px-4 py-3 font-medium w-24">NO</th>
                  <th className="text-right px-4 py-3 font-medium w-32">Volume</th>
                  <th className="text-right px-4 py-3 font-medium w-28">Ends</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m, i) => {
                  const yes = parsePrice(m);
                  const vol = parseFloat(String(m.volume ?? 0));
                  return (
                    <tr key={m.slug ?? i} className="hud-row">
                      <td className="px-4 py-3 max-w-md">
                        <span className="block truncate">{m.question}</span>
                        {m.category && (
                          <span className="text-[10px]" style={{ color: "var(--hud-muted)" }}>{m.category}</span>
                        )}
                      </td>
                      <td className="text-right px-4 py-3 tabular-nums font-bold" style={{ color: m.noQuotes ? "var(--hud-muted)" : "var(--hud-green)" }}>
                        {m.noQuotes ? "—" : `${(yes * 100).toFixed(1)}¢`}
                      </td>
                      <td className="text-right px-4 py-3 tabular-nums font-bold" style={{ color: m.noQuotes ? "var(--hud-muted)" : "var(--hud-red)" }}>
                        {m.noQuotes ? "—" : `${((1 - yes) * 100).toFixed(1)}¢`}
                      </td>
                      <td className="text-right px-4 py-3 tabular-nums" style={{ color: "var(--hud-muted)" }}>
                        ${vol >= 1e6 ? `${(vol / 1e6).toFixed(1)}M` : `${(vol / 1e3).toFixed(0)}K`}
                      </td>
                      <td className="text-right px-4 py-3" style={{ color: "var(--hud-muted)" }}>
                        {m.endDate ? new Date(m.endDate).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center py-10" style={{ color: "var(--hud-muted)" }}>
                      No markets match your filter
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
