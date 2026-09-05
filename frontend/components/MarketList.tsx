"use client";
import { useState, useMemo } from "react";
import { Star, Search, TrendingUp, TrendingDown } from "lucide-react";
import { useTradingStore } from "@/lib/store";
import type { Market } from "@/lib/types";
import clsx from "clsx";

const CATEGORY_COLORS: Record<string, string> = {
  crypto:     "text-neon-yellow  border-neon-yellow/40",
  ai:         "text-neon-cyan    border-neon-cyan/40",
  politics:   "text-neon-purple  border-neon-purple/40",
  science:    "text-neon-green   border-neon-green/40",
  technology: "text-neon-orange  border-neon-orange/40",
  other:      "text-txt-dim      border-txt-muted/40",
};

const TABS = ["ALL", "WATCHLIST", "CRYPTO", "AI", "POLITICS"] as const;
type Tab = typeof TABS[number];

export default function MarketList() {
  const { markets, selectedMarket, watchlist, selectMarket, toggleWatchlist } = useTradingStore((s) => ({
    markets:       s.markets,
    selectedMarket: s.selectedMarket,
    watchlist:     s.watchlist,
    selectMarket:  s.selectMarket,
    toggleWatchlist: s.toggleWatchlist,
  }));

  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("ALL");

  const filtered = useMemo(() => {
    let list = markets;
    if (tab === "WATCHLIST") list = list.filter((m) => watchlist.has(m.condition_id));
    else if (tab === "CRYPTO")   list = list.filter((m) => m.category === "crypto");
    else if (tab === "AI")       list = list.filter((m) => m.category === "ai");
    else if (tab === "POLITICS") list = list.filter((m) => m.category === "politics");
    if (search) list = list.filter((m) => m.question.toLowerCase().includes(search.toLowerCase()));
    return list;
  }, [markets, tab, search, watchlist]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="panel-header">
        <span>MARKETS</span>
        <span className="text-neon-cyan num">{markets.length}</span>
      </div>

      {/* Search */}
      <div className="relative border-b border-terminal-border px-2 py-1.5">
        <Search size={10} className="absolute left-4 top-1/2 -translate-y-1/2 text-txt-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search markets..."
          className="w-full bg-transparent pl-6 pr-2 py-0.5 text-xs text-txt-primary placeholder-txt-muted outline-none border border-transparent focus:border-neon-cyan/30 rounded"
        />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-terminal-border overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              "px-2.5 py-1.5 text-2xs uppercase tracking-wider whitespace-nowrap transition-colors",
              tab === t
                ? "text-neon-cyan border-b border-neon-cyan bg-neon-cyan/5"
                : "text-txt-muted hover:text-txt-dim"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Market list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="text-txt-muted text-xs p-4 text-center">No markets</div>
        ) : (
          filtered.map((market) => (
            <MarketRow
              key={market.condition_id}
              market={market}
              isSelected={selectedMarket?.condition_id === market.condition_id}
              isWatched={watchlist.has(market.condition_id)}
              onSelect={() => selectMarket(market)}
              onToggleWatch={(e) => { e.stopPropagation(); toggleWatchlist(market.condition_id); }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function MarketRow({
  market, isSelected, isWatched, onSelect, onToggleWatch,
}: {
  market: Market;
  isSelected: boolean;
  isWatched: boolean;
  onSelect: () => void;
  onToggleWatch: (e: React.MouseEvent) => void;
}) {
  const catColor = CATEGORY_COLORS[market.category] ?? CATEGORY_COLORS.other;

  return (
    <div
      onClick={onSelect}
      className={clsx(
        "px-2 py-2 cursor-pointer border-b border-terminal-border/50 transition-colors",
        isSelected
          ? "bg-neon-cyan/5 border-l-2 border-l-neon-cyan"
          : "hover:bg-terminal-hover border-l-2 border-l-transparent"
      )}
    >
      {/* Top row: category + watchlist */}
      <div className="flex items-center justify-between mb-1">
        <span className={clsx("text-2xs px-1 py-0.5 border rounded-sm uppercase tracking-wider", catColor)}>
          {market.category}
        </span>
        <button onClick={onToggleWatch} className="text-txt-muted hover:text-neon-yellow transition-colors">
          <Star size={10} fill={isWatched ? "currentColor" : "none"} className={isWatched ? "text-neon-yellow" : ""} />
        </button>
      </div>

      {/* Question */}
      <p className="text-xs text-txt-primary leading-tight mb-1.5 line-clamp-2">
        {market.question}
      </p>

      {/* Prices + volume */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-neon-green num font-semibold">{(market.yes_price * 100).toFixed(1)}¢</span>
          <span className="text-txt-muted text-2xs">YES</span>
          <span className="text-neon-red num">{(market.no_price * 100).toFixed(1)}¢</span>
          <span className="text-txt-muted text-2xs">NO</span>
        </div>
        {market.change_24h !== undefined && (
          <div className={clsx("flex items-center gap-0.5 text-2xs", market.change_24h >= 0 ? "text-neon-green" : "text-neon-red")}>
            {market.change_24h >= 0 ? <TrendingUp size={8} /> : <TrendingDown size={8} />}
            <span className="num">{(market.change_24h * 100).toFixed(1)}%</span>
          </div>
        )}
      </div>

      {/* Volume */}
      <div className="text-2xs text-txt-muted mt-0.5 num">
        VOL ${(market.volume / 1000).toFixed(0)}K
        {market.linked_asset && <span className="ml-2 text-neon-orange">[{market.linked_asset}]</span>}
      </div>
    </div>
  );
}
