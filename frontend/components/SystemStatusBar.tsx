"use client";
import { useState, useEffect } from "react";
import { useTradingStore } from "@/lib/store";
import type { LogEntry, WorkerHealth } from "@/lib/types";
import { formatDistanceToNowStrict } from "date-fns";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";

const LOG_COLORS: Record<LogEntry["level"], string> = {
  DEBUG:    "text-txt-muted",
  INFO:     "text-txt-dim",
  WARNING:  "text-neon-yellow",
  ERROR:    "text-neon-red",
  CRITICAL: "text-neon-red font-bold",
};

const LOG_PREFIXES: Record<LogEntry["level"], string> = {
  DEBUG:    "DBG",
  INFO:     "INF",
  WARNING:  "WRN",
  ERROR:    "ERR",
  CRITICAL: "CRT",
};

function WorkerDot({ name, ts }: { name: string; ts: number }) {
  const ageS = (Date.now() - ts) / 1000;
  const alive = ageS < 30;
  const stale = ageS >= 30 && ageS < 60;

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className={clsx(
        "w-2 h-2 rounded-full",
        alive ? "bg-neon-green animate-pulse-dot" :
        stale ? "bg-neon-yellow" :
                "bg-neon-red"
      )} />
      <span className={clsx(
        "text-2xs uppercase",
        alive ? "text-neon-green" : stale ? "text-neon-yellow" : "text-neon-red"
      )}>
        {name.slice(0, 3)}
      </span>
    </div>
  );
}

export default function SystemStatusBar() {
  const { stats, workerHealth, logs, risk } = useTradingStore((s) => ({
    stats:        s.stats,
    workerHealth: s.workerHealth,
    logs:         s.logs,
    risk:         s.risk,
  }));

  const recentLogs = logs.slice(0, 5);

  return (
    <div className="flex items-stretch border-t border-terminal-border bg-terminal-header" style={{ minHeight: 48, maxHeight: 72 }}>

      {/* WS + latency */}
      <div className="flex flex-col justify-center px-3 border-r border-terminal-border gap-0.5 flex-shrink-0" style={{ minWidth: 110 }}>
        <div className="flex items-center gap-1.5">
          <div className={clsx(
            "w-1.5 h-1.5 rounded-full",
            stats.ws_connected ? "bg-neon-green animate-pulse-dot" : "bg-neon-red animate-blink"
          )} />
          <span className={clsx("text-2xs uppercase font-semibold", stats.ws_connected ? "text-neon-green" : "text-neon-red")}>
            {stats.ws_connected ? "CONNECTED" : "OFFLINE"}
          </span>
        </div>
        <div className="flex items-center gap-1 text-2xs text-txt-muted">
          <span>LAT</span>
          <span className={clsx("num", stats.ws_latency_ms < 50 ? "text-neon-green" : stats.ws_latency_ms < 150 ? "text-neon-yellow" : "text-neon-red")}>
            {stats.ws_connected ? `${stats.ws_latency_ms}ms` : "—"}
          </span>
        </div>
      </div>

      {/* Worker health */}
      <div className="flex items-center gap-3 px-3 border-r border-terminal-border flex-shrink-0">
        <span className="text-2xs text-txt-muted uppercase tracking-wider mr-1">WORKERS</span>
        {(["ingestion", "signal", "execution", "risk"] as const).map((w) => (
          <WorkerDot key={w} name={w} ts={(workerHealth as any)[w] ?? 0} />
        ))}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 px-3 border-r border-terminal-border flex-shrink-0 text-2xs">
        <StatusStat label="SIGNALS"  value={String(stats.signals_generated)} />
        <StatusStat label="ORDERS"   value={String(stats.orders_submitted)} color="green" />
        <StatusStat label="DRY RUN"  value={String(stats.orders_dry_run)}   color="dim" />
        <StatusStat label="REJECTED" value={String(stats.orders_rejected)}  color="red" />
        <StatusStat label="API COST" value={`$${stats.api_cost_usd.toFixed(2)}`} color="cyan" />
        <StatusStat label="UPTIME"   value={formatUptime(stats.uptime_s)}   />
      </div>

      {/* Scrolling log feed */}
      <div className="flex-1 overflow-hidden flex flex-col justify-center px-3 min-w-0">
        <div className="text-2xs text-txt-muted uppercase tracking-wider mb-0.5">SYSTEM LOG</div>
        <div className="overflow-hidden" style={{ maxHeight: 40 }}>
          <AnimatePresence initial={false}>
            {recentLogs.slice(0, 3).map((log) => (
              <motion.div
                key={log.id}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className={clsx("text-2xs truncate leading-tight", LOG_COLORS[log.level])}
              >
                <span className="text-txt-muted mr-1">[{LOG_PREFIXES[log.level]}]</span>
                {log.message}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Kill switch status */}
      {risk.kill_switch_active && (
        <div className="flex items-center px-3 border-l border-neon-red/40 bg-neon-red/5 flex-shrink-0">
          <span className="text-neon-red text-xs font-bold animate-blink">⛔ KILL ACTIVE</span>
        </div>
      )}

      {/* Clock */}
      <div className="flex items-center px-3 border-l border-terminal-border flex-shrink-0">
        <Clock />
      </div>
    </div>
  );
}

function Clock() {
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setTime(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col items-end text-2xs">
      <span className="text-neon-cyan num">{time ?? "——:——:——"}</span>
      <span className="text-txt-muted">UTC</span>
    </div>
  );
}

function StatusStat({ label, value, color = "primary" }: { label: string; value: string; color?: string }) {
  const colors: Record<string, string> = {
    primary: "text-txt-primary",
    green:   "text-neon-green",
    red:     "text-neon-red",
    cyan:    "text-neon-cyan",
    yellow:  "text-neon-yellow",
    dim:     "text-txt-dim",
  };
  return (
    <div className="flex flex-col items-center">
      <span className="text-txt-muted uppercase tracking-wider" style={{ fontSize: 9 }}>{label}</span>
      <span className={clsx("num font-semibold", colors[color])}>{value}</span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
}
