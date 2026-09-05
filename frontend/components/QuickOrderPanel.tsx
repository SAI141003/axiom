"use client";
import { useState } from "react";
import { Zap } from "lucide-react";
import { useTradingStore } from "@/lib/store";
import { sendMessage } from "@/lib/websocket";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";

type OrderMode = "LIMIT" | "MARKET";

export default function QuickOrderPanel() {
  const { selectedMarket, risk, stats } = useTradingStore((s) => ({
    selectedMarket: s.selectedMarket,
    risk:           s.risk,
    stats:          s.stats,
  }));

  const [side, setSide]     = useState<"YES" | "NO">("YES");
  const [mode, setMode]     = useState<OrderMode>("LIMIT");
  const [sizeUsd, setSize]  = useState("10");
  const [confirm, setConfirm] = useState(false);
  const [sent, setSent]     = useState(false);

  const yesPrice = selectedMarket?.yes_price ?? 0.5;
  const noPrice  = selectedMarket?.no_price  ?? 0.5;
  const price    = side === "YES" ? yesPrice : noPrice;
  const sizeNum  = parseFloat(sizeUsd) || 0;
  const shares   = sizeNum > 0 ? sizeNum / price : 0;
  const maxProfit = shares - sizeNum;
  const edge     = Math.abs(yesPrice - 0.5) * 0.5;
  const disabled = risk.kill_switch_active || !selectedMarket || sizeNum <= 0;

  const handleSubmit = () => {
    if (!confirm) { setConfirm(true); return; }
    if (disabled) return;

    sendMessage({
      type: "manual_order",
      market_id: selectedMarket!.condition_id,
      side,
      size: sizeNum,
      price,
      order_type: mode,
    });

    setSent(true);
    setConfirm(false);
    setTimeout(() => setSent(false), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="panel-header">
        <span className="flex items-center gap-1.5"><Zap size={10} />QUICK ORDER</span>
        <span className={clsx("text-2xs", stats.ws_connected ? "text-neon-green" : "text-neon-red")}>
          {stats.ws_connected ? "LIVE" : "OFFLINE"}
        </span>
      </div>

      <div className="flex-1 px-3 py-2 flex flex-col gap-2">
        {/* Market name */}
        <p className="text-2xs text-txt-dim truncate">
          {selectedMarket?.question ?? "Select a market"}
        </p>

        {/* YES / NO prices */}
        <div className="grid grid-cols-2 gap-1.5">
          <PriceButton
            label="YES"
            price={yesPrice}
            active={side === "YES"}
            onClick={() => { setSide("YES"); setConfirm(false); }}
          />
          <PriceButton
            label="NO"
            price={noPrice}
            active={side === "NO"}
            onClick={() => { setSide("NO"); setConfirm(false); }}
          />
        </div>

        {/* LIMIT / MARKET toggle + size */}
        <div className="flex items-center gap-2">
          <div className="flex border border-terminal-border text-2xs">
            {(["LIMIT", "MARKET"] as OrderMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={clsx(
                  "px-2 py-1 transition-colors",
                  mode === m ? "bg-neon-cyan/10 text-neon-cyan" : "text-txt-muted hover:text-txt-dim"
                )}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="flex-1 flex items-center border border-terminal-border">
            <span className="px-1.5 text-txt-muted text-xs">$</span>
            <input
              type="number"
              value={sizeUsd}
              onChange={(e) => { setSize(e.target.value); setConfirm(false); }}
              min="1"
              max="25"
              step="1"
              className="flex-1 bg-transparent py-1 pr-2 text-xs text-txt-primary outline-none num"
              placeholder="Size USD"
            />
          </div>
        </div>

        {/* Order summary */}
        <div className="grid grid-cols-3 text-2xs gap-1">
          <div className="bg-terminal-bg border border-terminal-border p-1.5">
            <div className="text-txt-muted">PRICE</div>
            <div className="text-txt-primary num">{(price * 100).toFixed(2)}¢</div>
          </div>
          <div className="bg-terminal-bg border border-terminal-border p-1.5">
            <div className="text-txt-muted">SHARES</div>
            <div className="text-neon-cyan num">{shares.toFixed(1)}</div>
          </div>
          <div className="bg-terminal-bg border border-terminal-border p-1.5">
            <div className="text-txt-muted">MAX PROFIT</div>
            <div className="text-neon-green num">${maxProfit.toFixed(2)}</div>
          </div>
        </div>

        {/* Submit button */}
        <AnimatePresence mode="wait">
          {sent ? (
            <motion.div
              key="sent"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="py-2 text-center text-neon-green text-xs font-bold border border-neon-green/40 bg-neon-green/5"
            >
              ✓ ORDER SENT
            </motion.div>
          ) : (
            <motion.button
              key="btn"
              onClick={handleSubmit}
              disabled={disabled}
              className={clsx(
                "py-2 text-xs font-bold uppercase tracking-wider transition-all",
                disabled
                  ? "bg-terminal-header text-txt-muted border border-terminal-border cursor-not-allowed"
                  : confirm
                    ? side === "YES"
                      ? "bg-neon-green/20 text-neon-green border-2 border-neon-green shadow-neon-green animate-pulse"
                      : "bg-neon-red/20   text-neon-red   border-2 border-neon-red   shadow-neon-red   animate-pulse"
                    : side === "YES"
                      ? "bg-neon-green/10 text-neon-green border border-neon-green/50 hover:bg-neon-green/20"
                      : "bg-neon-red/10   text-neon-red   border border-neon-red/50   hover:bg-neon-red/20"
              )}
            >
              {confirm
                ? `⚠ CONFIRM BUY ${side} — $${sizeNum.toFixed(2)}`
                : `BUY ${side} @ ${(price * 100).toFixed(1)}¢`}
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function PriceButton({ label, price, active, onClick }: {
  label: string; price: number; active: boolean; onClick: () => void;
}) {
  const isYes = label === "YES";
  return (
    <button
      onClick={onClick}
      className={clsx(
        "py-2 px-2 border text-center transition-all",
        active
          ? isYes
            ? "border-neon-green bg-neon-green/10 shadow-neon-green"
            : "border-neon-red   bg-neon-red/10   shadow-neon-red"
          : "border-terminal-border bg-terminal-bg hover:bg-terminal-hover"
      )}
    >
      <div className={clsx("text-2xs uppercase tracking-wider mb-0.5", active ? (isYes ? "text-neon-green" : "text-neon-red") : "text-txt-muted")}>
        {label}
      </div>
      <div className={clsx("num font-bold text-sm", isYes ? "text-neon-green" : "text-neon-red")}>
        {(price * 100).toFixed(2)}¢
      </div>
    </button>
  );
}
