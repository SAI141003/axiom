import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

/**
 * Pre-market scanner tuned to the user's style:
 *   $1,000 per trade · stocks under $10 · ~$1/day movers · profit taken in the
 *   first 20 minutes after the open.
 *
 * Repo capabilities used (ported to TS, cited):
 *   - Yang-Zhang OHLC vol            ← signals/crypto_binary_signal.py
 *   - TimesFM-style quantile forecast ← signals/timesfm_signal.py concept:
 *     empirical p10/p50/p90 of next-day $ moves conditioned on momentum sign
 *     (the real TimesFM torch model needs py3.10-12; this is its statistical
 *      stand-in, same output shape: p10/p50/p90 + direction)
 *   - Multi-factor style score        ← signals/ensemble.py (QuantDinger)
 *   - First-20-min session stats      ← tick_reactor/oracle-lag "window" idea
 *
 * Data: Yahoo screeners (most_actives, small_cap_gainers) + v8 charts with
 * pre/post candles. Cookie+crumb handled like /api/options.
 */

const UA = { "User-Agent": "Mozilla/5.0" };
const BUDGET = 1000;
const MAX_PRICE = 10;
const MIN_VOLUME = 3_000_000;

let _auth: { cookie: string; crumb: string; ts: number } | null = null;

async function yahooAuth() {
  if (_auth && Date.now() - _auth.ts < 20 * 60_000) return _auth;
  const r1 = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual" });
  const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, cookie } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.includes("{")) throw new Error("crumb failed");
  _auth = { cookie, crumb, ts: Date.now() };
  return _auth;
}

async function yGet(url: string) {
  const { cookie, crumb } = await yahooAuth();
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}crumb=${encodeURIComponent(crumb)}`, {
    headers: { ...UA, cookie }, cache: "no-store",
  });
  if (res.status === 401) { _auth = null; throw new Error("401"); }
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  return res.json();
}

/** Yang-Zhang (2000) — port of signals/crypto_binary_signal.py::_yang_zhang_vol */
function yangZhangVol(bars: number[][]): number {
  const n = bars.length;
  if (n < 4) return 0;
  const logRs: number[] = [], logCo: number[] = [], logOo: number[] = [];
  for (const [o, h, l, c] of bars) {
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    const lh = Math.log(h / o), ll = Math.log(l / o), lc = Math.log(c / o);
    logRs.push(lh * (lh - lc) + ll * (ll - lc));
    logCo.push(lc);
  }
  for (let i = 1; i < n; i++) if (bars[i][0] > 0 && bars[i - 1][0] > 0)
    logOo.push(Math.log(bars[i][0] / bars[i - 1][0]));
  if (logRs.length < 3 || logOo.length < 2) return 0;
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const oBar = mean(logOo), cBar = mean(logCo);
  const k = 0.34 / (1.34 + (logRs.length + 1) / Math.max(logRs.length - 1, 1));
  const s2 = mean(logOo.map((r) => (r - oBar) ** 2)) + k * mean(logCo.map((r) => (r - cBar) ** 2))
           + (1 - k) * mean(logRs);
  return Math.sqrt(Math.max(0, s2 * 252));
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}

async function analyze(sym: string) {
  // ── 3mo daily: ranges, momentum, YZ vol, TimesFM-style quantiles ──────────
  const daily = await yGet(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=3mo&interval=1d`);
  const dr = daily.chart?.result?.[0];
  if (!dr) throw new Error("no daily");
  const dq = dr.indicators.quote[0];
  const bars: number[][] = [];
  for (let i = 0; i < (dr.timestamp?.length ?? 0); i++)
    if (dq.open[i] != null) bars.push([dq.open[i], dq.high[i], dq.low[i], dq.close[i]]);
  if (bars.length < 20) throw new Error("thin history");
  const price: number = dr.meta.regularMarketPrice;
  // NOTE: chartPreviousClose on a 3mo chart is the close BEFORE the range
  // (3 months ago) — real yesterday close comes from the 1d chart below.
  let prevClose: number = bars.length >= 2 ? bars[bars.length - 2][3] : price;

  const ranges = bars.slice(-20).map((b) => b[1] - b[2]);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const closes = bars.map((b) => b[3]);
  const ret5d = closes.length > 5 ? closes[closes.length - 1] / closes[closes.length - 6] - 1 : 0;
  const yz = yangZhangVol(bars.slice(-40));

  // TimesFM-style quantile forecast of tomorrow's $ move, conditioned on
  // 5-day momentum sign (statistical stand-in for signals/timesfm_signal.py)
  const dayMoves: number[] = [];
  for (let i = 1; i < bars.length; i++) dayMoves.push(bars[i][3] - bars[i - 1][3]);
  const momUp = ret5d >= 0;
  const conditioned = dayMoves.filter((_, i) => {
    if (i < 5) return false;
    const m = closes[i] / closes[i - 5] - 1;
    return momUp ? m >= 0 : m < 0;
  });
  const pool = conditioned.length >= 8 ? conditioned : dayMoves;
  const sorted = [...pool].sort((a, b) => a - b);
  const forecast = {
    p10: +quantile(sorted, 0.10).toFixed(2),
    p50: +quantile(sorted, 0.50).toFixed(2),
    p90: +quantile(sorted, 0.90).toFixed(2),
    direction: quantile(sorted, 0.5) >= 0 ? "UP" : "DOWN",
    n: pool.length,
  };

  // ── 5d 5-min: first-20-minutes behaviour ──────────────────────────────────
  const intra = await yGet(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=5m`);
  const ir = intra.chart?.result?.[0];
  const first20: { move: number; gap: number }[] = [];
  if (ir?.timestamp?.length) {
    const iq = ir.indicators.quote[0];
    // group candles by trading day (UTC date of ts+gmtoffset)
    const off = ir.meta.gmtoffset ?? -14400;
    const byDay: Record<string, { ts: number; o: number; c: number }[]> = {};
    for (let i = 0; i < ir.timestamp.length; i++) {
      if (iq.open[i] == null) continue;
      const local = new Date((ir.timestamp[i] + off) * 1000);
      const day = local.toISOString().slice(0, 10);
      (byDay[day] ??= []).push({ ts: ir.timestamp[i], o: iq.open[i], c: iq.close[i] });
    }
    let prevDayClose: number | null = null;
    for (const day of Object.keys(byDay).sort()) {
      const cands = byDay[day];
      if (cands.length < 5) { prevDayClose = cands[cands.length - 1]?.c ?? prevDayClose; continue; }
      const openPx = cands[0].o;
      const at20 = cands[3].c;             // 4th 5-min candle close ≈ +20 min
      first20.push({
        move: at20 - openPx,
        gap: prevDayClose ? openPx - prevDayClose : 0,
      });
      prevDayClose = cands[cands.length - 1].c;
    }
  }
  const f20Moves = first20.map((f) => f.move);
  const f20AvgAbs = f20Moves.length
    ? f20Moves.reduce((a, m) => a + Math.abs(m), 0) / f20Moves.length : 0;
  // gap continuation: same sign of gap and first-20 move
  const gapDays = first20.filter((f) => Math.abs(f.gap) > 0.02);
  const gapContinue = gapDays.length
    ? gapDays.filter((f) => Math.sign(f.gap) === Math.sign(f.move)).length / gapDays.length : 0.5;

  // ── today's pre-market gap (extended-hours candles) ───────────────────────
  let preMarketPx: number | null = null;
  try {
    const pre = await yGet(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=5m&includePrePost=true`);
    const pr = pre.chart?.result?.[0];
    // 1d chart's chartPreviousClose IS the true prior-session close
    if (pr?.meta?.chartPreviousClose) prevClose = pr.meta.chartPreviousClose;
    const pq = pr?.indicators?.quote?.[0];
    for (let i = (pr?.timestamp?.length ?? 0) - 1; i >= 0; i--) {
      if (pq?.close?.[i] != null) { preMarketPx = pq.close[i]; break; }
    }
  } catch { /* pre-market feed optional */ }
  const gapPct = preMarketPx ? ((preMarketPx - prevClose) / prevClose) * 100 : 0;

  // ── Style score (QuantDinger multi-factor port, weights re-tuned to style) ─
  const rangeFit = Math.max(0, 1 - Math.abs(avgRange - 1.0) / 1.0);        // $1/day ideal
  const f20Fit = Math.min(1, f20AvgAbs / 0.30);                             // ≥30¢ in 20min = full marks
  const gapAlign = Math.abs(gapPct) > 0.5 ? gapContinue : 0.5;              // only meaningful when gapping
  const liquidity = 1.0;                                                     // pre-filtered by screener
  const score = 0.30 * rangeFit + 0.30 * f20Fit + 0.25 * gapAlign + 0.15 * liquidity;

  // ── Trade plan for $1,000 — shaped by the nightly self-learner ───────────
  // (.data/params_premarket.json: target/stop multipliers refit from real
  //  first-20-min outcomes, bounded; defaults 1.0/1.0 when absent)
  let tMult = 1.0, sMult = 1.0;
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const lp = JSON.parse(await fs.readFile(
      path.join(process.cwd(), "..", ".data", "params_premarket.json"), "utf-8"));
    tMult = Math.max(0.5, Math.min(1.5, lp.params?.target_mult ?? 1.0));
    sMult = Math.max(0.5, Math.min(1.5, lp.params?.stop_mult ?? 1.0));
  } catch { /* learner hasn't run yet */ }

  const shares = Math.floor(BUDGET / (preMarketPx ?? price));
  const dir: "LONG" | "SHORT" =
    Math.abs(gapPct) > 0.5 ? (gapPct > 0 && gapContinue >= 0.5 ? "LONG" : "SHORT")
    : forecast.direction === "UP" ? "LONG" : "SHORT";
  const targetMove = Math.max(0.10, Math.min(f20AvgAbs || 0.2, avgRange * 0.4)) * tMult;
  const entry = preMarketPx ?? price;
  const target = dir === "LONG" ? entry + targetMove : entry - targetMove;
  const stop = dir === "LONG" ? entry - targetMove * 0.7 * sMult : entry + targetMove * 0.7 * sMult;

  return {
    symbol: sym, price, preMarketPx, prevClose,
    gapPct: +gapPct.toFixed(2),
    avgDailyRange: +avgRange.toFixed(2),
    yzVolPct: +(yz * 100).toFixed(0),
    ret5dPct: +(ret5d * 100).toFixed(1),
    first20: {
      avgAbsMove: +f20AvgAbs.toFixed(3),
      days: f20Moves.length,
      gapContinuationPct: +(gapContinue * 100).toFixed(0),
    },
    forecast,
    styleScore: +score.toFixed(3),
    plan: {
      direction: dir,
      shares,
      entry: +entry.toFixed(2),
      target: +target.toFixed(2),
      stop: +stop.toFixed(2),
      exitBy: "09:50 ET (20 min after open)",
      expectedProfit: +(shares * targetMove * Math.max(0.5, gapContinue)).toFixed(0),
      maxLoss: +(shares * targetMove * 0.7).toFixed(0),
    },
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const budget = parseFloat(searchParams.get("budget") ?? String(BUDGET)) || BUDGET;

  // 1. Universe: live screeners (premarket movers) + NEWS-flagged names
  //    → self-picks sub-$10 stocks from BOTH momentum and news catalysts.
  const universe = new Map<string, { price: number; volume: number; name: string; news?: boolean }>();
  for (const scr of ["most_actives", "small_cap_gainers", "day_gainers"]) {
    try {
      const d = await yGet(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scr}&count=100`);
      for (const q of d.finance?.result?.[0]?.quotes ?? []) {
        const p = q.regularMarketPrice, v = q.regularMarketVolume;
        if (p && p < MAX_PRICE && p > 0.5 && v > MIN_VOLUME) {
          universe.set(q.symbol, { price: p, volume: v, name: q.shortName ?? q.symbol });
        }
      }
    } catch { /* screener best-effort */ }
  }
  // NEWS catalysts: high-magnitude names from the CACHED news-desk log
  // (logs/news_intel.jsonl, refreshed every 15 min by the poller — fast, no
  // LLM call here). A sub-$10 stock with a fresh mag-3+ catalyst is exactly
  // the kind of mover this strategy wants.
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "..", "logs", "news_intel.jsonl"), "utf-8");
    const syms = new Set<string>();
    const lines = raw.trim().split("\n").slice(-40);   // recent entries only
    for (const line of lines) {
      let r: any; try { r = JSON.parse(line); } catch { continue; }
      if (Date.now() / 1000 - (r.ts ?? 0) > 12 * 3600) continue;   // last 12h
      for (const c of r.cards ?? []) {
        if ((c.magnitude ?? 0) >= 3) {
          syms.add(String(c.sym).toUpperCase());
          for (const a of c.affected ?? []) syms.add(String(a).toUpperCase());
        }
      }
    }
    for (const sym of syms) {
      if (universe.has(sym)) { universe.get(sym)!.news = true; continue; }
      const q = await yGet(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=1d`)
        .then((d: any) => d?.chart?.result?.[0]?.meta).catch(() => null);
      const p = q?.regularMarketPrice;
      if (p && p < MAX_PRICE && p > 0.5) {
        universe.set(sym, { price: p, volume: q.regularMarketVolume ?? 0, name: sym, news: true });
      }
    }
  } catch { /* news best-effort */ }
  const candidates = Array.from(universe.entries())
    // news-flagged catalysts first, then by volume
    .sort((a, b) => (Number(b[1].news ?? false) - Number(a[1].news ?? false)) || (b[1].volume - a[1].volume))
    .slice(0, 14)
    .map(([s]) => s);

  if (candidates.length === 0) {
    return NextResponse.json({ error: "no under-$10 liquid candidates from screeners right now" }, { status: 502 });
  }

  // 2. Deep analysis on each
  const settled = await Promise.allSettled(candidates.map(analyze));
  const results = settled
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => r.value)
    .map((r) => ({ ...r, plan: { ...r.plan, shares: Math.floor(budget / (r.preMarketPx ?? r.price)) } }))
    .sort((a, b) => b.styleScore - a.styleScore);

  return NextResponse.json({
    budget,
    universeSize: universe.size,
    scanned: candidates.length,
    results,
    generated: Date.now(),
  });
}
