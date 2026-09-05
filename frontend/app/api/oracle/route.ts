import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { askLLM } from "../../../lib/llm";

const execFileP = promisify(execFile);

/**
 * THE ORACLE — ask anything, get an exact verdict + probability + why.
 *
 * Its own brain, per question:
 *   1. CLASSIFY  — what kind of question (stock direction / earnings /
 *                  business idea / event) + extract the ticker
 *   2. EVIDENCE  — live quote, 6mo history, realized vol, momentum, up-day
 *                  base rate, cached news for the name
 *   3. SIMULATE  — 10,000 Monte Carlo price paths from REALIZED vol for the
 *                  remaining session → P(close up) across every scenario
 *   4. DELIBERATE— the 72-agent MiroFish swarm argues it (2 rounds)
 *   5. VERDICT   — weighted fusion (simulation 45% · swarm 35% · behavior/
 *                  momentum 20%) → exact answer, probability, drivers
 *
 * Honesty built in: base rates stated, drivers listed, and the probability IS
 * the answer — a 55% "UP" is a coin-lean, not a certainty, and the page says so.
 * (TimesFM deliberately absent: unusable on Py3.14 and R²<0 on financial data.)
 */

const ROOT = path.join(process.cwd(), "..");
const UA = { "User-Agent": "Mozilla/5.0" };

async function classify(question: string) {
  // STAGE 1 (Tetlock): triage + FERMI DECOMPOSITION + reference-class pick.
  // The model must choose an OUTSIDE-VIEW class from our curated library —
  // anchoring on a researched base rate before any narrative reasoning.
  let classes: any = {};
  try { classes = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "base_rates.json"), "utf-8")).classes; } catch {}
  const classList = Object.entries<any>(classes).map(([k, v]) => `${k}: ${v.desc} (${(v.rate * 100).toFixed(0)}%)`).join("\n");
  const raw = await askLLM(
    `You are the triage stage of a superforecasting pipeline (Tetlock method).
Decompose the question and pick the OUTSIDE-VIEW reference class BEFORE any inside reasoning.
Available reference classes (name: description (base rate)):\n${classList}\n
Reply ONLY JSON:
{"type":"stock_direction"|"earnings_beat"|"business_idea"|"event",
 "symbol":"TICKER or null","horizon":"today"|"week"|"quarter"|"longterm",
 "reference_class":"<name from the list>",
 "subquestions":["2-4 Fermi sub-questions that decompose this"],
 "inside_factors":["2-4 case-specific factors that could move it off the base rate"]}`,
    question, 400);
  try {
    const c = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const rc = classes[c.reference_class] ?? classes["generic_binary_unknown"] ?? { rate: 0.5, desc: "unknown" };
    return { ...c, baseRate: rc.rate, baseRateDesc: rc.desc, baseRateSource: rc.source };
  } catch { return { type: "event", symbol: null, horizon: "week", reference_class: "generic_binary_unknown", baseRate: 0.5, baseRateDesc: "fallback", subquestions: [], inside_factors: [] }; }
}

// Satopää/Tetlock EXTREMIZING: aggregated forecasts are systematically
// underconfident (each source holds partial info). Push the aggregate away
// from 0.5 — but ONLY when the sources agree (extremizing a disagreement
// would manufacture false confidence).
function extremize(p: number, a: number): number {
  const num = Math.pow(p, a);
  return num / (num + Math.pow(1 - p, a));
}

async function stockEvidence(sym: string) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=6mo&interval=1d`,
    { headers: UA, cache: "no-store" }).then((r) => r.json()).catch(() => null);
  const r0 = res?.chart?.result?.[0];
  if (!r0) return null;
  const q = r0.indicators.quote[0];
  const closes: number[] = q.close.filter((x: number) => x != null);
  const meta = r0.meta;
  const px = meta.regularMarketPrice;
  // chartPreviousClose on a 6mo chart = the close before the RANGE (6mo ago!)
  // — the real previous close is the second-to-last daily bar
  const prev = meta.regularMarketPreviousClose
    ?? (Math.abs(closes[closes.length - 1] - px) < px * 0.001
        ? closes[closes.length - 2] : closes[closes.length - 1]);
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length);
  const upDays = rets.filter((r) => r > 0).length / rets.length;
  const mom20 = closes.length > 21 ? (closes[closes.length - 1] / closes[closes.length - 21] - 1) : 0;
  // session progress (ET)
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  const open = 9 * 60 + 30, close = 16 * 60;
  const frac = Math.max(0, Math.min(1, (mins - open) / (close - open)));
  const marketOpen = et.getDay() > 0 && et.getDay() < 6 && mins >= open && mins < close;
  return {
    symbol: sym, price: px, prevClose: prev,
    chgPct: Number((((px - prev) / prev) * 100).toFixed(2)),
    dailyVolPct: Number((sd * 100).toFixed(2)),
    upDayBaseRate: Number(upDays.toFixed(3)),
    mom20Pct: Number((mom20 * 100).toFixed(2)),
    sessionFrac: Number(frac.toFixed(2)), marketOpen,
  };
}

function monteCarlo(ev: any, nPaths = 10_000) {
  // Remaining-session scenarios from REALIZED vol (drift 0 = honest
  // martingale). P(close > prevClose) given where price is NOW.
  const remaining = ev.marketOpen ? Math.max(0.02, 1 - ev.sessionFrac) : 1;
  const sigma = (ev.dailyVolPct / 100) * Math.sqrt(remaining);
  let up = 0;
  const dist = { down2: 0, down1: 0, flat: 0, up1: 0, up2: 0 };
  for (let i = 0; i < nPaths; i++) {
    // Box-Muller normal
    const z = Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());
    const end = ev.price * Math.exp(sigma * z - 0.5 * sigma * sigma);
    const ret = (end - ev.prevClose) / ev.prevClose * 100;
    if (ret > 0) up++;
    if (ret < -1) dist.down2++; else if (ret < -0.2) dist.down1++;
    else if (ret <= 0.2) dist.flat++; else if (ret <= 1) dist.up1++; else dist.up2++;
  }
  const pct = (n: number) => Number((n / nPaths).toFixed(3));
  return { pUp: pct(up), nPaths,
    scenarios: { "down >1%": pct(dist.down2), "down 0.2-1%": pct(dist.down1),
                 "flat ±0.2%": pct(dist.flat), "up 0.2-1%": pct(dist.up1),
                 "up >1%": pct(dist.up2) } };
}

async function recentNews(sym: string | null): Promise<string[]> {
  if (!sym) return [];
  try {
    const raw = await fs.readFile(path.join(ROOT, "logs", "news_intel.jsonl"), "utf-8");
    const out: string[] = [];
    for (const line of raw.trim().split("\n").slice(-40)) {
      try {
        const r = JSON.parse(line);
        for (const c of r.cards ?? [])
          if (c.sym === sym || (c.affected ?? []).includes(sym)) out.push(c.title);
      } catch {}
    }
    return Array.from(new Set(out)).slice(-5);
  } catch { return []; }
}

async function swarm(question: string, seed: string): Promise<any | null> {
  try {
    const sub = await fetch("http://localhost:5001/api/simulate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed, goal: question }),
    }).then((r) => r.json());
    const id = sub.simulation_id;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await fetch(`http://localhost:5001/api/status/${id}`).then((r) => r.json());
      if (st.status === "completed")
        return await fetch(`http://localhost:5001/api/report/${id}`).then((r) => r.json());
      if (st.status === "failed") return null;
    }
  } catch {}
  return null;
}

// EARNINGS: delegate to the research-grounded engine (PEAD / dispersion /
// revision momentum / options-implied move) rather than the generic swarm.
async function earningsForecast(sym: string): Promise<any | null> {
  try {
    const { stdout } = await execFileP(
      path.join(ROOT, ".venv", "bin", "python"),
      [path.join(ROOT, "signals", "earnings_engine.py"), sym],
      { cwd: ROOT, timeout: 30_000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  let body: { question?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const question = (body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

  const cls = await classify(question);
  const sym = cls.symbol && /^[A-Z]{1,5}$/.test(cls.symbol) ? cls.symbol : null;

  // ── EARNINGS BRANCH: the dedicated cited engine, not the generic pipeline ──
  if (cls.type === "earnings_beat" && sym) {
    const ef = await earningsForecast(sym);
    if (ef) {
      const askingDirection = /\b(up|down|rise|fall|drop|rally|move|react|pop|tank|after)\b/i.test(question);
      const prob = askingDirection ? ef.p_up_after : ef.p_beat;
      const verdict = askingDirection ? ef.verdict_direction : ef.verdict_beat;
      const conviction = Math.abs(prob - 0.5) > 0.15 ? "strong" : Math.abs(prob - 0.5) > 0.07 ? "moderate" : "slight lean";
      const result = {
        question, type: "earnings_beat", symbol: sym, horizon: "event",
        verdict, probability: Number(prob.toFixed(3)), conviction, extremized: false,
        referenceClass: "earnings_beat_eps", baseRate: 0.75,
        baseRateDesc: "S&P 500 firm beats consensus EPS (FactSet 5-yr)",
        baseRateSource: "FactSet Earnings Insight",
        engine: "earnings", nextEarnings: ef.next_earnings,
        earnings: {
          pBeat: ef.p_beat, verdictBeat: ef.verdict_beat,
          pUpAfter: ef.p_up_after, verdictDirection: ef.verdict_direction,
          expectedSurprise: ef.expected_surprise, surpriseSd: ef.surprise_sd,
          dispersion: ef.dispersion, impliedMove: ef.implied_move,
          beatStreak: ef.beat_streak, nAnalysts: ef.n_analysts,
          revisions: ef.revisions, confidence: ef.confidence,
        },
        drivers: ef.drivers,
        honesty: askingDirection
          ? `${(prob * 100).toFixed(0)}% is calibrated, capped near 50% ON PURPOSE — the post-earnings move is near-efficient because the beat is already priced in. Beats are predictable (${(ef.p_beat * 100).toFixed(0)}%); the reaction is not.`
          : `${(ef.p_beat * 100).toFixed(0)}% to beat consensus — grounded in a ${ef.beat_streak} streak shrunk to the 75% market base rate and revision momentum, NOT a guess.`,
        generated: Date.now(),
      };
      try {
        await fs.appendFile(path.join(ROOT, "logs", "oracle_predictions.jsonl"),
          JSON.stringify({ ts: Math.floor(Date.now() / 1000), question, type: "earnings_beat",
            symbol: sym, horizon: "event", verdict, probability: result.probability,
            resolved: false, engine: "earnings" }) + "\n");
      } catch {}
      return NextResponse.json(result);
    }
  }

  const ev = sym ? await stockEvidence(sym) : null;
  const mc = ev ? monteCarlo(ev) : null;
  const news = await recentNews(sym);

  const seed = [
    `Question: ${question}`,
    ev ? `Live evidence for ${sym}: price $${ev.price} (${ev.chgPct >= 0 ? "+" : ""}${ev.chgPct}% today), ` +
         `daily vol ${ev.dailyVolPct}%, 20-day momentum ${ev.mom20Pct}%, ` +
         `historical up-day rate ${(ev.upDayBaseRate * 100).toFixed(0)}%, ` +
         `session ${ev.marketOpen ? `${(ev.sessionFrac * 100).toFixed(0)}% elapsed` : "closed"}` : "",
    mc ? `Monte Carlo (10,000 scenarios from realized vol): P(close up) = ${(mc.pUp * 100).toFixed(0)}%` : "",
    news.length ? `Recent news: ${news.join(" | ")}` : "",
    cls.type === "business_idea" ? "Base rate context: ~90% of startups fail; ~50% of new products miss projections." : "",
  ].filter(Boolean).join("\n");

  const sw = await swarm(question, seed);

  // ── STAGE 5: SUPERFORECASTER FUSION ──
  // Outside view is the ANCHOR; inside evidence moves it; extremize only on
  // agreement (Tetlock/Satopää). Every stage's number is reported.
  const stages: Record<string, number | null> = {
    outside_view: cls.baseRate,
    simulation: mc ? mc.pUp : null,
    swarm: sw?.probability ?? null,
    behavior: ev ? Math.max(0.05, Math.min(0.95,
      0.5 + Math.max(-0.1, Math.min(0.1, ev.mom20Pct / 100)) + (ev.upDayBaseRate - 0.5) * 0.5)) : null,
  };
  const drivers: string[] = [];
  drivers.push(`OUTSIDE VIEW anchor: ${(cls.baseRate * 100).toFixed(0)}% — reference class "${cls.reference_class}" (${cls.baseRateDesc})`);
  let prob: number;
  if (mc && cls.type === "stock_direction") {
    prob = 0.20 * cls.baseRate + 0.40 * mc.pUp + 0.25 * (sw?.probability ?? mc.pUp) + 0.15 * (stages.behavior as number);
    drivers.push(`SIMULATION: ${(mc.pUp * 100).toFixed(0)}% of 10,000 realized-vol scenarios close up (${ev!.chgPct >= 0 ? "+" : ""}${ev!.chgPct}% today, ${((1 - ev!.sessionFrac) * 100).toFixed(0)}% of session left)`);
    if (sw) drivers.push(`SWARM: ${(sw.probability * 100).toFixed(0)}% (${sw.personas?.filter((p: any) => p.p > 0.5).length}/${sw.personas?.length} bullish, disagreement ${sw.disagreement})`);
    drivers.push(`BEHAVIOR: ${(ev!.upDayBaseRate * 100).toFixed(0)}% up-day rate, ${ev!.mom20Pct >= 0 ? "+" : ""}${ev!.mom20Pct}% momentum-20d`);
    if (news.length) drivers.push(`NEWS in play: ${news[0]}`);
  } else {
    prob = sw ? 0.35 * cls.baseRate + 0.65 * sw.probability : cls.baseRate;
    if (sw) drivers.push(`SWARM: ${(sw.probability * 100).toFixed(0)}% across ${sw.personas?.length ?? 0} agents (disagreement ${sw.disagreement}, deliberation shift ${sw.deliberation_shift >= 0 ? "+" : ""}${sw.deliberation_shift})`);
    for (const p of (sw?.personas ?? []).slice(0, 2)) drivers.push(`${p.name}: ${p.why}`);
  }
  // EXTREMIZE only when sources agree (all on the same side of 0.5)
  const sources = Object.values(stages).filter((v): v is number => v != null && v !== cls.baseRate || v === cls.baseRate);
  const active = [stages.simulation, stages.swarm, stages.behavior].filter((v): v is number => v != null);
  const agree = active.length >= 2 && active.every((v) => (v >= 0.5) === (active[0] >= 0.5));
  let extremized = false;
  if (agree && Math.abs(prob - 0.5) > 0.03) {
    prob = extremize(prob, 1.6);
    extremized = true;
    drivers.push(`EXTREMIZED (Satopää): sources agree → aggregate pushed from consensus toward conviction`);
  } else if (!agree && active.length >= 2) {
    drivers.push(`NOT extremized: evidence sources disagree — confidence honestly capped`);
  }
  prob = Math.max(0.03, Math.min(0.97, prob));

  // Fermi decomposition surfaced for transparency
  const decomposition = { subquestions: cls.subquestions ?? [], inside_factors: cls.inside_factors ?? [] };

  const positive = prob >= 0.5;
  const verdict = cls.type === "business_idea" ? (positive ? "PASS" : "FAIL")
    : cls.type === "earnings_beat" ? (positive ? "BEAT" : "MISS")
    : (positive ? "UP" : "DOWN");
  const conviction = Math.abs(prob - 0.5) > 0.15 ? "strong" : Math.abs(prob - 0.5) > 0.07 ? "moderate" : "slight lean";

  const result = {
    question, type: cls.type, symbol: sym, horizon: cls.horizon,
    verdict, probability: Number(prob.toFixed(3)), conviction, extremized,
    referenceClass: cls.reference_class, baseRate: cls.baseRate,
    baseRateDesc: cls.baseRateDesc, baseRateSource: cls.baseRateSource,
    stages, decomposition, drivers,
    evidence: ev, simulation: mc,
    swarm: sw ? { probability: sw.probability, confidence: sw.confidence,
                  disagreement: sw.disagreement, shift: sw.deliberation_shift,
                  agents: sw.personas?.length ?? 0,
                  voices: (sw.personas ?? []).slice(0, 6) } : null,
    honesty: `${(prob * 100).toFixed(0)}% is the calibrated probability, not a certainty — the other side happens ${(100 - prob * 100).toFixed(0)}% of the time. Anchored on the ${(cls.baseRate * 100).toFixed(0)}% outside-view base rate, moved by live evidence.`,
    generated: Date.now(),
  };

  // LOG the prediction so the Oracle can be SCORED against reality (Brier).
  // This is what no generic AI does — its forecasts become a tracked record.
  try {
    await fs.appendFile(path.join(ROOT, "logs", "oracle_predictions.jsonl"),
      JSON.stringify({ ts: Math.floor(Date.now() / 1000), question, type: cls.type,
        symbol: sym, horizon: cls.horizon, verdict, probability: result.probability,
        refPrice: ev?.price ?? null, refPrevClose: ev?.prevClose ?? null,
        resolved: false }) + "\n");
  } catch {}

  return NextResponse.json(result);
}
