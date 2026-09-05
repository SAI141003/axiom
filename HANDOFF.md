# AXIOM — Project Handoff

*A live quant trading & research platform for Polymarket + equities/options. This file lets any AI or engineer pick up exactly where the project is. Read it top to bottom before touching anything.*

Last updated: 2026-07-11.

---

## 0. THE OPERATING METHOD (read first — it's why this works)

This project is built on one rule: **refuse to believe your own numbers until they survive contact with reality.** Full doctrine is in `~/Downloads/FABLE_METHOD.md`. The short version:

- **Reality co-signs every number.** A price isn't real until the venue confirms it; a ticker the LLM names isn't real until a live quote validates it; a strategy has no edge until paper trades resolve profitably.
- **Price at the executable side.** Buyers pay the ask, sellers get the bid, baskets must be complete, fees included, resolution from the venue's own settlement source.
- **Losses are data.** Report them first with exact numbers. A strategy that fails its gap-test is a finding, not a failure.
- **Question the premise.** "Why does BTC lose?" → BTC wasn't the loser (see §6).

---

## 1. WHAT IT IS

Two halves that meet through Redis + JSONL logs + a WebSocket bridge:

- **Python bot** (`main.py`, 15 async workers) — the live Polymarket trading engine + quant math. Runs DRY_RUN by default.
- **Next.js frontend** (`frontend/`) — the whole web UI + a live-data API layer (TypeScript).
- **Dry-run daemons** (`dryrun/`) — each strategy paper-trades live 24/7, resolves against reality, and logs to `logs/*.jsonl`.
- **Self-learner + Monte Carlo** — nightly parameter refit (stability-tested) and hourly robustness backtest.

Languages: **Python 3.14** (`.venv/`) + **TypeScript/React**. No C++.

---

## 2. RUN IT

Everything is launchd (`~/Library/LaunchAgents/com.polymarket.*`), auto-restart + reboot-safe. Manual:

```bash
# frontend  → http://localhost:3000
cd frontend && npm run dev
# bot
NO_DASHBOARD=1 .venv/bin/python main.py
# any daemon
.venv/bin/python dryrun/<name>_daemon.py
```

Infra: **Redis** (`brew services start redis`), **PostgreSQL 14** (role `trading`/`trading`, db `polymarket_hft`).

**GOTCHA:** never run `next build` while the dev server is up — it corrupts the shared `.next`. If pages 404/500 in dev: `rm -rf frontend/.next && npm run dev`.

---

## 3. THE STRATEGIES (all paper-tested; NONE proven robust yet except the newest candidate)

| Strategy | Daemon | Status (2026-07-11) |
|---|---|---|
| **BTC Oracle-Lag** ⭐ | `btc_oraclelag_daemon.py` | THE EDGE. First-minute in-window move predicts close **74.5% @ +9.5σ**. Binance leads Chainlink (Polymarket's resolution source); the lag is the edge. Paper-testing whether the CLOB ask lags enough. |
| Crypto 5-min | `crypto_daemon.py` | Momentum = NOISE (~51%, coin flip). BTC-only now; eth/sol/xrp disabled (losers). |
| Weather | `weather_daemon.py` | Net-negative. Two bugs fixed (guard 1: no NO vs locked max; guard 3: no YES rise after 16h). Watching post-fix trades. |
| Pre-Market | `premarket_daemon.py` | User's style: $1k, under-$10, first-20-min. −$17/10 trades. |
| Options | `options_daemon.py` | Daily paper positions at the ask, marked at the bid. Penny 0DTE lesson: take intraday, not to expiry. |
| Kronos 1-hour | `kronos1h_daemon.py` | Kronos foundation model on hourly BTC/ETH markets. Just started. |
| VWAP Trend | `vwap_daemon.py` | Zarattini/Aziz SSRN 4631351 replication: long QQQ/TQQQ above session VWAP, short below, EOD flat. Started 2026-07-13. |
| News-Lag ⭐ | `newslag_daemon.py` | brody-pipeline architecture (brodyautomates/polymarket-pipeline): news-desk classifications → NICHE markets <$500K vol → edge = materiality × room-to-move → quarter-Kelly paper trades. The research-backed successor to BTC oracle-lag. Started 2026-07-13. |
| NegRisk arb | in `main.py` | CLOB-validated Dutch books (the "+153%" was fake incomplete baskets — fixed). |

Analyze all: `.venv/bin/python dryrun/analyze.py`
Monte Carlo (10k iter): `.venv/bin/python dryrun/montecarlo_backtest.py`
  — now includes a permutation SELECTION-BIAS check on the crypto param scan
  (2026-07-13 result: best config p=1.0 → pure luck; momentum tuning is dead).
THE BRAIN: `dryrun/brain.py` — reflection loop (per-segment attribution →
  lessons → bounded actions) + payoff-aware discounted Thompson allocation
  (`.data/brain_allocation.json`, advisory). Owns kronos per-asset arming.
META-LABEL: `dryrun/metalabel.py` — trains P(win|features) for oracle-lag;
  gates the daemon ONLY after OOS AUC ≥ 0.55 at n ≥ 60 (status in
  `.data/metalabel_oraclelag.json`).
Overnight loop runs MC + learner + brain + metalabel hourly → `logs/reports/overnight_latest.txt`.
Research: `RESEARCH_NEURAL_TRADING.md` (methods + roadmap) and
`RESEARCH_FUNDS_PLAYBOOK.md` (Bridgewater/HFT parts mapped to this system).

---

## 4. LIVE TRADING (proven, gated, currently DRY_RUN)

- **Connection PROVEN** with a real $1 order (Norway-WC NO @ 94¢, filled). Balance $14.16 (via CLOB collateral, sig_type=1 — on-chain scanners show $0 because funds are in the proxy L2 layer).
- **Keys needed** (in `.env`, set via `/settings` UI): `POLYMARKET_PRIVATE_KEY` + `POLYMARKET_FUNDER` (proxy addr). API creds auto-derive. `POLYMARKET_SIGNATURE_TYPE=1` (email/Magic account).
- **CLOB v2 is mandatory** — `py-clob-client-v2` (installed). v1 builds an outdated order schema the server rejects ("invalid order version"). Orders MUST pass `neg_risk` + `tick_size` per token via `PartialCreateOrderOptions`. See `dryrun/live_connection_test.py` for the canonical working call.
- **Risk stack** (`.env`, editable at `/live-account`): `LIVE_MICRO_USD` (stake, ≤$5), `LIVE_DAILY_CAP_USD`, `LIVE_DAILY_PROFIT_TARGET` (auto-stop after +$X), `LIVE_STOP_LOSS_USD`. Plus `MAX_BET_USD=25`, `DAILY_LOSS_LIMIT_USD=150`, order throttle 12/min, kill switch.
- **Going live = one manual step**: `DRY_RUN=true → false` in `.env`, restart bot. NEVER a UI button. Don't flip until a strategy is ROBUST in the MC report.

---

## 5. THE PAGES (frontend/app/)

`/` launcher · `/live-account` (real balance + risk knobs) · `/intel` (opportunities + AI review + learning journal) · `/crypto` (auto-bot) · `/weather` + `/weather-bot` · `/premarket` · `/options` (+ Budget Finder, Monte Carlo, penny finder) · `/stocks` (Deep Chain Research = search ANY company → suppliers/customers/news/history, all live-quote validated; + 6 supply-chain maps) · `/live` (Polymarket+Kalshi) · `/arbitrage` · `/ai` (5 LLM tools) · `/mirofish` (agent brain, canvas dot-net) · `/terminal` (Bloomberg-style) · `/settings` (keys + bot on/off + automation toggles).

Design system: `frontend/app/globals.css` — one accent (`--hud-accent` indigo), semantic green/red/amber only. Every page uses `hud-*` classes.

---

## 6. HARD-WON LESSONS (don't re-learn these)

1. **5-min crypto momentum is noise** for every asset (±1.3σ of coin flip). BTC "won" and SOL "lost" by luck. The edge is the oracle-lag (§3), not momentum tuning.
2. **Polymarket app shows ASK prices** (sum >$1). Mid flattered entries by half the spread — fixed everywhere.
3. **Resolution = the venue's source.** BTC 5-min settles on Chainlink; weather on Wunderground airport stations (ICAO in the market description URL); use those, Binance/grid are fallbacks.
4. **On-chain balance ≠ CLOB balance** for proxy accounts — always ask the CLOB.
5. **LLM output is a candidate, never fact** — validate every named ticker against a live quote (Deep Chain Research does this).
6. **Too-good numbers are bugs** — NegRisk "+153%" was incomplete baskets; validate at the orderbook.

---

## 7. REPO CAPABILITIES (cloned in-project, gitignored)

- `kronos_repo/` — Kronos foundation model (github.com/shiyu-coder/Kronos). Used via `signals/kronos_signal.py` — now a 3-run stochastic ENSEMBLE (agreement + pred_vol_bp).
- `vibe_trading_repo/` — HKUDS/Vibe-Trading, 460 alpha factors (191 gtja191, 154 qlib158=Microsoft Qlib Alpha158, 101 alpha101=WorldQuant, 10 academic). `signals/alpha_factors.py` computes ALL that run cleanly on our OHLCV → **50 daily** (was 7) → .data/alpha_factors.json.
- `brody_repo/` — brodyautomates/polymarket-pipeline. Architecture adopted in `dryrun/newslag_daemon.py` (direction+materiality classification, niche <$500K filter, edge_v2, quarter-Kelly). Daemon running.
- `signals/mirofish_server.py` + `mirofish_client.py` — ✅ LIVE. MiroFish (github 666ghj/MiroFish, 53k★: swarm of persona-agents → aggregate forecast). We run a right-sized backend on :5001 (launchd com.polymarket.mirofish): 12 diverse personas (role+bias+influence) each LLM-estimate P(YES) via NVIDIA NIM → influence-weighted consensus + disagreement→confidence. Wired: main.py MiroFishPreStager (hourly, uncertain markets vol>50K & 0.25-0.75) → Redis 24h cache → signal_worker → ensemble.py blends 0.80·signal + 0.20·mirofish. Frontend: /api/mirofish (run a swarm on any question). NOT the full upstream (Neo4j + thousands of agents = token-ruinous); this is the core swarm mechanism at runnable scale.
- `signals/timesfm_signal.py` — TimesFM integration, 298 lines, currently UNUSED (dead import path) — consistent with research: TimesFM zero-shot financial R² = −2.8%. Revive only as one meta-label feature, never standalone.

---

## 8. KEY FILES MAP

```
main.py                     bot orchestrator (15 workers)
core/{config,models,events} settings, pydantic models, event bus
signals/                    quant math: heston, kelly, yang-zhang, kronos, ensemble
match/                      arbitrage: negrisk_arb (CLOB-validated), oracle_lag, kalshi
execute/executor.py         CLOB order submission (v2, neg_risk+tick_size)
risk/                       risk_engine (7 checks), kill_switch
dryrun/                     all paper-test daemons + learner + montecarlo + live_micro
  bot_switch.py             per-bot master on/off (reads .env)
  live_micro.py             $1 real-order path, gated to death
  live_connection_test.py   canonical working live-order example (v2)
frontend/app/               pages + api/ routes
frontend/lib/               llm.ts (Groq→Cerebras→Anthropic→NVIDIA), montecarlo.ts, toggles.ts
logs/*.jsonl                every strategy's trade record (the source of truth)
.data/                      learned params, mc verdicts, day-start balance
scripts/clob_balance.py     one-shot real balance (used by /api/live/balance)
```

Secrets live in `.env` (gitignored). Template: `.env.example`. LLM keys go in `frontend/.env.local`.

---

## 9. WHAT TO DO NEXT

1. **BTC 5-min oracle-lag: VERDICT IN (2026-07-13)** — the maker-sim timing
   sweep (233 windows, signal at 12/24/36/48s × bid depth) shows EVERY config
   loses, maker and taker, even at 69% signal accuracy: the CLOB reprices in
   <12s and fills show adverse selection. Do NOT chase a sub-12s race (that's
   the professionals' arms race, per Budish/$40M literature). Keep the daemon
   signal-only for data; the edge hunt moves to (a) news-driven markets with
   the documented 30–90s lag (`logs/news_intel.jsonl` is accumulating), and
   (b) niche informed-specialist markets (weather-class).
2. **Crypto momentum: CLOSED** — permutation null p=1.0 AND the naive
   baseline (always buy the cheaper side, +$194/6878tr) beats every config.
3. **Read `logs/reports/overnight_latest.txt`** each morning — MC verdicts,
   brain lessons, Thompson allocation, meta-label status, maker-sim.
4. **Never flip DRY_RUN** until MC says ROBUST *and it stays ROBUST* (weather
   flipped 61%→37% in two days — verdicts are perishable).
