"""
MiroFish backend — a right-sized implementation of the MiroFish swarm-simulation
mechanism (github 666ghj/MiroFish, 53k★: GraphRAG → thousands of persona agents
→ aggregate forecast). Running the full upstream needs Neo4j + thousands of LLM
agents per market (token-ruinous). This service captures the CORE EDGE the
project documents — a DIVERSE PERSONA SWARM aggregates better than one LLM's
point estimate — at a scale we can actually run.

Mechanism (the part that matters):
  - a fixed roster of diverse persona archetypes, each with a role, an opinion
    BIAS, an INFLUENCE weight, and a reaction style (the MiroFish persona model)
  - each persona independently estimates P(YES) via one LLM call, grounded in
    the market's seed material
  - aggregate = INFLUENCE-WEIGHTED mean; dispersion across personas = the
    swarm's disagreement → confidence (low disagreement = high confidence).
    This is wisdom-of-crowds, and it matches our own AI-desk finding that
    multi-perspective debate beats a single call.

Satisfies the exact contract our client (signals/mirofish_client.py) expects:
  POST /api/simulate    {seed, goal}     → {simulation_id}
  GET  /api/status/{id}                  → {status}
  GET  /api/report/{id}                  → {report, confidence, personas...}

LLM: NVIDIA NIM (same key/model as the rest of the stack). Concurrency-capped.
Run: .venv/bin/python signals/mirofish_server.py   (launchd on :5001)
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
import uuid
from statistics import mean, pstdev

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aiohttp import web
from openai import AsyncOpenAI

from core.config import cfg

# ── the persona swarm (diverse roles, biases, influence) ─────────────────────
# influence = how much weight in the aggregate; bias = prior lean the persona
# argues from (the swarm's diversity is the whole point).
PERSONAS = [
    {"name": "Domain Expert",        "influence": 1.4, "bias": "evidence-driven, cites base rates",
     "role": "a subject-matter expert who reasons from historical base rates and mechanisms"},
    {"name": "Quant PM",             "influence": 1.3, "bias": "priced-market efficient",
     "role": "a quant portfolio manager who trusts the current market price unless there's a clear mispricing"},
    {"name": "Insider/Specialist",   "influence": 1.2, "bias": "informed, contrarian to crowd",
     "role": "a well-connected specialist who often knows more than the retail crowd"},
    {"name": "Policy Analyst",       "influence": 1.1, "bias": "institutional, slow-moving",
     "role": "a policy analyst weighing institutional and regulatory realities"},
    {"name": "News Reader",          "influence": 0.9, "bias": "recency-driven",
     "role": "a news-driven trader who over-weights the latest headlines"},
    {"name": "Momentum Chaser",      "influence": 0.8, "bias": "trend-following",
     "role": "a momentum trader who extrapolates the recent direction"},
    {"name": "Skeptic",              "influence": 1.0, "bias": "fade the hype",
     "role": "a professional skeptic who fades consensus and hype"},
    {"name": "Risk Manager",         "influence": 1.0, "bias": "tail-aware, cautious",
     "role": "a risk manager focused on what could make this resolve the unexpected way"},
    {"name": "Retail Crowd",         "influence": 0.7, "bias": "sentiment-driven",
     "role": "the aggregate retail crowd, driven by sentiment and narrative"},
    {"name": "Contrarian",           "influence": 0.9, "bias": "against consensus",
     "role": "a contrarian who bets against whatever the crowd believes"},
    {"name": "Historian",            "influence": 1.1, "bias": "base-rate anchored",
     "role": "a forecaster who anchors hard on the long-run base rate for this class of event"},
    {"name": "Market Maker",         "influence": 1.2, "bias": "order-flow aware",
     "role": "a market maker reading the balance of informed vs uninformed flow"},
    # expanded swarm — more expertise domains, horizons, and temperaments
    {"name": "Macro Economist",      "influence": 1.2, "bias": "top-down, cycle-aware",
     "role": "a macroeconomist weighing rates, growth and liquidity conditions"},
    {"name": "Geopolitics Analyst",  "influence": 1.0, "bias": "scenario-tree",
     "role": "a geopolitics analyst mapping how state actors and events could unfold"},
    {"name": "Contrarian Whale",     "influence": 1.1, "bias": "capital-weighted contrarian",
     "role": "a large-capital trader who fades crowded positioning when it's overextended"},
    {"name": "Sentiment Quant",      "influence": 0.9, "bias": "social-signal driven",
     "role": "a quant reading social-media sentiment and search-trend momentum"},
    {"name": "Value Investor",       "influence": 1.0, "bias": "mean-reversion, patient",
     "role": "a value investor who assumes extremes revert to fundamentals"},
    {"name": "Options Flow Reader",  "influence": 1.0, "bias": "dealer-positioning aware",
     "role": "a trader inferring direction from options gamma and dealer hedging"},
    {"name": "Contrarian Retail",    "influence": 0.6, "bias": "dumb-money fade",
     "role": "the over-eager retail dip-buyer whose consensus is often a fade signal"},
    {"name": "Event Trader",         "influence": 1.1, "bias": "catalyst-timing",
     "role": "an event-driven trader focused on whether the catalyst lands in the window"},
    {"name": "Statistician",         "influence": 1.2, "bias": "pure base-rate",
     "role": "a cold statistician who ignores narrative and prices only the base rate"},
    {"name": "Insider Skeptic",      "influence": 1.0, "bias": "assume you know less",
     "role": "a humble forecaster who assumes the market price already contains private info"},
    {"name": "Momentum Quant",       "influence": 0.9, "bias": "time-series momentum",
     "role": "a systematic momentum quant extrapolating the established trend"},
    {"name": "Regime Analyst",       "influence": 1.1, "bias": "regime-conditional",
     "role": "an analyst who first identifies the market regime, then forecasts within it"},
]
# MICRO-AGENTS (your idea): NVIDIA NIM open models let us run the persona votes
# on a small FAST model (llama-3.1-8b ≈ 0.25s vs the 31B ≈ 2s). Cheap+fast per
# agent → we replicate each archetype into a POPULATION (the MiroFish way: many
# agents per persona type, each with individual temperature variation). Small
# models are noisier individually, but the swarm AVERAGES the noise out — this
# is exactly why quantity of diverse cheap agents beats a few expensive ones.
MICRO_MODEL = os.getenv("MIROFISH_MICRO_MODEL", "meta/llama-3.1-8b-instruct")
REPLICAS = int(os.getenv("MIROFISH_REPLICAS", "3"))      # agents per archetype
MAX_CONCURRENCY = 20                                     # micro-agents are fast
DELIBERATION_ROUNDS = 2   # round 1 = independent; round 2 = see the swarm & revise


def build_population() -> list[dict]:
    """Expand archetypes → a population of micro-agents with individual variation."""
    pop = []
    for base in PERSONAS:
        for i in range(REPLICAS):
            a = dict(base)
            a["temp"] = round(0.55 + random.random() * 0.5, 2)   # personality spread
            a["agent_id"] = f"{base['name']}#{i+1}"
            pop.append(a)
    return pop

_client: AsyncOpenAI | None = None
_sims: dict[str, dict] = {}


def llm() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            api_key=cfg.mirofish_llm_api_key or cfg.nvidia_api_key,
            base_url=cfg.mirofish_llm_base_url, timeout=25.0)
    return _client


async def ask_persona(sem: asyncio.Semaphore, persona: dict, seed: str, goal: str,
                      crowd: str | None = None) -> dict | None:
    base = (f"You are {persona['role']}. Your natural bias: {persona['bias']}.\n\n"
            f"{seed}\n\nGoal: {goal}\n\n")
    if crowd:
        # DELIBERATION: the persona sees the swarm and may revise (the MiroFish
        # 'argue and shift opinion' mechanism) — but must stay true to its bias.
        base += (f"The swarm's first-round view: {crowd}\n"
                 "Considering the crowd BUT staying true to your perspective, "
                 "give your (possibly revised) probability. ")
    prompt = base + ('From YOUR perspective give an honest probability (0-100%) '
                     'that this resolves YES + one sentence why. '
                     'Reply ONLY as JSON: {"p": <0-100>, "why": "<one sentence>"}')
    async with sem:
        try:
            r = await llm().chat.completions.create(
                model=MICRO_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=persona.get("temp", 0.7), max_tokens=110)
            txt = r.choices[0].message.content or ""
            m = re.search(r"\{.*\}", txt, re.DOTALL)
            d = json.loads(m.group(0)) if m else {}
            p = float(d.get("p", 50))
            if p > 1:
                p /= 100.0
            p = max(0.02, min(0.98, p))
            return {"name": persona["name"], "influence": persona["influence"],
                    "p": round(p, 3), "why": str(d.get("why", ""))[:160]}
        except Exception:
            return None


def _aggregate(votes: list[dict]) -> tuple[float, float]:
    wsum = sum(v["influence"] for v in votes)
    p = sum(v["p"] * v["influence"] for v in votes) / wsum
    disp = pstdev([v["p"] for v in votes]) if len(votes) > 1 else 0.25
    return p, disp


def _extremize(p: float, disp: float) -> float:
    """Satopää-style extremizing. A simple crowd mean is provably UNDER-confident
    — it collapses toward 0.5. The optimal aggregate pushes away from 0.5 in
    proportion to how much the crowd AGREES. Tight swarm (low dispersion) → sharpen
    hard; split swarm → stay humble. This is what makes an aggregated crowd beat
    its own members (Satopää et al. 2014; "Wisdom of the Silicon Crowd" 2024)."""
    agreement = max(0.0, min(1.0, 1 - disp / 0.25))      # disp 0 → 1.0, disp≥.25 → 0
    a = 1.0 + 1.3 * agreement                            # exponent 1.0 … 2.3
    pe = p ** a / (p ** a + (1 - p) ** a)
    return max(0.02, min(0.98, pe))


async def run_simulation(sim_id: str, seed: str, goal: str) -> None:
    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    population = build_population()          # archetypes × REPLICAS micro-agents
    # ROUND 1 — independent votes
    r1 = [v for v in await asyncio.gather(
        *[ask_persona(sem, p, seed, goal) for p in population]) if v]
    if not r1:
        _sims[sim_id] = {"status": "failed", "ts": time.time()}
        return
    p1, disp1 = _aggregate(r1)
    votes = r1

    # ROUND 2+ — DELIBERATION: each persona sees the crowd summary and revises.
    # This is the emergent-opinion mechanism that makes a swarm > independent
    # votes; convergence across rounds = a real signal, persistent spread =
    # genuine irreducible uncertainty.
    shift = 0.0
    for _ in range(DELIBERATION_ROUNDS - 1):
        bull1 = sum(1 for v in votes if v["p"] > 0.5)
        crowd = (f"consensus {p1*100:.0f}% YES, {bull1}/{len(votes)} bullish, "
                 f"spread {disp1:.2f}. Sample views: "
                 + "; ".join(f"{v['name']} {v['p']*100:.0f}%" for v in votes[:6]))
        r2 = [v for v in await asyncio.gather(
            *[ask_persona(sem, p, seed, goal, crowd) for p in population]) if v]
        if r2:
            p2, disp2 = _aggregate(r2)
            shift = round(p2 - p1, 3)
            votes, p1, disp1 = r2, p2, disp2

    p_raw, disp = p1, disp1
    p_agg = _extremize(p_raw, disp)                         # sharpen a confident crowd
    ext_txt = (f" Extremized {p_raw*100:.0f}%→{p_agg*100:.0f}% (crowd agreement)."
               if abs(p_agg - p_raw) > 0.01 else "")
    confidence = max(0.2, min(0.95, 1 - disp * 2.5))       # tight swarm = confident
    bull = sum(1 for v in votes if v["p"] > 0.5)
    top = sorted(votes, key=lambda v: -v["influence"])[:5]
    shift_txt = (f" After {DELIBERATION_ROUNDS} deliberation rounds the swarm "
                 f"{'converged up' if shift > 0.02 else 'converged down' if shift < -0.02 else 'held steady'} "
                 f"({shift:+.2f}).") if DELIBERATION_ROUNDS > 1 else ""
    report = (
        f"MiroFish swarm ({len(votes)} personas, {DELIBERATION_ROUNDS} rounds): "
        f"consensus probability {p_agg*100:.0f}% YES (influence-weighted). "
        f"Split {bull} bullish / {len(votes)-bull} bearish; "
        f"disagreement {disp:.2f}.{shift_txt}{ext_txt} Key voices: "
        + " | ".join(f"{v['name']} {v['p']*100:.0f}% ({v['why']})" for v in top))
    _sims[sim_id] = {
        "status": "completed", "ts": time.time(),
        "report": report, "probability": round(p_agg, 3),
        "confidence": round(confidence, 3), "disagreement": round(disp, 3),
        "deliberation_shift": shift, "rounds": DELIBERATION_ROUNDS,
        "personas": votes}


async def h_simulate(request: web.Request) -> web.Response:
    body = await request.json()
    sim_id = uuid.uuid4().hex[:12]
    _sims[sim_id] = {"status": "running", "ts": time.time()}
    asyncio.create_task(run_simulation(sim_id, body.get("seed", ""), body.get("goal", "")))
    # bound memory
    if len(_sims) > 500:
        for k in sorted(_sims, key=lambda k: _sims[k]["ts"])[:100]:
            _sims.pop(k, None)
    return web.json_response({"simulation_id": sim_id})


async def h_status(request: web.Request) -> web.Response:
    s = _sims.get(request.match_info["id"])
    return web.json_response({"status": s["status"] if s else "unknown"})


async def h_report(request: web.Request) -> web.Response:
    s = _sims.get(request.match_info["id"])
    if not s or s["status"] != "completed":
        return web.json_response({"error": "not ready"}, status=404)
    return web.json_response(s)


async def h_health(_: web.Request) -> web.Response:
    return web.json_response({"ok": True, "archetypes": len(PERSONAS),
                             "population": len(PERSONAS)*REPLICAS, "sims": len(_sims),
                             "micro_model": MICRO_MODEL, "replicas": REPLICAS})


def main() -> None:
    app = web.Application()
    app.add_routes([
        web.get("/", h_health),
        web.post("/api/simulate", h_simulate),
        web.get("/api/status/{id}", h_status),
        web.get("/api/report/{id}", h_report),
    ])
    print(f"[mirofish-server] {len(PERSONAS)} archetypes x{REPLICAS} = {len(PERSONAS)*REPLICAS} "
          f"micro-agents on :5001 (model {MICRO_MODEL})", flush=True)
    web.run_app(app, host="127.0.0.1", port=5001, print=None)


if __name__ == "__main__":
    main()
