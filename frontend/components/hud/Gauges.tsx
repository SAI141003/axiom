"use client";

// Circular readouts in the Stark idiom: a ring with a tick track, an arc for
// the value, a big number in the middle, a caption beneath. SVG, token
// colours, no library.
export function RingGauge({ label, value, sub, pct = 0.66, tone = "var(--hud-accent)", size = 132 }:
  { label: string; value: string; sub?: string; pct?: number; tone?: string; size?: number }) {
  const r = size / 2 - 10, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct));
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${label} ${value}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r + 6} fill="none" stroke="var(--hud-line-dim)" strokeWidth="0.8" strokeDasharray="2 5" className="hud-spin" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hud-border-2)" strokeWidth="6" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ filter: `drop-shadow(0 0 6px ${tone})`, transition: "stroke-dasharray 0.6s var(--hud-ease)" }} />
      {Array.from({ length: 36 }).map((_, i) => <line key={i} x1={size / 2} y1={10} x2={size / 2} y2={i % 9 === 0 ? 16 : 13} stroke="var(--hud-line-dim)" strokeWidth={i % 9 === 0 ? 1.4 : 0.7} transform={`rotate(${i * 10} ${size / 2} ${size / 2})`} />)}
      <text x="50%" y="46%" textAnchor="middle" className="hud-ring-value">{value}</text>
      <text x="50%" y="60%" textAnchor="middle" className="hud-ring-label">{label}</text>
      {sub && <text x="50%" y="71%" textAnchor="middle" style={{ font: "400 8px/1 JetBrains Mono, monospace", fill: "var(--hud-muted)" }}>{sub}</text>}
    </svg>
  );
}

// The reactor stage: concentric instrument rings around the mind. Pure SVG,
// counter-rotating, with the brain orb from the rail idiom in the centre.
export function ReactorStage({ size = 420, tone = "var(--hud-accent)", children }: { size?: number; tone?: string; children?: React.ReactNode }) {
  const c = size / 2;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 w-full h-full" aria-hidden>
        <circle cx={c} cy={c} r={c - 4} fill="none" stroke="var(--hud-line-dim)" strokeWidth="1" strokeDasharray="1 6" className="hud-spin" />
        <g className="hud-spin-r">
          <circle cx={c} cy={c} r={c - 22} fill="none" stroke={tone} strokeWidth="2" strokeDasharray={`${(c - 22) * 1.4} ${(c - 22) * 2}`} opacity="0.85" strokeLinecap="round" />
          {Array.from({ length: 72 }).map((_, i) => <line key={i} x1={c} y1={22} x2={c} y2={i % 6 === 0 ? 34 : 28} stroke={tone} strokeWidth={i % 6 === 0 ? 1.6 : 0.7} opacity={i % 6 === 0 ? 0.9 : 0.45} transform={`rotate(${i * 5} ${c} ${c})`} />)}
        </g>
        <g className="hud-spin">
          <circle cx={c} cy={c} r={c - 60} fill="none" stroke={tone} strokeWidth="1.2" strokeDasharray="30 14 6 14" opacity="0.7" />
          {[0, 90, 180, 270].map((a) => <path key={a} d={`M${c},${68} l-6,10 h12 z`} fill={tone} opacity="0.8" transform={`rotate(${a} ${c} ${c})`} />)}
        </g>
        <circle cx={c} cy={c} r={c - 92} fill="none" stroke="var(--hud-line-dim)" strokeWidth="1" strokeDasharray="4 8" className="hud-spin-r" />
        <circle cx={c} cy={c} r={c - 120} fill="none" stroke={tone} strokeWidth="1" opacity="0.5" strokeDasharray="90 40" className="hud-spin" />
        <circle cx={c} cy={c} r={c - 128} fill="url(#coreGlow)" />
        <defs><radialGradient id="coreGlow"><stop offset="0%" stopColor={tone} stopOpacity="0.28" /><stop offset="70%" stopColor={tone} stopOpacity="0.04" /><stop offset="100%" stopColor="transparent" /></radialGradient></defs>
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}
