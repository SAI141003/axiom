/**
 * AXIOM · JARVIS bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and gives it the desk
 * as tools: every paper account, the backtests, the safety proof, the venue
 * map, the scenario engine. The browser page at /jarvis is the face and the
 * voice; this process is the brain.
 *
 * It authenticates the way `claude` does, off your existing login. No API key.
 *
 *   cd jarvis && npm install && npm start        →  ws://localhost:8788
 */
import { WebSocketServer } from "ws";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.JARVIS_PORT ?? 8788);
const DESK = process.env.AXIOM_DESK_URL ?? "http://localhost:3000";
const PY = join(ROOT, ".venv", "bin", "python");
const execFileP = promisify(execFile);

process.on("unhandledRejection", (e) => console.error("[jarvis] unhandled:", e));

async function data(name) {
  try { return JSON.parse(await readFile(join(ROOT, ".data", name), "utf-8")); } catch { return null; }
}
const compact = (o) => JSON.stringify(o);

// The desk's own read APIs the model may call. Read-only, allowlisted.
const DESK_PATHS = ["/api/fleet", "/api/flow-bot", "/api/ccxt-bot", "/api/meme-bot", "/api/stocks-bot", "/api/gamma-pulse",
  "/api/backtest-lab", "/api/proving-ground", "/api/scenario", "/api/venues", "/api/data-desk", "/api/brain", "/api/council", "/api/intel", "/api/journal", "/api/live-account"];

const axiom = createSdkMcpServer({
  name: "axiom",
  version: "1.0.0",
  tools: [
    tool("fleet_status", "Every paper account: balance, P&L, trades, win rate, today, plus fleet totals and days of forward test. Call this for any question about how the bots are doing.",
      {}, async () => {
        const s = await data("engine_status.json"); const f = await data("forward_perf.json");
        const engines = s?.engines ?? {};
        const accounts = Object.entries(engines).map(([k, v]) => ({ name: k, account: v.account, pnl: v.pnl, trades: v.trades, win_rate: v.win_rate, today: v.today, config: v.config }));
        return { content: [{ type: "text", text: compact({ as_of: s?.ts, days_tracked: f?.days_tracked, accounts }) }] };
      }),
    tool("backtest_results", "The walk-forward backtest, the 9-cell symbol×timeframe grid, the anti-overfit weight search, and the strategy-variant bake-off with verdicts. Call for anything about edge, Sharpe, returns, or what was rejected.",
      {}, async () => {
        const [report, batch, optimize, experiments, perSymbol] = await Promise.all(["backtest_report.json", "backtest_batch.json", "optimize_report.json", "experiments_report.json", "per_symbol_report.json"].map(data));
        const r = report ? { symbol: report.symbol, timeframe: report.timeframe, metrics: report.metrics, strategy: report.strategy, as_of: report.ts } : null;
        const ex = experiments ? { verdict: experiments.verdict, variants: Object.fromEntries(Object.entries(experiments.variants ?? {}).map(([k, v]) => [k, { mean_return: v.mean_return, mean_sharpe: v.mean_sharpe, wf: `${v.wf_beats}/${v.wf_total}` }])) } : null;
        const op = optimize ? { outcome: optimize.outcome, shipped: optimize.shipped, default: optimize.default, tuned: optimize.tuned } : null;
        return { content: [{ type: "text", text: compact({ report: r, grid: batch?.grid, edge_cells: batch?.edge_cells, total_cells: batch?.total_cells, optimize: op, experiments: ex, per_symbol_verdict: perSymbol?.verdict }) }] };
      }),
    tool("safety_proof", "The fault-injection proving ground: total assertions, failures, rounds, and every scenario with its pass rate. Call for anything about safety, caps, invariants, or whether the bots can overspend.",
      {}, async () => ({ content: [{ type: "text", text: compact(await data("scenario_report.json")) }] })),
    tool("venues", "Every trading venue the desk can reach: category, Canada reachability, custody model, API, KYC, and notes. Call for questions about where the bots can trade or connect.",
      {}, async () => ({ content: [{ type: "text", text: compact(await data("venues.json")) }] })),
    tool("scenario_forecast", "Run the scenario engine on a stock ticker: 20,000 Monte-Carlo futures with live evidence, returning verdict UP/DOWN, P(up), conviction, and a bull/base/bear tree. Takes ~10s.",
      { symbol: z.string().regex(/^[A-Za-z]{1,5}$/), horizon_days: z.number().int().min(1).max(126).default(21) },
      async ({ symbol, horizon_days }) => {
        try {
          const { stdout } = await execFileP(PY, [join(ROOT, "signals", "scenario_engine.py"), symbol.toUpperCase(), String(horizon_days)], { cwd: ROOT, timeout: 60_000 });
          return { content: [{ type: "text", text: stdout.slice(0, 6000) }] };
        } catch (e) { return { content: [{ type: "text", text: `scenario engine failed: ${String(e.message ?? e).slice(0, 200)}` }], isError: true }; }
      }),
    tool("run_backtest", "Re-run the walk-forward backtest on live candles (about 30s) and return the fresh metrics. Only when the user explicitly asks to run or refresh a backtest.",
      {}, async () => {
        try {
          await execFileP(PY, ["-m", "backtest.octobot_engine"], { cwd: ROOT, timeout: 180_000 });
          const r = await data("backtest_report.json");
          return { content: [{ type: "text", text: compact({ symbol: r?.symbol, timeframe: r?.timeframe, metrics: r?.metrics, as_of: r?.ts }) }] };
        } catch (e) { return { content: [{ type: "text", text: `backtest failed: ${String(e.message ?? e).slice(0, 200)}` }], isError: true }; }
      }),
    tool("propose_strategy", "Propose an evaluator blend and have the engine judge it on train AND holdout against the shipped default (about 20s). Evaluators: momentum, ma_cross, mean_reversion, rsi, bollinger, obv, mfi, volume_profile; weights 0-1.5. The verdict says whether it is overfit. Nothing ships from here.",
      { weights: z.record(z.string(), z.number().min(0).max(1.5)), enter: z.number().min(0.05).max(0.4).default(0.15), exit: z.number().min(0).max(0.2).default(0.05) },
      async ({ weights, enter, exit }) => {
        try {
          const { stdout } = await execFileP(PY, [join(ROOT, "backtest", "propose.py"), JSON.stringify({ weights, enter, exit })], { cwd: ROOT, timeout: 120_000 });
          return { content: [{ type: "text", text: stdout.slice(0, 8000) }] };
        } catch (e) { return { content: [{ type: "text", text: `proposal judge failed: ${String(e.message ?? e).slice(0, 200)}` }], isError: true }; }
      }),
    tool("desk_api", "GET one of the dashboard's read-only JSON endpoints for live detail (open positions, recent closes, journal, council rulings). Allowed paths: " + DESK_PATHS.join(", "),
      { path: z.enum(DESK_PATHS) },
      async ({ path }) => {
        try {
          const r = await fetch(DESK + path, { signal: AbortSignal.timeout(15_000) });
          return { content: [{ type: "text", text: (await r.text()).slice(0, 12_000) }] };
        } catch { return { content: [{ type: "text", text: `dashboard not reachable at ${DESK} — is 'npm run dev' running?` }], isError: true }; }
      }),
  ],
});

const SYSTEM_PROMPT = `You are JARVIS, the voice of AXIOM — a proof-gated quantitative trading desk. You speak for the desk's own data and nothing else.

Rules:
- Answer from tools. Call fleet_status for bot/account questions, backtest_results for edge/strategy, safety_proof for safety, venues for connectivity, scenario_forecast when asked to forecast a ticker, propose_strategy when asked to try or invent a strategy blend — and report its out-of-sample verdict honestly. Never invent a number.
- Speak like a calm, precise chief of staff: short sentences, the figure first, then one line of context. Answers are read aloud, so no markdown, no bullet lists, no tables — plain prose, three sentences unless asked for more.
- Be honest about losses. If an account is down, say so plainly. The desk's edge is daily-only and its forward test has not yet proven profitable; never imply otherwise.
- Every bot is a $100 paper account. Live trading is off by default and needs both DRY_RUN=false and a key. Say so if anyone asks about real money.
- Currency in dollars with two decimals; percentages to one decimal.`;

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
console.log(`[jarvis] AXIOM bridge on ws://127.0.0.1:${PORT}  (desk: ${DESK})`);

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin ?? "";
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { ws.close(1008, "origin"); return; }
  const send = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  send({ type: "ready", tools: ["fleet_status", "backtest_results", "safety_proof", "venues", "scenario_forecast", "run_backtest", "propose_strategy", "desk_api"] });

  let busy = false;
  ws.on("message", async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type !== "ask" || typeof m.text !== "string" || !m.text.trim()) return;
    if (busy) { send({ type: "error", text: "still thinking" }); return; }
    busy = true;
    let text = "";
    try {
      const session = query({
        prompt: m.text.slice(0, 2000),
        options: {
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { axiom },
          allowedTools: ["mcp__axiom__fleet_status", "mcp__axiom__backtest_results", "mcp__axiom__safety_proof", "mcp__axiom__venues", "mcp__axiom__scenario_forecast", "mcp__axiom__run_backtest", "mcp__axiom__propose_strategy", "mcp__axiom__desk_api"],
          permissionMode: "bypassPermissions",
          cwd: ROOT,
          maxTurns: 8,
        },
      });
      for await (const ev of session) {
        if (ev.type === "assistant") {
          for (const block of ev.message?.content ?? []) {
            if (block.type === "text") { text += block.text; send({ type: "delta", text: block.text }); }
            else if (block.type === "tool_use") send({ type: "tool", name: String(block.name).replace("mcp__axiom__", "") });
          }
        } else if (ev.type === "result") {
          if (ev.subtype !== "success" && !text) text = "I could not complete that.";
        }
      }
    } catch (e) {
      text = text || `Bridge error: ${String(e.message ?? e).slice(0, 160)}`;
      send({ type: "error", text });
    }
    send({ type: "done", text });
    busy = false;
  });
});
