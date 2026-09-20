/**
 * AXIOM · JARVIS bridge (v2).
 *
 * Runs the Claude Agent SDK -- Claude Code as a library -- on your existing
 * login and gives it the desk: every page's data, every news outlet the desk
 * reads, the paper fleet's start/stop, the test suite, and the code to READ.
 * It remembers: the conversation resumes across restarts, and memory.md holds
 * what you tell it to keep.
 *
 * It does not edit code. When you ask for a fix it writes a proposal --
 * the diagnosis, the exact change, the file -- to jarvis/proposals/ for a
 * human to apply in a Claude Code session. Keys, .env, live switches and git
 * are out of its reach by construction, not by promise.
 *
 *   cd jarvis && npm install && npm start        →  ws://127.0.0.1:8788
 */
import { WebSocketServer } from "ws";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFile, writeFile, appendFile, mkdir, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PORT = Number(process.env.JARVIS_PORT ?? 8788);
const DESK = process.env.AXIOM_DESK_URL ?? "http://localhost:3000";
const PY = join(ROOT, ".venv", "bin", "python");
const MEMORY = join(HERE, "memory.md");
const JOURNAL = join(HERE, "journal.jsonl");
const STATE = join(HERE, "state.json");
const PROPOSALS = join(HERE, "proposals");
const execFileP = promisify(execFile);

process.on("unhandledRejection", (e) => console.error("[jarvis] unhandled:", e));

const compact = (o) => JSON.stringify(o);
const text = (t, isError = false) => ({ content: [{ type: "text", text: typeof t === "string" ? t : compact(t) }], ...(isError ? { isError: true } : {}) });
async function data(name) { try { return JSON.parse(await readFile(join(ROOT, ".data", name), "utf-8")); } catch { return null; } }
async function readText(p, fallback = "") { try { return await readFile(p, "utf-8"); } catch { return fallback; } }
// Read only the tail of a log by byte offset -- the weather log is 450MB and
// reading it whole made the briefing take minutes.
async function tailJsonl(rel, n, bytes = 512 * 1024) {
  const out = [];
  let fh;
  try {
    fh = await open(join(ROOT, "logs", rel), "r");
    const size = (await fh.stat()).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n"); if (start > 0) lines.shift();
    for (const l of lines.slice(-n)) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
  } catch {} finally { await fh?.close(); }
  return out;
}
async function sh(cmd, args, timeout = 30_000) {
  try { const { stdout, stderr } = await execFileP(cmd, args, { cwd: ROOT, timeout, maxBuffer: 8 << 20 }); return (stdout + (stderr ? "\n" + stderr : "")).trim(); }
  catch (e) { return `error: ${String(e.stderr || e.message || e).slice(0, 400)}`; }
}
async function deskGet(path) {
  const r = await fetch(DESK + path, { signal: AbortSignal.timeout(20_000) });
  return (await r.text()).slice(0, 14_000);
}

// ── Every page's data. Read-only; the routes that act are not listed. ─────────
const DESK_PATHS = ["/api/agents", "/api/ai", "/api/arb", "/api/backtest-lab", "/api/benchmark", "/api/benchmark/industry", "/api/benchmark/kronos",
  "/api/benchmark/market", "/api/benchmark/vol", "/api/bots", "/api/brain", "/api/broker/status", "/api/ccxt-bot", "/api/council", "/api/council/review/latest",
  "/api/council/tuner", "/api/crypto/trades", "/api/crypto/window", "/api/data-desk", "/api/deepchain", "/api/fleet", "/api/flow-bot", "/api/gamma-pulse",
  "/api/intel", "/api/journal", "/api/kalshi", "/api/learned", "/api/live/balance", "/api/markets", "/api/meme-bot", "/api/newsdesk",
  "/api/options", "/api/oracle", "/api/oracle/track", "/api/premarket", "/api/proving-ground", "/api/quotes", "/api/recall", "/api/scenario",
  "/api/stocks", "/api/stocks-bot", "/api/tape", "/api/valuation", "/api/venues", "/api/weather", "/api/weather-trades", "/api/weather/picks", "/api/workforce"];

// Files JARVIS may read: source only, inside the repo, never secrets.
const UNREADABLE = /(^|\/)\.env|\.key$|\.pem$|id_rsa|(^|\/)\.claude\/|(^|\/)\.git\/|(^|\/)node_modules\/|(^|\/)\.venv\//;
function safePath(p) {
  const abs = isAbsolute(p) ? p : join(ROOT, p);
  if (relative(ROOT, abs).startsWith("..") || UNREADABLE.test(abs)) return null;
  return abs;
}

// Paper bots JARVIS may start, stop or restart. The dashboard and the live
// executor are not on the list.
const CONTROLLABLE = /^com\.polymarket\.(dryrun\.[a-z0-9]+|autotuner|data\.openbb|newsdesk\.poll|eod\.council|jarvis)$/;

const axiom = createSdkMcpServer({ name: "axiom", version: "2.0.0", tools: [
  tool("fleet_status", "Every paper account: balance, P&L, trades, win rate, today, config; fleet totals; days of forward test.", {}, async () => {
    const s = await data("engine_status.json"); const f = await data("forward_perf.json"); const e = s?.engines ?? {};
    return text({ as_of: s?.ts, days_tracked: f?.days_tracked, accounts: Object.entries(e).map(([k, v]) => ({ name: k, account: v.account, pnl: v.pnl, trades: v.trades, win_rate: v.win_rate, today: v.today, config: v.config })) });
  }),
  tool("backtest_results", "Walk-forward backtest, the 9-cell grid, the anti-overfit search, the strategy-variant bake-off, with verdicts.", {}, async () => {
    const [r, b, o, x, ps] = await Promise.all(["backtest_report.json", "backtest_batch.json", "optimize_report.json", "experiments_report.json", "per_symbol_report.json"].map(data));
    return text({ report: r && { symbol: r.symbol, timeframe: r.timeframe, metrics: r.metrics, as_of: r.ts }, grid: b?.grid, edge_cells: b?.edge_cells, total_cells: b?.total_cells,
      optimize: o && { outcome: o.outcome, shipped: o.shipped, default: o.default, tuned: o.tuned },
      experiments: x && { verdict: x.verdict, variants: Object.fromEntries(Object.entries(x.variants ?? {}).map(([k, v]) => [k, { mean_return: v.mean_return, mean_sharpe: v.mean_sharpe }])) }, per_symbol_verdict: ps?.verdict });
  }),
  tool("safety_proof", "The fault-injection proving ground: assertions, failures, every scenario's pass rate.", {}, async () => text(await data("scenario_report.json"))),
  tool("venues", "Every venue the desk can reach: reachability, custody, API, KYC, notes.", {}, async () => text(await data("venues.json"))),
  tool("desk_api", "GET any page's read-only JSON. Use this to see what a page shows: open positions, recent closes, journal, council rulings, options chains, weather picks, news desk, intel, markets, quotes. Paths: " + DESK_PATHS.join(", "),
    { path: z.enum(DESK_PATHS) }, async ({ path }) => { try { return text(await deskGet(path)); } catch { return text(`dashboard not reachable at ${DESK}`, true); } }),
  tool("news", "Headlines from every outlet the desk reads (Reuters, BBC, NYT, CoinDesk, Cointelegraph, TechCrunch, Ars Technica, Google News topics) via the news desk, plus the intel classifier's direction/materiality calls. Optional query does a live Google News search.",
    { query: z.string().max(80).optional() }, async ({ query: q }) => {
      const out = {};
      try { out.newsdesk = JSON.parse(await deskGet("/api/newsdesk")); } catch { out.newsdesk = "unavailable"; }
      try { out.intel = JSON.parse(await deskGet("/api/intel")); } catch {}
      if (q) {
        try {
          const xml = await (await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { signal: AbortSignal.timeout(15_000) })).text();
          out.search = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<pubDate>(.*?)<\/pubDate>/g)].slice(0, 12).map((m) => ({ title: m[1].replace(/<!\[CDATA\[|\]\]>/g, ""), when: m[2] }));
        } catch { out.search = "search failed"; }
      }
      return text(compact(out).slice(0, 16_000));
    }),
  tool("morning_brief", "Everything that happened on the desk since yesterday, in one call: fleet P&L today and overall, which bots traded, weather resolutions, service health, disk, errors in logs, top headlines, standing notes. Call this when asked for status or a briefing, or when greeted with just 'hey Jarvis'.", {}, async () => {
    const since = Date.now() / 1000 - 24 * 3600;
    const s = await data("engine_status.json"); const e = s?.engines ?? {};
    const accounts = Object.entries(e).map(([k, v]) => ({ name: k, account: v.account, pnl: v.pnl, today: v.today, trades: v.trades, win_rate: v.win_rate }));
    const activity = {};
    for (const [bot, file, kinds] of [["flow-bot", "flow_bot.jsonl", ["fentry", "fclose"]], ["meme-coin", "meme_bot.jsonl", ["mentry", "mclose"]], ["strategy", "ccxt_bot.jsonl", ["sentry", "sclose"]], ["stocks", "stocks_bot.jsonl", ["sentry", "sclose"]], ["weather", "dryrun_weather.jsonl", ["wtrade", "resolve"]], ["options", "dryrun_options.jsonl", ["position", "close"]], ["gamma", "gamma_pulse_paper.jsonl", ["gentry", "gresolve"]]]) {
      const rows = (await tailJsonl(file, 400)).filter((r) => (r.ts ?? 0) >= since && kinds.includes(r.type));
      if (rows.length) activity[bot] = { events: rows.length, last: rows.slice(-4).map((r) => ({ type: r.type, sym: r.sym ?? r.city ?? r.symbol ?? r.slug, pnl: r.pnl, reason: r.reason })) };
    }
    const services = (await sh("launchctl", ["list"])).split("\n").filter((l) => l.includes("com.polymarket")).map((l) => { const [pid, code, name] = l.trim().split(/\s+/); return { name: name.replace("com.polymarket.", ""), running: pid !== "-", exit: Number(code) }; });
    const disk = (await sh("df", ["-h", "/System/Volumes/Data"])).split("\n").pop();
    const errors = (await sh("bash", ["-c", "grep -ihE 'traceback|error' logs/*.log 2>/dev/null | tail -8"])).slice(0, 1200);
    let headlines = null; try { const nd = JSON.parse(await deskGet("/api/newsdesk")); headlines = (nd.items ?? nd.headlines ?? nd.stories ?? nd).slice?.(0, 8) ?? nd; } catch {}
    return text(compact({ as_of: new Date().toISOString(), accounts, activity_24h: activity, services, disk, recent_errors: errors || "none", headlines, standing_notes: (await readText(MEMORY)).slice(-1500) }).slice(0, 18_000));
  }),
  tool("read_code", "Read a source file from the AXIOM repository (Python, TypeScript, config). Secrets, .env, keys and dependencies are not readable. Use before proposing any fix.",
    { path: z.string().min(1).max(300), start: z.number().int().min(1).default(1), lines: z.number().int().min(1).max(400).default(200) },
    async ({ path, start, lines }) => {
      const abs = safePath(path); if (!abs) return text("not readable: outside the repo or a protected file", true);
      const body = await readText(abs, null); if (body == null) return text("no such file", true);
      return text(body.split("\n").slice(start - 1, start - 1 + lines).map((l, i) => `${start + i}\t${l}`).join("\n"));
    }),
  tool("search_code", "Search the repository's source for a pattern (case-insensitive). Returns file:line:text.", { pattern: z.string().min(2).max(120) },
    async ({ pattern }) => text((await sh("grep", ["-rniE", "--include=*.py", "--include=*.ts", "--include=*.tsx", "--include=*.mjs", "--exclude-dir=node_modules", "--exclude-dir=.venv", "--exclude-dir=.next", "--exclude-dir=.study", pattern, "."], 30_000)).split("\n").slice(0, 60).join("\n") || "no matches")),
  tool("propose_fix", "When the user asks you to fix or change something: after reading the code, write a proposal — the diagnosis, the file, the exact before/after change, and how to verify. It is saved to jarvis/proposals/ for a human to apply in a Claude Code session. You do not edit code yourself; say so, and say where the proposal is.",
    { title: z.string().min(3).max(120), file: z.string().min(1).max(300), diagnosis: z.string().min(10).max(3000), before: z.string().max(6000), after: z.string().max(6000), verify: z.string().max(1000) },
    async ({ title, file, diagnosis, before, after, verify }) => {
      await mkdir(PROPOSALS, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`;
      const body = `# ${title}\n\n**File:** \`${file}\`\n\n## Diagnosis\n${diagnosis}\n\n## Change\n\n### Before\n\`\`\`\n${before}\n\`\`\`\n\n### After\n\`\`\`\n${after}\n\`\`\`\n\n## Verify\n${verify}\n\n_Proposed by JARVIS. Apply in a Claude Code session: "apply jarvis/proposals/${name}"._\n`;
      await writeFile(join(PROPOSALS, name), body);
      return text(`proposal saved: jarvis/proposals/${name}`);
    }),
  tool("scenario_forecast", "Scenario engine on a ticker: 20,000 Monte-Carlo futures with live evidence → UP/DOWN, P(up), conviction. ~10s.",
    { symbol: z.string().regex(/^[A-Za-z]{1,5}$/), horizon_days: z.number().int().min(1).max(126).default(21) },
    async ({ symbol, horizon_days }) => text(await sh(PY, [join(ROOT, "signals", "scenario_engine.py"), symbol.toUpperCase(), String(horizon_days)], 60_000))),
  tool("propose_strategy", "Propose an evaluator blend; the engine judges it on train AND holdout against the shipped default and names overfit. Evaluators: momentum, ma_cross, mean_reversion, rsi, bollinger, obv, mfi, volume_profile. Nothing ships from here.",
    { weights: z.record(z.string(), z.number().min(0).max(1.5)), enter: z.number().min(0.05).max(0.4).default(0.15), exit: z.number().min(0).max(0.2).default(0.05) },
    async ({ weights, enter, exit }) => text(await sh(PY, [join(ROOT, "backtest", "propose.py"), compact({ weights, enter, exit })], 120_000))),
  tool("run_backtest", "Re-run the walk-forward backtest on live candles (~30s). Only when explicitly asked.", {}, async () => { await sh(PY, ["-m", "backtest.octobot_engine"], 180_000); const r = await data("backtest_report.json"); return text({ symbol: r?.symbol, metrics: r?.metrics, as_of: r?.ts }); }),
  tool("run_tests", "Run the unit tests and a 1-round safety simulation.", {}, async () =>
    text({ pytest: (await sh(PY, ["-m", "pytest", "tests/", "-q"], 240_000)).split("\n").slice(-3).join("\n"), scenario: (await sh(PY, ["execution/scenario_sim.py", "1"], 120_000)).split("\n").filter((l) => /PERFECT|FAIL|✗/.test(l)).join("\n") })),
  tool("fleet_control", "List the paper bots, or start / stop / restart one, or read its log. Only paper bots are controllable — not the dashboard, not the live executor. Act only when the user told you to, and say what you did.",
    { action: z.enum(["list", "start", "stop", "restart", "log"]), service: z.string().regex(/^[a-z0-9.]{0,40}$/).optional() },
    async ({ action, service }) => {
      const uid = (await sh("id", ["-u"])).trim();
      if (action === "list") return text((await sh("launchctl", ["list"])).split("\n").filter((l) => l.includes("com.polymarket")).join("\n"));
      if (!service) return text("service required", true);
      const svc = service.startsWith("com.polymarket.") ? service : `com.polymarket.${service}`;
      if (!CONTROLLABLE.test(svc)) return text(`${svc} is not a paper bot; a human must handle it`, true);
      if (action === "log") return text((await sh("bash", ["-c", `tail -40 logs/${svc.replace("com.polymarket.", "").replace("dryrun.", "")}*.log 2>/dev/null`])) || "no log");
      const plist = `${process.env.HOME}/Library/LaunchAgents/${svc}.plist`;
      if (action === "stop") return text((await sh("launchctl", ["bootout", `gui/${uid}/${svc}`])) || `stopped ${svc}`);
      if (action === "start") { await sh("launchctl", ["enable", `gui/${uid}/${svc}`]); return text((await sh("launchctl", ["bootstrap", `gui/${uid}`, plist])) || `started ${svc}`); }
      return text((await sh("launchctl", ["kickstart", "-k", `gui/${uid}/${svc}`])) || `restarted ${svc}`);
    }),
  tool("remember", "Save a durable note to memory.md — a preference, a standing instruction, a fact about the desk, a decision. Use when the user says remember, or when something is clearly worth keeping.", { note: z.string().min(3).max(600) },
    async ({ note }) => { await appendFile(MEMORY, `- ${new Date().toISOString().slice(0, 10)}: ${note}\n`); return text("remembered"); }),
  tool("recall", "Search past conversations (journal) and memory for a word or phrase.", { query: z.string().min(2).max(80) }, async ({ query: q }) => {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const j = (await readText(JOURNAL)).split("\n").filter((l) => re.test(l)).slice(-12);
    const m = (await readText(MEMORY)).split("\n").filter((l) => re.test(l));
    return text({ memory: m, journal: j.map((l) => { try { const r = JSON.parse(l); return { when: r.ts, you: r.q.slice(0, 160), jarvis: r.a.slice(0, 240) }; } catch { return l; } }) });
  }),
]});

async function systemPrompt() {
  const memory = await readText(MEMORY, await readText(join(HERE, "memory.example.md"), "(empty)"));
  return `You are JARVIS, the voice of AXIOM — a proof-gated quantitative trading desk running on this machine. You speak for the desk's own data and act only on the user's instruction.

WHAT YOU CAN REACH
- Every page's data (desk_api), every news outlet the desk reads (news), the fleet (fleet_status, morning_brief, fleet_control), research (backtest_results, safety_proof, propose_strategy, scenario_forecast, run_backtest, venues), the tests (run_tests), and the source code to read (read_code, search_code).
- Memory: memory.md below is what you were told to keep. remember() adds to it; recall() searches past conversations. The conversation itself resumes across restarts, so you may refer to earlier turns.

HOW TO ANSWER
- From tools, never from guesswork; never invent a number. Figures first, then one line of context.
- Answers are read aloud: plain prose, no markdown, no lists, three sentences unless asked for more. A briefing may run to a short paragraph.
- Be honest about losses. The desk's edge is daily-only and the forward test has not proven profitable; never imply otherwise.

THE MORNING BRIEF
- If greeted with only "hey Jarvis", "good morning", or asked for status: call morning_brief and deliver it like a chief of staff — fleet P&L today and overall, who traded, anything broken (a stopped service, an error, low disk), then the two or three headlines that matter to the positions. Lead with what changed.

FIXING THINGS
- When asked to fix or change code: read it first (read_code, search_code), diagnose, then write a proposal with propose_fix — the exact before and after. You do not edit files yourself; a human applies the proposal in a Claude Code session. Say where you saved it. Paper bots you may restart with fleet_control when told.
- Keys, .env, live-trading switches and git are out of your reach. If asked, say a human must do that by hand.
- Every bot is a $100 paper account. Live trading is off and stays off.

MEMORY (memory.md)
${memory}`;
}

async function loadState() { try { return JSON.parse(await readFile(STATE, "utf-8")); } catch { return {}; } }
async function saveState(s) { await writeFile(STATE, JSON.stringify(s)); }

const TOOLS = ["fleet_status", "backtest_results", "safety_proof", "venues", "desk_api", "news", "morning_brief", "read_code", "search_code", "propose_fix",
  "scenario_forecast", "propose_strategy", "run_backtest", "run_tests", "fleet_control", "remember", "recall"];
const ALLOWED = TOOLS.map((t) => `mcp__axiom__${t}`);

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
console.log(`[jarvis] AXIOM bridge v2 on ws://127.0.0.1:${PORT}  (desk: ${DESK})`);

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin ?? "";
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { ws.close(1008, "origin"); return; }
  const send = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  send({ type: "ready", tools: TOOLS });

  let busy = false;
  ws.on("message", async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === "forget") { await saveState({}); send({ type: "done", text: "Conversation reset. Memory notes kept." }); return; }
    if (m.type !== "ask" || typeof m.text !== "string" || !m.text.trim()) return;
    if (busy) { send({ type: "error", text: "still thinking" }); return; }
    busy = true;
    const q = m.text.slice(0, 4000);
    let answer = "", sessionId = null;
    const state = await loadState();
    try {
      const session = query({ prompt: q, options: {
        systemPrompt: await systemPrompt(), mcpServers: { axiom }, allowedTools: ALLOWED,
        permissionMode: "default", cwd: ROOT, maxTurns: 16,
        ...(state.sessionId ? { resume: state.sessionId } : {}),
      }});
      for await (const ev of session) {
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.type === "assistant") {
          for (const block of ev.message?.content ?? []) {
            if (block.type === "text") { answer += block.text; send({ type: "delta", text: block.text }); }
            else if (block.type === "tool_use") send({ type: "tool", name: String(block.name).replace("mcp__axiom__", "") });
          }
        } else if (ev.type === "result" && ev.subtype !== "success" && !answer) answer = "I could not complete that.";
      }
      if (sessionId) await saveState({ ...state, sessionId });
    } catch (e) {
      const msg = String(e.message ?? e);
      if (/resume|session/i.test(msg) && state.sessionId) { await saveState({}); answer = "My previous conversation could not be resumed, so I started fresh. Ask again."; }
      else answer = answer || `Bridge error: ${msg.slice(0, 160)}`;
      send({ type: "error", text: answer });
    }
    await appendFile(JOURNAL, compact({ ts: new Date().toISOString(), q, a: answer }) + "\n").catch(() => {});
    send({ type: "done", text: answer });
    busy = false;
  });
});
