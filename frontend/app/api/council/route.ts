import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { askLLM } from "../../../lib/llm";

const ROOT = path.join(process.cwd(), "..");

// OUTSIDE VIEW (Tetlock): anchor the aggregate on the reference-class base rate,
// not naive 0.5 — the single technique that lifted the Oracle from tie→beat.
// Keyword-classify the question to a curated base rate (no extra LLM call).
async function baseRate(q: string): Promise<{ p: number; cls: string }> {
  let classes: Record<string, { rate: number }> = {};
  try { classes = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "base_rates.json"), "utf-8")).classes; } catch {}
  const t = q.toLowerCase();
  const pick = (k: string) => classes[k]?.rate;
  let cls = "generic_binary_unknown", p = 0.5;
  const hit = (name: string, r?: number) => { if (r != null) { cls = name; p = r; } };
  if (/beat|earnings|eps|revenue/.test(t)) hit("earnings_beat_eps", pick("earnings_beat_eps"));
  else if (/\bfed\b|rate cut|rate hike|fomc/.test(t)) hit("fed_moves_as_futures_price", pick("fed_moves_as_futures_price"));
  else if (/btc|bitcoin|crypto|ethereum|\beth\b/.test(t)) hit(/week/.test(t) ? "crypto_up_week" : "crypto_up_day", pick(/week/.test(t) ? "crypto_up_week" : "crypto_up_day"));
  else if (/win|beat|defeat|favorite|game|match/.test(t) && /team|vs\.|against/.test(t)) hit("sports_favorite_wins", pick("sports_favorite_wins"));
  else if (/re-?elect|incumbent|president|election/.test(t)) hit("incumbent_reelected", pick("incumbent_reelected"));
  else if (/merger|acquisition|acquire|m&a|deal close/.test(t)) hit("m_and_a_deal_closes", pick("m_and_a_deal_closes"));
  else if (/startup|raise|series [a-d]|found/.test(t)) hit("startup_survives_10y", pick("startup_survives_10y"));
  else if (/up|higher|rise|gain|green|above|beat/.test(t)) hit(/week/.test(t) ? "stock_up_week" : "stock_up_day", pick(/week/.test(t) ? "stock_up_week" : "stock_up_day"));
  return { p: p ?? 0.5, cls };
}

/**
 * THE COUNCIL — the named agents actually deliberate, then converge to ONE call.
 *
 *   Round 1  each department head states a view through its own lens (parallel).
 *   Crowd    the 72-agent MiroFish swarm votes the same question.
 *   Round 2  every head sees the others' views + the crowd, and may revise —
 *            this is the "talk to each other / share ideas" step.
 *   Vote     influence-weighted aggregation across heads + the swarm block.
 *   Chair    KRONOS synthesizes the final decision and names the dissent.
 *
 * Real deliberation, not theatre: each view is a live LLM call grounded in that
 * head's domain, and the crowd number comes from the running swarm.
 */

const HEADS = [
  { id: "delphi", name: "Delphi", role: "Chief Forecaster", influence: 1.4,
    lens: "outside-view base rates, superforecasting, calibration — anchor on reference classes" },
  { id: "quill", name: "Quill", role: "Earnings Analyst", influence: 1.1,
    lens: "fundamentals, earnings power, analyst revisions and dispersion" },
  { id: "nova", name: "Nova", role: "Crypto Latency Trader", influence: 1.0,
    lens: "market microstructure, order flow, how fast information is already priced in" },
  { id: "dex", name: "Dex", role: "Options Desk", influence: 1.1,
    lens: "implied volatility, options positioning, tail risk and skew" },
  { id: "sage", name: "Sage", role: "Price Forecaster", influence: 1.0,
    lens: "time-series structure, momentum vs mean-reversion, regime" },
  { id: "atlas", name: "Atlas", role: "Execution & Arbitrage", influence: 1.0,
    lens: "market efficiency — is there a real free edge here, or is it already priced?" },
  { id: "sky", name: "Sky", role: "Prediction-Market Analyst", influence: 0.9,
    lens: "prediction-market pricing, where informed specialists set the line" },
];

// role → human name (matches the workforce council roster) so the graph can
// show named micro-agents, not anonymous archetypes.
const ROLE_NAME: Record<string, string> = {
  "Domain Expert": "Ada", "Quant PM": "Quinn", "Insider/Specialist": "Ivo",
  "Policy Analyst": "Pia", "News Reader": "Noor", "Momentum Chaser": "Milo",
  "Skeptic": "Sana", "Risk Manager": "Rhea", "Retail Crowd": "Remy",
  "Contrarian": "Cato", "Historian": "Hugo", "Market Maker": "Mara",
  "Macro Economist": "Enzo", "Geopolitics Analyst": "Goran", "Contrarian Whale": "Wade",
  "Sentiment Quant": "Suki", "Value Investor": "Vaughn", "Options Flow Reader": "Odile",
  "Contrarian Retail": "Cruz", "Event Trader": "Ezra", "Statistician": "Stella",
  "Insider Skeptic": "Iris", "Momentum Quant": "Mika", "Regime Analyst": "Rex",
};

const SFX = ["St", "Ba", "Bo"];   // steady / balanced / bold replicas

function nameMicro(personas: any[]): any[] {
  // every one of the 72 votes named individually (role's human name + replica)
  const seen = new Map<string, number>();
  return personas.map((v) => {
    const role = String(v.name ?? "");
    const i = seen.get(role) ?? 0;
    seen.set(role, i + 1);
    const p = Number(v.p) || 0.5;
    return { name: `${ROLE_NAME[role] ?? role}·${SFX[i] ?? i + 1}`, role,
             p: Number(p.toFixed(2)), vote: p >= 0.5 ? "YES" : "NO",
             why: String(v.why ?? "").slice(0, 120) };
  });
}

function parseJSON(s: string): any {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
const clamp = (p: number) => Math.max(0.02, Math.min(0.98, p));
const pOf = (v: any) => {
  const c = clamp(Number(v?.confidence) || 0.5);
  return String(v?.vote).toUpperCase() === "YES" ? c : 1 - c;   // → P(YES)
};

async function head1(h: typeof HEADS[0], q: string) {
  const raw = await askLLM(
    `You are ${h.name}, the ${h.role} on a forecasting council. Reason ONLY through your lens: ${h.lens}. Be decisive and brief.`,
    `Question: "${q}"\nReply ONLY as JSON: {"vote":"YES"|"NO","confidence":0.0-1.0,"argument":"one sharp sentence from your lens"}`,
    220).catch(() => "");
  const v = parseJSON(raw) ?? { vote: "NO", confidence: 0.5, argument: "(no read)" };
  return { ...h, round1: { vote: String(v.vote).toUpperCase() === "YES" ? "YES" : "NO",
    p: pOf(v), argument: String(v.argument ?? "").slice(0, 180) } };
}

async function head2(h: any, q: string, digest: string, swarmP: number | null) {
  const raw = await askLLM(
    `You are ${h.name}, the ${h.role}. You are in round 2 of a council debate. Update your view if the others or the crowd change your mind; hold firm if not.`,
    `Question: "${q}"\nYour round-1 view: ${h.round1.vote} (${(h.round1.p * 100).toFixed(0)}%). ${h.round1.argument}\n\nThe council said:\n${digest}\n${swarmP != null ? `The 72-agent crowd sees P(YES)=${(swarmP * 100).toFixed(0)}%.` : ""}\nReply ONLY as JSON: {"vote":"YES"|"NO","confidence":0.0-1.0,"reaction":"one sentence: did you change and why"}`,
    220).catch(() => "");
  const v = parseJSON(raw);
  if (!v) return { ...h, round2: h.round1, changed: false, reaction: "held position" };
  const p = pOf(v);
  return { ...h, round2: { vote: String(v.vote).toUpperCase() === "YES" ? "YES" : "NO", p,
    reaction: String(v.reaction ?? "").slice(0, 180) },
    changed: (p >= 0.5) !== (h.round1.p >= 0.5) };
}

// TradingAgents (Tauric Research, arXiv 2412.20138) contribution: a dedicated
// Bull and Bear argue the strongest opposing cases, then a risk panel gates it.
async function bullBear(q: string, digest: string, swarmP: number | null) {
  const ctx = `Question: "${q}"\nThe desk's views:\n${digest}\n${swarmP != null ? `Crowd P(YES) ${(swarmP * 100).toFixed(0)}%.` : ""}`;
  const [bull, bear] = await Promise.all([
    askLLM(`You are Taurus, the Bull Researcher. Argue the STRONGEST possible YES case in 2 sentences — your job is conviction, not balance.`, ctx, 200).catch(() => ""),
    askLLM(`You are Ursa, the Bear Researcher. Argue the STRONGEST possible NO case in 2 sentences — surface the risk everyone is ignoring.`, ctx, 200).catch(() => ""),
  ]);
  return { bull: bull.trim(), bear: bear.trim() };
}

async function riskPanel(q: string, decision: string, finalP: number) {
  const ctx = `Question: "${q}"\nProposed ruling: ${decision} at ${(finalP * 100).toFixed(0)}% confidence.`;
  const lenses: [string, string][] = [
    ["aggressive", "You are the Aggressive risk voice — push for size when conviction is real."],
    ["neutral", "You are the Neutral risk voice — weigh reward vs downside evenly."],
    ["conservative", "You are the Conservative risk voice — protect capital, flag the tail."],
  ];
  const out = await Promise.all(lenses.map(async ([name, sys]) => {
    const raw = await askLLM(sys + " Reply ONLY as JSON.", `${ctx}\n{"stance":"SIZE UP"|"HOLD"|"TRIM/PASS","note":"one sentence"}`, 150).catch(() => "");
    const v = parseJSON(raw) ?? {};
    return { lens: name, stance: String(v.stance ?? "HOLD"), note: String(v.note ?? "").slice(0, 160) };
  }));
  return out;
}

// Sentinel — a SEPARATE critic (research: intrinsic self-correction is
// unreliable; an external red-team catches overconfidence + blind spots).
async function critic(q: string, decision: string, finalP: number, digest: string, research: any) {
  const raw = await askLLM(
    `You are Sentinel, the council's critic and red-team. Your ONLY job is to find the flaw in this ruling: overconfidence, groupthink, ignored evidence, or a bias. Be skeptical, not agreeable.`,
    `Question: "${q}"\nRuling: ${decision} at ${(finalP * 100).toFixed(0)}%.\nBull: ${research.bull}\nBear: ${research.bear}\nDebate:\n${digest}\n` +
    `Reply ONLY as JSON: {"overconfident":true|false,"blindspot":"the main thing the council may be missing, one sentence","suggested_confidence":0.0-1.0}`,
    220).catch(() => "");
  const v = parseJSON(raw) ?? {};
  return {
    overconfident: v.overconfident === true,
    blindspot: String(v.blindspot ?? "").slice(0, 200),
    suggested: typeof v.suggested_confidence === "number" ? clamp(v.suggested_confidence) : null,
  };
}

async function swarmVote(q: string): Promise<{ p: number | null; voices: any[]; micro: any[] }> {
  try {
    const r = await fetch("http://localhost:3000/api/mirofish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: q }), signal: AbortSignal.timeout(70_000),
    }).then((x) => x.json());
    const personas = r?.personas ?? [];
    return { p: typeof r?.probability === "number" ? r.probability : null,
             voices: personas.slice(0, 6), micro: nameMicro(personas) };
  } catch { return { p: null, voices: [], micro: [] }; }
}

export async function POST(request: Request) {
  let body: { question?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const q = (body.question ?? "").trim();
  if (!q) return NextResponse.json({ error: "question required" }, { status: 400 });

  // Round 1 (all heads) + the swarm crowd, in parallel
  const [r1, swarm] = await Promise.all([
    Promise.all(HEADS.map((h) => head1(h, q))),
    swarmVote(q),
  ]);

  const digest = r1.map((h) => `- ${h.name} (${h.role}): ${h.round1.vote} — ${h.round1.argument}`).join("\n");

  // Round 2 — everyone sees everyone (the deliberation), in parallel
  const r2 = await Promise.all(r1.map((h) => head2(h, q, digest, swarm.p)));

  // Influence-weighted vote: heads + the swarm as one weighted block
  const SWARM_W = 2.0;
  let wsum = 0, psum = 0;
  for (const h of r2) { wsum += h.influence; psum += h.influence * h.round2.p; }
  if (swarm.p != null) { wsum += SWARM_W; psum += SWARM_W * swarm.p; }
  const rawP = clamp(psum / Math.max(wsum, 1e-9));
  // OUTSIDE VIEW: anchor on the reference-class base rate (Tetlock), then let the
  // council's evidence move it. On disagreement, regress toward the base rate —
  // NOT naive 0.5 — which is what closed the tie-coin-flip gap vs the Oracle.
  const base = await baseRate(q);
  const hp = r2.map((h) => h.round2.p);
  const mean = hp.reduce((a, b) => a + b, 0) / hp.length;
  const disagreement = Math.sqrt(hp.reduce((a, b) => a + (b - mean) ** 2, 0) / hp.length);
  const temper = 1 - Math.min(0.5, 1.6 * disagreement);
  // blend the crowd aggregate with the outside-view prior, then temper toward that prior
  const anchored = clamp(0.30 * base.p + 0.70 * rawP);
  const finalP = clamp(base.p + (anchored - base.p) * temper);
  const decision = finalP >= 0.5 ? "YES" : "NO";

  const yesHeads = r2.filter((h) => h.round2.p >= 0.5).map((h) => h.name);
  const noHeads = r2.filter((h) => h.round2.p < 0.5).map((h) => h.name);
  const dissent = decision === "YES" ? noHeads : yesHeads;

  // TradingAgents layer + Sentinel critic (all parallel)
  const research = await bullBear(q, digest, swarm.p);
  const [risk, review] = await Promise.all([
    riskPanel(q, decision, finalP),
    critic(q, decision, finalP, digest, research),
  ]);

  // Chair (KRONOS) synthesis — weighs the vote, the bull/bear case, and risk
  const chair = await askLLM(
    `You are KRONOS, chair of the forecasting council. State the ruling in 2-3 crisp sentences: the decision, the core reason, the main dissent, and the risk stance to take. No preamble.`,
    `Question: "${q}"\nDecision: ${decision} at ${(finalP * 100).toFixed(0)}% confidence.\nFor: ${yesHeads.join(", ") || "none"}\nAgainst: ${noHeads.join(", ") || "none"}\nCrowd P(YES): ${swarm.p != null ? (swarm.p * 100).toFixed(0) + "%" : "n/a"}\n` +
    `Bull (Taurus): ${research.bull}\nBear (Ursa): ${research.bear}\nRisk panel: ${risk.map((x) => `${x.lens}=${x.stance}`).join(", ")}\nKey arguments:\n${digest}`,
    280).catch(() => "");

  // Log every ruling so the council is Brier-scored against reality (like the
  // Oracle) — research: calibration tracking is a prerequisite for trust.
  try {
    await fs.appendFile(path.join(ROOT, "logs", "council_rulings.jsonl"),
      JSON.stringify({ ts: Math.floor(Date.now() / 1000), question: q, decision,
        probability: Number(finalP.toFixed(3)), raw: Number(rawP.toFixed(3)),
        disagreement: Number(disagreement.toFixed(3)),
        overconfident: review.overconfident, resolved: false }) + "\n");
  } catch { /* best-effort */ }

  return NextResponse.json({
    question: q, decision, probability: Number(finalP.toFixed(3)),
    tally: { for: yesHeads.length, against: noHeads.length, dissent },
    heads: r2.map((h) => ({
      id: h.id, name: h.name, role: h.role, influence: h.influence,
      round1: h.round1, round2: h.round2, changed: h.changed,
    })),
    swarm: { probability: swarm.p, weight: SWARM_W, voices: swarm.voices, micro: swarm.micro ?? [] },
    research, risk, critic: review,
    calibration: { raw: Number(rawP.toFixed(3)), calibrated: Number(finalP.toFixed(3)),
                   disagreement: Number(disagreement.toFixed(3)),
                   tempered: Math.abs(rawP - finalP) > 0.01,
                   baseRate: Number(base.p.toFixed(3)), referenceClass: base.cls },
    chair: chair.trim() || `Council rules ${decision} at ${(finalP * 100).toFixed(0)}%.`,
    generated: Date.now(),
  });
}
