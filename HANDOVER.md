# Polymarket HFT — Complete Agent Handover Document

> **Written for:** Any new Claude agent taking over this project  
> **Last updated:** 2026-07-07  
> **Project location:** `/Users/saiyaganti/polymarket-hft/`  
> **Frontend:** `/Users/saiyaganti/polymarket-hft/frontend/` → `http://localhost:3000`

---

## 1. What This System Is

A fully autonomous **Polymarket prediction-market HFT trading bot** written in Python asyncio. It:

- Monitors hundreds of Polymarket markets 24/7 via WebSocket
- Ingests live news (Twitter, Telegram, RSS) and matches to markets using semantic embeddings
- Runs a multi-model ensemble (LLM + quantitative) to estimate true probabilities
- Executes trades via Polymarket CLOB v2 REST API
- Has a Next.js dark-theme dashboard at `frontend/` modeled after the MiroFish bot interface

**NEVER** run with `DRY_RUN=false` unless the user explicitly confirms live trading. The default is dry run.

---

## 2. How to Run

### Backend
```bash
cd /Users/saiyaganti/polymarket-hft
cp .env.example .env   # fill in API keys
python main.py         # starts all 15 workers
```

### Frontend
```bash
cd /Users/saiyaganti/polymarket-hft/frontend
npm install            # if node_modules missing
npm run dev            # → http://localhost:3000
```

### With Docker
```bash
docker-compose up      # Redis + PostgreSQL + Python backend
```

### Key environment variables (in `.env`)
```
POLYMARKET_PRIVATE_KEY=...    # NEVER hardcode — env only
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
POLYMARKET_FUNDER=...
NVIDIA_API_KEY=...             # for Gemma 4 (NVIDIA NIM)
ANTHROPIC_API_KEY=...          # fallback + Claude analysis panel
DRY_RUN=true                   # KEEP TRUE until explicitly told otherwise
MAX_BET_USD=25
DAILY_LOSS_LIMIT_USD=150
REDIS_URL=redis://localhost:6379/0
DATABASE_URL=postgresql://trading:trading@localhost:5432/polymarket_hft
```

For the **frontend** Claude panel, also add to `frontend/.env.local`:
```
ANTHROPIC_API_KEY=...
```

---

## 3. System Architecture

### Workers (15 concurrent asyncio tasks in `main.py`)

| Worker | File | Purpose |
|--------|------|---------|
| `kill_switch` | `risk/kill_switch.py` | Emergency halt — monitors Redis flag |
| `ingestion` | `workers/ingestion_worker.py` | Polymarket WS + Binance WS + news streams |
| `signal` | `workers/signal_worker.py` | Runs all signal paths, builds ensemble |
| `execution` | `workers/execution_worker.py` | Submits orders, handles arb opportunities |
| `risk` | `workers/risk_worker.py` | Syncs risk state to Redis every 5s |
| `order_tracker` | `execute/order_tracker.py` | Tracks fill status of open orders |
| `mirofish_prestager` | `signals/mirofish_client.py` | Pre-fetches MiroFish reports |
| `consensus_tracker` | `consensus/ai_trader_client.py` | AI-Trader consensus aggregation |
| `quant_calibration` | `workers/quant_calibration_worker.py` | CVXPY@30s, Diffrax@60s, NumPyro@300s |
| `nightly_review` | `compound/nightly_review.py` | Claude Opus self-learning at 2am |
| `research_worker` | `workers/research_worker.py` | Weekly arXiv scan → Claude extraction |
| `market_maker` | `execute/market_maker.py` | Avellaneda-Stoikov quotes (disabled by default) |
| `tick_reactor` | `execute/tick_reactor.py` | Sub-10ms velocity trading |
| `position_guard` | `portfolio/position_guard.py` | Exit on adverse velocity |
| `paper_trader` | `workers/paper_worker.py` | Virtual P&L alongside live trades |

### Signal Pipeline (per news event)

```
News arrives → SignalWorker
  → matcher.match() (semantic embedding, top-5 markets)
  → For each matched market, in parallel:
      PATH A: Gemma 4 (NVIDIA NIM) — LLM classification
      PATH B: Kronos — time-series price forecast
      PATH C: MiroFish — cached probability report
      PATH D: TimesFM — quantile price forecast
      PATH E: Sports statistical model (soccer/tennis/ufc)
      PATH F: Crypto Binary Option model (Black-Scholes + SABR + Merton)
      PATH G: Markov State Transition (BTC persistence gate)
      PATH H: Wash trading filter (skip suspicious volume)
  → ensemble.build_signal() — weighted combination + Robust Kelly sizing
  → microstructure_gate() — latency decay, OBI, VPIN, EV filter
  → Signal published to bus → ExecutionWorker
  → ExecutionEngine.submit() → 7 risk checks → CLOB API
```

### Risk Checks (all must pass before any order)
1. Edge > `cfg.edge_threshold` (4%)
2. Daily loss < 15% of bankroll
3. Drawdown < `cfg.max_drawdown_pct` (8%)
4. Market concentration < 5% of bankroll per market
5. Concurrent positions < 15
6. Signal age < 5000ms
7. CVaR tail check (active after 50+ trades)

---

## 4. All Bugs Fixed (10 total across 2 sessions)

### Session 1 bugs (were causing zero/wrong trades)
1. **Oracle lag got Polymarket probability (0.84) instead of BTC spot price ($95,000)**
   - File: `ingest/binance_feed.py` — now provides real Binance USD prices
   
2. **Edge inflated ~14× for "above" direction** (always used YES price, never flipped for NO bets)
   - File: `signals/crypto_binary_signal.py`

3. **Near-resolved markets (YES ≥ 0.93) generated false signals**
   - Fix: guard added in `crypto_binary_signal.py`

4. **Expired markets returned by scanner** — no expiry filter
   - Fix: `fetch_active_markets()` now filters `end_dt <= now`

5. **VPIN always 0.0** — microstructure gate for adverse selection never fired
   - Fix: full VPIN wired from `order_flow_signal.py` → `CryptoBinaryOutput.vpin` → `ensemble.py`

6. **CLOB fees never deducted** — Kelly overbetting 56% near p=0.50 on crypto
   - Fix: `clob_taker_fee()` + `clob_net_edge()` in `microstructure.py`

### Session 2 bugs (this session — 2026-07-06/07)
7. **`ensemble.py:~385` — crypto_binary model_prob NOT flipped for NO side**
   - `model_prob = N(d₂) = P(YES wins)`. For NO bet, should be `1 - model_prob`.
   - Fix: `p_estimates.append(cb_p if side == "YES" else 1.0 - cb_p)`

8. **`risk_engine.py:~119` — daily loss limit blocked trading on profitable days**
   - `abs(_daily_loss)` fired on large gains too. `_daily_loss` is net P&L (positive=profit).
   - Fix: `max(0.0, -_daily_loss)` — only fires when you've net lost money

9. **`monitor/dashboard.py` — only 4 of 15 workers monitored**
   - Added: `market_maker`, `tick_reactor`, `position_guard`, `paper_trader`, `quant_calibration`, `research_worker`

10. **`monitor/dashboard.py` — latency_tracker imported inside hot function (every 2s)**
    - Moved import to module level

---

## 5. Frontend Structure

```
frontend/
├── app/
│   ├── page.tsx                    # root → imports Dashboard
│   ├── mirofish/page.tsx           # standalone MiroFish page at /mirofish
│   ├── gravia/                     # Gravia sub-app
│   └── api/
│       ├── markets/route.ts        # Gamma API proxy
│       └── claude-analyze/route.ts # Claude Haiku analysis endpoint (NEW)
├── components/
│   ├── Dashboard.tsx               # main Bloomberg-style terminal (7 tabs)
│   ├── MiroFishDashboard.tsx       # MiroFish-style dark UI (NEW)
│   ├── MarketList.tsx
│   ├── OrderBook.tsx
│   ├── ChartPanel.tsx
│   ├── SignalFeed.tsx
│   ├── RiskPanel.tsx
│   ├── PositionsPanel.tsx
│   ├── OrdersPanel.tsx
│   ├── QuickOrderPanel.tsx
│   └── ArbitragePanel.tsx
└── lib/
    ├── store.ts                    # Zustand state (markets, signals, positions, risk)
    ├── types.ts                    # TypeScript interfaces
    ├── websocket.ts                # WS client → backend ws_bridge.py
    ├── mockFeed.ts                 # Simulated feed when WS offline
    └── liveData.ts                 # Gamma API + Binance price fetches
```

### Dashboard Navigation Keys
- `1` Markets, `2` Signals, `3` Risk, `4` P&L, `5` Analytics, `6` Arb, `7` **MIROFISH**
- `F8` Kill switch (double-press to activate)
- `F10` Toggle sim feed

### MiroFish Dashboard (`/mirofish` or key 7)
- **Stat bar**: Total PnL, Daily PnL, Trades, Win Rate, Sharpe, Bankroll, Open Positions, Drawdown
- **Probability Lattice**: scatter plot — edge% vs p_model% (YES=green, NO=red)
- **Tail Probability Ridge**: area chart — p10/p50/p90/implied bands across strikes
- **Relationship Graph**: SVG force layout — signal nodes (bear/bull/median/catalyst/hub)
- **Claude AI Analysis**: `/api/claude-analyze` → risk level + insight + action (90s refresh)
- **Live Signal Feed**: last 12 signals scrolling

---

## 6. Quantitative Stack

| Model | Paper | File |
|-------|-------|------|
| Yang-Zhang OHLC vol | Yang & Zhang 2000 | `signals/crypto_binary_signal.py` |
| Black-Scholes digital | — | `signals/crypto_binary_signal.py` |
| Heston SDE + Lewis digital | Lewis 2001 | `signals/heston_pricer.py` |
| Robust Kelly Eq.4 | — | `signals/heston_pricer.py` |
| Merton jump-diffusion | Merton 1976 | `signals/heston_pricer.py` |
| SABR smile | Hagan 2002 | `signals/sabr_smile.py` |
| CVXPY portfolio LP/SOCP | — | `signals/portfolio_optimizer.py` |
| Diffrax Heston gradient | JAX | `signals/diffrax_calibrator.py` |
| NumPyro SVI Bayesian vol | — | `signals/bayesian_vol_posterior.py` |
| VPIN | Easley-LPdP-O'Hara 2012 | `signals/order_flow_signal.py` |
| Markov State Transition | — | `signals/markov_signal.py` |
| Avellaneda-Stoikov MM | binary adaptation | `execute/market_maker.py` |
| Isotonic calibration | BrierTracker | `compound/calibration.py` |
| Domain+horizon calibration | arXiv:2602.19520 | `signals/calibration.py` |
| Dixon-Coles Poisson | sports | `signals/sports_signal.py` |
| OBI gate | Cont-Kukanov-Stoikov | `signals/microstructure.py` |
| CLOB fee curve | Polymarket April 2026 | `signals/microstructure.py` |

---

## 7. Key Config Values (`core/config.py`)

```python
dry_run = True                    # KEEP TRUE
max_bet_usd = 25.0                # per trade hard cap
daily_loss_limit_usd = 150.0      # daily halt
initial_bankroll = 1000.0
edge_threshold = 0.04             # 4% minimum edge
kelly_lambda = 1.5                # Robust Kelly risk-aversion
vpin_adverse_threshold = 0.70     # skip if VPIN > 70%
clob_fee_peak_crypto = 0.018      # 1.8% peak at p=0.50
oracle_lag_min_edge = 0.04
negrisk_min_edge = 0.02
market_maker_enabled = False      # off by default
```

---

## 8. Strategy Summary (7 alpha sources)

1. **NegRisk Dutch Book** (`match/negrisk_arb.py`) — complementary market probabilities don't sum to 1; scan every 5s
2. **Oracle Lag Arb** (`match/oracle_lag.py`) — Chainlink 5/15-min crypto markets lag spot by ~45s; enter in last 45s
3. **Crypto Binary Option** (`signals/crypto_binary_signal.py`) — Black-Scholes edge vs market price on crypto markets
4. **Smart Money Detection** (`match/smart_money.py`) — orderbook depth spikes (73% accuracy)
5. **UMA Dispute Front-running** (`match/uma_dispute.py`) — 89.6% accuracy post-filing
6. **Mean Reversion** (`signals/mean_reversion.py`) — price overreaction (18-33% CAR documented)
7. **Longshot NO Bias** (`match/longshot_no.py`) — Stanford study: 64pp EV gap at extreme probabilities

---

## 9. Files NOT to Touch

Per `CLAUDE.md` architecture rules:
- `core/config.py` — only change via `.env`, never hardcode secrets
- `risk/kill_switch.py` — must remain independently testable
- Any file that sets `polymarket_private_key` — must be `""` (env only)

---

## 10. Known Remaining Issues / Next Steps

1. **`_daily_loss` naming confusion** — variable accumulates net P&L (positive=gain) but named "loss". `redis_state.add_daily_loss(pnl)` naming is misleading. Should rename to `daily_pnl` in a future refactor.

2. **Dashboard `daily_pnl = -daily_loss`** — shows inverted sign (shows negative when up). Tied to the naming confusion above.

3. **`execution_worker._handle_arb`** — publishes to `SIGNAL_FAST` bus AND immediately calls `_handle_signal`. Paper worker gets the bus event correctly, but execution is deduped on the second call. Intentional but creates unnecessary bus traffic.

4. **TimesFM** — `requirements.txt` has it commented out (`# timesfm[torch]>=2.5.0`) because it requires Python 3.10-3.12. If running Python 3.13+, TimesFM is unavailable and falls back gracefully.

5. **MT4 EA v17** — XAUUSD and GBPJPY are profitable in Python backtest. Still needs MT4 Strategy Tester run with proper H4 data (see Section 4 of MT4 EA memory for instructions).

---

## 11. MT4 Expert Advisor (separate project)

**File:** `/Users/saiyaganti/FinalQuantGoldJPY_v17_FINAL.mq4`  
**Instruments:** XAUUSD (primary), GBPJPY (secondary), USDJPY, EURJPY, AUDUSD  
**Timeframe:** M15  

See full details in the MT4 EA memory file. Key point: use a CENT account for $20 starting capital.

---

## 12. Quick Debug Checklist

If the bot isn't trading:
1. Check `DRY_RUN` — it's true by default, orders won't go live
2. Check kill switch: `redis-cli GET kill_switch` → should not be "1"
3. Check edge threshold: signals with edge < 4% are suppressed
4. Check VPIN: if all signals have VPIN > 0.70, the gate is blocking
5. Check daily loss limit: if you've lost >15% today, trading is halted until midnight
6. Check bankroll in PostgreSQL: `SELECT current_bankroll FROM bankroll ORDER BY ts DESC LIMIT 1`

If frontend shows no data:
1. Check `npm run dev` is running in `frontend/`
2. Check `ws_bridge.py` is running: `python ws_bridge.py`
3. Check sim feed toggle: key `F10` in the dashboard
