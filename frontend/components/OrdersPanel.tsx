"use client";
import { useTradingStore } from "@/lib/store";
import { formatDistanceToNowStrict } from "date-fns";
import type { OrderStatus } from "@/lib/types";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";

const STATUS_STYLE: Record<OrderStatus, string> = {
  FILLED:    "text-neon-green  border-neon-green/40  bg-neon-green/5",
  SUBMITTED: "text-neon-cyan   border-neon-cyan/40   bg-neon-cyan/5",
  PENDING:   "text-neon-yellow border-neon-yellow/40 bg-neon-yellow/5",
  DRY_RUN:   "text-txt-muted   border-txt-muted/40",
  REJECTED:  "text-neon-red    border-neon-red/40    bg-neon-red/5",
  CANCELLED: "text-txt-dim     border-txt-muted/30",
  STALE:     "text-neon-orange border-neon-orange/40",
  ERROR:     "text-neon-red    border-neon-red/60    bg-neon-red/10",
};

export default function OrdersPanel() {
  const orders = useTradingStore((s) => s.orders);

  const filled    = orders.filter((o) => o.status === "FILLED").length;
  const submitted = orders.filter((o) => o.status === "SUBMITTED").length;
  const rejected  = orders.filter((o) => ["REJECTED", "ERROR"].includes(o.status)).length;

  return (
    <div className="flex flex-col h-full">
      <div className="panel-header">
        <span>ORDERS</span>
        <div className="flex items-center gap-3 text-2xs">
          <span className="text-neon-green num">{filled} FILL</span>
          <span className="text-neon-cyan num">{submitted} LIVE</span>
          <span className="text-neon-red num">{rejected} REJ</span>
        </div>
      </div>

      {/* Column headers */}
      <div className="grid px-2 py-1 text-2xs text-txt-muted border-b border-terminal-border uppercase tracking-wider"
        style={{ gridTemplateColumns: "1fr 38px 45px 60px" }}>
        <span>MARKET</span>
        <span className="text-center">SIDE</span>
        <span className="text-right">PRICE</span>
        <span className="text-right">STATUS</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <AnimatePresence initial={false}>
          {orders.map((order) => (
            <motion.div
              key={order.order_id}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="grid px-2 py-1.5 border-b border-terminal-border/50 text-xs hover:bg-terminal-hover transition-colors"
                style={{ gridTemplateColumns: "1fr 38px 45px 60px" }}>

                {/* Market */}
                <div className="min-w-0 pr-1">
                  <p className="text-txt-primary truncate text-2xs">
                    {order.market_question.slice(0, 35)}
                  </p>
                  <p className="text-txt-muted text-2xs num">
                    ${order.size.toFixed(2)} — {formatDistanceToNowStrict(order.ts)}
                  </p>
                </div>

                {/* Side */}
                <div className="flex items-center justify-center">
                  <span className={clsx(
                    "text-2xs font-bold px-1 border",
                    order.side === "YES"
                      ? "text-neon-green border-neon-green/40"
                      : "text-neon-red   border-neon-red/40"
                  )}>
                    {order.side}
                  </span>
                </div>

                {/* Price */}
                <div className="flex flex-col items-end justify-center">
                  <span className="text-txt-primary num text-xs">
                    {order.fill_price
                      ? `${(order.fill_price * 100).toFixed(2)}¢`
                      : `${(order.price * 100).toFixed(2)}¢`}
                  </span>
                  {order.filled_size && order.filled_size < order.size && (
                    <span className="text-neon-orange text-2xs num">
                      {((order.filled_size / order.size) * 100).toFixed(0)}%
                    </span>
                  )}
                </div>

                {/* Status badge */}
                <div className="flex items-center justify-end">
                  <span className={clsx(
                    "text-2xs px-1 py-0.5 border",
                    STATUS_STYLE[order.status] ?? "text-txt-dim"
                  )}>
                    {order.status.replace("_", " ")}
                  </span>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {orders.length === 0 && (
          <div className="text-txt-muted text-xs p-3 text-center">No orders yet</div>
        )}
      </div>
    </div>
  );
}
