# Running AXIOM on a Mac

One command installs everything and registers every service with macOS
`launchd`. After that the whole desk **starts by itself at every login** and
**restarts any service that crashes**. Nothing needs a terminal left open.

## 1. Install (once, about 10 minutes)

You need: macOS, [Homebrew](https://brew.sh), and the internet.

```bash
brew install python@3.12 node redis postgresql@16
git clone https://github.com/SAI141003/axiom.git
cd axiom
./scripts/install.sh
```

The installer:

1. checks Python 3.11+, Node 18+, Redis and Postgres;
2. creates `.env` from `.env.example` if it is missing (your keys go there — it is never committed);
3. creates the database and its user from `DATABASE_URL` in `.env`;
4. installs the Python packages (`.venv/`) and Node packages, builds the dashboard;
5. writes each service into `~/Library/LaunchAgents/` with this Mac's paths and loads it;
6. waits for the dashboard and prints the status of every service.

Then open **http://localhost:3300**.

Options: `--core-only` skips the large machine-learning packages (the Kronos bot
then does not run); `--skip-build` reuses an existing dashboard build.
Running it again is safe — it updates in place.

## 2. Keys (`.env`)

The desk runs on keyless public data out of the box. Add keys for more:

| Key | What it unlocks |
|---|---|
| `GROQ_API_KEY`, `NVIDIA_API_KEY` | AXIOM's voice and chat, AI news reading, the Council |
| `NTFY_TOPIC` | weather pick alerts on your phone (install the free **ntfy** app, subscribe to the same topic) |
| `DATABASE_URL` | the original Polymarket engine (`bot`) |
| `POLYMARKET_*` | live Polymarket orders — **leave `DRY_RUN=true`** until a strategy is proven |

After changing `.env`: `./scripts/axiom.sh restart <service>` (or log out and in).

## 3. Everyday control

```bash
./scripts/axiom.sh status            # every service: running / scheduled / off / FAILING
./scripts/axiom.sh restart frontend  # restart one service
./scripts/axiom.sh logs dryrun.weather
./scripts/axiom.sh stop              # stop everything (starts again at next login)
./scripts/axiom.sh start
./scripts/axiom.sh uninstall         # remove the services; code and data stay
```

To keep the bots running while the Mac is idle, leave it plugged in; the
`dryrun.caffeinate` service stops it sleeping while the desk runs (closing the
lid on battery still sleeps it).

## 4. What runs

| Service | What it does | When |
|---|---|---|
| `frontend` | the dashboard, http://localhost:3300 | always |
| `redis`, `postgres` | cache and database | always |
| `jarvis`, `stt`, `wsbridge` | AXIOM's voice/chat bridge, speech-to-text, market websocket bridge | always |
| `mirofish` | the Council's agent swarm | always |
| `dryrun.weather` | Polymarket weather bot (paper) | every 30 min |
| `dryrun.oraclelag`, `dryrun.crypto`, `dryrun.kronos1h`, `dryrun.newslag` | Polymarket crypto / news bots (paper) | always |
| `dryrun.options`, `dryrun.gammapulse`, `dryrun.stocksbot`, `dryrun.premarket`, `dryrun.vwap` | options and stock bots (paper) | market hours |
| `bot` | the original Polymarket HFT engine (dry-run unless `DRY_RUN=false`) | always |
| `weatheralerts` | pushes the best weather picks to ntfy | every 10 min |
| `autotuner`, `dryrun.montecarlo`, `eod.council`, `dryrun.report`, `dryrun.forwardsnapshot` | nightly learning, robustness tests, council review, daily report, scoreboard | scheduled |
| `jarvis.agent`, `jarvis.study`, `jarvis.freshness` | AXIOM's unattended checks, night study, weekly freshness research | scheduled |
| `newsdesk.poll`, `data.openbb` | news and macro data refresh | scheduled |
| `cleanup` | caps logs and clears caches daily, never touches trade records | 03:30 |

Bots switched off on purpose (meme, flow, CCXT, user-made bots) are not
installed; their history stays on the Bots page.

## 5. If something is wrong

* `./scripts/axiom.sh status` shows **FAILING** → `./scripts/axiom.sh logs <name>` shows why.
* Dashboard blank after an update → `cd frontend && npm run build && ../scripts/axiom.sh restart frontend`.
* Postgres will not start after a crash → the `postgres` service clears a stale lock itself; if not, `./scripts/axiom.sh restart postgres`.
* Disk full → the `cleanup` service caps logs daily; `du -sh logs .data` shows what is large.
