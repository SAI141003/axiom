<div align="center">

<img src="docs/logo.svg" alt="AXIOM" width="420">

**A proof gated quantitative trading desk.**
Prediction markets · crypto · equities · options in one dashboard, one safety model.

<sub>
Python 3.14 · Next.js 15 · CCXT 4.5 · OpenBB · 33 pages · 29 bots · MIT
</sub>

</div>

---

## What AXIOM is

AXIOM started as a Polymarket high-frequency bot and grew into a full research desk:
a backtest engine, a fault-injection proving ground, 29 paper-trading daemons, and
a 33-page dashboard over live market data.

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

[Quick start](#quick-start) · [What it has been through](#what-it-has-been-through) ·
[Results](#results) · [Polymarket](#polymarket-the-origin) · [Commands](#command-reference) ·
[Agents & skills](#agents--skills) · [Going live](#going-live) · [Safety](#safety-model) ·
[Credits](#tools--repos-combined) · [Security](#security)

---

## Quick start

No API keys required — the core runs entirely on keyless public data.

```bash
git clone https://github.com/SAI141003/axiom.git && cd axiom

python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt   # backend
cd frontend && npm install && npm run dev                              # dashboard
```

Open **http://localhost:3000**.

### Verify it yourself (offline, no keys, ~20s)

```bash
./.venv/bin/python -m pytest tests/ -q          # 26 tests
./.venv/bin/python execution/scenario_sim.py 5  # 10,500 safety assertions
./.venv/bin/python -m backtest.octobot_engine   # walk-forward backtest
```

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
| **Dashboard** | 33 pages, production build green |

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
./.venv/bin/python dryrun/meme_bot_daemon.py       # meme-coin momentum (CoinGecko)
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
| [**Next.js**](https://github.com/vercel/next.js) | MIT | The 33-page dashboard |
| [**pandas**](https://github.com/pandas-dev/pandas) · [**NumPy**](https://github.com/numpy/numpy) | BSD-3 | Every backtest computation |
| [**Hyperliquid SDK**](https://github.com/hyperliquid-dex/hyperliquid-python-sdk) | MIT | Perps adapter |
| [**Jupiter**](https://station.jup.ag/) | — | Solana spot routing |

### Architectural influences

| Project | What AXIOM took |
|---|---|
| [**OctoBot**](https://github.com/Drakkar-Software/OctoBot) (GPL-3.0) | Its three pillars — exchange abstraction, the Evaluator→Strategy→TradingMode pipeline, and event-driven backtesting with walk-forward. **Re-implemented natively**, not vendored |
| [**Microsoft RD-Agent**](https://github.com/microsoft/RD-Agent) (MIT) | Automated factor research & hypothesis-testing loop |
| [**Kronos**](https://github.com/shiyu-coder/Kronos) (MIT) | Pretrained K-line foundation model behind the 1h forecast bot |
| [**HKUDS Vibe-Trading**](https://github.com/HKUDS/Vibe-Trading) | LLM-agent trading research patterns |
| [**brodyautomates/polymarket-pipeline**](https://github.com/brodyautomates/polymarket-pipeline) | Prediction-market ingestion patterns |

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
