"use client";
import { useState } from "react";
import { AlertTriangle, ShieldOff, Shield } from "lucide-react";
import { useTradingStore } from "@/lib/store";
import { sendMessage } from "@/lib/websocket";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";

function MeterBar({
  value, max, label, valueStr, warnAt = 0.7, critAt = 0.9,
}: {
  value: number; max: number; label: string; valueStr: string;
  warnAt?: number; critAt?: number;
}) {
  const pct = Math.min((value / max) * 100, 100);
  const ratio = value / max;
  const color =
    ratio >= critAt ? "bg-neon-red"    :
    ratio >= warnAt ? "bg-neon-yellow" :
                      "bg-neon-green";
  const textColor =
    ratio >= critAt ? "text-neon-red"    :
    ratio >= warnAt ? "text-neon-yellow" :
                      "text-neon-green";

  return (
    <div className="mb-2">
      <div className="flex justify-between text-2xs mb-0.5">
        <span className="text-txt-dim uppercase tracking-wider">{label}</span>
        <span className={clsx("num font-semibold", textColor)}>{valueStr}</span>
      </div>
      <div className="h-1.5 bg-terminal-bg rounded overflow-hidden">
        <motion.div
          className={clsx("h-full rounded transition-colors", color)}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5 }}
        />
      </div>
    </div>
  );
}

export default function RiskPanel() {
  const { risk, activateKillSwitch } = useTradingStore((s) => ({
    risk: s.risk,
    activateKillSwitch: s.activateKillSwitch,
  }));

  const [confirmKill, setConfirmKill] = useState(false);

  const handleKillSwitch = () => {
    if (!confirmKill) { setConfirmKill(true); return; }
    activateKillSwitch();
    sendMessage({ type: "kill_switch", reason: "manual_dashboard" });
    setConfirmKill(false);
  };

  const drawdownPct = risk.drawdown_pct * 100;
  const dailyLossPct = (risk.daily_loss / risk.daily_loss_limit) * 100;

  return (
    <div className="flex flex-col h-full">
      <div className="panel-header">
        <span className="flex items-center gap-2">
          <Shield size={10} className={risk.kill_switch_active ? "text-neon-red" : "text-neon-green"} />
          RISK ENGINE
        </span>
        <span className={clsx(
          "text-2xs px-1.5 py-0.5 border font-bold",
          risk.kill_switch_active
            ? "text-neon-red border-neon-red/60 bg-neon-red/10 animate-pulse"
            : "text-neon-green border-neon-green/40 bg-neon-green/5"
        )}>
          {risk.kill_switch_active ? "KILLED" : "ACTIVE"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {/* Key stats row */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <Stat label="BANKROLL" value={`$${risk.bankroll.toFixed(2)}`} sub={`PEAK $${risk.peak_bankroll.toFixed(0)}`} color="cyan" />
          <Stat label="DAILY LOSS" value={`$${risk.daily_loss.toFixed(2)}`} sub={`LIMIT $${risk.daily_loss_limit}`} color={risk.daily_loss / risk.daily_loss_limit > 0.7 ? "red" : "green"} />
          <Stat label="POSITIONS" value={String(risk.open_positions)} sub={`EXP $${risk.total_exposure.toFixed(0)}`} color="cyan" />
          <Stat label="DRAWDOWN" value={`${drawdownPct.toFixed(2)}%`} sub={`MAX ${(risk.max_drawdown_pct * 100).toFixed(0)}%`} color={drawdownPct / (risk.max_drawdown_pct * 100) > 0.7 ? "red" : "green"} />
        </div>

        {/* Meters */}
        <MeterBar
          label="Daily Loss"
          value={risk.daily_loss}
          max={risk.daily_loss_limit}
          valueStr={`${dailyLossPct.toFixed(1)}%`}
          warnAt={0.7}
          critAt={0.9}
        />
        <MeterBar
          label="Drawdown"
          value={risk.drawdown_pct}
          max={risk.max_drawdown_pct}
          valueStr={`${drawdownPct.toFixed(2)}%`}
          warnAt={0.7}
          critAt={0.9}
        />
        <MeterBar
          label="Exposure"
          value={risk.total_exposure}
          max={risk.bankroll * 0.20}
          valueStr={`$${risk.total_exposure.toFixed(0)}`}
          warnAt={0.6}
          critAt={0.85}
        />

        {/* Kill switch */}
        <div className="mt-3">
          <AnimatePresence>
            {confirmKill && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-2 px-2 py-1.5 border border-neon-red/60 bg-neon-red/5 text-neon-red text-xs"
              >
                <AlertTriangle size={10} className="inline mr-1" />
                CONFIRM: cancels ALL orders &amp; halts trading
              </motion.div>
            )}
          </AnimatePresence>

          <button
            onClick={handleKillSwitch}
            disabled={risk.kill_switch_active}
            className={clsx(
              "w-full py-2 text-xs font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2",
              risk.kill_switch_active
                ? "bg-terminal-header text-txt-muted border border-terminal-border cursor-not-allowed"
                : confirmKill
                  ? "bg-neon-red/20 text-neon-red border-2 border-neon-red animate-pulse shadow-neon-red"
                  : "bg-terminal-card text-neon-red border border-neon-red/40 hover:bg-neon-red/10 hover:shadow-neon-red"
            )}
          >
            <ShieldOff size={12} />
            {risk.kill_switch_active
              ? "KILL SWITCH ACTIVE"
              : confirmKill
                ? "⚠ CONFIRM KILL SWITCH"
                : "KILL SWITCH"}
          </button>

          {confirmKill && !risk.kill_switch_active && (
            <button
              onClick={() => setConfirmKill(false)}
              className="w-full mt-1 py-1 text-2xs text-txt-dim hover:text-txt-primary border border-terminal-border transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color: string;
}) {
  const colors: Record<string, string> = {
    green:  "text-neon-green",
    red:    "text-neon-red",
    cyan:   "text-neon-cyan",
    yellow: "text-neon-yellow",
  };
  return (
    <div className="bg-terminal-bg p-2 border border-terminal-border">
      <div className="text-txt-muted text-2xs uppercase tracking-wider mb-0.5">{label}</div>
      <div className={clsx("num font-bold text-sm", colors[color] ?? "text-txt-primary")}>{value}</div>
      {sub && <div className="text-txt-muted text-2xs num mt-0.5">{sub}</div>}
    </div>
  );
}
