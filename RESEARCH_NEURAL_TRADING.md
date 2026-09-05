# Neural & AI Methods in Automated Trading — Deep Research

*Synthesized 2026-07-13 from the primary literature. Each section: what the field
actually knows → what it means for THIS system. Sources at the bottom.*

---

## 1. The validation problem comes before any model (López de Prado)

**The field's hardest-won lesson:** most published trading ML "results" are
backtest overfitting. *Advances in Financial Machine Learning* (the book to
read first) formalizes the fixes:

- **Deflated Sharpe Ratio** — if you test N configurations and report the best,
  its performance is inflated by selection bias. The DSR corrects for the
  number of trials. Our `crypto_param_mc` tests 10 configs and surfaces the
  best — its "best median" is *expected* to look good by chance.
- **Purged cross-validation + embargo** — train/test splits must not leak
  overlapping-label information. Our chronological-halves stability test is a
  crude but honest version of this.
- **Meta-labeling** — don't ask the model to find the signal; take a primary
  signal you already trust and train a *secondary* classifier that predicts
  WHEN it wins (features: spread, vol, time-of-day, book state). Size the bet
  by that probability. This is the single most applicable idea for us.

**→ Applied here:** the MC verdict now requires stability across both halves
AND P(profit) ≥ 0.60; treat any "best of many configs" as suspect until it
survives fresh out-of-sample data. Meta-labeling is the planned upgrade for
oracle-lag once ~100 resolved trades accumulate (learn P(win | move_bp, ask,
book imbalance, hour) and only trade above breakeven probability).

## 2. Deep learning on order books (DeepLOB line of work)

- DeepLOB (CNN+LSTM over 100-event LOB windows) shows genuine short-horizon
  directional predictability from raw book structure, generalizing across
  instruments.
- BUT the 2025-26 crypto follow-up literature is blunt: **better inputs beat
  deeper networks** — microstructural features (imbalance, depth slope, trade
  flow) carry the alpha; stacking layers on bad inputs learns noise.
- Financial series are noise-dominated; horizon matters — predictability
  concentrates in the very short term where the book mechanically constrains
  prices.

**→ Applied here:** we don't need a deep net; we need the *inputs*. The
oracle-lag daemon now logs **top-of-book depth imbalance** at entry — the
single feature the Polymarket microstructure paper found most predictive
(net order imbalance from large trades predicts subsequent returns).

## 3. Prediction-market microstructure (the directly-relevant evidence)

The 2026 Polymarket literature validates our exact strategy space:

- **Latency arbitrage is the documented edge**: bots derive CEX-implied
  probabilities (log-normal model on Binance/Coinbase spot) and trade stale
  Polymarket quotes *within the human reaction-time window*. 14 of the 20 most
  profitable Polymarket wallets are bots; ~$40M extracted Apr'24–Apr'25. The
  advantage is **execution speed, not predictive accuracy**.
- **Our probe confirms the window is seconds, not a minute**: by t=72s the
  CLOB has repriced (asks 0.73–0.91); at t=24–36s the same side costs
  ~0.61–0.67. The tradeable question is early-move persistence at cheap asks.
- **Longshot spread premium**: cheap tails are systematically overpriced —
  matches our own losses (kronos ETH entries at 0.12/0.20 lost; options
  pennies decayed). Rule: be very suspicious of buying < ~20¢.
- **Polymarket leads Kalshi in price discovery** → cross-venue arb direction
  is usually "Polymarket right, Kalshi stale," useful prior for /api/arb.
- **Toxic order flow predicts forecast error** — markets full of informed
  flow are harder; wide-spread niche markets attract informed specialists
  (weather!). This explains why our weather bot is the first ROBUST strategy.

## 4. Bandits & regime switching (the math behind the brain)

- The strategy-arming problem is formally a **non-stationary multi-armed
  bandit**: allocate stake across strategy "arms," balancing exploration vs
  exploitation, with regime switches modeled as a hidden Markov chain
  (Regime-Switching Bandits, Thompson-sampling portfolio papers).
- Robust designs: **discounted Thompson sampling** (old outcomes decay) and
  **change-detection restarts** (reset a strategy's posterior after a regime
  break).

**→ Applied here:** brain.py's disarm/re-arm IS a bandit policy (currently a
hard threshold). Planned upgrade: per-strategy Beta posterior with exponential
decay — win probability that *forgets* slowly — replacing binary switches with
graded paper-stake allocation. Regime detection (via realized-vol tercile on
BTC) can gate crypto strategies: the brain found hour-of-day bleeders, which
is regime structure by another name.

## 5. LLM agents (FinMem, FinAgent, TradingAgents, TradingGroup)

- The reproducible finding across all four frameworks: **layered memory +
  reflection beats raw LLM calls**. Removing the reflection module measurably
  degrades returns. Debate between bull/bear analyst roles improves decisions.
- The honest caveat from the evaluation literature: reflection loops can also
  *destroy* output quality; the loop must be graded against reality, not
  against the model's own opinion.

**→ Applied here:** we independently converged on this architecture — the
brain (attribution → lessons → bounded action), the journal (memory), the AI
desk (bull/bear debate), the news desk (classification grounded by live-quote
validation). Reality-grading is the Fable method: every lesson traces to
resolved trades, never LLM judgment.

## 6. Time-series foundation models (Kronos, TimesFM, Chronos)

- General-purpose TSFMs **fail on financial data**: TimesFM zero-shot financial
  R² = −2.8%, Chronos ≈ −1.4% — worse than useless; they learn noise as signal.
- Domain-specific Kronos (12B K-line records, 45 exchanges) is meaningfully
  better on rank-IC benchmarks, but rank-IC ≠ tradeable after costs.
- Our live record agrees: kronos1h is 4/12 with a systematic ETH-bearish bias
  and non-informative confidence (always 0.95–1.0).

**→ Applied here:** Kronos stays demoted to *one feature among several* —
never a standalone trigger. Its forecast can enter the future meta-label
feature set; it doesn't get its own unchecked P&L line.

## 7. RL market-making (Avellaneda-Stoikov + RL) — deliberately skipped

The literature (RL-tuned risk-aversion γ over the A-S quoting model) is solid
but applies to *makers with inventory risk*. We are takers at $10 paper size.
Revisit only if we ever quote two-sided markets. Honesty > ambition.

## The system this research points to (our roadmap)

1. **NOW — inputs**: log book imbalance + depth at oracle-lag entry (done).
2. **~100 resolved oracle-lag trades**: fit meta-label (logistic P(win|features));
   gate + Kelly-size by it.
3. **Brain v2**: discounted Thompson sampling per strategy/segment; graded
   stake allocation instead of binary arming.
4. **Validation v2**: deflated-Sharpe-style trial correction on every
   "best config" the learner reports.
5. **Regime gate**: realized-vol tercile on BTC gates crypto strategies
   (the hour=11/23 bleeders are likely low-vol regimes).
6. **News-lag strategy**: news desk classifies a mag-4+ event → check related
   Polymarket market's repricing latency (the 30–90s window the literature
   documents for news, vs the ~15s for price feeds).

## Sources

- [DeepLOB: Deep CNNs for Limit Order Books](https://arxiv.org/abs/1808.03668) · [Deep LOB forecasting: a microstructural guide](https://arxiv.org/html/2403.09267v1) · [Crypto LOB: inputs matter more than layers](https://arxiv.org/html/2506.05764v2)
- [The Deflated Sharpe Ratio (Bailey & López de Prado)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551) · [Purged cross-validation](https://en.wikipedia.org/wiki/Purged_cross-validation) · [Advances in Financial ML — key takeaways](https://abouttrading.substack.com/p/my-key-takeways-from-maros-lopez)
- [Anatomy of a Decentralized Prediction Market: Polymarket order book](https://arxiv.org/abs/2604.24366) · [Price Discovery in Modern Prediction Markets (Polymarket vs Kalshi)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5331995) · [AI-augmented arbitrage in 5-min BTC binaries](https://medium.com/@gwrx2005/ai-augmented-arbitrage-in-short-duration-prediction-markets-live-trading-analysis-of-polymarkets-8ce1b8c5f362) · [Prediction markets as bot playground ($40M extracted)](https://www.financemagnates.com/trending/prediction-markets-are-turning-into-a-bot-playground/)
- [Regime Switching Bandits](https://arxiv.org/pdf/2001.09390) · [Adaptive Portfolio via Thompson Sampling](https://arxiv.org/pdf/1911.05309) · [MAB methods in trading](https://www.daytrading.com/multi-armed-bandit)
- [FinMem: layered memory LLM trading agent](https://arxiv.org/abs/2311.13743) · [TradingAgents: multi-agent LLM framework](https://arxiv.org/abs/2412.20138) · [TradingGroup: self-reflection + data synthesis](https://arxiv.org/pdf/2508.17565)
- [Kronos: foundation model for financial K-lines](https://arxiv.org/abs/2508.02739) · [Re(Visiting) TSFMs in finance (TimesFM/Chronos fail)](https://arxiv.org/pdf/2511.18578)
- [RL-tuned Avellaneda-Stoikov market making](https://pmc.ncbi.nlm.nih.gov/articles/PMC9767337/)

---

## ML capacity audit + upgrade (2026-07-13)

**Was our ML at full capacity? No — but the fix is NOT a bigger model.**
sklearn 1.8, torch 2.12, scipy, numpyro were installed but the meta-label ran
a single hand-rolled logistic with a naive 70/30 split. On a small, noisy
financial sample the literature is unanimous ([López de Prado — 10 reasons ML
funds fail](https://www.garp.org/hubfs/Whitepapers/a1Z1W0000054x6lUAA.pdf),
[meta-labeling](https://en.wikipedia.org/wiki/Meta-Labeling)): complexity
overfits; power comes from **variance reduction + leak-free validation +
feature importance**, not model size.

Upgraded `dryrun/metalabel.py` accordingly (the correct, not the flashy, move):
- **Bagged logistic ensemble** (40 estimators, 0.8 subsample) — variance
  reduction, the real lever on low signal-to-noise data.
- **Purged walk-forward CV** (embargo gap around each test fold) — kills the
  look-ahead leakage the old 70/30 split allowed on time-adjacent trades.
- **MDA feature importance** — shuffle each feature, measure AUC drop → tells
  us WHICH of {abs_move, ask, book_imbalance, hour} actually carries signal.
  Verified on synthetic data: correctly isolates the true feature (imp 0.45 vs
  ~0 noise).
- Gate still activates only if the **purged-CV bagged AUC ≥ 0.55** (was the
  leaky single-split AUC). Daemon keeps a lightweight pure-python coef for the
  live gate; sklearn does the rigorous go/no-go.
- StandardScaler + L2 (C=0.5) for convergence + regularization.

Binding constraint remains DATA, not model power: oracle-lag at n=52/60. When
it clears 60 the rigorous eval runs for real and reports which feature matters.
Meta-labeling itself is the overfitting antidote: ML sizes the bet, the
primary signal picks the side.
