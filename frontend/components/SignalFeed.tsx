"use client";
import { useTradingStore } from "@/lib/store";
import { formatDistanceToNowStrict } from "date-fns";
import type { Signal } from "@/lib/types";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";

export default function SignalFeed() {
  const signals = useTradingStore((s) => s.signals);

  return (
    <div className="flex flex-col h-full">
      <div className="panel-header">
        <span>SIGNAL FEED</span>
        <span className="text-neon-cyan num">{signals.length}</span>
      </div>

      {/* Column headers */}
      <div className="grid px-2 py-1 text-2xs text-txt-muted border-b border-terminal-border uppercase tracking-wider"
        style={{ gridTemplateColumns: "1fr 40px 55px 50px" }}>
        <span>MARKET</span>
        <span className="text-center">SIDE</span>
        <span className="text-right">EDGE</span>
        <span className="text-right">SRC</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <AnimatePresence initial={false}>
          {signals.map((sig) => (
            <motion.div
              key={sig.id}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <SignalRow signal={sig} />
            </motion.div>
          ))}
        </AnimatePresence>
        {signals.length === 0 && (
          <div className="text-txt-muted text-xs p-4 text-center">Awaiting signals...</div>
        )}
      </div>
    </div>
  );
}

function SignalRow({ signal }: { signal: Signal }) {
  const edgePct = (signal.edge * 100).toFixed(1);
  const isYes = signal.side === "YES";
  const isConsensus = signal.source === "consensus";

  return (
    <div className={clsx(
      "grid px-2 py-1.5 border-b border-terminal-border/50 text-xs hover:bg-terminal-hover transition-colors",
      isYes ? "border-l-2 border-l-neon-green/40" : "border-l-2 border-l-neon-red/40"
    )} style={{ gridTemplateColumns: "1fr 40px 55px 50px" }}>

      {/* Market */}
      <div className="min-w-0 pr-1">
        <p className="text-txt-primary truncate text-2xs leading-tight">
          {signal.market_question.slice(0, 50)}
        </p>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-txt-muted text-2xs num">
            p={( signal.p_model * 100).toFixed(0)}% m={( signal.p_market * 100).toFixed(0)}%
          </span>
          {isConsensus && signal.consensus_count >= 3 && (
            <span className="text-neon-purple text-2xs">⬡ {signal.consensus_count}</span>
          )}
        </div>
      </div>

      {/* Side */}
      <div className="flex items-center justify-center">
        <span className={clsx(
          "text-2xs font-bold px-1 py-0.5 border",
          isYes
            ? "text-neon-green border-neon-green/40 bg-neon-green/5"
            : "text-neon-red border-neon-red/40 bg-neon-red/5"
        )}>
          {signal.side}
        </span>
      </div>

      {/* Edge */}
      <div className="flex flex-col items-end justify-center">
        <span className={clsx("num font-semibold", parseFloat(edgePct) >= 8 ? "text-neon-green" : "text-neon-yellow")}>
          +{edgePct}%
        </span>
        <span className="text-txt-muted text-2xs num">${signal.approved_size.toFixed(0)}</span>
      </div>

      {/* Source + time */}
      <div className="flex flex-col items-end justify-center">
        <span className={clsx("text-2xs uppercase", isConsensus ? "text-neon-purple" : "text-neon-cyan")}>
          {signal.source}
        </span>
        <span className="text-txt-muted text-2xs">
          {formatDistanceToNowStrict(signal.ts, { addSuffix: false })}
        </span>
      </div>
    </div>
  );
}
