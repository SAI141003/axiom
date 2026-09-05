"use client";
import { useState, useMemo } from "react";
import {
  ComposedChart, Area, Line, Bar, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { useTradingStore } from "@/lib/store";
import type { PricePoint, Signal } from "@/lib/types";
import { format } from "date-fns";
import clsx from "clsx";

const RANGES = ["15M", "1H", "6H", "1D"] as const;
type Range = typeof RANGES[number];

const RANGE_POINTS: Record<Range, number> = { "15M": 15, "1H": 60, "6H": 120, "1D": 288 };

interface ChartDatum extends PricePoint {
  signalYes?: number;
  signalNo?: number;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as ChartDatum;
  return (
    <div className="bg-terminal-card border border-terminal-border p-2 text-xs font-mono shadow-lg">
      <div className="text-txt-dim mb-1">{format(d.ts, "HH:mm:ss")}</div>
      <div className="text-neon-green num">YES {(d.yes_price * 100).toFixed(2)}¢</div>
      <div className="text-neon-red   num">NO  {(d.no_price * 100).toFixed(2)}¢</div>
      {d.volume && <div className="text-txt-dim num">VOL ${d.volume.toFixed(0)}</div>}
    </div>
  );
}

function SignalDot(props: any) {
  const { cx, cy, payload } = props;
  if (!payload?.signalYes && !payload?.signalNo) return null;
  const isYes = !!payload.signalYes;
  return (
    <g>
      <polygon
        points={isYes ? `${cx},${cy - 8} ${cx - 5},${cy} ${cx + 5},${cy}` : `${cx},${cy + 8} ${cx - 5},${cy} ${cx + 5},${cy}`}
        fill={isYes ? "#00ff88" : "#ff3355"}
        opacity={0.9}
      />
    </g>
  );
}

export default function ChartPanel() {
  const { selectedMarket, priceHistory, signals } = useTradingStore((s) => ({
    selectedMarket: s.selectedMarket,
    priceHistory:   s.priceHistory,
    signals:        s.signals,
  }));

  const [range, setRange] = useState<Range>("1H");

  const chartData: ChartDatum[] = useMemo(() => {
    const n = RANGE_POINTS[range];
    const sliced = priceHistory.slice(-n);

    // Overlay signals as dots
    const sigMap: Record<number, Signal> = {};
    signals.forEach((sig) => {
      const closest = sliced.reduce((prev, cur) =>
        Math.abs(cur.ts - sig.ts) < Math.abs(prev.ts - sig.ts) ? cur : prev
      , sliced[0]);
      if (closest) sigMap[closest.ts] = sig;
    });

    return sliced.map((pt) => {
      const sig = sigMap[pt.ts];
      return {
        ...pt,
        signalYes: sig?.side === "YES" ? pt.yes_price : undefined,
        signalNo:  sig?.side === "NO"  ? pt.no_price  : undefined,
      };
    });
  }, [priceHistory, signals, range]);

  const currentPrice = selectedMarket?.yes_price ?? 0.5;
  const priceChange = chartData.length > 1
    ? currentPrice - (chartData[0]?.yes_price ?? currentPrice)
    : 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="panel-header flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="truncate max-w-xs">{selectedMarket?.question ?? "Select a market"}</span>
          {selectedMarket?.linked_asset && (
            <span className="text-neon-orange text-2xs">[{selectedMarket.linked_asset}]</span>
          )}
        </div>

        <div className="flex items-center gap-4 flex-shrink-0 ml-3">
          {/* Price */}
          <div className="flex items-center gap-2">
            <span className="text-neon-green num font-bold text-sm">{(currentPrice * 100).toFixed(2)}¢</span>
            <span className={clsx("num text-xs", priceChange >= 0 ? "text-neon-green" : "text-neon-red")}>
              {priceChange >= 0 ? "▲" : "▼"} {(Math.abs(priceChange) * 100).toFixed(2)}¢
            </span>
          </div>

          {/* Volume */}
          {selectedMarket && (
            <span className="text-txt-dim text-2xs num">
              VOL ${(selectedMarket.volume / 1_000_000).toFixed(2)}M
            </span>
          )}

          {/* Range buttons */}
          <div className="flex gap-0.5">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={clsx(
                  "px-2 py-0.5 text-2xs transition-colors",
                  range === r
                    ? "text-neon-cyan bg-neon-cyan/10 border border-neon-cyan/40"
                    : "text-txt-muted hover:text-txt-dim border border-transparent"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-0 px-1 pb-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="yesGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#00ff88" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#00ff88" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="noGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#ff3355" stopOpacity={0.1} />
                <stop offset="95%" stopColor="#ff3355" stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="2 4" stroke="#1a2535" vertical={false} />

            <XAxis
              dataKey="ts"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={(v) => format(v, "HH:mm")}
              tick={{ fontSize: 9, fill: "#4a5568" }}
              tickLine={false}
              axisLine={{ stroke: "#1a2535" }}
              tickCount={6}
            />
            <YAxis
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}¢`}
              tick={{ fontSize: 9, fill: "#4a5568" }}
              tickLine={false}
              axisLine={false}
              width={32}
              tickCount={5}
            />
            <YAxis
              yAxisId="vol"
              orientation="right"
              domain={[0, "dataMax"]}
              tick={false}
              axisLine={false}
              tickLine={false}
              width={0}
            />

            <Tooltip content={<CustomTooltip />} />

            {/* Volume bars (background) */}
            <Bar dataKey="volume" yAxisId="vol" fill="#1a2535" opacity={0.5} />

            {/* YES area */}
            <Area
              type="monotone"
              dataKey="yes_price"
              stroke="#00ff88"
              strokeWidth={1.5}
              fill="url(#yesGrad)"
              dot={false}
              activeDot={{ r: 3, fill: "#00ff88" }}
            />

            {/* NO line (dashed) */}
            <Line
              type="monotone"
              dataKey="no_price"
              stroke="#ff3355"
              strokeWidth={1}
              strokeDasharray="3 3"
              dot={false}
              activeDot={false}
            />

            {/* Signal overlay dots */}
            <Line
              type="monotone"
              dataKey="signalYes"
              stroke="transparent"
              dot={<SignalDot />}
              activeDot={false}
              legendType="none"
            />
            <Line
              type="monotone"
              dataKey="signalNo"
              stroke="transparent"
              dot={<SignalDot />}
              activeDot={false}
              legendType="none"
            />

            {/* Mid reference line */}
            <ReferenceLine y={0.5} stroke="#1a2535" strokeDasharray="4 4" />

            {/* Current price reference */}
            <ReferenceLine
              y={currentPrice}
              stroke="#00d4ff"
              strokeDasharray="2 3"
              strokeWidth={1}
              opacity={0.6}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 px-3 pb-1.5 flex-shrink-0 text-2xs text-txt-dim">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-neon-green" />YES</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-neon-red opacity-60" style={{ borderTop: "1px dashed" }} />NO</span>
        <span className="flex items-center gap-1"><span className="text-neon-green">▲</span>BUY SIGNAL</span>
        <span className="flex items-center gap-1"><span className="text-neon-red">▼</span>SELL SIGNAL</span>
        <span className="ml-auto text-neon-cyan/50">PROB CHART — POLYMARKET</span>
      </div>
    </div>
  );
}
