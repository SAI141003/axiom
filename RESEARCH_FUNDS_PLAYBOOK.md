# Bridgewater & HFT — Categorized Playbook for AXIOM

*2026-07-13. First, the honest correction: Bridgewater is NOT an HFT firm — it
is the world's largest systematic MACRO fund (horizon: months, not
microseconds). The HFT names are Citadel Securities, Jane Street, Virtu, Jump.
Both literatures are mined below, categorized, and each part mapped to our
system.*

---

## PART A — Bridgewater: the portfolio brain (slow intelligence)

Source papers: [Engineering Targeted Returns and Risks (Dalio)](https://bridgewater.brightspotcdn.com/fa/e3/d09e72bd401a8414c5c0bdaf88bb/bridgewater-associates-engineering-targeted-returns-and-risks-aug-2011.pdf) ·
[The All Weather Story](https://www.bridgewater.com/research-and-insights/the-all-weather-story) ·
[Alpha-Beta framework](https://navnoorbawa.substack.com/p/bridgewaters-alpha-beta-framework)

### A1. The Holy Grail — 15 uncorrelated return streams
Dalio: combining 10–15 uncorrelated, risk-balanced streams keeps the average
return while cutting risk up to 80%. **The most important idea in this doc.**

**→ Our system:** our strategies ARE return streams (weather, oracle-lag,
premarket, options, kronos, news-lag). Their value isn't individual P&L — it's
LOW CORRELATION: weather resolutions have nothing to do with BTC windows.
Action: the journal now tracks per-strategy daily P&L; the correlation matrix
between streams is the next brain metric. A marginal strategy that's
uncorrelated (weather, 61%) beats a "better" one that's correlated. This is
why we run many small paper streams instead of one big bet.

### A2. Risk parity — size by risk contribution, not dollars
Equal-dollar staking overweights volatile streams. Bridgewater sizes so each
stream contributes equal RISK.

**→ Our system:** when anything goes live, per-strategy stake = allocation
weight ÷ that strategy's P&L volatility — options (avg win $429/avg loss $153)
must get far fewer dollars per unit of brain-weight than weather ($18/$10).
The brain's `brain_allocation.json` weights are the numerator; daily-P&L stdev
is the denominator. Not applied to paper $10 stakes (comparability first).

### A3. Environment quadrants — strategies thrive in regimes
All Weather holds four risk-balanced portfolios for (growth↑, growth↓,
inflation↑, inflation↓). The general lesson: **map each stream to the
environment it needs, and know the current environment.**

**→ Our system:** the micro analog is live: crypto momentum's stable bleeders
at hour 11/23 UTC are a low-vol regime (rv_bp now logged per entry);
oracle-lag needs volatile US hours; weather thrives in wide-spread niche
markets (informed-specialist regime). Brain v3: condition arming on regime,
not just global record.

### A4. Systematic rules, written down, stress-tested "timeless & universal"
Every Bridgewater rule must work across decades and countries before capital
touches it — the antidote to curve-fitting.

**→ Our system:** exactly our stability gate (both chronological halves) +
the new permutation null. Today's result made this concrete: crypto's best
config showed +$371 but p=1.0 vs the noise null — a Bridgewater-style test
would never fund it.

### A5. Believability-weighted decisions (idea meritocracy)
Decisions weighted by each voice's demonstrated track record, not seniority
or confidence.

**→ Our system:** Kronos's "confidence 0.99" gets zero believability (it's
always 0.95–1.0 and its record is 4/12). The brain's posterior means ARE
believability scores. LLM opinions (news desk, AI desk) are candidates until
reality co-signs. Same principle, already enforced.

### A6. Alpha–beta separation
Separate cheap market exposure (beta) from skill (alpha); never pay alpha
fees for beta returns.

**→ Our system:** the paper analog — every strategy should be measured
against its NAIVE BASELINE, not zero: crypto vs "always buy the cheaper
side"; weather vs "always buy market favorite"; options vs "buy-and-hold the
underlying." A strategy that only matches its baseline has no alpha. Planned
addition to the MC report.

---

## PART B — HFT literature: the execution brain (fast mechanics)

Source papers: [Quantifying the HFT Arms Race (Aquilina, Budish, O'Neill — QJE 2022)](https://ericbudish.org/wp-content/uploads/2022/02/Quantifying-the-High-Frequency-Trading-Arms-Race.pdf) ·
[Frequent Batch Auctions (Budish, Cramton, Shim)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2388265) ·
[HFT and the New Market Makers (Menkveld)](https://ideas.repec.org/a/oup/qjecon/v137y2022i1p493-564..html)

### B1. The arms race is over SHARED information (Budish)
Latency races happen when many parties see the SAME signal and race to act;
the winner takes the whole rent. In equities races last ~5–10ms. On
Polymarket the same race runs in SECONDS (Binance→CLOB), which is why $40M/yr
is extractable there by ordinary bots.

**→ Our system:** our oracle-lag IS this race, at a speed class we can
actually compete in. Two implications: (1) enter EARLIER in the window — the
probe shows the rent is gone by t=72s; whatever remains lives at t≈12–36s.
(2) expect decay: as faster bots join, the window shrinks — the probe
measures this drift continuously, so we'll SEE the edge dying instead of
bleeding into it.

### B2. Maker vs taker — the queue is an asset (Menkveld)
Modern market makers earn the spread and win by managing queue position and
inventory, not by predicting price.

**→ Our system:** we always TAKE (cross the spread) — paying ~5–10¢ of edge
per trade. The concrete upgrade: for oracle-lag, POST a resting bid at a
favorable price early in the window instead of lifting a 0.73 ask at t=72s.
Filled = entry at our price; unfilled = no trade. Paper daemons can simulate
this from the probe's book snapshots (fill iff ask crossed our level).

### B3. Adverse selection — the fill itself is information
A resting order gets filled precisely when someone informed wants the other
side. Menkveld's MMs survive by pricing this in.

**→ Our system:** the t=72s ask of 0.73–0.91 IS adverse selection — the
market charging us for arriving late with public information. And for the
maker upgrade (B2): simulated resting-bid fills must be marked against the
final outcome to measure how toxic our fills are BEFORE any real posting.

### B4. Market design determines the game (Frequent Batch Auctions)
Budish's fix for the arms race is discrete-time batch auctions — when time is
discrete, speed rents vanish and price competition returns.

**→ Our system:** Polymarket's 5-minute windows are effectively slow batch
products — resolution is discrete even though trading is continuous. The rent
concentrates at window-open (first ~30s of repricing); after that it's a
fair-odds market. This is exactly what the probe data shows, now explained by
theory: **the strategy frontier is the first 30 seconds.**

---

## The combined blueprint

| Layer | Source | Our implementation |
|---|---|---|
| Many uncorrelated streams | Dalio A1 | 6 paper strategies, correlation matrix next |
| Risk-balanced sizing | Dalio A2 | Thompson weight ÷ P&L vol (at go-live) |
| Regime awareness | Dalio A3 | rv_bp logging, hour-segment lessons, regime gate v3 |
| Anti-curve-fit validation | Dalio A4 | halves-stability + permutation null (live today: crypto p=1.0) |
| Believability weighting | Dalio A5 | posterior means; LLM = candidate only |
| Alpha vs baseline | Dalio A6 | naive-baseline comparison (planned in MC report) |
| Race positioning | Budish B1 | probe at 12–36s; measure edge decay continuously |
| Maker entries | Menkveld B2 | simulated resting-bid fills from probe books (next build) |
| Toxicity measurement | Menkveld B3 | mark simulated fills vs outcomes |
| Design-aware timing | Budish B4 | first-30s frontier, discrete-resolution mindset |

---

## PART C — Why intraday winners win (and why we didn't) · added 2026-07-13

Diagnosed against our own logs, not theory. Each gap → the fix now in place.

| # | What winners do | What WE were doing (evidence) | Fix (live) |
|---|---|---|---|
| 1 | **Asymmetric R**: risk 1 to make 2-3; losers cut fast | Learner had converged to target 0.8× / stop 1.0× — cut winners, ride losers. Premarket stops lesson: 0/7 won, −$148 | 2R shape ENFORCED (target 1.6×/stop 0.8×) and — critical — the daemon now actually READS the params (it never did) |
| 2 | **Selectivity**: 1-3 A+ setups/day, skip everything else | We forced top-5 picks every single day; options forced ≥1 contract even when Kelly said 0 (−$2,359 on main legs, 1/8) | Kelly=0 respected; ensemble-agreement gate on kronos; meta-label gate pending data |
| 3 | **VWAP as the institutional benchmark**: longs only above, shorts only below | No VWAP anywhere in the system | `vwap_daemon.py` live (Zarattini/Aziz replication, QQQ/TQQQ); VWAP-side can later filter premarket entries |
| 4 | **Liquidity awareness**: enter after stop-hunts (sweep + reclaim), not into them | No sweep concept | `sweep` feature now logged on every premarket pick (prior-day H/L sweep + reclaim) |
| 5 | **Vol/regime filter**: trade trending days, sit out chop | We traded every day identically; crypto's stable hour-11/23 bleed is chop by another name | `rv_bp` logged per crypto entry; VWAP flip-count per day measures chop directly |
| 6 | **Factor context**: know if the name is a fade or a runner | None | Vibe-Trading zoo live: 7 factors daily on the watchlist (strev already flags ONDS/JOBY as fades) |
| 7 | **Journal + review discipline** | We built it (brain, lessons, calendar) | Memory consolidation now grades which lessons survive repetition |

**Honest caveat:** published day-trading returns (671%/8,242% VWAP paper included)
carry selection and publication bias — the permutation-null lesson applies to
OTHER people's backtests too. Our replication paper-trades it against live
data and lets the MC verdict decide.

## PART D — Super-memory / neural-link architecture (implemented)

Human-memory mapping, all layers real and wired:

- **EPISODIC** — `logs/journal.jsonl` daily notes + every trade log (what happened)
- **SEMANTIC** — `.data/brain_memory.json`: repeated stable lessons consolidate
  into principles with evidence counts (for/against → strength); 3+
  confirmations at ≥0.7 strength = LONG-TERM (survives any single bad day);
  contradicting evidence weakens, unreinforced principles fade — synaptic
  strengthening/pruning, honestly implemented
- **PROCEDURAL** — `.data/params_*.json` + Thompson allocation: what the
  daemons actually DO (the brain's bounded actuators)
- **PERCEPTION → CONSOLIDATION loop** — hourly: trades → attribution →
  lessons → memory update → (bounded) action → journal. Sleep-cycle analog:
  the overnight loop is when consolidation runs.
