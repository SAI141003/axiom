"use client";

import { useEffect, useRef } from "react";

/**
 * BrainCore — a living neural brain (pure canvas, no deps).
 *
 * Anatomy: two wrinkled hemispheres + cerebellum + brainstem as a 3D point
 * cloud. Over it: glowing neural filaments tracing the cortex, colored
 * energy nodes, dendrites branching outward, roots grounding the stem, and
 * bright pulses traveling the network — the reference-image look.
 *
 * Interaction: hovering rotates the brain with the cursor (x = spin,
 * y = tilt); it eases back to a slow auto-rotate when the cursor leaves.
 * `activity` (real system activity) drives pulse rate and glow.
 */
export interface DataMote {
  label: string;
  kind: "win" | "loss" | "news" | "opinion" | "event";
  mag: number;
}
const MOTE_COLOR: Record<DataMote["kind"], [number, number, number]> = {
  win: [52, 211, 153], loss: [248, 113, 113], news: [34, 211, 238],
  opinion: [251, 191, 36], event: [167, 139, 250],
};

export default function BrainCore({
  size = 480,
  activity = 0.5,
  stars = false,
  motes = [],
}: { size?: number; activity?: number; stars?: boolean; motes?: DataMote[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const actRef = useRef(activity);
  actRef.current = activity;
  const motesRef = useRef(motes);
  motesRef.current = motes;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // ══ 1. anatomy point cloud ══════════════════════════════════════════
    interface P { x: number; y: number; z: number }
    const pts: P[] = [];
    const NC = 940;
    for (let i = 0; i < NC; i++) {
      const t = i / NC;
      const phi = Math.acos(1 - 2 * t);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      let x = Math.sin(phi) * Math.cos(theta);
      let y = Math.cos(phi);
      let z = Math.sin(phi) * Math.sin(theta);
      const fold = 1
        + 0.055 * Math.sin(9 * Math.atan2(y, x) + 4 * z)
        + 0.045 * Math.sin(13 * z + 5 * Math.atan2(y, x))
        + 0.03 * Math.sin(7 * (x * 2 + z));
      x *= 0.74 * fold; y *= 0.72 * fold; z *= 1.02 * fold;
      if (y < -0.32) y = -0.32 - (y + 0.32) * 0.25;
      if (y < 0.05 && y > -0.4 && Math.abs(x) > 0.3 && z > -0.35) { x *= 1.16; y -= 0.06; }
      if (z > 0.62) { x *= 0.86; y -= (z - 0.62) * 0.28; }
      if (z < -0.66) z = -0.66 - (z + 0.66) * 0.55;
      if (y > -0.05) {
        const gap = 0.085 * Math.min(1, (y + 0.05) * 2.2);
        x += x >= 0 ? gap : -gap;
        if (Math.abs(x) < 0.16) y -= (0.16 - Math.abs(x)) * 0.5;
      }
      pts.push({ x, y, z });
    }
    const NB = 150;
    for (let i = 0; i < NB; i++) {
      const t = i / NB;
      const phi = Math.acos(1 - 2 * t);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const ridge = 1 + 0.05 * Math.sin(16 * Math.cos(phi));
      pts.push({
        x: Math.sin(phi) * Math.cos(theta) * 0.46 * ridge,
        y: Math.cos(phi) * 0.28 * ridge - 0.38,
        z: Math.sin(phi) * Math.sin(theta) * 0.34 * ridge - 0.52,
      });
    }
    const stemBase: number[] = [];
    const NS = 55;
    for (let i = 0; i < NS; i++) {
      const u = i / NS;
      const ang = Math.random() * Math.PI * 2;
      const r = 0.11 * (1 - u * 0.35);
      pts.push({ x: Math.cos(ang) * r, y: -0.30 - u * 0.34, z: -0.18 + u * 0.16 + Math.sin(ang) * r });
      if (u > 0.8) stemBase.push(pts.length - 1);
    }
    const N = pts.length;

    // ══ 2. neural filaments — random walks between nearby surface points ══
    const PALETTE = [
      [34, 211, 238],   // cyan
      [167, 139, 250],  // violet
      [251, 191, 36],   // amber
      [244, 114, 182],  // pink
      [96, 165, 250],   // blue
    ];
    interface Branch { idx: number[]; color: number[]; w: number }
    const branches: Branch[] = [];
    const nearIdx = (from: number): number => {
      // pick a random point reasonably close in 3D
      let best = -1, bestD = 1e9;
      for (let k = 0; k < 14; k++) {
        const j = (Math.random() * NC) | 0;
        if (j === from) continue;
        const a = pts[from], b = pts[j];
        const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
        if (d > 0.005 && d < bestD) { bestD = d; best = j; }
      }
      return best;
    };
    for (let b = 0; b < 42; b++) {
      const idx = [(Math.random() * NC) | 0];
      for (let s = 0; s < 6 + ((Math.random() * 5) | 0); s++) {
        const nxt = nearIdx(idx[idx.length - 1]);
        if (nxt < 0) break;
        idx.push(nxt);
      }
      if (idx.length > 3) branches.push({
        idx,
        color: PALETTE[b % PALETTE.length],
        w: 0.8 + Math.random() * 1.4,
      });
    }

    // ══ 3. energy nodes — bright colored orbs on the cortex ══
    const nodes = Array.from({ length: 26 }, (_, i) => ({
      p: (Math.random() * NC) | 0,
      color: PALETTE[i % PALETTE.length],
      r: 3 + Math.random() * 5,
      ph: Math.random() * 6.28,
    }));

    // ══ 4. dendrites — branching tendrils growing outward ══
    interface Tendril { base: P; dir: P; len: number; twigs: { at: number; dir: P; len: number }[] }
    const tendrils: Tendril[] = [];
    for (let i = 0; i < 16; i++) {
      const p = pts[(Math.random() * NC) | 0];
      const m = Math.hypot(p.x, p.y, p.z) || 1;
      const dir = { x: p.x / m, y: p.y / m, z: p.z / m };
      tendrils.push({
        base: p, dir, len: 0.25 + Math.random() * 0.4,
        twigs: Array.from({ length: 2 + ((Math.random() * 3) | 0) }, () => ({
          at: 0.3 + Math.random() * 0.6,
          dir: { x: dir.x + (Math.random() - 0.5) * 1.2, y: dir.y + (Math.random() - 0.5) * 1.2, z: dir.z + (Math.random() - 0.5) * 1.2 },
          len: 0.08 + Math.random() * 0.15,
        })),
      });
    }

    // ══ 5. pulses traveling along branches ══
    interface Pulse { b: number; t: number; v: number }
    let pulses: Pulse[] = [];

    // ══ 5b. data motes — REAL trades/news/opinions spiralling into the mind ══
    interface Fly { m: DataMote; ang: number; rad: number; y: number; born: number; absorbed: number | null }
    let flies: Fly[] = [];
    let moteCursor = 0;

    // ══ 6. roots — screen-space curves grounding the stem ══
    const rootSeeds = Array.from({ length: 9 }, (_, i) => ({
      dx: (i - 4) / 4 + (Math.random() - 0.5) * 0.2,
      sway: Math.random() * 6.28,
      w: 0.6 + Math.random() * 1.2,
    }));

    // starfield
    const starPts = stars ? Array.from({ length: 150 }, () => ({
      x: Math.random() * size, y: Math.random() * size,
      r: Math.random() * 1.1 + 0.2, tw: Math.random() * 6.28,
    })) : [];

    // ══ hover interaction ══
    const hover = { on: false, dx: 0, dy: 0 };
    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      hover.on = true;
      hover.dx = ((e.clientX - r.left) / r.width - 0.5) * 2;   // −1..1
      hover.dy = ((e.clientY - r.top) / r.height - 0.5) * 2;
    };
    const onLeave = () => { hover.on = false; };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);

    let rot = 0.6, spinV = 0.3, tilt = 0.1;
    let raf = 0;
    let last = performance.now();
    let lastFrame = 0;
    const FRAME_MS = 33;   // cap ~30fps + pause when tab hidden — halves CPU/fan

    const render = (now: number) => {
      if (document.hidden || now - lastFrame < FRAME_MS) { raf = requestAnimationFrame(render); return; }
      lastFrame = now;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const act = actRef.current;

      // rotation: cursor drives spin & tilt, eases back when idle
      const targetV = hover.on ? hover.dx * 2.2 : 0.3 + act * 0.3;
      spinV += (targetV - spinV) * Math.min(1, dt * 3);
      rot += spinV * dt;
      const targetTilt = hover.on ? hover.dy * 0.45 : 0.1 + Math.sin(now / 2600) * 0.08;
      tilt += (targetTilt - tilt) * Math.min(1, dt * 3);
      const breathe = 0.85 + 0.15 * Math.sin(now / 1400);

      const cx = size / 2, cy = size / 2;
      const scale = size * 0.42;
      ctx.clearRect(0, 0, size, size);

      for (const s of starPts) {
        const a = 0.25 + 0.2 * Math.sin(now / 1900 + s.tw);
        ctx.fillStyle = `rgba(148,163,184,${a})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill();
      }

      const halo = ctx.createRadialGradient(cx, cy, size * 0.1, cx, cy, size * 0.52);
      halo.addColorStop(0, `rgba(99,102,241,${0.12 * breathe + act * 0.06})`);
      halo.addColorStop(1, "rgba(99,102,241,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      // project all points
      const cosY = Math.cos(rot), sinY = Math.sin(rot);
      const cosX = Math.cos(tilt), sinX = Math.sin(tilt);
      const project = (p: P) => {
        const x1 = p.x * cosY + p.z * sinY;
        const z1 = -p.x * sinY + p.z * cosY;
        const y1 = p.y * cosX - z1 * sinX;
        const z2 = p.y * sinX + z1 * cosX;
        const persp = 1 / (1.9 - z2 * 0.55);
        return { sx: cx + x1 * scale * persp, sy: cy + y1 * scale * persp, depth: z2 };
      };
      const proj = pts.map(project);

      // ── roots: wavy energy grounding from the stem to the bottom edge ──
      const stemPt = stemBase.length ? proj[stemBase[0]] : { sx: cx, sy: cy + scale * 0.5 };
      for (const r of rootSeeds) {
        const sway = Math.sin(now / 1700 + r.sway) * size * 0.03;
        const endX = cx + r.dx * size * 0.42 + sway;
        const g = ctx.createLinearGradient(stemPt.sx, stemPt.sy, endX, size);
        g.addColorStop(0, `rgba(129,140,248,${0.30 * breathe})`);
        g.addColorStop(1, "rgba(34,211,238,0.03)");
        ctx.strokeStyle = g;
        ctx.lineWidth = r.w;
        ctx.beginPath();
        ctx.moveTo(stemPt.sx, stemPt.sy);
        ctx.bezierCurveTo(
          stemPt.sx + sway, stemPt.sy + (size - stemPt.sy) * 0.4,
          endX - sway, stemPt.sy + (size - stemPt.sy) * 0.75,
          endX, size,
        );
        ctx.stroke();
      }

      // ── dendrites: tendrils growing outward, rotate with the brain ──
      for (const td of tendrils) {
        const a = project(td.base);
        const tip = project({
          x: td.base.x + td.dir.x * td.len,
          y: td.base.y + td.dir.y * td.len,
          z: td.base.z + td.dir.z * td.len,
        });
        const fade = (a.depth + 1.2) / 2.2;
        ctx.strokeStyle = `rgba(96,165,250,${0.22 * fade * breathe})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(tip.sx, tip.sy); ctx.stroke();
        for (const tw of td.twigs) {
          const at = {
            x: td.base.x + td.dir.x * td.len * tw.at,
            y: td.base.y + td.dir.y * td.len * tw.at,
            z: td.base.z + td.dir.z * td.len * tw.at,
          };
          const p1 = project(at);
          const p2 = project({ x: at.x + tw.dir.x * tw.len, y: at.y + tw.dir.y * tw.len, z: at.z + tw.dir.z * tw.len });
          ctx.strokeStyle = `rgba(96,165,250,${0.14 * fade * breathe})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.moveTo(p1.sx, p1.sy); ctx.lineTo(p2.sx, p2.sy); ctx.stroke();
        }
      }

      // ── point cloud (structure) ──
      const order = proj.map((_, i) => i).sort((i, j) => proj[i].depth - proj[j].depth);
      for (const i of order) {
        const p = proj[i];
        const lit = (p.depth + 1) / 2;
        const alpha = (0.10 + lit * 0.45) * breathe;
        ctx.fillStyle = lit > 0.72 ? `rgba(34,211,238,${alpha})` : `rgba(129,140,248,${alpha})`;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 0.6 + lit * 1.3, 0, 7);
        ctx.fill();
      }

      // ── neural filaments: two-pass glow strokes along the cortex ──
      for (const br of branches) {
        const [r, g, b] = br.color;
        const ps = br.idx.map((i) => proj[i]);
        const fade = Math.max(0, (ps[0].depth + 1.1) / 2.1);
        for (const pass of [[br.w * 3.2, 0.06], [br.w, 0.34]] as const) {
          ctx.strokeStyle = `rgba(${r},${g},${b},${pass[1] * fade * breathe})`;
          ctx.lineWidth = pass[0];
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(ps[0].sx, ps[0].sy);
          for (let k = 1; k < ps.length - 1; k++) {
            ctx.quadraticCurveTo(ps[k].sx, ps[k].sy, (ps[k].sx + ps[k + 1].sx) / 2, (ps[k].sy + ps[k + 1].sy) / 2);
          }
          ctx.stroke();
        }
      }

      // ── pulses traveling the filaments ──
      if (Math.random() < dt * (3 + act * 12) && branches.length) {
        pulses.push({ b: (Math.random() * branches.length) | 0, t: 0, v: 0.4 + Math.random() * 0.7 });
        if (pulses.length > 30) pulses.shift();
      }
      pulses = pulses.filter((p) => p.t < 1);
      for (const pu of pulses) {
        pu.t += pu.v * dt;
        const br = branches[pu.b];
        const f = pu.t * (br.idx.length - 1);
        const k = Math.min(br.idx.length - 2, f | 0);
        const frac = f - k;
        const A = proj[br.idx[k]], B = proj[br.idx[k + 1]];
        const x = A.sx + (B.sx - A.sx) * frac, y = A.sy + (B.sy - A.sy) * frac;
        const [r, g, b] = br.color;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 7);
        glow.addColorStop(0, `rgba(255,255,255,0.9)`);
        glow.addColorStop(0.3, `rgba(${r},${g},${b},0.7)`);
        glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
      }

      // ── energy nodes: colored orbs with soft bloom ──
      for (const nd of nodes) {
        const p = proj[nd.p];
        const lit = (p.depth + 1) / 2;
        const pulse = 0.6 + 0.4 * Math.sin(now / 900 + nd.ph);
        const R = nd.r * (0.7 + lit * 0.6) * pulse;
        const [r, g, b] = nd.color;
        const glow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, R * 3);
        glow.addColorStop(0, `rgba(255,255,255,${0.55 * lit})`);
        glow.addColorStop(0.25, `rgba(${r},${g},${b},${0.5 * lit})`);
        glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, R * 3, 0, 7); ctx.fill();
      }

      // ── data motes: REAL trades/news/opinions spiral in and are absorbed ──
      const ms = motesRef.current;
      if (ms.length && Math.random() < dt * (2.5 + act * 7)) {
        flies.push({ m: ms[moteCursor++ % ms.length], ang: Math.random() * 6.28,
                     rad: size * (0.52 + Math.random() * 0.08),
                     y: (Math.random() - 0.5) * size * 0.5, born: now, absorbed: null });
        if (flies.length > 40) flies.shift();
      }
      ctx.textAlign = "left";
      ctx.font = "8px ui-monospace, monospace";
      for (const f of flies) {
        const [r, g, b] = MOTE_COLOR[f.m.kind];
        if (f.absorbed !== null) {
          const k = Math.max(0, 1 - (now - f.absorbed) / 480);
          const rr = Math.max(0.5, 26 * k);           // radius must stay ≥ 0
          const gl = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
          gl.addColorStop(0, `rgba(${r},${g},${b},${0.7 * k})`);
          gl.addColorStop(1, `rgba(${r},${g},${b},0)`);
          ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, 7); ctx.fill();
          continue;
        }
        f.ang += dt * 0.7;
        f.rad -= size * 0.05 * dt * (1 + act);
        f.y *= 1 - dt * 1.5;
        if (f.rad < scale * 0.5) f.absorbed = now;
        const x = cx + Math.cos(f.ang) * f.rad;
        const y = cy + Math.sin(f.ang) * f.rad * 0.55 + f.y;
        const sz = 1.6 + f.m.mag * 4;
        ctx.fillStyle = `rgba(${r},${g},${b},0.95)`;
        ctx.shadowColor = `rgba(${r},${g},${b},0.9)`; ctx.shadowBlur = 7;
        ctx.beginPath(); ctx.arc(x, y, sz, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = `rgba(${r},${g},${b},0.72)`;
        ctx.fillText(f.m.label.slice(0, 20), x + sz + 3, y + 2.5);
      }
      flies = flies.filter((f) => f.absorbed === null || now - f.absorbed < 480);

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  }, [size, stars]);

  return (
    <canvas ref={ref}
            style={{ width: size, height: size, display: "block", cursor: "grab" }} />
  );
}
