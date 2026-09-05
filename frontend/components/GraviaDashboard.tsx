"use client";

import { useEffect, useRef, useState } from "react";

// ── Color constants (single source of truth) ──────────────────────────────────

const C = {
  bg:       "#04070d",
  surface:  "#08030e",
  pink:     "#ff00ff",
  pinkDim:  "rgba(255,0,255,0.3)",
  pinkBorder: "rgba(255,0,255,0.45)",
  green:    "#00ff88",
  greenDim: "rgba(0,255,136,0.5)",
  red:      "#ff3355",
  cyan:     "#00d4ff",
  orange:   "#ff8c00",
  yellow:   "#ffd700",
  purple:   "#9b59ff",
  white:    "#e2e8f0",
  dim:      "#8892a4",
  muted:    "#4a5568",
  border:   "#2a2a2a",
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Candle { o: number; h: number; l: number; c: number; }

interface Node {
  x: number; y: number; vx: number; vy: number;
  r: number; label: string; color: string; glow: string;
}

// ── Static data ───────────────────────────────────────────────────────────────

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function genCandles(base: number, n: number): Candle[] {
  const out: Candle[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const chg = (Math.random() - 0.49) * 110;
    const o = p;
    p += chg;
    out.push({ o, h: Math.max(o, p) + Math.random() * 55, l: Math.min(o, p) - Math.random() * 55, c: p });
  }
  return out;
}

const NODE_DEFS: Omit<Node, "x" | "y" | "vx" | "vy">[] = [
  { r: 22, label: "BEAR",     color: C.red,    glow: "rgba(255,51,85,0.7)"  },
  { r: 20, label: "BULL",     color: C.green,  glow: "rgba(0,255,136,0.7)"  },
  { r: 15, label: "MEDIAN",   color: C.cyan,   glow: "rgba(0,212,255,0.5)"  },
  { r: 28, label: "CATALYST", color: C.orange, glow: "rgba(255,140,0,0.7)"  },
  { r: 12, label: "CLUSTER",  color: C.purple, glow: "rgba(155,89,255,0.6)" },
  { r: 18, label: "RESIST",   color: C.pink,   glow: "rgba(255,0,255,0.7)"  },
  { r: 10, label: "SUPPORT",  color: C.green,  glow: "rgba(0,255,136,0.5)"  },
  { r: 13, label: "LONG",     color: C.cyan,   glow: "rgba(0,212,255,0.4)"  },
  { r:  8, label: "CROSS",    color: C.white,  glow: "rgba(226,232,240,0.3)" },
  { r: 11, label: "LINE",     color: C.yellow, glow: "rgba(255,215,0,0.5)"  },
  { r: 20, label: "MACRO",    color: C.orange, glow: "rgba(255,140,0,0.6)"  },
  { r: 14, label: "CPI",      color: C.red,    glow: "rgba(255,51,85,0.5)"  },
  { r: 16, label: "ETF",      color: C.green,  glow: "rgba(0,255,136,0.5)"  },
  { r: 10, label: "MEME",     color: C.purple, glow: "rgba(155,89,255,0.4)" },
  { r:  8, label: "GPT",      color: C.cyan,   glow: "rgba(0,212,255,0.3)"  },
  { r: 16, label: "REJECT",   color: C.red,    glow: "rgba(255,51,85,0.5)"  },
  { r: 12, label: "BUY",      color: C.green,  glow: "rgba(0,255,136,0.4)"  },
  { r:  8, label: "SELL",     color: C.red,    glow: "rgba(255,51,85,0.3)"  },
  { r: 10, label: "MYRGE",    color: C.yellow, glow: "rgba(255,215,0,0.4)"  },
];

function initNodes(W: number, H: number): Node[] {
  return NODE_DEFS.map(d => ({
    ...d,
    x:  d.r * 2 + Math.random() * (W - d.r * 4),
    y:  d.r * 2 + Math.random() * (H - d.r * 4),
    vx: (Math.random() - 0.5) * 0.55,
    vy: (Math.random() - 0.5) * 0.55,
  }));
}

// Pre-computed star field positions (deterministic, avoids per-frame arc calls)
const STARS = Array.from({ length: 60 }, (_, i) => ({
  x: ((i * 137.508 + 50) % 1000) / 1000,   // 0..1 relative
  y: ((i * 97.3   + 20) % 1000) / 1000,
}));

const PRICE_ROWS = [
  { price: 78139, pct: "57.2", chg: "+0.22", size: 313 },
  { price: 78136, pct: "57.9", chg: "+0.16", size: 533 },
  { price: 78133, pct: "53.5", chg: "+0.13", size: 273 },
  { price: 78131, pct: "56.2", chg: "+0.21", size: 519 },
  { price: 78129, pct: "57.7", chg: "+0.08", size: 341 },
  { price: 78127, pct: "53.6", chg: "+0.18", size: 510 },
  { price: 78125, pct: "57.5", chg: "+0.06", size: 487 },
  { price: 78124, pct: "53.3", chg: "+0.06", size: 788 },
];

const LOG_ENTRIES = [
  { id: 23, dir: "UP",  amt: "+$3.22",      txt: "PM caught up · exit 0.516 · clean fill $3.08",            c: C.green  },
  { id: 25, dir: "DP",  amt: "+7 · $0.01",  txt: "57.1% Ask will sweat · lag 0.51% · executing",             c: C.yellow },
  { id: 26, dir: "DW",  amt: "-$5.18",      txt: "Expected win: slippage 0.01% · $1.87",                     c: C.red    },
  { id: 24, dir: "TY",  amt: "$0.01",       txt: "57.9% ETF spike +$22M · PM skin UP underpriced",           c: C.cyan   },
  { id: 22, dir: "CRA", amt: "$2.77",       txt: "TY DP CRA areas · waiting PM lag",                         c: C.yellow },
  { id: 23, dir: "UP",  amt: "-$2 56.9%",   txt: "Polymarket lag +0.42% · TradingView confirms · 50.8% edge", c: C.green },
];

// ── Shared canvas hook ────────────────────────────────────────────────────────

function useCanvasSize(ref: React.RefObject<HTMLCanvasElement>) {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const sync = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0)  canvas.width  = Math.round(rect.width);
      if (rect.height > 0) canvas.height = Math.round(rect.height);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [ref]);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Dot({ color }: { color: string }) {
  return (
    <span style={{
      display: "inline-block", width: 6, height: 6, borderRadius: "50%",
      background: color, boxShadow: `0 0 7px ${color}`, flexShrink: 0,
    }} className="g-pulse" />
  );
}

function PLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6, padding: "3px 10px",
      fontSize: 9, borderBottom: `1px solid ${C.pinkDim}`,
      color: C.pink, letterSpacing: "0.18em", fontWeight: 700,
    }}>
      <Dot color={C.pink} />
      {children}
    </div>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ padding: "4px 7px", background: "rgba(255,255,255,0.02)", border: `1px solid ${C.border}` }}>
      <div style={{ color: C.muted, fontSize: 8, marginBottom: 1 }}>{label}</div>
      <div style={{ color, fontWeight: 600, fontSize: 11 }}>{value}</div>
    </div>
  );
}

function TopStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <span style={{ color: C.muted, fontSize: 8, letterSpacing: "0.15em" }}>{label}</span>
      <span style={{ color, fontWeight: 700, fontSize: 11 }}>{value}</span>
    </div>
  );
}

// ── Candlestick Chart ─────────────────────────────────────────────────────────

function CandlestickChart({ candles, price }: { candles: Candle[]; price: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasSize(ref);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = "rgba(26,37,53,0.6)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) { const y = H * i / 5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (let i = 0; i <= 9; i++) { const x = W * i / 9; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }

    if (!candles.length) return;

    const allPx = candles.flatMap(c => [c.h, c.l]);
    const lo = Math.min(...allPx) - 60, hi = Math.max(...allPx) + 60;
    const rng = hi - lo;
    const toY = (p: number) => H - ((p - lo) / rng) * H;
    const slot = W / candles.length;
    const bw = Math.max(2, Math.floor(slot * 0.55));

    candles.forEach((cd, i) => {
      const cx = i * slot + slot / 2;
      const up = cd.c >= cd.o;
      const col = up ? C.green : C.red;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, toY(cd.h)); ctx.lineTo(cx, toY(cd.l)); ctx.stroke();
      ctx.fillStyle = up ? col + "dd" : col;
      const top = toY(Math.max(cd.o, cd.c)), bot = toY(Math.min(cd.o, cd.c));
      ctx.fillRect(cx - bw / 2, top, bw, Math.max(1, bot - top));
    });

    const py = toY(price);
    ctx.strokeStyle = C.pink; ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.shadowColor = C.pink; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
    ctx.setLineDash([]); ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(255,0,255,0.15)";
    ctx.fillRect(W - 98, py - 10, 94, 18);
    ctx.strokeStyle = C.pink; ctx.lineWidth = 0.5; ctx.strokeRect(W - 98, py - 10, 94, 18);
    ctx.fillStyle = C.pink;
    ctx.font = "bold 10px JetBrains Mono";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(`$${fmt(price)}`, W - 6, py);
  }, [candles, price]);

  return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />;
}

// ── MiroFish Network ──────────────────────────────────────────────────────────

function MiroFishNetwork() {
  const ref   = useRef<HTMLCanvasElement>(null);
  const nodes = useRef<Node[]>([]);
  const raf   = useRef<number>(0);
  useCanvasSize(ref);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    nodes.current = initNodes(canvas.width || 800, canvas.height || 220);

    // Pre-render static star field to an offscreen canvas once
    const stars = document.createElement("canvas");
    stars.width  = canvas.width  || 800;
    stars.height = canvas.height || 220;
    const sctx = stars.getContext("2d")!;
    sctx.fillStyle = "rgba(200,200,255,0.4)";
    STARS.forEach(s => {
      sctx.beginPath();
      sctx.arc(s.x * stars.width, s.y * stars.height, 0.7, 0, Math.PI * 2);
      sctx.fill();
    });

    let lastFrame = 0;
    const FRAME_MS = 33;   // cap ~30fps + pause when tab hidden — halves CPU/fan
    const draw = () => {
      const now = performance.now();
      if (document.hidden || now - lastFrame < FRAME_MS) { raf.current = requestAnimationFrame(draw); return; }
      lastFrame = now;
      const ctx = canvas.getContext("2d");
      if (!ctx) { raf.current = requestAnimationFrame(draw); return; }
      const W = canvas.width, H = canvas.height;

      ctx.clearRect(0, 0, W, H);

      const bg = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, W * 0.65);
      bg.addColorStop(0, "rgba(18,5,28,0.98)");
      bg.addColorStop(1, "rgba(4,3,8,0.98)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      ctx.drawImage(stars, 0, 0);

      const ns = nodes.current;
      ns.forEach(n => {
        n.x += n.vx; n.y += n.vy;
        if (n.x - n.r < 2)     { n.x = n.r + 2;     n.vx =  Math.abs(n.vx); }
        if (n.x + n.r > W - 2) { n.x = W - n.r - 2; n.vx = -Math.abs(n.vx); }
        if (n.y - n.r < 2)     { n.y = n.r + 2;     n.vy =  Math.abs(n.vy); }
        if (n.y + n.r > H - 2) { n.y = H - n.r - 2; n.vy = -Math.abs(n.vy); }
      });

      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const dx = ns[i].x - ns[j].x, dy = ns[i].y - ns[j].y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 200) {
            ctx.strokeStyle = `rgba(255,0,255,${((1 - d / 200) * 0.3).toFixed(3)})`;
            ctx.lineWidth = (1 - d / 200) * 1.8;
            ctx.beginPath(); ctx.moveTo(ns[i].x, ns[i].y); ctx.lineTo(ns[j].x, ns[j].y); ctx.stroke();
          }
        }
      }

      ns.forEach(n => {
        const halo = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 3);
        halo.addColorStop(0,   n.glow);
        halo.addColorStop(0.5, n.glow.replace(/[\d.]+\)$/, "0.15)"));
        halo.addColorStop(1,   "transparent");
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 3, 0, Math.PI * 2); ctx.fill();

        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.strokeStyle = n.color; ctx.lineWidth = 1.5;
        ctx.shadowColor = n.color; ctx.shadowBlur = 10;
        ctx.stroke(); ctx.shadowBlur = 0;

        const core = ctx.createRadialGradient(n.x - n.r * 0.3, n.y - n.r * 0.3, 0, n.x, n.y, n.r);
        core.addColorStop(0, n.color + "ff"); core.addColorStop(0.5, n.color + "66"); core.addColorStop(1, n.color + "11");
        ctx.fillStyle = core; ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 0.72, 0, Math.PI * 2); ctx.fill();

        ctx.font = `600 ${Math.max(7, n.r * 0.52)}px JetBrains Mono`;
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillStyle = n.color; ctx.shadowColor = n.color; ctx.shadowBlur = 5;
        ctx.fillText(n.label, n.x, n.y + n.r + 4);
        ctx.shadowBlur = 0;
      });

      raf.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(raf.current);
  }, []);

  return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />;
}

// ── Equity Curve ──────────────────────────────────────────────────────────────

function EquityCurve() {
  const ref  = useRef<HTMLCanvasElement>(null);
  const data = useRef<number[]>([]);
  const raf  = useRef<number>(0);
  useCanvasSize(ref);

  useEffect(() => {
    let p = 980;
    const d: number[] = [];
    for (let i = 0; i < 160; i++) { p += (Math.random() - 0.44) * 14; d.push(p); }
    data.current = d;

    let tick = 0;
    let lastFrame = 0;
    const FRAME_MS = 33;   // cap ~30fps + pause when tab hidden — halves CPU/fan
    const animate = () => {
      const now = performance.now();
      if (document.hidden || now - lastFrame < FRAME_MS) { raf.current = requestAnimationFrame(animate); return; }
      lastFrame = now;
      const canvas = ref.current;
      if (!canvas) { raf.current = requestAnimationFrame(animate); return; }
      const ctx = canvas.getContext("2d");
      if (!ctx) { raf.current = requestAnimationFrame(animate); return; }
      const W = canvas.width, H = canvas.height;

      if (tick++ % 20 === 0) {
        const last = data.current[data.current.length - 1];
        data.current.push(last + (Math.random() - 0.44) * 8);
        if (data.current.length > 200) data.current.shift();
      }

      ctx.clearRect(0, 0, W, H);

      const d = data.current;
      const mn = Math.min(...d) - 10, mx = Math.max(...d) + 10, rng = mx - mn;
      const toX = (i: number) => (i / (d.length - 1)) * W;
      const toY = (v: number) => H - ((v - mn) / rng) * H * 0.9 - H * 0.05;

      const fill = ctx.createLinearGradient(0, 0, 0, H);
      fill.addColorStop(0, "rgba(0,255,136,0.3)");
      fill.addColorStop(1, "rgba(0,255,136,0.0)");
      ctx.beginPath();
      ctx.moveTo(toX(0), H);
      d.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
      ctx.lineTo(toX(d.length - 1), H); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();

      ctx.beginPath();
      d.forEach((v, i) => (i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v))));
      ctx.strokeStyle = C.green; ctx.lineWidth = 1.5;
      ctx.shadowColor = C.green; ctx.shadowBlur = 5;
      ctx.stroke(); ctx.shadowBlur = 0;

      const lx = toX(d.length - 1), ly = toY(d[d.length - 1]);
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 400);
      ctx.beginPath(); ctx.arc(lx, ly, 3 + pulse * 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,255,136,${0.3 + pulse * 0.3})`; ctx.fill();
      ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = C.green; ctx.fill();

      raf.current = requestAnimationFrame(animate);
    };

    animate();
    return () => cancelAnimationFrame(raf.current);
  }, []);

  return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />;
}

// ── Volume Bars ───────────────────────────────────────────────────────────────

function VolumeBars() {
  const ref   = useRef<HTMLCanvasElement>(null);
  const bars  = useRef<{ v: number; up: boolean }[]>([]);
  const raf   = useRef<number>(0);
  useCanvasSize(ref);

  useEffect(() => {
    bars.current = Array.from({ length: 20 }, () => ({ v: 0.2 + Math.random() * 0.8, up: Math.random() > 0.4 }));

    let tick = 0;
    let lastFrame = 0;
    const FRAME_MS = 33;   // cap ~30fps + pause when tab hidden — halves CPU/fan
    const animate = () => {
      const now = performance.now();
      if (document.hidden || now - lastFrame < FRAME_MS) { raf.current = requestAnimationFrame(animate); return; }
      lastFrame = now;
      const canvas = ref.current;
      if (!canvas) { raf.current = requestAnimationFrame(animate); return; }
      const ctx = canvas.getContext("2d");
      if (!ctx) { raf.current = requestAnimationFrame(animate); return; }
      const W = canvas.width, H = canvas.height;

      if (tick++ % 40 === 0) {
        bars.current.shift();
        bars.current.push({ v: 0.2 + Math.random() * 0.8, up: Math.random() > 0.4 });
      }

      ctx.clearRect(0, 0, W, H);
      const bw = Math.floor(W / bars.current.length) - 1;
      bars.current.forEach(({ v, up }, i) => {
        const col = up ? C.green : C.red;
        const bh = v * H, x = i * (bw + 1), y = H - bh;
        const grad = ctx.createLinearGradient(0, y, 0, H);
        grad.addColorStop(0, col + "cc"); grad.addColorStop(1, col + "22");
        ctx.fillStyle = grad; ctx.fillRect(x, y, bw, bh);
      });

      raf.current = requestAnimationFrame(animate);
    };

    animate();
    return () => cancelAnimationFrame(raf.current);
  }, []);

  return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />;
}

// ── Global CSS (injected once) ────────────────────────────────────────────────

const CSS = `
  @keyframes pulseDot  { 0%,100%{opacity:1;} 50%{opacity:0.25;} }
  @keyframes blinkFast { 0%,100%{opacity:1;} 50%{opacity:0;}    }
  .g-pulse { animation: pulseDot  2s ease-in-out infinite; }
  .g-blink { animation: blinkFast 1s step-end    infinite; }
  .gravia * { box-sizing: border-box; }
  .gravia ::-webkit-scrollbar { width: 2px; }
  .gravia ::-webkit-scrollbar-thumb { background: rgba(255,0,255,0.3); }
`;

// ── Main Dashboard ────────────────────────────────────────────────────────────

// These never change — plain constants, not state
const STREAK    = 8;
const TRADES    = 25;
const PNL_PCT   = 109;
const WIN_RATE  = 100.0;
const BRIER     = "0.184";
const EDGE_AVG  = "0.083";

export default function GraviaDashboard() {
  const [price,    setPrice   ] = useState(78125.30);
  const [candles,  setCandles ] = useState<Candle[]>(() => genCandles(78125.30, 60));
  const [clock,    setClock   ] = useState("");
  const [balance,  setBalance ] = useState(3.08);
  const [totalPnl, setTotalPnl] = useState(4382);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-US", { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setPrice(p => {
        const np = p + (Math.random() - 0.49) * 70;
        setCandles(prev => {
          const last = prev[prev.length - 1];
          return [...prev.slice(0, -1), { ...last, c: np, h: Math.max(last.h, np), l: Math.min(last.l, np) }];
        });
        return np;
      });
      setBalance(b => Math.max(0, +(b + (Math.random() - 0.48) * 0.02).toFixed(2)));
      setTotalPnl(t => t + Math.floor((Math.random() - 0.4) * 5));
    }, 1400);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setCandles(prev => {
        const last = prev[prev.length - 1];
        const np: Candle = { o: last.c, c: last.c + (Math.random() - 0.5) * 90, h: 0, l: 0 };
        np.h = np.c + Math.random() * 50; np.l = np.c - Math.random() * 50;
        return [...prev.slice(1), np];
      });
    }, 12000);
    return () => clearInterval(id);
  }, []);

  const pUp = price >= 78125;

  // Shared inline styles for panel separators
  const borderR = `1px solid ${C.pinkDim}`;

  return (
    <div
      className="gravia"
      style={{ width: "100vw", height: "100vh", background: C.bg, fontFamily: "'JetBrains Mono', monospace", display: "flex", flexDirection: "column", overflow: "hidden", color: C.white, fontSize: 11 }}
    >
      <style>{CSS}</style>

      {/* ── TOP BAR ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", height: 38, flexShrink: 0, borderBottom: `1px solid ${C.pinkBorder}`, background: "rgba(8,3,18,0.97)", boxShadow: "0 2px 24px rgba(255,0,255,0.12)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: C.pink, fontWeight: 700, fontSize: 14, letterSpacing: "0.22em", textShadow: "0 0 12px rgba(255,0,255,0.9)" }}>GRAVIA</span>
          <span style={{ color: "#3a2a4a" }}>—</span>
          <span style={{ color: C.dim, letterSpacing: "0.12em", fontSize: 10 }}>BTC POLYMARKET</span>
          <span style={{ color: "#3a2a4a" }}>—</span>
          <span className="g-blink" style={{ color: C.red, fontSize: 9, fontWeight: 700, letterSpacing: "0.15em" }}>● LIVE</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <TopStat label="BTC/USD"     value={`$${fmt(price)}`}             color={C.yellow} />
          <TopStat label="SESSION P&L" value={`+$${totalPnl.toLocaleString()}`} color={C.green}  />
          <TopStat label="TRADES"      value={`${TRADES}/268`}              color={C.cyan}   />
          <TopStat label="WIN RATE"    value={`${WIN_RATE.toFixed(1)}%`}    color={C.green}  />
          <TopStat label="FILL RATE"   value="100.0%"                       color={C.purple} />
          <div style={{ color: C.dim, letterSpacing: "0.06em", fontSize: 11 }}>
            {clock}&nbsp;<span style={{ color: C.pink }}>UTC</span>
          </div>
        </div>
      </div>

      {/* ── MAIN ROW ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", height: "36%", flexShrink: 0, borderBottom: borderR }}>

        {/* Trader card */}
        <div style={{ width: "18%", minWidth: 160, borderRight: borderR, display: "flex", flexDirection: "column" }}>
          <PLabel>GRAVIA_001</PLabel>
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <div style={{ color: C.muted, fontSize: 8, letterSpacing: "0.12em", marginBottom: 4 }}>BALANCE</div>
              <div style={{ color: C.green, fontSize: 28, fontWeight: 700, lineHeight: 1, textShadow: "0 0 22px rgba(0,255,136,0.8)" }}>
                ${balance.toFixed(2)}
              </div>
              <div style={{ color: C.dim, fontSize: 9, marginTop: 3 }}>+2.43% · {TRADES} TRADES</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
              <StatCell label="WIN RATE" value={`${WIN_RATE.toFixed(1)}%`} color={C.green}  />
              <StatCell label="AVG EDGE" value={EDGE_AVG}                  color={C.cyan}   />
              <StatCell label="STREAK"   value={`×${STREAK}`}              color={C.yellow} />
              <StatCell label="BRIER"    value={BRIER}                     color={C.purple} />
            </div>
            <div style={{ marginTop: "auto", padding: "6px 8px", background: "rgba(0,255,136,0.04)", border: `1px solid ${C.greenDim}`, borderRadius: 2 }}>
              <div style={{ color: C.muted, fontSize: 8, marginBottom: 4, letterSpacing: "0.1em" }}>ACTIVE POSITION</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: C.green, fontSize: 10, fontWeight: 600 }}>BTC &gt; $78K · YES</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontSize: 10 }}>
                <span style={{ color: C.dim }}>entry</span>
                <span style={{ color: C.yellow }}>$0.516</span>
                <span style={{ color: C.green, fontWeight: 600 }}>+$3.22</span>
              </div>
            </div>
          </div>
        </div>

        {/* Candlestick chart */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", borderRight: borderR }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "3px 12px", flexShrink: 0, borderBottom: `1px solid ${C.pinkDim}`, background: "rgba(8,3,18,0.6)" }}>
            <Dot color={C.pink} />
            <span style={{ color: C.pink, fontSize: 10, letterSpacing: "0.12em", fontWeight: 700 }}>BTC / USD</span>
            <span style={{ color: "#3a2a4a" }}>│</span>
            <span style={{ color: C.yellow, fontSize: 14, fontWeight: 700, textShadow: "0 0 10px rgba(255,215,0,0.6)" }}>${fmt(price)}</span>
            <span style={{ color: pUp ? C.green : C.red, fontSize: 10 }}>{pUp ? "▲" : "▼"} {Math.abs(price - 78125).toFixed(2)}</span>
            <span style={{ marginLeft: "auto", color: "#3a4a5a", fontSize: 9 }}>1 MIN · OHLCV · SIMULATED</span>
          </div>
          <CandlestickChart candles={candles} price={price} />
        </div>

        {/* Live streak */}
        <div style={{ width: "21%", minWidth: 180, display: "flex", flexDirection: "column" }}>
          <PLabel>#1 TRADER · LIVE STREAK</PLabel>
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
            <div style={{ textAlign: "center" }}>
              <span style={{ color: C.yellow, fontSize: 34, fontWeight: 700, textShadow: "0 0 24px rgba(255,215,0,0.8)" }}>×{STREAK}</span>
              <span style={{ color: C.green, fontSize: 18, fontWeight: 700, marginLeft: 10, textShadow: "0 0 12px rgba(0,255,136,0.8)" }}>+12</span>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 44, paddingBottom: 2 }}>
              {[0.28, 0.55, 0.44, 0.75, 0.38, 0.62, 0.88, 1.0, 0.82, 0.93].map((v, i) => (
                <div key={i} style={{ flex: 1, height: `${v * 100}%`, background: i >= 7 ? `linear-gradient(to top, ${C.pink}, #ff88ff)` : "rgba(255,0,255,0.22)", boxShadow: i >= 7 ? "0 0 8px rgba(255,0,255,0.9)" : "none", borderRadius: 1 }} />
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
              <StatCell label="TOTAL P&L" value={`$${totalPnl.toLocaleString()}`} color={C.green} />
              <StatCell label="ROI"       value={`+${PNL_PCT}%`}                 color={C.cyan}  />
            </div>
            <div style={{ padding: "6px 8px", background: `rgba(255,0,255,0.03)`, border: `1px solid ${C.pinkDim}`, borderRadius: 2, marginTop: "auto" }}>
              <div style={{ color: C.muted, fontSize: 8, marginBottom: 5, letterSpacing: "0.1em" }}>SIGNAL QUALITY</div>
              {[["EDGE AVG", EDGE_AVG, C.yellow], ["TIMESFM P50", "+2.1%", C.cyan], ["5K REJECT", "3", C.red]] .map(([l, v, c]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 9 }}>
                  <span style={{ color: C.dim }}>{l}</span>
                  <span style={{ color: c as string, fontWeight: 600 }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── MIROFISH ──────────────────────────────────────────────────────────── */}
      <div style={{ height: "26%", flexShrink: 0, borderBottom: borderR, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 4, left: 10, zIndex: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <Dot color={C.cyan} />
          <span style={{ color: C.cyan, fontSize: 9, letterSpacing: "0.2em", fontWeight: 700 }}>MIROFISH · LIVE SIGNAL NETWORK · BTC FORCE CHAIN</span>
        </div>
        <div style={{ position: "absolute", top: 5, right: 10, zIndex: 10, display: "flex", gap: 14, fontSize: 8 }}>
          {[["BULL", C.green], ["BEAR", C.red], ["CATALYST", C.orange], ["CLUSTER", C.purple], ["RESIST", C.pink]].map(([l, c]) => (
            <span key={l} style={{ color: c as string, display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: c as string, boxShadow: `0 0 5px ${c}`, display: "inline-block" }} />
              {l}
            </span>
          ))}
        </div>
        <div style={{ position: "absolute", bottom: 6, left: 10, zIndex: 10, display: "flex", gap: 8 }}>
          {[["BEAR", "95.5%", C.red], ["1,209", "NODES", C.dim], ["651", "LINKS", C.dim], ["18", "ACTIVE", C.green]].map(([v, l, c]) => (
            <div key={l} style={{ padding: "2px 7px", background: "rgba(0,0,0,0.6)", border: `1px solid ${(c as string) + "33"}`, fontSize: 9 }}>
              <span style={{ color: c as string, fontWeight: 700 }}>{v}</span>
              <span style={{ color: C.muted, marginLeft: 4 }}>{l}</span>
            </div>
          ))}
        </div>
        <MiroFishNetwork />
      </div>

      {/* ── BOTTOM ROW ────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, borderBottom: borderR }}>
        <div style={{ width: "22%", minWidth: 160, borderRight: `1px solid ${C.pinkDim}`, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "3px 10px", borderBottom: `1px solid ${C.pinkDim}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
            <span style={{ color: C.dim, fontSize: 8, letterSpacing: "0.12em" }}>EQUITY CURVE</span>
            <span style={{ color: C.green, fontWeight: 700, fontSize: 10 }}>+$2.08</span>
          </div>
          <EquityCurve />
        </div>

        <div style={{ flex: 1, borderRight: `1px solid ${C.pinkDim}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "3px 10px", borderBottom: `1px solid ${C.pinkDim}`, flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: C.dim, fontSize: 8, letterSpacing: "0.12em" }}>PRICE TABLE · LIVE</span>
            <span style={{ marginLeft: "auto", color: C.muted, fontSize: 8 }}>MM · ANALYST</span>
          </div>
          <div style={{ overflow: "auto", flex: 1 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
              <thead>
                <tr>
                  {["PRICE", "PROB %", "CHNG", "SIZE"].map((h, i) => (
                    <th key={h} style={{ padding: "3px 8px", textAlign: i === 0 ? "left" : "right", fontWeight: 400, fontSize: 8, letterSpacing: "0.1em", color: "#3a4a5a", borderBottom: `1px solid ${C.pinkDim}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PRICE_ROWS.map((row, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid rgba(26,37,53,0.5)` }}>
                    <td style={{ padding: "3px 8px", color: C.yellow }}>${row.price.toLocaleString()}</td>
                    <td style={{ padding: "3px 8px", textAlign: "right", color: C.dim }}>{row.pct}%</td>
                    <td style={{ padding: "3px 8px", textAlign: "right", color: row.chg.startsWith("+") ? C.green : C.red }}>{row.chg}</td>
                    <td style={{ padding: "3px 8px", textAlign: "right", color: C.muted }}>{row.size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ width: "22%", minWidth: 160, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "3px 10px", borderBottom: `1px solid ${C.pinkDim}`, flexShrink: 0 }}>
            <span style={{ color: C.dim, fontSize: 8, letterSpacing: "0.12em" }}>VOLUME ANALYTICS</span>
          </div>
          <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ color: C.muted, fontSize: 8 }}>24H TRADES</span>
              <span style={{ color: C.cyan, fontSize: 15, fontWeight: 700, textShadow: "0 0 10px rgba(0,212,255,0.6)" }}>2,417</span>
            </div>
            <VolumeBars />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ color: C.muted, fontSize: 8 }}>24H VOLUME</span>
              <span style={{ color: C.yellow, fontSize: 13, fontWeight: 700, textShadow: "0 0 8px rgba(255,215,0,0.6)" }}>1,002K</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── EXECUTION LOG ─────────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0, height: 88, background: "rgba(4,3,10,0.97)", borderTop: `1px solid ${C.pinkBorder}`, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 12px 2px", borderBottom: `1px solid rgba(255,51,85,0.2)` }}>
          <Dot color={C.red} />
          <span style={{ color: C.red, fontSize: 8, letterSpacing: "0.22em", fontWeight: 700 }}>EXECUTION LOG · LIVE</span>
          <span style={{ marginLeft: "auto", color: C.muted, fontSize: 8 }}>POLY-HFT ENGINE v2.5 · TimesFM + Gemma4 + Kronos</span>
        </div>
        <div style={{ overflow: "hidden", height: 64 }}>
          {LOG_ENTRIES.map((e, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 12px", fontSize: 9, borderBottom: "1px solid rgba(20,30,45,0.7)", fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ color: C.muted, minWidth: 24 }}>#{e.id}</span>
              <span style={{ color: e.c, fontWeight: 700, minWidth: 30 }}>{e.dir}</span>
              <span style={{ color: e.c, fontWeight: 700, minWidth: 80 }}>{e.amt}</span>
              <span style={{ color: C.dim, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.txt}</span>
              <span style={{ color: "#3a4a5a", fontSize: 8, flexShrink: 0 }}>{new Date(Date.now() - i * 18000).toLocaleTimeString("en-US", { hour12: false })}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
