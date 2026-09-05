# AXIOM — Session Log & Handoff

A durable record of decisions, state, and how to resume — so nothing is lost
between sessions (mirrors what's in agent memory, but lives in the repo).

**Home base:** Vancouver, BC, Canada. **Standing rule:** everything paper/DRY_RUN
until proven; honest fee-true numbers; no fake/dead data on screen; never fabricate
or delete losing data; secrets stay in gitignored `.env`, never printed; verify UI
via screenshots.

---

## Current state (2026-08-10)

- **All trading is PAPER.** No real keys set; every `*_DRY_RUN` flag is `true`.
- **Live $100 paper accounts** (forward tests): Gamma Pulse (dealer-gamma stocks/
  options), Stocks Bot (multi-factor long/short), Meme Bot (meme momentum). All run
  as `launchd` KeepAlive daemons; each has a dashboard page + `/api/*` route.
- **Real-money adapters exist but are gated + capped + unfunded** (see below).
- Frontend (`next dev`) served by `com.polymarket.frontend` launchd on :3000.
  `next build` is green. UI verified by headless-Chrome screenshots.

---

## Decisions that matter (the "why", so we don't relitigate)

1. **Polymarket is IP-geoblocked in Canada (403).** MetaMask does NOT bypass it —
   the block is at the IP level, not the wallet. We do **not** circumvent it.
2. **MetaMask is now more than a wallet.** Its **Agent Wallet** (launched Aug 6
   2026) is built for AI agents (supports Claude Code), signs with a trade-only key
   in a TEE, enforces spend caps + protocol allowlists + MEV protection, and reaches
   **Hyperliquid + EVM**. This is the honest bridge from paper → guarded real.
3. **Meme coins live on Solana, not EVM.** Real path = a Solana wallet → Jupiter
   (Raydium/Orca/Pump.fun routing), NOT MetaMask (EVM-first). Two real-money paths
   therefore exist: MetaMask Agent Wallet → Hyperliquid (perps), and Solana wallet
   → Jupiter (meme spot).
4. **"Full hands to the bots" is safe only behind a hard floor.** A trade-only key
   (can't withdraw) + per-order cap + daily cap means the worst a bot can do in a
   day is bounded, and a liquidation/rug can only lose the capital committed to that
   one position. Proven by `scenario_sim.py` (39,000 assertions, 0 failures). The
   caps are the seatbelt that *lets* the bot run autonomously — not a brake on it.
5. **Kronos** (foundation model) LOST to our simple factor blend on equity direction
   (46.7% vs 50%) → kept as a feature, not a standalone.

---

## Real-money adapters (dry-run-gated, NOT live)

| File | Venue | Custody | Caps (from `.env`) | Loss bound |
|---|---|---|---|---|
| `execution/hyperliquid_adapter.py` | Hyperliquid perps | agent key trades, can't withdraw | `HL_MAX_ORDER_USD=$5` margin, `HL_DAILY_CAP_USD=$20`, `HL_MAX_LEVERAGE=3`, `HL_SLIPPAGE_BPS=50` | committed margin |
| `execution/solana_adapter.py` | Jupiter meme spot | you sign, funds stay in wallet | `SOL_MAX_ORDER_USD=$5`, `SOL_DAILY_CAP_USD=$20`, `SOL_SLIPPAGE_BPS=150` | swap size (rug→0) |
| `execution/broker_adapter.py` | Questrade (equities/options, Canada-legal) | custodial, scoped no-withdraw keys | `BROKER_MAX_ORDER_USD=$5`, `BROKER_DAILY_CAP_USD=$20` | notional |

**To go live (later, deliberately):** set the venue's key in `.env` and flip its
`*_DRY_RUN=false`. Hyperliquid live path uses `hyperliquid-python-sdk` (lazy import).
Solana live *swap-send* is the intentionally-unwired last mile — quotes are real,
but signing+sending a swap tx is only enabled when a funded key + `SOL_DRY_RUN=false`
are set. Start tiny. The caps hold either way.

---

## Proving Ground — the safety proof

`execution/scenario_sim.py` — hermetic (no network, no real money) fault harness.
Runs both adapters through every fault and asserts **11 invariants**:

- I1 paper never emits live · I2 per-order cap · I3 daily cap · I4 leverage clamp
- I5 slippage-abort (no spend) · I6 in-tolerance fills · I7 reject no spend
- I8 timeout=unknown + idempotent resend (no double-spend) · I9 partial commits only
  filled fraction · I10 loss ≤ committed (liquidation/rug floor) · I11 live requires
  BOTH switch-off AND a key

**Latest: 39,000 assertions, 0 failures, 26/26 scenarios 100%.**
Re-run: `python execution/scenario_sim.py 25` → writes `.data/scenario_report.json`.
Dashboard: **`/proving-ground`** (matrix + honest adapter gate status).

---

## Key files / pages index

- Venue research: `signals/venue_catalog.py` → `.data/venues.json`; page `/venues`.
- Adapters + sim: `execution/{hyperliquid_adapter,solana_adapter,scenario_sim}.py`.
- Meme bot: `dryrun/meme_bot_daemon.py` (launchd `com.polymarket.dryrun.memebot`),
  page `/meme-bot`, log `logs/meme_bot.jsonl`.
- Benchmarks: `signals/{industry_comparison,market_model_benchmark,vol_model_benchmark,kronos_benchmark}.py`; page `/benchmark`.
- Brain (reflection loop): `dryrun/brain.py` (`engines_status()` aggregates all accounts).

---

## How to resume

```bash
# frontend on :3000 (launchd usually already running it)
launchctl kickstart -k gui/$(id -u)/com.polymarket.frontend

# re-prove the safety floor
python execution/scenario_sim.py 25

# regenerate the venue map
python signals/venue_catalog.py

# check adapter gate status (never prints keys)
python execution/hyperliquid_adapter.py
python execution/solana_adapter.py
```

---

### Log

- **2026-08-14d** — UI redesign + OpenBB + Graft:
  - **UI:** elevated `frontend/app/globals.css` shared primitives (layered backdrop,
    top-lit panels w/ depth + hover-lift, gradient chips/bars, accent scrollbar,
    `.hud-gradient-text`, emoji-safe title halo) — all class names preserved so all
    29 pages upgraded with zero markup changes. Polished `TopNav` (gradient wordmark,
    sharp active state) + refreshed Home (hero, stats strip, current lineup). Verified
    Home/Backtest-Lab/Brain screenshots — nothing broke.
  - **Skill:** installed `kepano/obsidian-skills` via `npx skills add` → `.claude/skills/`
    (obsidian-bases/cli/markdown, json-canvas, defuddle).
  - **OpenBB (A, full capabilities):** `pip install openbb` (4.7.2, +29 provider exts;
    ADDITIVE — pandas/numpy/scipy/ccxt unchanged, sim still 0-fail). `signals/openbb_connector.py`
    → keyless snapshot (equities quotes, crypto, full UST curve + 2s10s, CPI YoY, market
    news) → `.data/openbb_snapshot.json`, 15-min cron `com.polymarket.data.openbb`.
    Page `/data-desk` + `/api/data-desk`, nav "Data Desk". NOTE: sanitize NaN (yfinance
    NaNs some ETFs) — `json.dumps(NaN)` is invalid JSON and breaks the frontend parse.
  - **Graft (B):** `npm i -g @nanonets/graft` + `graft init --no-agents` → wired Claude
    Code (`.claude/settings.json` hooks+statusline, `.claude/skills/graft`, `.mcp.json`
    graft server alongside existing `magic`). Local tree-sitter graph: 15,714 nodes /
    34,815 edges. MCP tools (graft_find_code, graft_repo_map, graft_trace_calls…) load
    on next Claude Code restart. Reversible (all in-repo).
  - `next build` clean. All 6 bots + 2 crons + frontend alive.
- **2026-08-14c** — Top-trader strategies (from an "Avengers of Trading" reel:
  Imre Gams, Patrick Nill 6×WCTC, Fabio Valentini, Fredy Sarmiento). Decoded their
  stacks → real microstructure: Volume Profile, TPO, Ultra Delta (=CVD), Big Trades,
  Deepdom (=DOM), Deep Gamma (=our gamma_pulse). User: "not trading enough."
  - **Honest reframe:** our bot is flat because it's DAILY + few signals; our own
    batch proved intraday LOSES for our signals. Pros trade often via ORDER FLOW —
    data we didn't ingest. WCTC %s are leveraged contest returns, survivorship-biased.
  - **(portable #1) Volume Profile** `VolumeProfileEvaluator` (VPOC + 70% value area
    from OHLCV). Added to registry + experiment. **REJECTED** — it HURT (+18.7→+9.0%
    mean daily). Also revealed default≈+orderflow now (ties) → daily edge is within
    NOISE (only ~7 trades/symbol; too few to measure). Kept shipped blend.
  - **(portable #2) Order flow** `signals/intraday_flow.py` — live CVD + big-trade
    detection + DOM imbalance via CCXT fetch_trades/fetch_order_book (public, no key).
    Fixed DOM (Kraken book entries are [px,amt,ts], 3 elems). Real read: BTC +57–59%
    buy imbalance, ETH +69%, big buyers dominant.
  - **Flow Bot** `dryrun/flow_bot_daemon.py` — **6th $100 paper bot**, trades the tape
    (enter bias>+0.25, exit on flip/90min, $30×3, 8bps/side, 10-min cadence). launchd
    `com.polymarket.dryrun.flowbot`. Brain "flow-bot ($100 acct)" ← `logs/flow_bot.jsonl`.
    Page `/flow-bot` (nav "Flow Bot"). First cycle opened ETH+BTC longs on live buy-flow.
    **HONEST: order flow is real edge (Cont-Kukanov-Stoikov 2014) but NOT backtestable
    (no free tick history) → forward-test only.** Retail latency vs pros' co-located
    feeds is a real handicap; the $100 book is how we find out if edge survives.
  - Scenario sim 10,500/0. `next build` green.
- **2026-08-14b** — Per-symbol routing tested honestly (`backtest/per_symbol.py`):
  pick each symbol's strategy on TRAIN, judge the mapping on untouched HOLDOUT.
  Train picked {BTC:orderflow, ETH:default, SOL:orderflow} — those picks did NOT
  generalize. Holdout mean return: global-orderflow **−15.3%** > per-symbol −18.5%
  > global-default −19.2%. **Per-symbol REJECTED (overfit)** — no `symbol_strategy.json`
  written; kept global order-flow. Byproduct: independently confirms global
  order-flow > global default OOS (validates the Aug-14 adoption). Surfaced as a
  compact line on /backtest-lab. `next build` clean (must bootout the frontend dev
  service first — concurrent `.next` writes cause transient /_document or /ai/macro
  PageNotFoundError; boot it back after).
- **2026-08-14** — Regime filter (b) + more evaluators (c) + forward tracker (a):
  - **(c) order-flow evaluators** `OBVEvaluator`, `MFIEvaluator` (backtestable from
    OHLCV volume; live CVD `order_flow_signal.py` + on-chain `onchain_signal.py` are
    real-time-only, NOT historically backtestable; Kronos already lost its benchmark
    + too slow per-bar → not added). `expanded_strategy()` = default + OBV + MFI.
  - **(b) regime filter** `signals/regime_filter.py` `RegimeTradingMode` — ride
    confirmed bulls passively (price > rising SMA50), active strategy in bear/chop.
  - **Edge experiment** `backtest/experiments.py` → `.data/experiments_report.json`
    (daily BTC/ETH/SOL bake-off): default 3/3 +19.4%/Sh0.46; **+orderflow 3/3
    +22.2%/Sh0.55 ★ (won)**; regime-switch 3/3 +16.4%/Sh0.39 (HURT — gave back gains
    in pullbacks → REJECTED). **Adopted order-flow** → wrote `.data/strategy_weights.json`
    (source=experiment, incl obv0.5/mfi0.4) so `default_strategy()` + live bot use it.
    Honest tradeoff: order-flow lifts BTC (+20.6→+47.4%, Sh0.57→1.09) & holds ETH,
    but HURTS SOL (lost ★edge, batch edge_cells 3→2). Reversible: `rm .data/strategy_weights.json`.
  - **(a) forward tracker** `dryrun/forward_snapshot.py` → daily launchd cron
    `com.polymarket.dryrun.forwardsnapshot` (StartInterval 24h) → `logs/forward_perf.jsonl`
    + `.data/forward_perf.json`. Day-0: options +$17.48, gamma −$0.39, stocks −$2.06,
    meme −$1.92. Surfaced on /backtest-lab (experiments table + forward scoreboard).
  - ccxtbot restarted onto order-flow blend. Scenario sim 10,500/0. `next build` green.
- **2026-08-13** — Batch + tune + live-paper on the OctoBot stack (all A/B/C):
  - **A (batch, `backtest/batch.py` → `.data/backtest_batch.json`):** BTC/ETH/SOL ×
    1d/4h/1h. Edge is ONLY on the **daily** timeframe — the 3 ★EDGE cells are all
    1d (ETH/1d +46.2% vs −20.1% b&h, 3/3 folds; SOL/1d −8.6% vs −44.8%, 3/3;
    BTC/1d +20.6% vs +4.4%). 4h/1h churn to negative Sharpe. Lesson: daily only.
  - **C (optimize, `backtest/optimize.py` → `.data/optimize_report.json`):** 400-cand
    random search, robustness selection (mean objective over train sub-windows),
    Sharpe−1.5·maxDD, multi-symbol daily. Tuned beat default IN-sample (Sharpe
    1.05→1.74) but NOT on holdout → **shipped nothing, kept default** (no
    `.data/strategy_weights.json` written). `default_strategy()` loads that file if
    present. Honest: naive weight tuning overfits; system refuses to ship it.
  - **B (`dryrun/ccxt_strategy_daemon.py`):** $100 paper acct, default evaluator
    strategy, DAILY BTC/ETH/SOL via CCXT data, $30/pos ×3, 10bps/side. launchd
    `com.polymarket.dryrun.ccxtbot` (KeepAlive). Brain wired ("ccxt-strategy
    ($100 acct)" ← `logs/ccxt_bot.jsonl` sclose). Page `/ccxt-bot`, nav "Strategy
    Bot". First cycle: flat (no daily LONG signal — correct discipline).
  - Backtest Lab page now shows batch matrix + optimizer verdict. Scenario sim
    still **10,500 / 0**. `next build` green (note: clear `.next` if `next dev` is
    running concurrently — shared `.next` causes a transient /ai/macro
    PageNotFoundError). Still all paper.
- **2026-08-12** — Adopted **OctoBot's three pillars** natively (not vendored):
  (1) **Exchange** — `execution/ccxt_adapter.py`, one gated door to 100+ CEXes via
  CCXT 4.5.64 (already installed); real public ticker/OHLCV even in paper; gate
  `CCXT_DRY_RUN`(true)/`CCXT_API_KEY`+`CCXT_SECRET`/`CCXT_MAX_ORDER_USD`($5)/
  `CCXT_DAILY_CAP_USD`($20)/`CCXT_SLIPPAGE_BPS`(30); default exchange kraken.
  (2) **Strategy** — `signals/evaluators.py`: OctoBot-style Evaluator→Strategy→
  TradingMode (RSI/MA-cross/momentum/mean-reversion/Bollinger, weighted blend,
  hysteresis). `default_strategy()` = our benchmarked factor blend.
  (3) **Backtest** — `backtest/octobot_engine.py`: event-driven, no look-ahead,
  fees+slippage, Sharpe/maxDD/winrate/exposure + walk-forward folds. Real Kraken
  OHLCV. First run BTC/USD 1d (720c): strat +20.8% vs b&h +5.1%, Sharpe 0.57, 35%
  exposure; edge = downside protection (beat b&h in both down-folds). Writes
  `.data/backtest_report.json`; page `/backtest-lab` (equity curve vs b&h).
  Extended `scenario_sim.py` to cover CCXT — now **10,500 assertions, 0 failures**
  across all 3 adapters. `next build` green. Still all paper (no keys).
- **2026-08-10** — Built meme-bot ($100 paper) + dashboard. Deep venue research →
  found MetaMask Agent Wallet (Aug 6 2026, agent-native). Built both real-money
  adapters (Hyperliquid perps, Solana/Jupiter meme), dry-run-gated + capped, and
  `scenario_sim.py` proving 11 invariants at 39k assertions / 0 fails. Added
  `/venues` + `/proving-ground` pages. `next build` green. Still all paper.
