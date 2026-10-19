# AXIOM 2.0 — handoff

This is everything needed to install, run, use and maintain AXIOM 2.0.

---

## 1. What it is

AXIOM 2.0 is a stocks, ETF and options **advisory** desk that runs on a Mac,
around the clock. It reads live market data, builds and checks investment plans,
and tells the investor **what to buy, when, and why**. It does **not** trade:
there are no broker connections, no orders and no paper-trading bots. Every
decision stays with the investor.

| Page | What it is for |
|---|---|
| **Home** | S&P 500 and TSX today, your calls, live news summary, AXIOM |
| **Invest** | the SIP planner, the top 20 ETFs (US and Canada), your calls |
| **Stocks** | your calls, the **SIP** button, stock research and live quotes |
| **Options** | option chains, volatility, sizing — research, see §6 |
| **Pre-Market** | early-session movers — research, see §6 |
| **AI Desk** | stock analyst, market intel, risk, macro |
| **Council** | give it any idea ("Is NVDA a buy this quarter?"); eight specialists and a 72-agent swarm debate and rule |
| **Axiom** | the brain: talk or type; it reads every page's data |
| **Intel / News / God's Eye** | classified news, live TV and wires, a world map |
| **Keys** (Settings) | API keys, voice on/off, page switches |

---

## 2. Install (once, about 10 minutes)

Needs a Mac (Apple silicon or Intel), [Homebrew](https://brew.sh) and internet.

```bash
brew install python@3.12 node ffmpeg
cd ~/Downloads/AXIOM-2.0          # wherever this folder is; you can move it first
./scripts/install.sh
```

The installer checks the tools, creates `.env` from `.env.example`, installs the
Python packages (`.venv/`) and Node packages, downloads the speech model for the
voice (142 MB), builds the dashboard, registers every service with macOS so it
**starts by itself at every login and restarts if it crashes**, and prints the
status. Then open **http://localhost:3300**.

Run it again any time — after moving the folder, after an update — it updates in place.

---

## 3. Keys

Open **http://localhost:3300/settings** and paste keys there (they are written to
the local env files, never shown again, never leave the Mac). Or edit `.env`.

| Key | Needed? | Where to get it | What it powers |
|---|---|---|---|
| `GROQ_API_KEY` | **yes** (or NVIDIA) | console.groq.com/keys — free | AXIOM's chat and voice, news summaries, the Council |
| `NVIDIA_API_KEY` | **recommended** | build.nvidia.com — free tier | the Council's 72-agent swarm, AXIOM fallback |
| `NVIDIA_API_KEY_JARVIS` | optional | same site, a second key | AXIOM on its own key (no contention) |
| `OPENAI_API_KEY` | optional | platform.openai.com | AXIOM's second opinion |
| `NTFY_TOPIC` | **for phone alerts** | the free **ntfy** app → subscribe to a private topic name (e.g. `axiom-yourname-7f3k`) → put the same name here | your calls on the phone |
| `FMP_API_KEY` | optional | financialmodelingprep.com | company valuations on the AI desk |

Market data (prices, fund profiles, holdings, news) needs **no key** — it comes
from Yahoo Finance's public feeds.

After changing keys: `./scripts/axiom.sh restart jarvis` (or log out and in).

---

## 4. Daily use

1. **Invest** (or **Stocks → SIP**) → choose 🇺🇸 US or 🇨🇦 Canada → enter the monthly
   amount, years, an optional goal → pick a risk level → **Build my plan**.
2. Read the plan (§5), then press **Save as my plan**. One plan per market; save
   one for each if you invest in both.
3. From then on the **advisor** watches it every 15 minutes, day and night:

| Call | When | What to do |
|---|---|---|
| **NEXT SIP** | always shown | the date and time of the next monthly buy and the amounts |
| **SIP BUY** | the day before, then at the buy time | buy every line of the plan, at the amounts shown |
| **PAUSE** | a holding closed a month below its 10-month average, and on that fund's own 20-year history stepping aside paid | keep what you own; put that holding's monthly amount into the T-bill fund named (SGOV in the US, CASH.TO in Canada) until told to resume |
| **RESUME** | the paused holding closed a month back above its average | move it back, from the next buy |
| **DIP** | a holding marked "buy on dip" reached its limit price | extra money (beyond the SIP) can go in |
| news digest | once a day after 7:30 AM New York | headlines on what you own |

Calls appear under **YOUR CALLS** (Home, Invest, Stocks) and, with `NTFY_TOPIC`
set, on the phone — each one once.

**Buy time:** the first trading day of each month at 10:00 AM New York (30 minutes
after the open, when prices have settled) — weekends and NYSE/TSX holidays are
skipped. The calendar shows each date in New York and India time.

---

## 5. How every recommendation is made

**The plan.** Risk sets the stock/bond split (Conservative 40/60, Balanced 60/40,
Growth 80/20, Aggressive 100/0), capped by the horizon: money needed within 3
years is held to Conservative, within 6 years to Balanced. Three ways to hold it:

* **Diversified** (default): broad ETFs as the core; a stock slice (10–25% of the
  stock money, rising with risk) split across **one leader per sector**; **5% in
  gold and silver**; bonds.
* **One fund**: a single all-in-one ETF with the same mix (AOM/AOR/AOA/VT in the US,
  XCNS/XBAL/XGRO/XEQT in Canada) — the simplest.
* **ETF blocks**: the core ETFs alone — the lowest fees.

**Sector leaders.** For each of the 11 sectors, two or three of its largest
companies are candidates. A stock qualifies only with 10+ years of data, a
10-year return above cash (4%), a worst fall no deeper than −70%, and a positive
last 3 years; among those, the best return per unit of risk (Sharpe) is chosen.
The page shows each pick, its numbers and what it was chosen over. Past leaders
are not promised future leaders, which is why the stock slice stays a minority
beside ETFs that already own every company.

**Back-test.** The exact monthly SIP is replayed on real month-end prices,
dividends reinvested, over the longest history all holdings share (2011 onward
in the US, 2015 onward in Canada), and from every possible start month — so the
plan shows the best, typical and worst outcomes of timing luck, not one lucky run.

**Forecast.** 2,000 simulated futures built from 12-month blocks of that real
history (which keeps crashes and how the holdings move together) but re-centred
on deliberately modest long-run returns — stocks 6.5%, bonds 3.5%, metals 4% a
year — so the "likely" figure is not a replay of the strong last decade. Values
are shown in future dollars and in today's money (2.5% inflation).

**Pause / resume.** The 10-month moving-average rule (Faber, 2007), checked at
each month-end close. It is used **only** for a holding where, on that fund's own
history, stepping aside beat holding on **both** return and worst fall. For most
stock funds it did not (on the S&P 500 it cost about 5% a year), so for them
there is no signal and the SIP simply continues. Nothing is ever sold: new money
waits in a T-bill fund instead.

**Top 20 ETFs** are the 20 largest by assets among ~30 well-known funds per
market, refreshed every 6 hours. "Moves almost exactly with X" means the two
track the same index (≥99.5% correlated) — owning both doubles up.

---

## 6. What it deliberately does not do, and why

The desk this was built from ran stock, options, pre-market and VWAP **trading
bots** on paper for 45 days. None showed an edge: the options bot lost 91% of its
account, the pre-market stop rule won 0 of 126, a VWAP rule lost on 353 of 411
trades. AXIOM 2.0 therefore **does not issue short-term trade calls**. The
Options and Pre-Market pages remain as research tools — read them as information,
not instructions. Every call the advisor makes comes from the tested methods in §5.

---

## 7. Services

Each runs under macOS `launchd`, starts at login and restarts if it stops.

| Service | Job |
|---|---|
| `frontend` | the dashboard on http://localhost:3300 |
| `advisor` | your calls, every 15 minutes, 24/7 |
| `jarvis` | AXIOM's brain (voice and chat) |
| `jarvis.freshness` | weekly check for API and model changes |
| `stt` | speech-to-text for "hey Axiom" |
| `mirofish` | the Council's 72-agent swarm |
| `data.openbb` | macro and market data refresh |
| `newsdesk.poll` | news classification every 15 minutes |
| `cleanup` | caps logs and clears caches daily (03:30) |
| `keepawake` | keeps the Mac awake while plugged in |

```bash
./scripts/axiom.sh status              # every service: running / scheduled / FAILING
./scripts/axiom.sh logs advisor        # follow one service's log
./scripts/axiom.sh restart frontend
./scripts/axiom.sh stop | start
./scripts/axiom.sh uninstall           # removes the services; files stay
```

Keep the Mac plugged in and logged in for 24/7 calls (closing the lid on battery
sleeps it).

---

## 8. Files

| Path | What |
|---|---|
| `frontend/` | the dashboard (Next.js) |
| `jarvis/` | AXIOM's brain and voice bridge (Node) |
| `signals/` | the Council swarm, speech, data connectors (Python) |
| `core/` | shared Python configuration |
| `scripts/` | `install.sh`, `axiom.sh`, `advisor.py`, `daily_cleanup.sh` |
| `deploy/launchd/` | the service definitions the installer fills in |
| `.env` | your keys (never share or commit) |
| `.data/` | your saved plans (`client_profile.json`), calls (`advice.json`), caches |
| `logs/` | one log per service |

---

## 9. When something is wrong

| Symptom | Fix |
|---|---|
| a service shows **FAILING** | `./scripts/axiom.sh logs <name>` shows why |
| AXIOM does not answer | a key is missing or out of quota: Settings → AI keys; `./scripts/axiom.sh restart jarvis` |
| no phone alerts | `NTFY_TOPIC` empty, or the app is subscribed to a different name |
| "YOUR CALLS" empty | no plan saved yet — Invest → Build my plan → Save as my plan |
| dashboard blank after moving the folder | run `./scripts/install.sh` again |
| a page is slow the first time after a restart | first load fetches live data; later loads come from memory in milliseconds |
| disk full | the `cleanup` service caps logs daily; `du -sh logs .data` |

---

## 10. Limits and disclaimer

Data comes from public feeds and can be late or wrong; check a price with the
broker before buying. Back-tests use the past; the future can be worse than any
period in it. The forecast is a range of possibilities, not a promise. This is
educational research software, not financial, investment or tax advice; for
advice on your own situation, speak to a licensed adviser.
