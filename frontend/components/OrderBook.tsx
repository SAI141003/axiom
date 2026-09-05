"use client";
import { useMemo } from "react";
import { useTradingStore } from "@/lib/store";
import type { OrderBookLevel } from "@/lib/types";
import clsx from "clsx";

export default function OrderBook() {
  const { orderbook, selectedMarket } = useTradingStore((s) => ({
    orderbook:      s.orderbook,
    selectedMarket: s.selectedMarket,
  }));

  const maxTotal = useMemo(() => {
    if (!orderbook) return 1;
    const allTotals = [...orderbook.asks, ...orderbook.bids].map((l) => l.total);
    return Math.max(...allTotals, 1);
  }, [orderbook]);

  if (!orderbook) {
    return (
      <div className="flex flex-col h-full">
        <div className="panel-header"><span>ORDER BOOK</span></div>
        <div className="flex-1 flex items-center justify-center text-txt-muted text-xs">
          No market selected
        </div>
      </div>
    );
  }

  const asks = [...orderbook.asks].sort((a, b) => b.price - a.price).slice(0, 8);
  const bids = orderbook.bids.slice(0, 8);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="panel-header">
        <span>ORDER BOOK</span>
        <div className="flex items-center gap-3 text-2xs">
          <span className="text-txt-dim">SPREAD</span>
          <span className="text-neon-yellow num">{(orderbook.spread * 100).toFixed(2)}¢</span>
          <span className="text-txt-dim">MID</span>
          <span className="text-neon-cyan num">{(orderbook.mid_price * 100).toFixed(2)}¢</span>
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-3 px-2 py-1 text-2xs text-txt-muted border-b border-terminal-border uppercase tracking-wider">
        <span>PRICE</span>
        <span className="text-center">SIZE ($)</span>
        <span className="text-right">TOTAL</span>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Asks (sell side) — red */}
        <div className="flex-1 overflow-y-auto flex flex-col-reverse">
          {asks.map((level, i) => (
            <OrderBookRow
              key={`ask-${i}`}
              level={level}
              side="ask"
              maxTotal={maxTotal}
            />
          ))}
        </div>

        {/* Mid price row */}
        <div className="px-2 py-1.5 border-y border-terminal-border bg-terminal-header flex items-center justify-between">
          <span className="text-2xs text-txt-muted">LAST</span>
          <span className="text-neon-cyan font-bold num">{(orderbook.mid_price * 100).toFixed(3)}¢</span>
          <span className={clsx("text-2xs num", orderbook.mid_price >= 0.5 ? "text-neon-green" : "text-neon-red")}>
            {(orderbook.mid_price * 100).toFixed(1)}% PROB
          </span>
        </div>

        {/* Bids (buy side) — green */}
        <div className="flex-1 overflow-y-auto">
          {bids.map((level, i) => (
            <OrderBookRow
              key={`bid-${i}`}
              level={level}
              side="bid"
              maxTotal={maxTotal}
            />
          ))}
        </div>
      </div>

      {/* Depth indicator */}
      <DepthBar
        bidTotal={bids.reduce((s, b) => s + b.size, 0)}
        askTotal={asks.reduce((s, a) => s + a.size, 0)}
      />
    </div>
  );
}

function OrderBookRow({ level, side, maxTotal }: {
  level: OrderBookLevel;
  side: "bid" | "ask";
  maxTotal: number;
}) {
  const pct = (level.total / maxTotal) * 100;
  const isAsk = side === "ask";

  return (
    <div className="relative grid grid-cols-3 px-2 py-0.5 text-xs cursor-pointer hover:bg-terminal-hover transition-colors group">
      {/* Depth fill */}
      <div
        className={clsx("absolute inset-y-0 right-0 opacity-20 transition-all", isAsk ? "bg-neon-red" : "bg-neon-green")}
        style={{ width: `${pct}%` }}
      />

      <span className={clsx("num font-medium relative z-10", isAsk ? "text-neon-red" : "text-neon-green")}>
        {(level.price * 100).toFixed(3)}¢
      </span>
      <span className="text-txt-primary num text-center relative z-10 group-hover:text-neon-cyan transition-colors">
        ${level.size.toFixed(0)}
      </span>
      <span className="text-txt-dim num text-right relative z-10 text-2xs">
        ${level.total.toFixed(0)}
      </span>
    </div>
  );
}

function DepthBar({ bidTotal, askTotal }: { bidTotal: number; askTotal: number }) {
  const total = bidTotal + askTotal;
  const bidPct = total > 0 ? (bidTotal / total) * 100 : 50;

  return (
    <div className="px-2 py-1.5 border-t border-terminal-border">
      <div className="flex items-center gap-2 text-2xs mb-1">
        <span className="text-neon-green num">{bidPct.toFixed(1)}% BID</span>
        <span className="text-txt-muted ml-auto">{(100 - bidPct).toFixed(1)}% ASK</span>
        <span className="text-neon-red num"></span>
      </div>
      <div className="flex h-1.5 rounded overflow-hidden">
        <div className="bg-neon-green/70 transition-all" style={{ width: `${bidPct}%` }} />
        <div className="bg-neon-red/70 flex-1" />
      </div>
    </div>
  );
}
