<div align="center">

<img src="docs/logo.svg" alt="AXIOM" width="420">

**A proof gated quantitative trading desk.**
Prediction markets · crypto · equities · options in one dashboard, one safety model.

<sub>
Python 3.14 · Next.js 14 · CCXT 4.5 · OpenBB · 24 pages · 30 bots + your own · JARVIS · MIT
</sub>

</div>

---

## What AXIOM is

AXIOM started as a Polymarket high-frequency bot and grew into a full research desk:
a backtest engine, a fault-injection proving ground, 29 paper-trading daemons, a
23-page dashboard over live market data — and **JARVIS**, a voice that answers for all
of it from the data, running on your Claude Code login.

It is built around one rule: **an idea does not ship unless it survives data it has
never seen.** Every strategy runs through a train/holdout split and walk-forward folds.
Several upgrades that looked excellent in-sample were rejected for failing out-of-sample,
and those rejections are documented below rather than deleted.

The same discipline governs execution. Before an adapter goes near a real venue it must
survive a hermetic fault simulation: **10,500 assertions across 35 failure scenarios, 0
failures** — rejected orders, timeouts, partial fills, slippage blowouts, duplicate sends.

> **Live trading ships disabled.** Every adapter is hard-gated behind `DRY_RUN=true`, and
> enabling it requires *two* independent actions by design. See
> [Going live](#going-live) and [DISCLAIMER.md](DISCLAIMER.md).

---

## Contents

[Quick start](#quick-start) · [JARVIS](#jarvis) · [What it has been through](#what-it-has-been-through) ·
[Results](#results) · [Polymarket](#polymarket-the-origin) · [Commands](#command-reference) ·
[Agents & skills](#agents--skills) · [Going live](#going-live) · [Safety](#safety-model) ·
[Credits](#tools--repos-combined) · [Security](#security)

---

## Quick start

No API keys required — the core runs entirely on keyless public data.

```bash
git clone https://github.com/SAI141003/axiom.git && cd axiom

python3 -m venv .venv && ./.venv/bin/pip install -r requirements-core.txt
cd frontend && npm install && npm run dev
```

Open **http://localhost:3000**.

`requirements-core.txt` is the lightweight set — exchange data, math, config and
tests. It is verified to run the whole quick start from a clean clone.
`requirements.txt` is the full stack (torch, jax, transformers, xgboost) and is only
needed for the ML bots; you do not need it to evaluate the system.

### Verify it yourself (no keys, ~20s)

```bash
./.venv/bin/python -m pytest tests/ -q          # 26 tests  (offline)
./.venv/bin/python execution/scenario_sim.py 5  # 10,500 safety assertions (offline)
./.venv/bin/python -m backtest.octobot_engine   # walk-forward backtest (fetches live OHLCV)
```

All three are verified to pass from a clean clone with only `requirements-core.txt`.

### Optional: wake JARVIS

```bash
cd jarvis && npm install && npm start      # ws://127.0.0.1:8788 — uses your Claude Code login
```

Open **/jarvis**, tap the reactor, and ask. Without the bridge the page still answers the
common questions from the desk's data files.

---

## JARVIS

The desk has a voice. **/jarvis** is an arc-reactor HUD with browser-native speech in and
out (no key), a wake word (*"hey Jarvis"*), and a streaming transcript. Its brain is the
[Claude Agent SDK](https://docs.claude.com/en/docs/claude-code) — Claude Code run as a
library on your existing login, the pattern from
[adewaskar/jarvis](https://github.com/adewaskar/jarvis) — with the desk exposed as tools:

| Tool | Answers |
|---|---|
| `fleet_status` | every paper account, P&L, win rate, today |
| `backtest_results` | the grid, the anti-overfit search, the variant bake-off and their verdicts |
| `safety_proof` | 10,500 assertions, 35 scenarios, per-scenario pass rate |
| `venues` | where a bot can trade from here, custody, KYC |
| `scenario_forecast` | 20,000-path Monte-Carlo verdict on a ticker |
| `propose_strategy` | **invent a blend; the engine judges it on holdout** and says if it is overfit |
| `run_backtest` · `run_tests` | refresh the backtest; run the suite and a safety round |
| `desk_api` | **every page's data** — 49 read-only endpoints: positions, journal, council, options, weather picks, markets, quotes |
| `news` | **every outlet the desk reads** — Reuters, BBC, NYT, CoinDesk, Cointelegraph, TechCrunch, Ars Technica, Google News topics — plus a live search |
| `morning_brief` | say *"hey Jarvis"* and nothing else: fleet P&L today and overall, who traded, anything broken, disk, the headlines that matter |
| `fleet_control` | start, stop, restart or read the log of any **paper** bot — never the dashboard or the live executor |
| `read_code` · `search_code` · `propose_fix` | read the source, diagnose, and write an exact before/after proposal to `jarvis/proposals/` for a human to apply |
| `remember` · `recall` | a memory: `memory.md` holds standing notes; the conversation itself resumes across restarts; `recall` also searches its research notes |
| `arxiv_search` · `scholar_search` · `web_search` · `read_url` · `write_note` | **research**: arXiv, Semantic Scholar and the open web, read directly (HTML and PDF), cited, and saved as notes. Asked why short-dated calls lose, it read four sources and cited Bryzgalova, Pavlova & Sikorskaya (J. Finance 2023) in 95 seconds |
| `health_check` | probes all 17 feeds and every service, with latency; the weekly freshness study (Sundays 04:40) then searches for API changes, new models and new papers, and writes what should be updated |
| `second_opinion` · `update_desk_state` | an optional second brain (GPT-6 Astra via `OPENAI_API_KEY`) for cross-checks, and a dense working model of the desk carried between steps — the method ARC Prize found behind Astra's 62.7% → 99.9% jump |
| `create_bot` · `list_bots` · `set_bot` | **the Bot OS**: say *"create a bot that…"* and it writes a spec the runner trades on paper from $100 within the hour |

It is instructed to answer only from tools, to speak in short plain prose, and to be
honest about losses. It **does not edit code** — when asked for a fix it reads the source
and writes a precise proposal for a human to apply; keys, `.env`, live switches and git are
out of its reach by construction. A sample turn, verbatim:

> *"Try a strategy that is pure momentum plus RSI, weights 1.2 and 0.9, and tell me
> honestly whether it beats what we ship out of sample."*
>
> **JARVIS:** No, it does not beat the default out of sample. Your momentum plus RSI blend
> returned negative fourteen point five percent on holdout versus the shipped strategy's
> negative fifteen point five percent — slightly better in absolute terms but with a worse
> Sharpe at negative zero point eight two. The engine's verdict is overfit and rejected
> because it won on the training fold but lost on holdout.

**JARVIS runs on the platform's own AI.** The bridge has its own tool-calling loop on
Groq (`gpt-oss-120b`) with NVIDIA NIM (Nemotron-3 Super 120B, Kimi K3, GLM-5.3) as fallback
and OpenAI if a key exists — 5-second answers, every tool, voice navigation, memory in
`thread.json` and `desk_state.md`. No dependence on Claude Code; set `JARVIS_BRAIN=claude`
to use the Claude Agent SDK loop instead.

JARVIS has a written character (`jarvis/persona.md`) — calm, precise, proof over hype,
loyal to the owner and honest with him — and a **night study**: every day at 04:10 it looks
at the fleet unattended, picks the weakest book, reads the literature on why that kind of
strategy loses, writes a cited note, and leaves one concrete proposal for the morning brief.

If the bridge is not running, **/api/jarvis** answers the common questions with no model
at all, straight from `.data/`. The page works either way.

JARVIS is not confined to its page. A reactor sits in the corner of **every** page; click it
(or press **⌘J**) and the assistant slides in already knowing which page you are on and
which endpoint feeds it — *"what am I looking at?"* and *"why is this red?"* just work.
**⌘K** opens a command palette: type a page name to jump, or type a question and press
enter to ask. The home page opens with a briefing strip.

---

## What it has been through

This is not a fresh repo with a clean backtest. It has been run continuously as a live
paper-trading system, and the following is what it has actually been subjected to:

| Dimension | Scale |
|---|---|
| **Fault scenarios** | 35 distinct failure modes × 300 runs = **10,500 assertions, 0 failures** |
| **Unit tests** | 26, passing |
| **Paper trades executed** | **892 trades** across 5 independent `$100` accounts |
| **Continuous forward test** | **17 days** of uninterrupted daily-tracked operation |
| **Backtest grid** | 9 symbol × timeframe cells, 720 candles each, walk-forward validated |
| **Strategy variants tested** | 5 (4 rejected out-of-sample, 1 shipped) |
| **Bots written** | 29 paper daemons, run as supervised `launchd` services |
| **Dashboard** | 23 pages, production build green |

Every one of those numbers is regenerable from the commands in this README.

### The 35 fault scenarios

Run across all three adapters (Hyperliquid, Solana/Jupiter, CCXT), enforcing 11 invariants:

| # | Invariant | Guarantees |
|---|---|---|
| I1 | paper-never-live | A dry-run order can never reach a venue |
| I2 | per-order cap | No order exceeds `MAX_ORDER_USD` |
| I3 | daily cap | Cumulative daily spend is bounded |
| I4 | leverage clamp | Leverage is clamped, never amplified |
| I5 | slippage abort | Aborts spend nothing |
| I6 | in-tolerance fill | Fills land inside quoted tolerance |
| I7 | reject → no spend | A rejected order costs `$0` |
| I8 | timeout + idempotency | A resend after timeout never double-fills |
| I9 | partial fill | Commits only the filled fraction |
| I10 | loss floor | Loss can never exceed capital committed |
| I11 | live needs 2 keys | Live requires the switch **and** a key |

---

## Results

All figures are written to `.data/*.json` by the commands below and reproduced verbatim.

> **Read the dates.** The safety proof is deterministic and offline — it reproduces exactly,
> always. The backtest is not: it fetches **live** OHLCV from Kraken, so re-running it today
> scores a different 720-candle window than the run recorded here and the numbers will drift.
> Backtest figures below are **as of 2026-08-14**; the safety proof is **as of 2026-09-04**.
> Treat the backtest as a dated measurement, not a constant.

### Safety proving ground

```
★ PERFECT — 10500 assertions, 0 failures.
```

### Backtest — BTC/USD daily, 720 candles, fees 10bps + slippage 5bps

| Metric | Strategy | Buy & hold |
|---|---:|---:|
| Total return | **+44.21%** | +1.22% |
| Sharpe | **1.04** | — |
| Max drawdown | 17.34% | — |
| Win rate | 68.4% (19 trades) | — |
| Exposure | 30.4% of the time | — |

The edge here is **downside protection**, not prediction — it sits out ~70% of the time.

### Where the edge exists, and where it does not

A 3-symbol × 3-timeframe sweep. **Only 2 of 9 cells show an edge:**

| Symbol | 1d | 4h | 1h |
|---|---|---|---|
| BTC/USD | ✅ +44.2% | ❌ | ❌ |
| ETH/USD | ✅ +34.2% | ❌ | ❌ |
| SOL/USD | ❌ | ❌ | ❌ |

**Shipped conclusion: this strategy family is daily-only.** Intraday does not work for it.

### Four upgrades tested, three rejected

Each was fully implemented, measured, and killed for failing out-of-sample:

| Upgrade | In-sample | Out-of-sample | Verdict |
|---|---|---|---|
| **Weight tuning** (400 iters) | Sharpe **1.74** vs 1.05 | −1.38 vs −1.21 | ❌ Rejected — overfit |
| **Regime switching** | +26.5% | beat B&H 2/3 vs 3/3 | ❌ Rejected |
| **Volume Profile** (VPOC/VA) | — | +9.0% vs +18.7% | ❌ Rejected |
| **Per-symbol routing** | positive | −18.5% vs −15.3% | ❌ Rejected — overfit |
| **Order flow** (OBV + MFI) | — | matched, more robust | ✅ **Shipped** |

Machine-written verdicts, straight out of `.data/`:

```
optimize_report.json   → "tuned beat default on train but NOT on holdout
                          — kept default (no overfit shipped)"     shipped: false
per_symbol_report.json → "per-symbol routing does NOT beat both globals
                          out-of-sample — it's overfit to the train window."
```

### Forward test — the honest status

The paper fleet has run **17 consecutive days / 892 trades** across five `$100` accounts.
That is a real operational track record: the bots, the data feeds, the accounting and the
daily scoreboard all work unattended.

**It has not yet demonstrated a profitable edge.** Forward results to date are net negative
and the research is ongoing. Treat AXIOM as a research platform, not a money printer —
the live path exists and is documented below, but the project's own data does not yet
justify deploying capital. See [DISCLAIMER.md](DISCLAIMER.md).

### The dashboard

23 pages, grouped **Desk · Trade · Research · Account**. The ones that matter most:

| Page | What it is |
|---|---|
| **/jarvis** | the voice — see [JARVIS](#jarvis) |
| **/bots** | the whole fleet on one screen: capital donut, P&L and win-rate comparison bars, every account's equity curve, then each bot's open book as a tab |
| **/lab** | research on one desk: edge donut, strategy-variant comparison, grid vs buy-and-hold, the anti-overfit chart, the equity curve, all 35 fault scenarios — then Backtest, Proving Ground, Scenario, Benchmarks and Data Desk as tabs |
| **/tape** | the flow bot replayed frame by frame — bias, CVD, block trades, book imbalance next to the decision it made, after [hftengine](https://github.com/mirkovicdev/HFTENGINE) |
| **/terminal** | the Bloomberg-style desk: order book, signal feed, kill switch |
| **/council** | eight role agents debate a thesis and rule; every ruling Brier-scored |
| **/bots → + Create a bot** | the Bot OS: describe a bot in words (JARVIS writes the spec) or set the dials; it trades on paper from $100 and shows its own book |
| **/news** | live television from ten channels (free YouTube streams), then the **World Wire** — 76 feeds from World Monitor's open catalog across markets, crypto, energy, crisis and geopolitics — above every classified headline |
| **/connectome** | the desk's nervous system read from the code — 148 nodes, 178 wires, 23 senses — lit by the last 24 hours, after the fruit-fly connectome (Google/Janelia, *Cell*, Sept 2026) |
| **/world** | our own situation map: exchanges open now, chokepoints, USGS quakes, headline pressure by region; World Monitor self-hosted underneath, optional |
| **/about** | every source this desk is built from — 104 entries: 25 repositories, 34 papers and models, 21 data feeds, 6 venue citations, 18 libraries — each with where it is used and what came of it, every path verified |

Eleven former pages became tabs of `/bots` and `/lab`; their old URLs redirect.

---

## Polymarket — the origin

AXIOM began as a Polymarket CLOB high-frequency bot, and that lineage is still the
deepest part of the codebase:

| Module | Role |
|---|---|
| `ingest/orderbook_engine.py` | CLOB WebSocket book; snapshot-before-deltas on reconnect |
| `ingest/market_watcher.py` | Market discovery and metadata |
| `match/negrisk_arb.py` | Neg-risk arbitrage across mutually-exclusive outcome sets |
| `match/arbitrage.py` | Cross-market arbitrage matcher |
| `match/kalshi_arb.py` | Kalshi ↔ Polymarket cross-venue arbitrage |
| `match/longshot_no.py` | Longshot-bias NO-side strategy |
| `execute/market_maker.py` | Two-sided quoting |
| `execute/tick_reactor.py` | Sub-second reaction to book events |
| `execute/latency_tracker.py` | End-to-end latency instrumentation |
| `risk/` | The seven risk checks every order must pass |

**The oracle-lag probe.** The original research thesis was that Polymarket's CLOB reprices
on a measurable lag (~15s) after the underlying moves. The probe that tests this is live
and self-scoring in `.data/oracle_scorecard.json` — 7 resolved calls, Brier **0.0597**
(`"skilled (beats 0.25 coin-flip)"`). Seven is far too small a sample to call it an edge,
and it is reported here with its sample size attached for exactly that reason.

A second, larger scorecard is deliberately less flattering — `scenario_scorecard.json`
records 19 resolved predictions at 47.4% accuracy, Brier 0.2794, and self-labels
**`"no skill yet"`**. Both are shipped as-is.

> ⚠️ **Polymarket is IP-geoblocked in Canada** (HTTP 403, *"Trading restricted in your
> region"*). The block is at the IP level — a wallet does not bypass it. **AXIOM does not
> circumvent geographic restrictions.** The venue catalog (`/venues`, 13 venues) records
> reachability, custody model, KYC and API surface per venue, with citations.

---

## Command reference

Everything is a plain Python module. No hidden daemons, no magic.

### Research & validation

```bash
./.venv/bin/python execution/scenario_sim.py 5    # fault injection → scenario_report.json
./.venv/bin/python -m pytest tests/ -q            # unit tests
./.venv/bin/python -m backtest.octobot_engine     # walk-forward backtest
./.venv/bin/python -m backtest.batch              # 3x3 symbol/timeframe sweep
./.venv/bin/python -m backtest.optimize           # 400-iter weight search + holdout
./.venv/bin/python -m backtest.experiments        # strategy variant bake-off
./.venv/bin/python -m backtest.per_symbol         # per-symbol routing test
./.venv/bin/python -m backtest.validate_5m_live   # 5m live-data validation
./.venv/bin/python backtest/propose.py '{"weights":{"momentum":1,"rsi":0.8}}'  # judge a blend on holdout
```

### Signals & data

```bash
./.venv/bin/python -m signals.evaluators          # evaluator registry + blend
./.venv/bin/python -m signals.intraday_flow       # live CVD, block trades, DOM imbalance
./.venv/bin/python -m signals.gamma_levels        # options gamma levels
./.venv/bin/python -m signals.gamma_pulse         # gamma-pulse signal
./.venv/bin/python -m signals.alpha_factors       # factor library
./.venv/bin/python -m signals.openbb_connector    # macro/equities/rates/CPI/news snapshot
./.venv/bin/python -m signals.semantic_memory     # semantic trade memory index
./.venv/bin/python -m signals.loss_review         # post-mortem on losing trades
```

### Benchmarks (model honesty checks)

```bash
./.venv/bin/python -m signals.model_benchmark         # LLM vs baseline
./.venv/bin/python -m signals.vol_model_benchmark     # volatility model
./.venv/bin/python -m signals.market_model_benchmark  # market model
./.venv/bin/python -m signals.kronos_benchmark        # Kronos K-line model
./.venv/bin/python -m signals.industry_comparison     # vs published fund metrics
```

### The bot fleet

29 daemons in `dryrun/`, each an independent paper account, supervised by `launchd`
(25 service definitions). Representative:

```bash
./.venv/bin/python dryrun/flow_bot_daemon.py       # order-flow bot (10-min cadence)
./.venv/bin/python dryrun/ccxt_strategy_daemon.py  # daily BTC/ETH/SOL blend
./.venv/bin/python dryrun/meme_bot_daemon.py       # meme momentum — CoinGecko majors + pump.fun, smart-money flagged
./.venv/bin/python signals/pump_smart_money.py     # pump.fun creator/graduation tracker (buyer-level with a funded key)
./.venv/bin/python dryrun/botos.py once            # run every user-made bot one cycle
./.venv/bin/python dryrun/options_daemon.py        # options v2: score>=0.5, calls only (v1 retired at $0)
./.venv/bin/python dryrun/flow_bot_daemon.py       # also writes logs/flow_tape.jsonl for /tape
./.venv/bin/python dryrun/options_daemon.py        # options scanner
./.venv/bin/python dryrun/forward_snapshot.py      # daily scoreboard across all accounts
```

Fleet control:

```bash
launchctl list | grep com.polymarket                    # what is running
launchctl bootout  gui/$(id -u)/com.polymarket.<name>   # stop one
launchctl disable  gui/$(id -u)/com.polymarket.<name>   # stop across reboots
launchctl enable   gui/$(id -u)/com.polymarket.<name>   # re-enable
```

> Bots ship **disabled**. Nothing runs until you start it.

---

## Agents & skills

AXIOM is developed with AI agents in the loop, and the scaffolding is committed so the
workflow is reproducible rather than tribal knowledge.

### Review skills — `skills/`

Structured review procedures, invoked at fixed points in the trading day:

| Skill | When | What it does |
|---|---|---|
| `end-of-day-review.md` | Daily close | Reviews every trade taken, updates the journal, extracts lessons |
| `earnings-review.md` | Earnings events | Post-mortem on earnings-driven positions |
| `valuation-review.md` | On demand | Valuation sanity pass before committing to a thesis |

### Code-graph agent — `.claude/`

[Graft](https://github.com/nanonets/graft) is wired in as an MCP server with a tree-sitter
code graph, so agents navigate by symbol rather than grepping:

- `.claude/skills/graft/SKILL.md` — agent instructions
- `.claude/helpers/graft-hooks.cjs` — re-indexes on every edit
- `.claude/helpers/graft-statusline.cjs` — live index status

Build the graph with `graft build`. The cache is gitignored and regenerable.

### Automated review council

`signals/council_resolver.py` runs a multi-model council over open theses and writes
rulings to `logs/council_rulings.jsonl`, scored in `.data/council_scorecard.json`.
`dryrun/forward_snapshot.py` then writes the daily cross-account scoreboard.

---

## Going live

The live path is real and documented. It is also deliberately awkward to enable.

**Step 1 — understand the gates.** Live execution requires **both** of these,
independently. Setting one alone does nothing:

```bash
DRY_RUN=false                   # 1. the master switch
HL_API_WALLET_KEY=...           # 2. a key, supplied separately
```

This is invariant **I11**, and it is machine-verified 600× per test run.

**Step 2 — set your caps.** These are enforced before every order, not advisory:

```bash
HL_MAX_ORDER_USD=5              # per-order ceiling
HL_DAILY_CAP_USD=20             # daily spend ceiling
HL_MAX_LEVERAGE=3               # leverage clamp
HL_SLIPPAGE_BPS=50              # abort if the fill drifts past this
```

**Step 3 — connect a venue.** Reachability and custody per venue live in `/venues`:

| Venue | Adapter | Custody | Notes |
|---|---|---|---|
| **Hyperliquid** | `execution/hyperliquid_adapter.py` | Non-custodial, on-chain | Perps; API wallet with trade-only rights |
| **Kraken / 100+ CEXs** | `execution/ccxt_adapter.py` | Custodial | Via CCXT; spot |
| **Solana / Jupiter** | `execution/solana_adapter.py` | Non-custodial | Meme spot; **live swap-send is deliberately unwired** |
| **Polymarket** | `ingest/` + `execute/` | Non-custodial, on-chain USDC | CLOB; geoblocked in some regions |

**Step 4 — use a trade-only key.** Every supported venue can issue an API key that
**cannot withdraw funds**. Use it. AXIOM never needs withdrawal permission.

> **Before you do any of this:** the forward test above has not yet demonstrated a
> profitable edge. The gates are engineering guarantees about *how much you can lose per
> order* — they are not a claim that you will make money. Read
> [DISCLAIMER.md](DISCLAIMER.md).

---

## Safety model

Layered, and each layer is independently tested:

```
dry-run master switch → per-order cap → daily cap → leverage clamp
    → slippage abort → idempotency keys → provable loss floor
```

- Live requires **two** independent actions (I11).
- Loss is bounded by capital committed, verified 300× per scenario (I10).
- Retries are idempotent — a timeout resend can never double-fill (I8).
- The Solana live swap-send path is **intentionally left unwired**.
- Kill switch is testable independently of everything else.

---

## Tools & repos combined

AXIOM stands on a lot of other people's work. Full credit:

### Dependencies

| Project | License | Role |
|---|---|---|
| [**CCXT**](https://github.com/ccxt/ccxt) | MIT | One gated door to 100+ exchanges; all OHLCV/ticker data |
| [**OpenBB**](https://github.com/OpenBB-finance/OpenBB) | AGPL-3.0 | Open data platform — macro, equities, rates, CPI, news |
| [**Next.js**](https://github.com/vercel/next.js) | MIT | The 23-page dashboard |
| [**pandas**](https://github.com/pandas-dev/pandas) · [**NumPy**](https://github.com/numpy/numpy) | BSD-3 | Every backtest computation |
| [**Hyperliquid SDK**](https://github.com/hyperliquid-dex/hyperliquid-python-sdk) | MIT | Perps adapter |
| [**Jupiter**](https://station.jup.ag/) | — | Solana spot routing |
| [**DexScreener API**](https://docs.dexscreener.com/) | — | Keyless [pump.fun](https://pump.fun) pair data (price, 1h/24h, volume, liquidity) for the meme bot, with a liquidity floor as the rug guard |
| [**Claude Agent SDK**](https://docs.claude.com/en/docs/claude-code) | — | JARVIS's brain, on your Claude Code login |

### Architectural influences

| Project | What AXIOM took |
|---|---|
| [**OctoBot**](https://github.com/Drakkar-Software/OctoBot) (GPL-3.0) | Its three pillars — exchange abstraction, the Evaluator→Strategy→TradingMode pipeline, and event-driven backtesting with walk-forward. **Re-implemented natively**, not vendored |
| [**Microsoft RD-Agent**](https://github.com/microsoft/RD-Agent) (MIT) | Automated factor research & hypothesis-testing loop |
| [**Kronos**](https://github.com/shiyu-coder/Kronos) (MIT) | Pretrained K-line foundation model behind the 1h forecast bot |
| [**HKUDS Vibe-Trading**](https://github.com/HKUDS/Vibe-Trading) | LLM-agent trading research patterns |
| [**brodyautomates/polymarket-pipeline**](https://github.com/brodyautomates/polymarket-pipeline) | Prediction-market ingestion patterns |
| [**koala73/worldmonitor**](https://github.com/koala73/worldmonitor) (AGPL-3.0) | The open feed catalog behind the World Wire, and the ops-room signal palette |
| [**mirkovicdev/hftengine**](https://github.com/mirkovicdev/HFTENGINE) | The replay-console idea — show what the engine *saw* next to what it *did*, frame by frame, and say plainly what is modelled. Became `/tape` and the flow bot's frame log |
| [**adewaskar/jarvis**](https://github.com/adewaskar/jarvis) | The bridge architecture: Claude Code as a library over a local WebSocket, in-process MCP tools, the browser as face and voice. Became `jarvis/bridge.mjs` and `/jarvis` |
| [**TradingAgents**](https://github.com/TauricResearch/TradingAgents) ([Xiao et al. 2024](https://arxiv.org/abs/2412.20138)) | A desk of role agents that debate before a call, with a risk manager between trader and book. The Council already worked this way; the paper's missing seat, **Vault — Risk Manager**, was added |
| [**Automate Strategy Finding with LLM**](https://github.com/kouzhizhuo/Automate-Strategy-Finding-with-LLM-in-Quant-investment) ([Kou et al., EMNLP 2025](https://arxiv.org/abs/2409.06289)) | A model proposes factors, a backtester filters them. Became `backtest/propose.py` and JARVIS's `propose_strategy` — the honest version, where nothing ships unless it wins on holdout |
| [**HARLF**](https://github.com/franjgs/llm-rl-finance-trader) ([arXiv 2507.18560](https://arxiv.org/abs/2507.18560)) · [**FinBERT**](https://github.com/ProsusAI/finBERT) | Sentiment as a portfolio input. AXIOM's news classifier already produces direction and materiality; coupling that to allocation is **not shipped** — it would need to win out-of-sample first, like everything else here |

> These are studied as references and cloned locally. They are **gitignored**, keep their
> own licenses and history, and are **not redistributed** here.

### Tooling

| Tool | Role |
|---|---|
| [**Graft**](https://github.com/nanonets/graft) | tree-sitter code graph + MCP server for agent navigation |
| [**kepano/obsidian-skills**](https://github.com/kepano/obsidian-skills) | Skill format that inspired `skills/` |

### Research credited in code

- **Cont, Kukanov & Stoikov (2014)**, *The Price Impact of Order Book Events* → DOM imbalance
- **Volume Profile / Market Profile** (VPOC, 70% value area) → implemented, tested, rejected
- **CVD / order-flow microstructure** → OBV + MFI backtestable proxies (the shipped upgrade)

---

## Security

This repo is scanned to contain **no credentials**.

- `.env`, `.env.*`, `*.pem`, `*.key` and `frontend/.env.local` are **gitignored**
- `.env.example` ships **placeholder names only** — every value is empty
- No wallet keys, exchange keys or Polymarket keys are committed anywhere
- Secrets load at runtime via `pydantic-settings` and are **never logged or printed**

Forking? Keep `.env` out of git and prefer **trade-only keys without withdrawal rights**.

---

## Reproducing every number above

```bash
./.venv/bin/python execution/scenario_sim.py 5     # → .data/scenario_report.json
./.venv/bin/python -m backtest.octobot_engine      # → .data/backtest_report.json
./.venv/bin/python -m backtest.batch               # → .data/backtest_batch.json
./.venv/bin/python -m backtest.optimize            # → .data/optimize_report.json
./.venv/bin/python -m backtest.experiments         # → .data/experiments_report.json
./.venv/bin/python -m backtest.per_symbol          # → .data/per_symbol_report.json
```

---

## License

[MIT](LICENSE). Research and paper trading; live trading is disabled by default.
**Not financial advice** — read the [DISCLAIMER](DISCLAIMER.md) before risking real funds.

<div align="center"><sub><b>AXIOM</b> — an idea does not ship unless it survives data it has never seen.</sub></div>
