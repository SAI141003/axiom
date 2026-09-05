"use client";

import { useEffect, useRef } from "react";

/**
 * FaceCore — a left-facing PROFILE HEAD rendered as a glowing plexus point
 * cloud (Yuichiro-Chino style): the silhouette (forehead → nose → lips →
 * chin → jaw → back of skull) in blue, a bright wrinkled BRAIN inside the
 * upper skull, a network mesh dissolving off to the left, and binary streams
 * drifting through it.
 *
 * Every network node that streams IN from the left is REAL data (props):
 *   green/red trades (size ∝ |P&L|), cyan news, amber brain opinions,
 *   violet agent events — flowing along the mesh and absorbed by the brain.
 *
 * Alive: the eye blinks and its iris tracks the cursor; the mouth bends with
 * today's real P&L (mood); the whole head breathes; synapses fire in the brain.
 */

export interface DataMote {
  label: string;
  kind: "win" | "loss" | "news" | "opinion" | "event";
  mag: number;
}
const KIND_COLOR: Record<DataMote["kind"], [number, number, number]> = {
  win: [52, 211, 153], loss: [248, 113, 113], news: [34, 211, 238],
  opinion: [251, 191, 36], event: [167, 139, 250],
};

// Left-facing profile silhouette (x<0 = face/left, x>0 = back of head).
// Hand-traced anchors, normalized; interpolated into a dense point cloud.
const PROFILE: [number, number][] = [
  [0.16, -0.97], [-0.12, -0.94], [-0.36, -0.84], [-0.52, -0.60],
  [-0.585, -0.36], [-0.56, -0.22], [-0.585, -0.14],  // forehead → brow → nose bridge dip
  [-0.70, -0.02], [-0.83, 0.08], [-0.79, 0.12],      // nose ridge → sharp tip → underside
  [-0.62, 0.15], [-0.585, 0.19],                     // nostril → philtrum
  [-0.70, 0.25], [-0.60, 0.29], [-0.685, 0.35],      // upper lip (out) → mouth → lower lip (out)
  [-0.55, 0.42], [-0.615, 0.54],                     // chin crease → chin (round)
  [-0.45, 0.64], [-0.18, 0.71], [-0.11, 0.87],       // jaw → neck front
  [0.17, 0.75], [0.42, 0.56], [0.60, 0.28],          // under-jaw → back neck → back head
  [0.69, -0.05], [0.61, -0.44], [0.40, -0.76], [0.16, -0.97],
];

interface Pt { x: number; y: number; kind: "line" | "brain" | "bright"; }

export default function FaceCore({
  size = 620, motes = [], mood = 0, activity = 0.5,
}: { size?: number; motes?: DataMote[]; mood?: number; activity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const propRef = useRef({ motes, mood, activity });
  propRef.current = { motes, mood, activity };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr; canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // ── build silhouette point cloud (dense, jittered) ──
    const pts: Pt[] = [];
    for (let i = 0; i < PROFILE.length - 1; i++) {
      const [ax, ay] = PROFILE[i], [bx, by] = PROFILE[i + 1];
      const seg = Math.hypot(bx - ax, by - ay);
      const n = Math.max(5, Math.round(seg * 44));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        pts.push({
          x: ax + (bx - ax) * t + (Math.random() - 0.5) * 0.02,
          y: ay + (by - ay) * t + (Math.random() - 0.5) * 0.02,
          kind: "line",
        });
      }
    }
    const SIL_COUNT = pts.length;

    // ── brain cluster inside the upper-front skull ──
    const BRAIN_CX = -0.12, BRAIN_CY = -0.44, BRW = 0.42, BRH = 0.34;
    const brainStart = pts.length;
    for (let i = 0; i < 260; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.7);
      // wrinkle the radius so it reads as cortex, squash to skull shape
      const wob = 1 + 0.18 * Math.sin(a * 6) + 0.12 * Math.sin(a * 11 + r * 5);
      const x = BRAIN_CX + Math.cos(a) * r * BRW * wob;
      const y = BRAIN_CY + Math.sin(a) * r * BRH * wob * (Math.sin(a) < 0 ? 1 : 0.82);
      pts.push({ x, y, kind: Math.random() < 0.45 ? "bright" : "brain" });
    }
    const brainIdx: number[] = [];
    for (let i = brainStart; i < pts.length; i++) brainIdx.push(i);

    // ── left network nodes (static mesh points, faint) ──
    interface Node { x: number; y: number; ph: number; }
    const nodes: Node[] = Array.from({ length: 34 }, () => ({
      x: -1.45 + Math.random() * 0.85,
      y: -0.95 + Math.random() * 1.9,
      ph: Math.random() * 6.28,
    }));
    // precompute near-neighbor edges
    const edges: [number, number][] = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < 0.42)
          edges.push([i, j]);

    // ── binary rain particles ──
    interface Bit { x: number; y: number; ch: string; sp: number; a: number; }
    const bits: Bit[] = Array.from({ length: 46 }, () => ({
      x: -1.5 + Math.random() * 1.9, y: -1 + Math.random() * 2,
      ch: Math.random() < 0.5 ? "0" : "1",
      sp: 0.02 + Math.random() * 0.05, a: 0.2 + Math.random() * 0.4,
    }));

    // ── data motes streaming in from the left into the brain ──
    interface Fly { m: DataMote; x: number; y: number; born: number; absorbed: number | null; }
    let flies: Fly[] = [];
    let cursor = 0;

    // ── eye (single, on profile) + mouth ──
    const EYE = { x: -0.40, y: -0.20 };
    const gaze = { x: 0, y: 0, tx: 0, ty: 0 };
    let nextBlink = performance.now() + 2500, blinkT = -1, nextSac = 0;
    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      gaze.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      gaze.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
      nextSac = performance.now() + 3000;
    };
    canvas.addEventListener("mousemove", onMove);

    const cx = size / 2, cy = size / 2, S = size * 0.42;
    const T = (x: number, y: number) => ({ sx: cx + x * S, sy: cy + y * S });

    let raf = 0, last = performance.now();
    let lastFrame = 0;
    const FRAME_MS = 33;   // cap ~30fps + pause when tab hidden — halves CPU/fan
    let synflash: { a: number; b: number; born: number }[] = [];

    const render = (now: number) => {
      if (document.hidden || now - lastFrame < FRAME_MS) { raf = requestAnimationFrame(render); return; }
      lastFrame = now;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const { mood, activity: act, motes: ms } = propRef.current;
      const breathe = 0.86 + 0.14 * Math.sin(now / 1600);
      ctx.clearRect(0, 0, size, size);

      // background head glow (behind everything)
      const bc = T(BRAIN_CX, BRAIN_CY);
      const halo = ctx.createRadialGradient(bc.sx, bc.sy, 4, bc.sx, bc.sy, S * 0.9);
      halo.addColorStop(0, `rgba(56,189,248,${0.16 * breathe + act * 0.06})`);
      halo.addColorStop(0.5, `rgba(37,99,235,${0.05})`);
      halo.addColorStop(1, "rgba(37,99,235,0)");
      ctx.fillStyle = halo; ctx.fillRect(0, 0, size, size);

      // ── binary rain ──
      ctx.font = `${Math.round(size * 0.018)}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      for (const b of bits) {
        b.y += b.sp * dt * 6; if (b.y > 1.05) { b.y = -1.05; b.x = -1.5 + Math.random() * 1.9; }
        const p = T(b.x, b.y);
        ctx.fillStyle = `rgba(120,190,255,${b.a * (0.5 + 0.5 * Math.sin(now / 800 + b.x * 5))})`;
        ctx.fillText(b.ch, p.sx, p.sy);
      }

      // ── left network edges ──
      for (const [i, j] of edges) {
        const A = T(nodes[i].x, nodes[i].y), B = T(nodes[j].x, nodes[j].y);
        const a = 0.10 + 0.10 * Math.sin(now / 1200 + nodes[i].ph);
        ctx.strokeStyle = `rgba(90,160,240,${a})`; ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.stroke();
      }
      for (const n of nodes) {
        const p = T(n.x, n.y);
        ctx.fillStyle = `rgba(150,200,255,${0.35 + 0.25 * Math.sin(now / 900 + n.ph)})`;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, 1.4, 0, 7); ctx.fill();
      }

      // ── spawn + fly data motes from far-left into the brain ──
      if (Math.random() < dt * (2.5 + act * 7) && ms.length) {
        const src = nodes[(Math.random() * nodes.length) | 0];
        flies.push({ m: ms[cursor++ % ms.length], x: src.x, y: src.y, born: now, absorbed: null });
        if (flies.length > 40) flies.shift();
      }
      ctx.textAlign = "left";
      ctx.font = "8px ui-monospace, monospace";
      for (const f of flies) {
        if (f.absorbed) continue;
        const dx = BRAIN_CX - f.x, dy = BRAIN_CY - f.y;
        const d = Math.hypot(dx, dy);
        f.x += (dx / d) * dt * 0.9 * (0.6 + act); f.y += (dy / d) * dt * 0.9 * (0.6 + act);
        if (d < 0.18) f.absorbed = now;
        const p = T(f.x, f.y);
        const [r, g, b] = KIND_COLOR[f.m.kind];
        const sz = 1.5 + f.m.mag * 4;
        ctx.fillStyle = `rgba(${r},${g},${b},0.95)`;
        ctx.shadowColor = `rgba(${r},${g},${b},0.9)`; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, sz, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = `rgba(${r},${g},${b},0.7)`;
        ctx.fillText(f.m.label.slice(0, 18), p.sx + sz + 3, p.sy + 2.5);
      }
      for (const f of flies) if (f.absorbed) {
        const k = 1 - (now - f.absorbed) / 450;
        const [r, g, b] = KIND_COLOR[f.m.kind];
        const gl = ctx.createRadialGradient(bc.sx, bc.sy, 0, bc.sx, bc.sy, 22 * k);
        gl.addColorStop(0, `rgba(${r},${g},${b},${0.7 * k})`); gl.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(bc.sx, bc.sy, 22 * k, 0, 7); ctx.fill();
      }
      flies = flies.filter((f) => !f.absorbed || now - f.absorbed < 450);

      // ── brain interior synapses ──
      if (Math.random() < dt * (3 + act * 10) && brainIdx.length) {
        synflash.push({ a: brainIdx[(Math.random() * brainIdx.length) | 0],
                        b: brainIdx[(Math.random() * brainIdx.length) | 0], born: now });
        if (synflash.length > 18) synflash.shift();
      }
      synflash = synflash.filter((s) => now - s.born < 500);
      for (const s of synflash) {
        const f = 1 - (now - s.born) / 500;
        const A = T(pts[s.a].x, pts[s.a].y), B = T(pts[s.b].x, pts[s.b].y);
        ctx.strokeStyle = `rgba(140,230,255,${0.5 * f})`; ctx.lineWidth = 0.8 * f + 0.2;
        ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.stroke();
      }

      // ── brain bloom ──
      const bloom = ctx.createRadialGradient(bc.sx, bc.sy, 2, bc.sx, bc.sy, S * 0.42);
      bloom.addColorStop(0, `rgba(200,240,255,${0.28 * breathe})`);
      bloom.addColorStop(0.5, `rgba(56,189,248,${0.10})`);
      bloom.addColorStop(1, "rgba(56,189,248,0)");
      ctx.fillStyle = bloom; ctx.beginPath(); ctx.arc(bc.sx, bc.sy, S * 0.42, 0, 7); ctx.fill();

      // ── gaze + blink ──
      if (now > nextSac) { gaze.tx = (Math.random() - 0.5); gaze.ty = (Math.random() - 0.5) * 0.7; nextSac = now + 1800 + Math.random() * 2600; }
      gaze.x += (gaze.tx - gaze.x) * Math.min(1, dt * 6);
      gaze.y += (gaze.ty - gaze.y) * Math.min(1, dt * 6);
      if (blinkT < 0 && now > nextBlink) { blinkT = now; nextBlink = now + 2400 + Math.random() * 3500; }
      let lid = 0;
      if (blinkT > 0) { const p = (now - blinkT) / 240; lid = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2); if (p >= 1) blinkT = -1; }

      // ── draw silhouette + brain points ──
      const curve = -mood * 0.06;
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        let { x, y } = pt;
        // mouth region bends with mood (profile lips ≈ y 0.24..0.37, x near -0.63)
        if (y > 0.22 && y < 0.40 && x < -0.5) y += curve;
        const p = T(x, y);
        if (pt.kind === "line") {
          // brighter, slightly larger silhouette points + soft glow so the
          // profile reads crisply as a face
          ctx.fillStyle = `rgba(150,205,255,${0.9 * breathe})`;
          ctx.shadowColor = "rgba(90,170,255,0.6)"; ctx.shadowBlur = 3;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, 1.35, 0, 7); ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          const bright = pt.kind === "bright";
          ctx.fillStyle = bright
            ? `rgba(210,245,255,${(0.7 + 0.3 * Math.sin(now / 500 + i)) * breathe})`
            : `rgba(90,200,255,${0.5 * breathe})`;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, bright ? 1.5 : 1.0, 0, 7); ctx.fill();
        }
      }

      // ── the eye ──
      const ep = T(EYE.x + gaze.x * 0.02, EYE.y);
      const ew = S * 0.055, eh = S * 0.03 * (1 - lid * 0.9);
      ctx.strokeStyle = `rgba(160,220,255,${0.85 * breathe})`; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.ellipse(ep.sx, ep.sy, ew, Math.max(1, eh), 0, 0, 7); ctx.stroke();
      if (eh > 2.5) {
        const ix = ep.sx + gaze.x * ew * 0.5, iy = ep.sy + gaze.y * eh * 0.6;
        const ir = ctx.createRadialGradient(ix, iy, 0, ix, iy, ew * 0.6);
        ir.addColorStop(0, "rgba(255,255,255,0.95)");
        ir.addColorStop(0.4, "rgba(56,189,248,0.9)");
        ir.addColorStop(1, "rgba(56,189,248,0)");
        ctx.fillStyle = ir; ctx.beginPath(); ctx.arc(ix, iy, ew * 0.6, 0, 7); ctx.fill();
        ctx.fillStyle = "rgba(6,12,24,0.95)"; ctx.beginPath(); ctx.arc(ix, iy, ew * 0.2, 0, 7); ctx.fill();
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => { cancelAnimationFrame(raf); canvas.removeEventListener("mousemove", onMove); };
  }, [size]);

  return <canvas ref={ref} style={{ width: size, height: size, display: "block" }} />;
}
