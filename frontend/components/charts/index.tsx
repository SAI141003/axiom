"use client";

import {
  PieChart, Pie, Cell, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend, ReferenceLine,
} from "recharts";

// One palette for every chart on the desk. Indigo is the brand; the rest are
// chosen to stay distinguishable on the dark ground and to a colour-blind eye.
export const PALETTE = ["#7c9aff", "#34d399", "#fbbf24", "#f87171", "#c084fc", "#22d3ee", "#a3e635", "#fb923c"];
export const GREEN = "#34d399";
export const RED = "#f87171";

const tip = {
  contentStyle: { background: "#0d1017", border: "1px solid #313a4e", borderRadius: 6, fontSize: 11, fontFamily: "inherit" },
  labelStyle: { color: "#a8b9ff" },
  itemStyle: { color: "#e8ecf4" },
};
const axis = { stroke: "#6b7488", fontSize: 10, fontFamily: "inherit" };

export function Card({ title, sub, children, className = "" }: { title: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`hud-panel hud-panel-static p-4 min-w-0 ${className}`}>
      <div className="text-[10px] tracking-widest font-bold" style={{ color: "var(--hud-accent)" }}>{title}</div>
      {sub && <div className="text-[9px] mb-2 break-words" style={{ color: "var(--hud-muted)" }}>{sub}</div>}
      {children}
    </div>
  );
}

export function Kpi({ label, value, tone, sub }: { label: string; value: string; tone?: "good" | "bad" | "neutral"; sub?: string }) {
  const color = tone === "good" ? GREEN : tone === "bad" ? RED : "var(--hud-text)";
  return (
    <div className="hud-panel hud-panel-static px-4 py-3 min-w-0">
      <div className="text-[8px] tracking-widest truncate" style={{ color: "var(--hud-muted)" }}>{label}</div>
      <div className="text-xl font-bold tabular-nums truncate" style={{ color }}>{value}</div>
      {sub && <div className="text-[9px] truncate" style={{ color: "var(--hud-muted)" }}>{sub}</div>}
    </div>
  );
}

export function DonutChart({ data, height = 220, valueLabel }: { data: { name: string; value: number }[]; height?: number; valueLabel?: (v: number) => string }) {
  const rows = data.filter((d) => d.value > 0);
  if (!rows.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={rows} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke="none">
          {rows.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Pie>
        <Tooltip {...tip} formatter={(v: any) => (valueLabel ? valueLabel(Number(v)) : v)} />
        <Legend wrapperStyle={{ fontSize: 10 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// Bars run horizontally: category names get a full row each, so they never
// collide however long they are or however narrow the card is.
export function CompareBars({ data, keys, height = 240, format, signed }:
  { data: any[]; keys: { key: string; label: string }[]; height?: number; format?: (v: number) => string; signed?: boolean }) {
  if (!data?.length) return <Empty />;
  const h = Math.max(height, data.length * (keys.length > 1 ? 44 : 34) + 40);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid stroke="#232936" horizontal={false} />
        <XAxis type="number" tick={axis} tickFormatter={(v) => (format ? format(v) : v)} />
        <YAxis type="category" dataKey="name" tick={{ ...axis, fontSize: 11 }} width={96} interval={0} />
        <Tooltip {...tip} formatter={(v: any) => (format ? format(Number(v)) : v)} />
        {keys.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
        {signed && <ReferenceLine x={0} stroke="#6b7488" />}
        {keys.map((k, i) => (
          <Bar key={k.key} dataKey={k.key} name={k.label} fill={PALETTE[i % PALETTE.length]} radius={[0, 3, 3, 0]}>
            {keys.length === 1 && signed && data.map((d, j) => <Cell key={j} fill={d[k.key] >= 0 ? GREEN : RED} />)}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Lines({ data, keys, height = 260, format, xKey = "date", refY }:
  { data: any[]; keys: string[]; height?: number; format?: (v: number) => string; xKey?: string; refY?: number }) {
  if (!data?.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid stroke="#232936" vertical={false} />
        <XAxis dataKey={xKey} tick={axis} minTickGap={24} />
        <YAxis tick={axis} tickFormatter={(v) => (format ? format(v) : v)} domain={["auto", "auto"]} />
        <Tooltip {...tip} formatter={(v: any) => (format ? format(Number(v)) : v)} />
        {keys.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
        {refY != null && <ReferenceLine y={refY} stroke="#6b7488" strokeDasharray="4 4" />}
        {keys.map((k, i) => (
          <Line key={k} type="monotone" dataKey={k} stroke={PALETTE[i % PALETTE.length]} dot={false} strokeWidth={1.8} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto mb-5 pb-1" style={{ scrollbarWidth: "none" }} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => onChange(t.id)}
                className="text-[10px] tracking-widest font-bold px-3 py-1.5 rounded border whitespace-nowrap transition-colors"
                style={{
                  borderColor: active === t.id ? "var(--hud-accent)" : "var(--hud-border)",
                  color: active === t.id ? "var(--hud-accent)" : "var(--hud-muted)",
                  background: active === t.id ? "var(--hud-accent-soft)" : "transparent",
                }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Empty() {
  return <div className="text-[11px] py-8 text-center" style={{ color: "var(--hud-muted)" }}>no data yet — run the generator command</div>;
}

export const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
export const usd = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
