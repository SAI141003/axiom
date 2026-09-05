"use client";
import { useTradingStore } from "@/lib/store";
import { formatDistanceToNowStrict } from "date-fns";
import clsx from "clsx";

export default function PositionsPanel() {
  const positions = useTradingStore((s) => s.positions);
  const totalUnrealized = positions.reduce((s, p) => s + p.unrealized_pnl, 0);
  const totalExposure   = positions.reduce((s, p) => s + p.size * p.avg_price, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="panel-header">
        <span>POSITIONS ({positions.length})</span>
        <div className="flex items-center gap-3 text-2xs">
          <span className="text-txt-dim">EXP</span>
          <span className="text-neon-cyan num">${totalExposure.toFixed(2)}</span>
          <span className="text-txt-dim">UPNL</span>
          <span className={clsx("num", totalUnrealized >= 0 ? "text-neon-green" : "text-neon-red")}>
            {totalUnrealized >= 0 ? "+" : ""}${totalUnrealized.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Column headers */}
      <div className="grid px-2 py-1 text-2xs text-txt-muted border-b border-terminal-border uppercase tracking-wider"
        style={{ gridTemplateColumns: "1fr 38px 45px 45px 55px" }}>
        <span>MARKET</span>
        <span className="text-center">SIDE</span>
        <span className="text-right">AVG</span>
        <span className="text-right">CUR</span>
        <span className="text-right">UPNL</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {positions.length === 0 ? (
          <div className="text-txt-muted text-xs p-3 text-center">No open positions</div>
        ) : (
          positions.map((pos) => {
            const pnlPositive = pos.unrealized_pnl >= 0;
            const pnlPct = pos.avg_price > 0
              ? ((pos.current_price - pos.avg_price) / pos.avg_price * 100)
              : 0;
            return (
              <div
                key={pos.market_id}
                className="grid px-2 py-1.5 border-b border-terminal-border/50 text-xs hover:bg-terminal-hover transition-colors"
                style={{ gridTemplateColumns: "1fr 38px 45px 45px 55px" }}
              >
                {/* Market */}
                <div className="min-w-0 pr-1">
                  <p className="text-txt-primary truncate text-2xs">
                    {pos.market_question.slice(0, 40)}
                  </p>
                  <p className="text-txt-muted text-2xs num">
                    ${(pos.size * pos.avg_price).toFixed(2)} — {formatDistanceToNowStrict(pos.opened_at)}
                  </p>
                </div>

                {/* Side */}
                <div className="flex items-center justify-center">
                  <span className={clsx(
                    "text-2xs font-bold px-1 border",
                    pos.side === "YES"
                      ? "text-neon-green border-neon-green/40"
                      : "text-neon-red border-neon-red/40"
                  )}>
                    {pos.side}
                  </span>
                </div>

                {/* Avg price */}
                <span className="text-txt-primary num text-right self-center">
                  {(pos.avg_price * 100).toFixed(1)}¢
                </span>

                {/* Current price */}
                <span className={clsx(
                  "num text-right self-center",
                  pos.current_price > pos.avg_price ? "text-neon-green" : "text-neon-red"
                )}>
                  {(pos.current_price * 100).toFixed(1)}¢
                </span>

                {/* Unrealized PnL */}
                <div className="flex flex-col items-end justify-center">
                  <span className={clsx("num font-semibold text-xs", pnlPositive ? "text-neon-green" : "text-neon-red")}>
                    {pnlPositive ? "+" : ""}${pos.unrealized_pnl.toFixed(2)}
                  </span>
                  <span className={clsx("text-2xs num", pnlPositive ? "text-neon-green/70" : "text-neon-red/70")}>
                    {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
