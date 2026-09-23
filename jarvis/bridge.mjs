/**
 * AXIOM · AXIOM bridge (v2).
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
import { record as recordUsage, recordLimit, avoid as avoidLanes, ledger as usageLedger, focus as powerFocus, setFocus as setPowerFocus, orderLanes, FOCI } from "./usage.mjs";
import { WebSocketServer } from "ws";
import { query, createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ── Two brains, one set of tools ──────────────────────────────────────────────
// JARVIS_BRAIN=platform (default): our own tool-calling loop on the AI already
// wired to the desk -- Groq (gpt-oss-120b), then NVIDIA NIM, then OpenAI if a
// key exists. No dependence on Claude Code. JARVIS_BRAIN=claude keeps the
// Claude Agent SDK loop as an option. Every tool below is registered once and
// served to whichever brain is running.
const REGISTRY = [];
const tool = (name, description, shape, handler) => {
  const schema = z.object(shape);
  REGISTRY.push({ name, description, schema, handler });
  return sdkTool(name, description, shape, handler);
};
import { readFile, writeFile, appendFile, mkdir, open, readdir } from "node:fs/promises";
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
const NOTES = join(HERE, "notes");
const SKILLS = join(ROOT, ".data", "skills");
const A402 = process.env.AGENT402_URL || "http://127.0.0.1:3402";   // the self-hosted toolbox
const ACTIONS = join(ROOT, ".data", "actions.jsonl");
async function audit(kind, args, result) { try { await mkdir(dirname(ACTIONS), { recursive: true }); await appendFile(ACTIONS, JSON.stringify({ ts: Date.now(), kind, args, result: String(result).slice(0, 300) }) + "\n"); } catch {} }
async function envFile() { try { return Object.fromEntries((await readFile(join(ROOT, ".env"), "utf-8")).split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })); } catch { return {}; } }
const PERSONA = join(HERE, "persona.md");
const DESK_STATE = join(HERE, "desk_state.md");
// Optional second brain. GPT-6 Astra (OpenAI, Sept 2026) or any OpenAI-compatible model:
// set OPENAI_API_KEY (and OPENAI_MODEL, default gpt-6-astra) in .env. Loaded here so the
// key never enters the browser or the prompt.
async function dotenv() { const out = {}; for (const l of (await readText(join(ROOT, ".env"))).split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/); if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return out; }

// ── Research: the free corners of the internet, read directly ────────────────
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
async function get(url, ms = 20_000) { const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": "Mozilla/5.0 (AXIOM AXIOM research)" } }); return r.text(); }
async function arxiv(q, max) {
  const xml = await get(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=${max}&sortBy=relevance`);
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => { const e = m[1]; const f = (t) => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)) || [])[1]?.replace(/\s+/g, " ").trim();
    return { title: f("title"), published: f("published")?.slice(0, 10), authors: [...e.matchAll(/<name>(.*?)<\/name>/g)].map((a) => a[1]).slice(0, 4).join(", "), url: f("id"), abstract: (f("summary") || "").slice(0, 700) }; });
}
async function semanticScholar(q, max) {
  const j = JSON.parse(await get(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${max}&fields=title,year,citationCount,abstract,url,authors,venue`));
  return (j.data ?? []).map((p) => ({ title: p.title, year: p.year, venue: p.venue, citations: p.citationCount, authors: (p.authors ?? []).slice(0, 4).map((a) => a.name).join(", "), url: p.url, abstract: (p.abstract ?? "").slice(0, 600) }));
}
async function webSearch(q, max) {
  const html = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  return [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, max)
    .map((m) => { let u = m[1]; const dd = u.match(/uddg=([^&]+)/); if (dd) u = decodeURIComponent(dd[1]); return { title: strip(m[2]), url: u, snippet: strip(m[3]).slice(0, 240) }; });
}
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

// ── The pages AXIOM can open by voice, each with the endpoint that feeds it ──
const PAGES = [
  ["/", "home", "the desk at a glance", "/api/fleet"], ["/mind", "jarvis", "the assistant", null], ["/terminal", "terminal", "order book, signal feed, kill switch", "/api/markets"],
  ["/mind", "brain mind reflection", "the mind: reflection loop, feeds, swarm", "/api/brain"], ["/council", "council", "eight role agents debate and rule", "/api/council/review/latest"],
  ["/workforce", "workforce", "the agent roster", "/api/workforce"], ["/connectome", "connectome wiring", "the desk's nervous system read from the code", "/api/connectome"], ["/bots", "bots fleet", "every paper account on one screen", "/api/fleet"],
  ["/bots?tab=create", "create a bot", "the Bot OS", "/api/botos"], ["/crypto", "crypto auto-bot", "5-minute crypto engine", "/api/crypto/trades"],
  ["/weather", "weather", "station observations vs market buckets", "/api/weather/picks"], ["/premarket", "pre-market", "first-20-minute stock picks", "/api/premarket"],
  ["/options", "options", "chains, vol, Kelly-sized recommendations", "/api/options"], ["/stocks", "stocks", "sizing and factor view", "/api/stocks"],
  ["/arbitrage", "arbitrage arb", "neg-risk and cross-venue arbitrage", "/api/arb"], ["/live", "markets", "live market list", "/api/markets"],
  ["/tape", "tape replay", "the flow bot replayed frame by frame", "/api/tape"], ["/lab", "lab research", "backtests, proving ground, scenarios, benchmarks", "/api/backtest-lab"],
  ["/lab?tab=proving", "proving ground safety", "the fault-injection proof", "/api/proving-ground"], ["/lab?tab=scenario", "scenario", "scenario forecasts", "/api/scenario"],
  ["/ai", "ai desk", "stock analyst, market intel, risk engine, macro, alpha hunter", null], ["/oracle", "oracle", "the oracle-lag probe", "/api/oracle"],
  ["/intel", "intel", "news read by the classifier", "/api/intel"], ["/news", "news", "live wall, live summary, the world wire", "/api/world/summary"],
  ["/world", "the eye, globe, world map", "The Eye: the live globe — flights, military, satellites, quakes, launches, radio, cables, the weather book, the exchanges", "/api/eye/layers"], ["/journal", "journal", "every trade, every lesson", "/api/journal"],
  ["/live-account", "account", "balance, caps, the go-live gate", "/api/live/balance"], ["/venues", "venues", "where a bot can trade from here", "/api/venues"],
  ["/settings", "keys settings", "API keys and bot switches", null], ["/about", "about sources", "every source, paper, repo and feed", null],
];
const PAGE_HREFS = PAGES.map((p) => p[0]);

// ── Every page's data. Read-only; the routes that act are not listed. ─────────
const DESK_PATHS = ["/api/agents", "/api/ai", "/api/arb", "/api/backtest-lab", "/api/benchmark", "/api/benchmark/industry", "/api/benchmark/kronos",
  "/api/benchmark/market", "/api/benchmark/vol", "/api/bots", "/api/brain", "/api/broker/status", "/api/ccxt-bot", "/api/council", "/api/council/review/latest",
  "/api/council/tuner", "/api/crypto/trades", "/api/crypto/window", "/api/data-desk", "/api/deepchain", "/api/fleet", "/api/flow-bot", "/api/gamma-pulse",
  "/api/intel", "/api/journal", "/api/kalshi", "/api/learned", "/api/live/balance", "/api/markets", "/api/meme-bot", "/api/newsdesk",
  "/api/options", "/api/oracle", "/api/oracle/track", "/api/premarket", "/api/proving-ground", "/api/quotes", "/api/recall", "/api/scenario",
  "/api/stocks", "/api/stocks-bot", "/api/tape", "/api/valuation", "/api/venues", "/api/weather", "/api/weather-trades", "/api/weather/picks", "/api/workforce", "/api/world", "/api/world/summary", "/api/botos", "/api/ai/health", "/api/jev"];

// Files AXIOM may read: source only, inside the repo, never secrets.
const UNREADABLE = /(^|\/)\.env|\.key$|\.pem$|id_rsa|(^|\/)\.claude\/|(^|\/)\.git\/|(^|\/)node_modules\/|(^|\/)\.venv\//;
function safePath(p) {
  const abs = isAbsolute(p) ? p : join(ROOT, p);
  if (relative(ROOT, abs).startsWith("..") || UNREADABLE.test(abs)) return null;
  return abs;
}

// Paper bots AXIOM may start, stop or restart. The dashboard and the live
// executor are not on the list.
// Every service of the desk answers to AXIOM except the live CLOB executor (com.polymarket.bot), which stays behind its two human switches.
const CONTROLLABLE = /^com\.polymarket\.(?!bot$)[a-z0-9.]+$/;

let uiSend = (m) => {};   // the open socket's sender, set per turn, so navigate can reach the browser

const axiom = createSdkMcpServer({ name: "axiom", version: "2.0.0", tools: [
  tool("navigate", "Open a page of the desk in the user's browser. Use when asked to open, show, go to, or take me to a screen. Pick the href from this list by meaning: " + PAGES.map((p) => `${p[0]} (${p[1]}: ${p[2]})`).join("; ") + ". After navigating, fetch that page's live data with desk_api (the endpoint is returned) and describe what is on the screen now in three sentences, figures first.",
    { href: z.enum(PAGE_HREFS) }, async ({ href }) => {
      const p = PAGES.find((x) => x[0] === href);
      uiSend({ type: "ui", op: "navigate", href });
      return text({ opened: href, page: p?.[1], about: p?.[2], live_data_endpoint: p?.[3] ?? "none — describe the page from its purpose", next: "call desk_api on the endpoint, then narrate" });
    }),
  tool("fleet_status", "Every paper account: balance, P&L, trades, win rate, today, config; fleet totals; days of forward test.", {}, async () => {
    const s = await data("engine_status.json"); const f = await data("forward_perf.json"); const e = s?.engines ?? {};
    // The pause rule is computed here, not judged by the model: a book is
    // pausable only with 30+ trades, its last three trading days all losing,
    // and a win rate under 50%. Fresh v2 books and retired books are never pausable.
    const verdict = (k, v) => { const d = (v.daily ?? []).slice(-3); const fresh = (v.trades ?? 0) < 30, retired = /retired/.test(k), bleeding = d.length === 3 && d.every((x) => x.pnl < 0), weak = (v.win_rate ?? 1) < 0.5, weather = /weather/.test(k);
      return { pausable: !fresh && !retired && !weather && bleeding && weak, why: retired ? "retired, history only" : weather ? "the proven earner, never paused" : fresh ? `only ${v.trades} trades — too young to judge` : !bleeding ? `last 3 days not all losing (${d.map((x) => x.pnl).join(", ")})` : !weak ? `win rate ${v.win_rate} is not under 0.5` : `bleeding 3 days at ${v.win_rate} win rate` }; };
    return text({ as_of: s?.ts, days_tracked: f?.days_tracked, accounts: Object.entries(e).map(([k, v]) => ({ name: k, account: v.account, pnl: v.pnl, trades: v.trades, win_rate: v.win_rate, today: v.today, last_days: (v.daily ?? []).slice(-3), config: v.config, ...verdict(k, v) })) });
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
      for (const c of ["crypto", "markets"]) { try { const w = JSON.parse(await deskGet(`/api/world?cat=${c}`)); out[`wire_${c}`] = (w.items ?? []).slice(0, 10).map((x) => `${x.title} — ${x.source}`); } catch {} }
      try { const nd = JSON.parse(await deskGet("/api/newsdesk")); out.newsdesk_cards = (nd.cards ?? []).slice(0, 8).map((c) => ({ sym: c.sym, title: c.title, direction: c.direction, magnitude: c.magnitude, publisher: c.publisher })); } catch { out.newsdesk_cards = "unavailable"; }
      try { out.intel = JSON.parse(await deskGet("/api/intel")); } catch {}
      if (q) {
        try {
          const xml = await (await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { signal: AbortSignal.timeout(15_000) })).text();
          out.search = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<pubDate>(.*?)<\/pubDate>/g)].slice(0, 12).map((m) => ({ title: m[1].replace(/<!\[CDATA\[|\]\]>/g, ""), when: m[2] }));
        } catch { out.search = "search failed"; }
      }
      return text(compact(out).slice(0, 16_000));
    }),
  tool("morning_brief", "Everything that happened on the desk since yesterday, in one call: fleet P&L today and overall, which bots traded, weather resolutions, service health, disk, errors in logs, top headlines, standing notes. Call this when asked for status or a briefing, or when greeted with just 'hey Axiom'.", {}, async () => {
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
    let study = null;
    try { const { readdir } = await import("node:fs/promises"); const fs = (await readdir(NOTES)).filter((x) => x.endsWith(".md")).sort(); if (fs.length) study = { file: fs[fs.length - 1], excerpt: (await readText(join(NOTES, fs[fs.length - 1]))).slice(0, 1600) }; } catch {}
    return text(compact({ as_of: new Date().toISOString(), accounts, activity_24h: activity, services, disk, recent_errors: errors || "none", headlines, last_night_study: study, standing_notes: (await readText(MEMORY)).slice(-1500) }).slice(0, 20_000));
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
      const body = `# ${title}\n\n**File:** \`${file}\`\n\n## Diagnosis\n${diagnosis}\n\n## Change\n\n### Before\n\`\`\`\n${before}\n\`\`\`\n\n### After\n\`\`\`\n${after}\n\`\`\`\n\n## Verify\n${verify}\n\n_Proposed by AXIOM. Apply in a Claude Code session: "apply jarvis/proposals/${name}"._\n`;
      await writeFile(join(PROPOSALS, name), body);
      return text(`proposal saved: jarvis/proposals/${name}`);
    }),
  tool("arxiv_search", "Search arXiv (free, no key) for papers. Returns title, authors, date, abstract, link. Use when asked to research, read papers, or find what the literature says about a problem on the desk.",
    { query: z.string().min(3).max(200), max: z.number().int().min(1).max(15).default(8) }, async ({ query: q, max }) => { try { return text(await arxiv(q, max)); } catch (e) { return text(`arxiv failed: ${String(e.message).slice(0, 120)}`, true); } }),
  tool("scholar_search", "Search Semantic Scholar (free, no key) — peer-reviewed papers with citation counts, all fields. Best for finding the canonical paper on a method.",
    { query: z.string().min(3).max(200), max: z.number().int().min(1).max(15).default(8) }, async ({ query: q, max }) => { try { return text(await semanticScholar(q, max)); } catch (e) { return text(`scholar failed: ${String(e.message).slice(0, 120)}`, true); } }),
  tool("web_search", "General web search (DuckDuckGo, free). Titles, links, snippets. Follow up with read_url on anything worth reading.",
    { query: z.string().min(2).max(200), max: z.number().int().min(1).max(12).default(8) }, async ({ query: q, max }) => { try { return text(await webSearch(q, max)); } catch (e) { return text(`search failed: ${String(e.message).slice(0, 120)}`, true); } }),
  tool("read_url", "Read a web page or a PDF as plain text (up to ~16k chars). PDFs (arxiv.org/pdf/…, .pdf links) are extracted properly. Quote what you read; never summarise a page you did not open.",
    { url: z.string().url().max(500) }, async ({ url }) => {
      if (!/^https?:\/\//.test(url) || /localhost|127\.0\.0\.1|\.local\b|^https?:\/\/10\.|^https?:\/\/192\.168\./.test(url)) return text("that address is not readable", true);
      try {
        const isPdf = /\.pdf($|\?)/i.test(url) || /arxiv\.org\/pdf\//.test(url);
        if (isPdf) return text(await sh(PY, [join(HERE, "read_pdf.py"), url, "16000"], 60_000));
        const t = strip(await get(url, 25_000)); return text(t.slice(0, 14_000) || "(empty page)");
      } catch (e) { return text(`could not read: ${String(e.message).slice(0, 120)}`, true); } }),
  tool("write_note", "Save a research note to jarvis/notes/ — findings with citations (title, authors, URL), what it means for the desk, and a concrete next step. Use after reading; notes are searchable with recall.",
    { title: z.string().min(3).max(120), body: z.string().min(40).max(12_000) }, async ({ title, body }) => {
      await mkdir(NOTES, { recursive: true });
      const name = `${new Date().toISOString().slice(0, 10)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50)}.md`;
      await writeFile(join(NOTES, name), `# ${title}\n\n_${new Date().toISOString()}_\n\n${body}\n`); return text(`note saved: jarvis/notes/${name}`); }),
  tool("second_opinion", "Ask the optional second brain (GPT-6 Astra via the OpenAI API, if OPENAI_API_KEY is set in .env) one self-contained question and get its answer verbatim. Use for a cross-check on a hard judgement, never as a source of desk numbers — those come from the desk's own tools. Says so if not configured.",
    { question: z.string().min(5).max(6000) }, async ({ question }) => {
      const env = await dotenv();
      // Deep bench, in order of preference: Meta Muse Spark, GPT-6 Astra, Nemotron 550B.
      const deep = env.META_API_KEY ? { base: env.META_API_BASE || "https://api.meta.com/v1", key: env.META_API_KEY, model: env.META_MODEL || "muse-spark-1.1" }
        : env.OPENAI_API_KEY ? { base: "https://api.openai.com/v1", key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || "gpt-6-astra" }
        : { base: "https://integrate.api.nvidia.com/v1", key: env.NVIDIA_API_KEY_JARVIS || env.NVIDIA_API_KEY, model: env.NVIDIA_MODEL_JARVIS_DEEP || "nvidia/nemotron-3-ultra-550b-a55b" };
      const { key, model } = deep;
      if (!key) return text("second brain not configured: add META_API_KEY, OPENAI_API_KEY or an NVIDIA key to .env", true);
      try {
        const r = await fetch(`${deep.base}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(180_000),
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: "system", content: "You are a careful quantitative-finance reviewer. Be concrete and brief. Do not invent numbers." }, { role: "user", content: question }] }) });
        const j = await r.json();
        if (!r.ok) { if (r.status === 429) await recordLimit(deep.name ?? "nvidia", model, j.error?.message ?? ""); return text(`second brain error (${model}): ${JSON.stringify(j.error ?? j).slice(0, 300)}`, true); }
        await recordUsage(deep.name ?? "nvidia", model, j.usage, "ok", question.length / 4);
        return text({ model, answer: j.choices?.[0]?.message?.content ?? "" });
      } catch (e) { return text(`second brain unreachable: ${String(e.message).slice(0, 120)}`, true); } }),
  tool("update_desk_state", "Rewrite jarvis/desk_state.md: a DENSE, compact symbolic state of the desk — the facts you would otherwise re-derive every time. One line per item: bot → book, P&L, win rate, status; open problems; standing decisions; what last night's study found; pending proposals. Under 60 lines. Do this at the end of every briefing and every study, and whenever a fact changes. Replace the whole file; do not append.",
    { state: z.string().min(20).max(8000) }, async ({ state }) => { await writeFile(DESK_STATE, `# Desk state — ${new Date().toISOString()}\n\n${state}\n`); return text("desk state updated"); }),
  tool("set_power", "Reallocate the desk's AI power. focus=axiom reserves the fast free lane (Groq) for you and moves the dashboard to NIM; research sends your long unattended work to NIM's big context and leaves Groq to the screens; dashboard gives the screens the fast lane; swarm keeps NIM clear for the 72 MiroFish personas; balanced is the default. Takes effect on the next call, everywhere. Use when Sai says 'reallocate', 'all power to', 'divert', 'focus on'.",
    { focus: z.enum(["balanced", "axiom", "research", "dashboard", "swarm"]), why: z.string().max(120).optional() }, async ({ focus, why }) => { const r = await setPowerFocus(focus, why ?? ""); await audit("set_power", { focus, why }, r.means); return text(r); }),
  tool("power_status", "Where the AI power is allocated right now and what each lane has spent: tokens today per provider/model, learned limits, cooldowns, lanes being skipped.", {}, async () => text({ power: await powerFocus(), ...(await usageLedger()) })),
  tool("health_check", "Probe every external feed and service the desk depends on, right now: exchange data, Polymarket, weather, meme feeds, news, research APIs, the bridge's own services. Returns ok/degraded/down per item with latency and a one-line reason. Run this in the morning brief when asked 'is everything working', and in the weekly freshness study.", {}, async () => {
    const probes = [
      ["Kraken OHLCV (CCXT)", "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440", (t) => t.includes('"error":[]')],
      ["Polymarket Gamma", "https://gamma-api.polymarket.com/events?limit=1&active=true", (t) => t.startsWith("[")],
      ["Polymarket CLOB", "https://clob.polymarket.com/time", (t) => /^\d+/.test(t)],
      ["Kalshi", "https://api.elections.kalshi.com/trade-api/v2/markets?limit=1", (t) => t.includes("markets")],
      ["Binance", "https://api.binance.com/api/v3/ping", (t) => t.trim() === "{}"],
      ["Open-Meteo ensemble", "https://ensemble-api.open-meteo.com/v1/ensemble?latitude=52.3&longitude=4.8&daily=temperature_2m_max&models=icon_seamless&forecast_days=1", (t) => t.includes("temperature_2m_max")],
      ["aviationweather METAR", "https://aviationweather.gov/api/data/metar?ids=EHAM&format=json", (t) => t.includes("EHAM")],
      ["CoinGecko", "https://api.coingecko.com/api/v3/ping", (t) => t.includes("gecko_says")],
      ["DexScreener", "https://api.dexscreener.com/token-boosts/top/v1", (t) => t.startsWith("[")],
      ["Yahoo Finance", "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=1d&interval=1d", (t) => t.includes('"chart"')],
      ["Google News RSS", "https://news.google.com/rss/search?q=bitcoin&hl=en-US&gl=US&ceid=US:en", (t) => t.includes("<item>")],
      ["arXiv API", "https://export.arxiv.org/api/query?search_query=all:momentum&max_results=1", (t) => t.includes("<entry>")],
      ["Semantic Scholar", "https://api.semanticscholar.org/graph/v1/paper/search?query=momentum&limit=1&fields=title", (t) => t.includes('"data"')],
      ["DuckDuckGo search", "https://html.duckduckgo.com/html/?q=arc+agi", (t) => t.includes("result__a")],
      ["YouTube live embed", "https://www.youtube.com/embed/live_stream?channel=UCIALMKvObZNtJ6AmdCLP7Lg", (t) => t.includes("<html")],
      ["Dashboard", `${DESK}/api/fleet`, (t) => t.includes('"accounts"')],
      ["AI health (every model, cached 10 min)", `${DESK}/api/ai/health`, (t) => /"brainReady":true/.test(t)],
    ];
    const out = await Promise.all(probes.map(async ([name, url, ok]) => { const t0 = Date.now(); try { const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Mozilla/5.0 (AXIOM health)" } }); const t = await r.text(); return { name, status: r.ok && ok(t) ? "ok" : "degraded", http: r.status, ms: Date.now() - t0 }; } catch (e) { return { name, status: "down", ms: Date.now() - t0, reason: String(e.message).slice(0, 80) }; } }));
    let pump = "unknown"; try { const WSc = (await import("ws")).default; pump = await new Promise((res) => { const w = new WSc("wss://pumpportal.fun/api/data"); const t = setTimeout(() => { w.terminate(); res("down"); }, 8000); w.on("open", () => { clearTimeout(t); w.close(); res("ok"); }); w.on("error", () => { clearTimeout(t); res("down"); }); }); } catch { pump = "down"; }
    out.push({ name: "PumpPortal stream", status: pump });
    const services = (await sh("launchctl", ["list"])).split("\n").filter((l) => l.includes("com.polymarket")).map((l) => { const [pid, code, name] = l.trim().split(/\s+/); return { name: name.replace("com.polymarket.", ""), running: pid !== "-" || code === "0" }; });
    return text({ as_of: new Date().toISOString(), feeds: out, services_down: services.filter((x) => !x.running).map((x) => x.name), services_total: services.length });
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
  // Plain names → the things Sai actually says. "crypto" is both a launchd
  // service (dryrun.crypto) and a trading switch (BOT_CRYPTO_ENABLED).
  tool("fleet_control", "Do what Sai says to a paper bot, by its plain name (crypto, weather, options, oracle-lag, kronos, premarket, vwap, newslag, memebot, flowbot, stocksbot, gammapulse, ccxtbot, botos, autotuner, mirofish, worldmonitor...). Actions: pause_trading / resume_trading flip the bot's trading switch (it keeps logging, places no trades) — use these for 'stop trading X'; stop / start / restart control the service itself; log reads its tail; list shows everything. Only paper bots — never the dashboard or the live executor. Act ONLY on the bot Sai named, once; if it is not found, say so and stop — never touch a different bot to compensate, and never claim something is stopped unless this tool said so.",
    { action: z.enum(["list", "pause_trading", "resume_trading", "start", "stop", "restart", "log"]), bot: z.string().max(40).optional() },
    async ({ action, bot }) => {
      const uid = (await sh("id", ["-u"])).trim();
      const list = (await sh("launchctl", ["list"])).split("\n").filter((l) => l.includes("com.polymarket"));
      const switches = async () => { try { return JSON.parse(await deskGet("/api/bots")).bots ?? []; } catch { return []; } };
      if (action === "list") return text({ services: list.join("\n"), switches: await switches() });
      if (!bot) return text("which bot?", true);
      const key = bot.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (action === "pause_trading" || action === "resume_trading") {
        const bots = await switches();
        const hit = bots.find((b) => b.key.toLowerCase().replace(/[^a-z0-9]/g, "").includes(key) || b.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(key));
        if (!hit) {
          // no trading switch for this bot (flow, meme, stocks, gamma, ccxt…): pausing means stopping its service, resuming means starting it. Same audit, said plainly.
          const norm0 = (n) => n.replace(/^com\.polymarket\.(dryrun\.)?/, "").replace(/[^a-z0-9]/g, "");
          const names0 = list.map((l) => l.split(/\s+/).pop()).filter((n) => CONTROLLABLE.test(n));
          const allNames = [...names0, ...(await sh("bash", ["-c", `ls ${process.env.HOME}/Library/LaunchAgents | sed 's/.plist$//'`])).split("\n").filter((n) => CONTROLLABLE.test(n))].filter((v, i, a) => a.indexOf(v) === i);
          const svc0 = allNames.find((n) => norm0(n) === key) ?? allNames.find((n) => norm0(n).includes(key) || key.includes(norm0(n)));
          if (!svc0) return text(`no bot called '${bot}'. Switches: ${bots.map((b) => b.name).join(", ")}; services: ${allNames.map((n) => n.replace("com.polymarket.", "")).join(", ")}`, true);
          const plist0 = `${process.env.HOME}/Library/LaunchAgents/${svc0}.plist`;
          const out0 = action === "pause_trading" ? ((await sh("launchctl", ["bootout", `gui/${uid}/${svc0}`])) || `stopped ${svc0}`) : ((await sh("launchctl", ["enable", `gui/${uid}/${svc0}`])), (await sh("launchctl", ["bootstrap", `gui/${uid}`, plist0])) || `started ${svc0}`);
          await audit("fleet_control", { action, service: svc0, via: "service" }, out0.slice(0, 120));
          return text(`${svc0.replace("com.polymarket.", "")}: ${action === "pause_trading" ? "STOPPED (this bot has no trading switch, so its service is stopped; its book and log are kept)" : "STARTED"} — ${out0}`);
        }
        const r = await fetch(`${DESK}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: hit.key, enabled: action === "resume_trading" }) });
        const on = action === "resume_trading";
        await audit("fleet_control", { action, bot: hit.name }, r.ok ? "ok" : `HTTP ${r.status}`);
        return text(r.ok ? `${hit.name}: trading ${on ? "RESUMED" : "PAUSED"} (${hit.key}=${on}); ${on ? "it places trades again from the next cycle (≤5 min)." : "the daemon keeps running and logging, it just places no trades from the next cycle (≤5 min)."}` : `switch failed: HTTP ${r.status}`, !r.ok);
      }
      const names = list.map((l) => l.split(/\s+/).pop()).filter((n) => CONTROLLABLE.test(n));
      // best match, not first match: exact, then the longest shared run between what Sai said and a service name
      const norm = (n) => n.replace(/^com\.polymarket\.(dryrun\.)?/, "").replace(/[^a-z0-9]/g, "");
      const overlap = (a, b) => { let best = 0; for (let i = 0; i < a.length; i++) for (let j = i + 2; j <= a.length; j++) if (b.includes(a.slice(i, j))) best = Math.max(best, j - i); return best; };
      const svc = names.find((n) => norm(n) === key) ?? names.map((n) => [n, overlap(key, norm(n))]).filter(([, o]) => o >= 4).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!svc) return text(`no paper-bot service matches '${bot}'; services: ${names.map((n) => n.replace("com.polymarket.", "")).join(", ")}`, true);
      if (action === "log") return text((await sh("bash", ["-c", `tail -40 logs/${svc.replace("com.polymarket.", "").replace("dryrun.", "")}*.log 2>/dev/null`])) || "no log");
      const plist = `${process.env.HOME}/Library/LaunchAgents/${svc}.plist`;
      let out;
      if (action === "stop") out = (await sh("launchctl", ["bootout", `gui/${uid}/${svc}`])) || `stopped ${svc}`;
      else if (action === "start") { await sh("launchctl", ["enable", `gui/${uid}/${svc}`]); out = (await sh("launchctl", ["bootstrap", `gui/${uid}`, plist])) || `started ${svc}`; }
      else out = (await sh("launchctl", ["kickstart", "-k", `gui/${uid}/${svc}`])) || `restarted ${svc}`;
      await audit("fleet_control", { action, service: svc }, out.slice(0, 120));
      return text(out);
    }),
  // ── AXIOM's hands ───────────────────────────────────────────────────────────
  // Every act is written to .data/actions.jsonl (who asked, what was done, the
  // result) — the audit trail an agent runtime owes its owner (Agent libOS,
  // arXiv 2606.03895: capability-controlled, auditable, human-approvable).
  tool("trade", "Buy, sell (short, crypto only) or close a position on AXIOM's own $100 PAPER book at the real price right now, or show the book. Symbols: crypto as BASE/QUOTE (ETH/USD, BTC/USD, SOL/USD), equities as tickers (NVDA). usd is the stake, max $50. This is paper: there is no route from here to an exchange. When Sai says 'buy', 'sell', 'close', 'take profit', 'get out' — do it, then say the fill price and the book balance. Live money needs the executor's two human switches; say so if asked.",
    { action: z.enum(["buy", "sell", "close", "status"]), symbol: z.string().max(16).optional(), usd: z.number().min(1).max(50).optional(), why: z.string().max(160).optional() },
    async ({ action, symbol, usd, why }) => {
      const args = action === "status" ? ["status"] : action === "close" ? ["close", symbol ?? "", why ?? "Sai said so"] : [action, symbol ?? "", String(usd ?? 10), why ?? "Sai said so"];
      const out = await sh(PY, [join(ROOT, "dryrun", "manual_book.py"), ...args], 40_000);
      if (action !== "status") await audit("trade", { action, symbol, usd, why }, out.slice(0, 400));
      return text(out);
    }),
  tool("send_message", "Send a message on Sai's behalf: iMessage/SMS through Messages on this Mac, or email through SMTP if SMTP_HOST/SMTP_USER/SMTP_PASS are set in .env. Only to people in .data/contacts.json (name → handle); if the name is not there, say so and do not send. Keep it short, sign it 'AXIOM for Sai', and read it back to Sai in the reply.",
    { to: z.string().max(60), body: z.string().min(1).max(1200), channel: z.enum(["imessage", "email"]).default("imessage"), subject: z.string().max(120).optional() },
    async ({ to, body, channel, subject }) => {
      let contacts = {}; try { contacts = JSON.parse(await readFile(join(ROOT, ".data", "contacts.json"), "utf-8")); } catch {}
      const key = Object.keys(contacts).find((k) => k.toLowerCase() === to.toLowerCase() || k.toLowerCase().includes(to.toLowerCase()));
      if (!key) return text(`'${to}' is not in .data/contacts.json — add {"${to}": "+1... or email"} there first. Known: ${Object.keys(contacts).join(", ") || "none"}`, true);
      const handle = contacts[key]; const msg = `${body}\n— AXIOM for Sai`;
      let result;
      if (channel === "email") {
        const env = await envFile();
        if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return text("email is not configured: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env (Gmail: an app password)", true);
        const nodemailer = (await import("nodemailer")).default;
        const t = nodemailer.createTransport({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: Number(env.SMTP_PORT) === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
        const r = await t.sendMail({ from: env.SMTP_FROM || env.SMTP_USER, to: handle, subject: subject || "From AXIOM", text: msg });
        result = `email sent to ${key} <${handle}> (${r.messageId})`;
      } else {
        const script = `tell application "Messages"\nset s to 1st account whose service type = iMessage\nset b to participant "${handle}" of s\nsend "${msg.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" to b\nend tell`;
        const out = await sh("osascript", ["-e", script], 20_000);
        if (/error|not allowed|can.t get/i.test(out)) return text(`Messages refused: ${out.slice(0, 200)} — allow Automation for Messages in System Settings › Privacy`, true);
        result = `iMessage sent to ${key} (${handle})`;
      }
      await audit("send_message", { to: key, channel, subject }, result);
      return text({ sent: true, result, message: msg });
    }),
  // ── Skills: what AXIOM learns to do, kept and replayed (MUSE-Autoskill, arXiv 2605.27366) ──
  tool("save_skill", "Save a multi-step procedure you just carried out successfully as a named skill so Sai can ask for it by name next time ('do the morning routine'). steps is the ordered list of tool calls with their arguments, in plain JSON. Save only what worked.",
    { name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/), description: z.string().max(200), steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).default({}) })).min(1).max(12) },
    async ({ name, description, steps }) => { await mkdir(SKILLS, { recursive: true }); await writeFile(join(SKILLS, `${name}.json`), JSON.stringify({ name, description, steps, saved: Date.now(), runs: 0 }, null, 1)); await audit("save_skill", { name }, `${steps.length} steps`); return text(`saved skill '${name}' (${steps.length} steps)`); }),
  tool("list_skills", "The skills AXIOM has saved: name, what it does, steps, how often it has run.", {}, async () => {
    try { const fs_ = (await readdir(SKILLS)).filter((f) => f.endsWith(".json")); return text(await Promise.all(fs_.map(async (f) => { const j = JSON.parse(await readFile(join(SKILLS, f), "utf-8")); return { name: j.name, description: j.description, steps: j.steps.map((s) => s.tool), runs: j.runs }; }))); } catch { return text("no skills saved yet"); } }),
  tool("run_skill", "Run a saved skill by name: executes its tool steps in order and returns every result. Stops at the first error.", { name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/) },
    async ({ name }) => {
      let j; try { j = JSON.parse(await readFile(join(SKILLS, `${name}.json`), "utf-8")); } catch { return text(`no skill '${name}'`, true); }
      const results = [];
      for (const st of j.steps) {
        const t = REGISTRY.find((x) => x.name === st.tool); if (!t) { results.push({ tool: st.tool, error: "unknown tool" }); break; }
        const parsed = t.schema.safeParse(nearest(t, st.args ?? {})); if (!parsed.success) { results.push({ tool: st.tool, error: "bad args" }); break; }
        const r = await t.handler(parsed.data); const out = (r.content ?? []).map((c) => c.text ?? "").join("\n").slice(0, 1500); results.push({ tool: st.tool, out }); if (r.isError) break;
      }
      j.runs = (j.runs ?? 0) + 1; j.last_run = Date.now(); await writeFile(join(SKILLS, `${name}.json`), JSON.stringify(j, null, 1));
      await audit("run_skill", { name }, `${results.length}/${j.steps.length} steps`);
      return text({ skill: name, results });
    }),
  tool("typed_judgment", "Ask Jev (TypeSafe AI's typed-judgment model, ~100 ms) a set of typed questions about a state: noul = probability, choice = pick from options, score = position on a scale. Frozen to logs/jev_judgments.jsonl with a hash, scored later if an outcome is recorded. Use it for a fast calibrated probability, never for a number about the desk's books. Needs TYPESAFE_AI_API_KEY; says so if missing.",
    { state: z.record(z.string(), z.any()), questions: z.record(z.string(), z.object({ type: z.enum(["noul", "choice", "score"]), instructions: z.string().max(600), criteria: z.record(z.string(), z.any()).optional() })), tag: z.string().max(60).optional() },
    async ({ state, questions, tag }) => text(await sh(PY, ["-c", `import json,sys;from signals import jev;print(json.dumps(jev.judge(${JSON.stringify(JSON.stringify(state))} and json.loads(${JSON.stringify(JSON.stringify(state))}), json.loads(${JSON.stringify(JSON.stringify(questions))}), tag=${JSON.stringify(tag ?? "axiom")}) or {"error": "Jev not configured — set TYPESAFE_AI_API_KEY in .env ($0.042 per million input tokens, no free tier)"}))`], 20_000))),
  tool("eye", "Drive the Eye (/world, the live globe): focus the camera on a place (lat, lon, alt in globe radii — 0.3 city, 0.8 country, 2 whole earth), switch a layer on or off (flights, mil, sats, quakes, vessels, fires, radio, launches, cables, datacenters, dams, stations, markets), track an entity by name or callsign, release it, or set the sensor (normal, crt, nvg, flir, noir). Opens the Eye first if the user is elsewhere. Use when Sai says 'show me', 'zoom to', 'track', 'night vision', 'what's flying over'.",
    { focus: z.object({ lat: z.number(), lon: z.number(), alt: z.number().min(0.05).max(4).optional() }).optional(), layer: z.object({ id: z.string(), on: z.boolean().optional() }).optional(), track: z.string().max(40).optional(), untrack: z.boolean().optional(), sensor: z.enum(["normal", "crt", "nvg", "flir", "noir"]).optional() },
    async (cmd) => {
      uiSend({ type: "ui", op: "navigate", href: "/world" });
      if (Object.keys(cmd).length) setTimeout(() => uiSend({ type: "ui", op: "eye", ...cmd }), 900);
      let layers = null; try { layers = JSON.parse(await deskGet("/api/eye/layers")); } catch {}
      return text({ opened: "/world", sent: cmd, on_screen: layers ? { stations_with_open_positions: (layers.stations ?? []).filter((s) => s.open?.length).map((s) => `${s.city}: ${s.open.length}`), exchanges_open: (layers.exchanges ?? []).filter((e) => e.open).map((e) => e.name) } : "layers unavailable",
        next: "The Eye is on screen: flights, military ADS-B, satellites, quakes, launches, the weather book's stations and the exchanges are live layers. Say what you actually see from these facts; never invent what is on the globe." });
    }),
  // ── The toolbox: Agent402, self-hosted on :3402 in free mode ───────────────
  // 591 deterministic and live-data tools + 84 skill packs (MikeyPetrillo/Agent402,
  // AGPL-3.0, run as its own launchd service, never linked into this code).
  // Read-only for the desk: nothing here can touch a bot, a book or a key, and
  // it never pays anyone — FREE_MODE has no wallet.
  tool("toolbox_find", "Find the right tool in the 591-tool Agent402 toolbox for a task, in plain words ('insider trades for NVDA', 'yield curve', 'perp funding BTC', 'decode this JWT', 'OCR this image', 'Solana token safety'). Returns route, input schema and a ready example. Then call toolbox_call. Also lists matching skill packs.",
    { q: z.string().min(2).max(120) }, async ({ q }) => {
      try { const r = await fetch(`${A402}/api/find?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(15_000) }); const j = await r.json();
        let packs = []; try { packs = JSON.parse(await readFile(join(ROOT, ".data", "a402_packs.json"), "utf-8")).packs.filter((p) => new RegExp(q.split(/\s+/).filter((w) => w.length > 3).join("|") || "$^", "i").test(`${p.slug} ${p.name} ${p.description}`)).slice(0, 4); } catch {}
        return text({ results: (j.results ?? []).map((x) => ({ slug: x.slug, name: x.name, route: x.route, required: x.required, example: x.example, schema: x.inputSchema?.properties })), packs }); }
      catch (e) { return text(`toolbox offline (${String(e.message).slice(0, 80)}) — launchctl kickstart -k gui/$UID/com.polymarket.agent402`, true); } }),
  tool("toolbox_call", "Call one Agent402 tool by slug with its JSON args (get the slug and schema from toolbox_find). Live data comes back as the upstream returned it, with its source; a tool that needs a key the desk lacks returns an error you must relay, never invent. Never use it for desk numbers — those come from fleet_status and desk_api.",
    { slug: z.string().regex(/^[a-z0-9-]{2,60}$/), args: z.record(z.string(), z.any()).default({}), method: z.enum(["POST", "GET"]).default("POST") },
    async ({ slug, args, method }) => {
      if (/^(memory|x402|usdc|transfer|tx-status|gas|wallet|credits|my-usage|seller-payability)/.test(slug)) return text(`'${slug}' is a payment or identity tool — the desk does not use those`, true);
      try {
        const t0 = Date.now();
        const r = method === "GET" ? await fetch(`${A402}/api/${slug}?${new URLSearchParams(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])))}`, { signal: AbortSignal.timeout(60_000) })
          : await fetch(`${A402}/api/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(60_000) });
        const body = (await r.text()).slice(0, 14_000); let j; try { j = JSON.parse(body); } catch { j = body; }
        await audit("toolbox_call", { slug, args }, r.ok ? `ok ${Date.now() - t0}ms` : `HTTP ${r.status}`);
        if (!r.ok || j?.error) return text({ tool: slug, error: j?.error ?? `HTTP ${r.status}`, expected: j?.expected, hint: j?.hint }, true);
        return text({ tool: slug, ms: Date.now() - t0, result: j });
      } catch (e) { return text(`toolbox_call failed: ${String(e.message).slice(0, 120)}`, true); } }),
  tool("toolbox_pack", "Get an Agent402 skill pack — an ordered multi-tool workflow with its prompt (earnings-deep-dive, options-analytics, fixed-income-desk, macro-dashboard, crypto-research, sec-filings-deep-dive, insider-alert, defi-dashboard, security-audit, forecasting-bake-off, trend-analysis, weather-brief, price-monitor… 84 in all; list with slug='list'). Then run its steps with toolbox_call, in order, and write the result up. A pack you run well is worth saving as a skill with save_skill.",
    { slug: z.string().regex(/^[a-z0-9-]{2,60}$/), args: z.record(z.string(), z.any()).default({}) },
    async ({ slug, args }) => {
      if (slug === "list") { try { return text(JSON.parse(await readFile(join(ROOT, ".data", "a402_packs.json"), "utf-8"))); } catch { return text("no pack index", true); } }
      try { const qs = new URLSearchParams(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]))); const r = await fetch(`${A402}/api/skill-packs/${slug}/prompt?${qs}`, { signal: AbortSignal.timeout(15_000) }); const j = await r.json();
        let pack = null; try { pack = JSON.parse(await readFile(join(ROOT, ".data", "a402_packs.json"), "utf-8")).packs.find((p) => p.slug === slug); } catch {}
        return text({ pack: slug, tools: pack?.tools, prompt: (j.messages ?? []).map((m) => m.content?.text ?? "").join("\n").slice(0, 6000) }); }
      catch (e) { return text(`pack failed: ${String(e.message).slice(0, 100)}`, true); } }),
  tool("actions_log", "What AXIOM has actually done lately (trades, bot switches, power moves, messages, skills), newest first.", { n: z.number().int().min(1).max(50).default(15) },
    async ({ n }) => { try { const lines = (await readFile(ACTIONS, "utf-8")).trim().split("\n"); return text(lines.slice(-n).reverse().join("\n")); } catch { return text("no actions yet"); } }),
  tool("create_bot", "The Bot OS: create a user-made paper bot from a spec. Translate the user's words into: id (a-z0-9-), name, universe (BASE/QUOTE symbols like ETH/USD), timeframe (1d unless they insist; the edge is daily), weights over the evaluators (momentum, ma_cross, mean_reversion, rsi, bollinger, obv, mfi, volume_profile; 0-1.5), enter (0.05-0.5), exit (below enter), stake ($5-50), max_pos (1-5, stake x max_pos <= 100), note (their request verbatim). It starts on paper from $100 within the hour and appears on /bots. Never creates code; a bad spec is rejected with a reason you should relay.",
    { id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/), name: z.string().min(2).max(60), universe: z.array(z.string()).min(1).max(8), timeframe: z.enum(["1h", "4h", "1d"]).default("1d"),
      weights: z.record(z.string(), z.number().min(0).max(1.5)), enter: z.number().min(0.05).max(0.5).default(0.15), exit: z.number().min(0).max(0.49).default(0.05),
      stake: z.number().min(5).max(50).default(20), max_pos: z.number().int().min(1).max(5).default(2), note: z.string().max(400).default("") },
    async (spec) => {
      const out = await sh(PY, [join(ROOT, "dryrun", "botos.py"), "validate", compact(spec)], 30_000);
      let v; try { v = JSON.parse(out); } catch { return text(`validator failed: ${out.slice(0, 200)}`, true); }
      if (!v.ok) return text(`rejected: ${v.error}`, true);
      await mkdir(join(ROOT, ".data", "bots"), { recursive: true });
      await writeFile(join(ROOT, ".data", "bots", `${v.spec.id}.json`), JSON.stringify(v.spec, null, 1));
      return text({ created: v.spec, note: "runner picks it up within the hour; it shows on /bots under YOUR BOTS" });
    }),
  tool("list_bots", "List the user-made spec bots with their paper books.", {}, async () => {
    try { return text(await deskGet("/api/botos")); } catch { return text("dashboard not reachable", true); }
  }),
  tool("set_bot", "Pause or resume a user-made bot by id. Only when told.", { id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/), enabled: z.boolean() },
    async ({ id, enabled }) => {
      const f = join(ROOT, ".data", "bots", `${id}.json`);
      try { const spec = JSON.parse(await readFile(f, "utf-8")); spec.enabled = enabled; await writeFile(f, JSON.stringify(spec, null, 1)); return text(`${id} ${enabled ? "resumed" : "paused"}`); }
      catch { return text("no such bot", true); }
    }),
  tool("remember", "Save a durable note to memory.md — a preference, a standing instruction, a fact about the desk, a decision. Use when the user says remember, or when something is clearly worth keeping.", { note: z.string().min(3).max(600) },
    async ({ note }) => { await appendFile(MEMORY, `- ${new Date().toISOString().slice(0, 10)}: ${note}\n`); return text("remembered"); }),
  tool("recall", "Search past conversations (journal) and memory for a word or phrase.", { query: z.string().min(2).max(80) }, async ({ query: q }) => {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const j = (await readText(JOURNAL)).split("\n").filter((l) => re.test(l)).slice(-12);
    const m = (await readText(MEMORY)).split("\n").filter((l) => re.test(l));
    let notes = [];
    try { const { readdir } = await import("node:fs/promises"); for (const f of (await readdir(NOTES)).filter((x) => x.endsWith(".md")).slice(-60)) { const b = await readText(join(NOTES, f)); if (re.test(b)) notes.push({ file: f, excerpt: b.slice(0, 400) }); } } catch {}
    return text({ memory: m, notes: notes.slice(-8), journal: j.map((l) => { try { const r = JSON.parse(l); return { when: r.ts, you: r.q.slice(0, 160), jarvis: r.a.slice(0, 240) }; } catch { return l; } }) });
  }),
]});

// One line per book, fresh from engine_status.json at every turn, so a stale
// desk_state.md can never put an old P&L in AXIOM's mouth.
async function liveBooks() {
  const s = await data("engine_status.json"); const e = s?.engines ?? {};
  const usd = (v) => (v == null ? "—" : `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`);
  const rows = Object.entries(e).filter(([k]) => !/retired/.test(k)).map(([k, v]) =>
    `- ${k}: ${usd(v.pnl)}${v.account != null ? ` (bal $${v.account})` : ""}, ${v.trades}t, ${v.win_rate == null ? "—" : Math.round(v.win_rate * 100) + "%"} win, today ${usd(v.today?.pnl)}`);
  return rows.length ? rows.join("\n") + `\n(as of ${s?.ts ? new Date(s.ts * 1000).toISOString().slice(0, 16) : "?"} UTC)` : "(engine_status.json missing — run dryrun/brain.py)";
}

// A turn with no tools does not need the tool catalogue, the memory or the
// desk state — and every token of prompt is latency. Persona and the live
// books are enough to talk like himself about what he already knows.
async function lightPrompt() {
  const persona = await readText(PERSONA, "");
  const keep = persona.split("\n## ").filter((s, i) => i === 0 || /^(Personality|Talking with Sai|Voice)/.test(s)).join("\n## ");
  return `${keep}\n\nLIVE BOOKS (fresh from the logs — never quote a number that is not here or in front of you)\n${await liveBooks()}\n\nAnswer in two or three spoken sentences. No markdown, no lists.`;
}

async function systemPrompt() {
  const memory = await readText(MEMORY, await readText(join(HERE, "memory.example.md"), "(empty)"));
  const persona = await readText(PERSONA, "");
  const state = await readText(DESK_STATE, "(no desk state yet — build it with update_desk_state after your first briefing)");
  return `${persona}

LIVE BOOKS (computed from the trade logs just now — these numbers beat anything in the desk state or in earlier turns of this conversation; when you quote a P&L, win rate or trade count, take it from here or from a tool, never from what you said before)
${await liveBooks()}

DESK STATE (your compact working model — trust it for context and decisions, verify with tools when it matters, and keep it current with update_desk_state)
${state.slice(0, 2400)}

YOUR TOOLBOX (permanent): Agent402, self-hosted on this machine — 591 tools and 84 skill packs for live and deterministic work: SEC EDGAR (insider trades, 13F, filings, XBRL), macro (FRED, yield curve, CPI when keyed), crypto (CoinGecko prices, Hyperliquid perps funding/OI/orderbook, DefiLlama yields, Solana token safety, on-chain reads), network truth (DNS/TLS/whois), documents (PDF, OCR, extract, scrape), stats and forecasting, finance math (Black-Scholes, bonds, IRR), 200+ utilities. toolbox_find → toolbox_call, or toolbox_pack for a workflow. It is read-only for the desk and never pays anyone.

You speak for the desk's own data and act only on the user's instruction. After navigate or eye, describe the page ONLY from the endpoint you just read; if you did not read it, say you opened it and ask what they want from it. When asked which AI you are or how healthy the models are, read desk_api /api/ai/health — it measures every model the desk uses — and answer with the measured latencies, not a guess.

WHAT YOU CAN REACH
- Every page's data (desk_api), every news outlet the desk reads (news), the fleet (fleet_status, morning_brief, fleet_control), the Bot OS (create_bot, list_bots, set_bot — the user can say "create a bot that…" and you build it from a spec, on paper), research (backtest_results, safety_proof, propose_strategy, scenario_forecast, run_backtest, venues), the tests (run_tests), and the source code to read (read_code, search_code).
- Memory: memory.md below is what you were told to keep. remember() adds to it; recall() searches past conversations and your research notes. The conversation itself resumes across restarts, so you may refer to earlier turns.
- Opening screens: when asked to open, show, go to or take me to a page, call navigate with the right href, then desk_api on the endpoint it returns, then tell the user what is live on that screen — figures first, three sentences. Do this from any page.
- Working memory: keep desk_state.md dense and current. Before a long task, read it; after a briefing, a study, or any change, rewrite it with update_desk_state. Compact notes you carry forward are worth more than re-reading everything.
- Second brain: second_opinion (GPT-6 Astra, if configured) for a cross-check on a hard judgement. Desk numbers never come from it.
- Research: arxiv_search, scholar_search, web_search and read_url reach the free corners of the internet. When asked to research, or when a book is losing and you want to know why: search, READ at least two sources with read_url, cite them (title, authors, URL), and save the findings with write_note. Never cite a paper you did not open. End research with one concrete next step for the desk — a propose_fix, a propose_strategy, or a plain recommendation.

HOW TO ANSWER
- From tools, never from guesswork; never invent a number. Figures first, then one line of context.
- Answers are read aloud: plain prose, no markdown, no lists, three sentences unless asked for more. A briefing may run to a short paragraph.
- Be honest about losses. The desk's edge is daily-only and the forward test has not proven profitable; never imply otherwise.

THE MORNING BRIEF
- If greeted with only "hey Axiom", "good morning", or asked for status: call morning_brief and deliver it like a chief of staff — fleet P&L today and overall, who traded, anything broken (a stopped service, an error, low disk), then the two or three headlines that matter to the positions. Lead with what changed.

FIXING THINGS
- When asked to fix or change code: read it first (read_code, search_code), diagnose, then write a proposal with propose_fix — the exact before and after. You do not edit files yourself; a human applies the proposal in a Claude Code session. Say where you saved it. Paper bots you may restart with fleet_control when told.
- Keys, .env, live-trading switches and git are out of your reach. If asked, say a human must do that by hand.
- Every bot is a $100 paper account. Live trading is off and stays off.

MEMORY (memory.md)
${memory}`;
}

async function loadState() { try { return JSON.parse(await readFile(STATE, "utf-8")); } catch { return {}; } }

// ── The platform brain: an OpenAI-compatible tool-calling loop ───────────────
const THREAD = join(HERE, "thread.json");
async function loadThread() { try { return JSON.parse(await readFile(THREAD, "utf-8")); } catch { return []; } }
async function saveThread(msgs) { await writeFile(THREAD, JSON.stringify(msgs.slice(-40))); }

async function providers() {
  const env = { ...(await dotenv()), ...(await (async () => { const o = {}; for (const l of (await readText(join(ROOT, "frontend", ".env.local"))).split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && m[2]) o[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return o; })()) };
  // AXIOM's own NIM key first (no contention with the classifier, no free-tier
  // rate limits), then Groq for speed, then the shared NIM key, then OpenAI.
  const nvKey = env.NVIDIA_API_KEY_JARVIS || env.NVIDIA_API_KEY;
  const nvModels = [env.NVIDIA_MODEL_JARVIS || env.NVIDIA_MODEL_TOOLS || "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b"];   // deepseek-v4-flash retired (410) 2026-09-21   // measured 2026-09-20: Super 2s, gpt-oss-20b 2s, DeepSeek 19s; mistral-large-2 is gone (404), GLM/Kimi 48-90s
  // Speed first: Groq answers in 0.2-0.5s but allows 8k tokens/min on the free
  // tier, so every turn is kept small (see platformTurn). NIM is the deep bench.
  return [
    // Cerebras: 2,600 tok/s and a 60k tokens/min budget -- the fast lane.
    env.CEREBRAS_API_KEY && { name: "cerebras", base: "https://api.cerebras.ai/v1", key: env.CEREBRAS_API_KEY, models: [env.CEREBRAS_MODEL_JARVIS || "gpt-oss-120b", "qwen-3.8-27b"] },
    env.GROQ_API_KEY && { name: "groq", base: "https://api.groq.com/openai/v1", key: env.GROQ_API_KEY, models: [env.GROQ_MODEL_JARVIS || "qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"] },
    // Meta Muse Spark (Meta Model API, public preview, paid after $20 credit): agentic, 1M context -- a deep lane, not the fast one.
    env.META_API_KEY && { name: "meta", base: env.META_API_BASE || "https://api.meta.com/v1", key: env.META_API_KEY, models: [env.META_MODEL || "muse-spark-1.1"] },
    env.MISTRAL_API_KEY && { name: "mistral", base: "https://api.mistral.ai/v1", key: env.MISTRAL_API_KEY, models: [env.MISTRAL_MODEL || "mistral-medium-latest", "mistral-small-latest", "mistral-large-latest"] },
    env.GEMINI_API_KEY && /^AIza/.test(env.GEMINI_API_KEY) && { name: "gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", key: env.GEMINI_API_KEY, models: [env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-2.5-flash-lite"] },
    env.SILICONFLOW_API_KEY && { name: "siliconflow", base: "https://api.siliconflow.com/v1", key: env.SILICONFLOW_API_KEY, models: [env.SILICONFLOW_MODEL || "Qwen/Qwen3-8B"] },
    env.ZHIPU_API_KEY && { name: "zhipu", base: "https://open.bigmodel.cn/api/paas/v4", key: env.ZHIPU_API_KEY, models: [env.ZHIPU_MODEL || "glm-4.7-flash", "glm-4.5-flash"] },
    nvKey && { name: "nvidia", base: env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1", key: nvKey, models: nvModels },
    env.OPENAI_API_KEY && { name: "openai", base: "https://api.openai.com/v1", key: env.OPENAI_API_KEY, models: [env.OPENAI_MODEL || "gpt-6-astra", "gpt-5"] },
  ].filter(Boolean);
}
const picked = new Map();
let groqTurn = 0;   // Groq's free tier meters tokens per minute PER MODEL; rotating across three models triples the budget
// Enums are hidden from the model to keep turns small; snap a near-miss to the
// closest allowed value (e.g. "/bots page" -> "/bots", "fleet" -> "/api/fleet").
function nearest(t, args) {
  const shape = t.schema.shape ?? {};
  for (const [k, v] of Object.entries(args)) {
    const def = shape[k]?._def; const vals = def?.values ?? def?.innerType?._def?.values;
    if (vals && typeof v === "string" && !vals.includes(v)) {
      const s = v.toLowerCase().replace(/^\/?api\//, "").replace(/[^a-z0-9]/g, "");
      const best = [...vals].sort((a, b) => score(b, s) - score(a, s))[0];
      if (best && score(best, s) > 0) args[k] = best;
    }
  }
  return args;
}
const score = (cand, s) => { const c = cand.toLowerCase().replace(/^\/?api\//, "").replace(/[^a-z0-9]/g, ""); if (!c || !s) return 0; if (c === s) return 100; if (c.includes(s) || s.includes(c)) return 50 + Math.min(c.length, s.length); let k = 0; for (const ch of new Set(s)) if (c.includes(ch)) k++; return k; };

const deadLanes = new Set();     // 401/402/403 — the key is the problem, not the moment
async function chat(messages, tools, send, force) {
  const errs = [];
  // Groq's free tier rejects anything over ~8k tokens per minute per model
  // (413) and Cerebras is unpaid; a long unattended turn (night study, weekly
  // freshness, a deep read) goes straight to NIM's 128k+ context instead of
  // burning a minute failing through the fast lanes first.
  const approxTokens = (JSON.stringify(messages).length + JSON.stringify(tools).length) / 4;
  const lanes = (await providers()).filter((p) => !deadLanes.has(p.name) && (approxTokens < 6000 || !["groq", "cerebras"].includes(p.name)));
  // Resource reallocation: lanes past 80% of a learned budget or inside a 429
  // cooldown are skipped up front, so the turn moves on before the lane dies.
  const skip = await avoidLanes();
  const { focus: f } = await powerFocus();
  for (const p of orderLanes("bridge", lanes, f)) {
    const order = p.name === "groq" ? [...p.models.slice(groqTurn++ % p.models.length), ...p.models.slice(0, groqTurn % p.models.length)] : [picked.get(p.name), ...p.models];
    for (const model of order.filter((v, i, a) => v && a.indexOf(v) === i)) {
      if (skip.has(`${p.name}:${model}`)) { errs.push(`${p.name}/${model} skipped (budget)`); continue; }
      let retried = false;
      models: for (;;) {
      try {
        const r = await fetch(`${p.base}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(p.name === "nvidia" ? 120_000 : 60_000),
          headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
          body: JSON.stringify({ model, messages, ...(tools?.length ? { tools, tool_choice: force ? { type: "function", function: { name: force } } : "auto" } : {}), max_tokens: 900, temperature: 0.3, stream: true,
            ...(["groq", "openai", "cerebras"].includes(p.name) ? { stream_options: { include_usage: true } } : {}),
            // reasoning models: think briefly and keep the thinking out of the spoken answer
            ...(model.includes("gpt-oss") ? { reasoning_effort: "low", ...(p.name === "groq" ? { reasoning_format: "hidden" } : {}) } : {}),
            // nemotron otherwise streams its thinking as reasoning_content and can end a turn with no answer text at all
            ...(model.includes("nemotron") ? { chat_template_kwargs: { enable_thinking: false } } : {}) }) });
        if (!r.ok) { let j = {}; try { j = await r.json(); } catch {} const e = `${p.name}/${model} ${r.status} ${JSON.stringify(j.error ?? "").slice(0, 160)}`; errs.push(e); console.error("[brain] fallback:", e);
          if (r.status === 429) await recordLimit(p.name, model, j.error?.message ?? JSON.stringify(j));
          else if ([401, 402, 403].includes(r.status)) { await recordLimit(p.name, model, `HTTP ${r.status} (key or billing) — try again in 24h0m0s`); deadLanes.add(p.name); console.error("[brain] lane", p.name, `is ${r.status} — dropped for this run`); }
          else await recordUsage(p.name, model, null, `http ${r.status}`, 0);
          if (r.status === 503 && !retried) { retried = true; await new Promise((res) => setTimeout(res, 400)); continue models; }
          if (![400, 404, 410, 429, 503].includes(r.status)) break; continue; }
        // stream: text deltas go to the browser as they arrive; tool calls are assembled
        const msg = { role: "assistant", content: "", tool_calls: [] }; const calls = new Map(); let buf = ""; let usage = null;
        const reader = r.body.getReader(); const dec = new TextDecoder();
        while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line.startsWith("data:")) continue; const data = line.slice(5).trim(); if (data === "[DONE]") continue;
            let ev; try { ev = JSON.parse(data); } catch { continue; } if (ev.usage) usage = ev.usage; const d = ev.choices?.[0]?.delta; if (!d) continue;
            if (d.content) { msg.content += d.content; send?.({ type: "delta", text: d.content }); }
            for (const tc of d.tool_calls ?? []) { const c = calls.get(tc.index) ?? { id: tc.id, type: "function", function: { name: "", arguments: "" } }; if (tc.id) c.id = tc.id; if (tc.function?.name) c.function.name += tc.function.name; if (tc.function?.arguments) c.function.arguments += tc.function.arguments; calls.set(tc.index, c); } } }
        for (const line of buf.split("\n")) { const l = line.trim(); if (!l.startsWith("data:") || l.slice(5).trim() === "[DONE]") continue; try { const d = JSON.parse(l.slice(5)).choices?.[0]?.delta; if (d?.content) { msg.content += d.content; send?.({ type: "delta", text: d.content }); } } catch {} }
        msg.tool_calls = [...calls.values()]; if (!msg.tool_calls.length) delete msg.tool_calls;
        await recordUsage(p.name, model, usage, "ok", approxTokens + (msg.content.length + JSON.stringify(msg.tool_calls ?? []).length) / 4);
        if (!msg.content.trim() && !msg.tool_calls) { errs.push(`${p.name}/${model} empty`); console.error("[brain] empty answer from", `${p.name}/${model}`); continue; }
        picked.set(p.name, model); return { msg, brain: `${p.name}/${model}` };
      } catch (e) { errs.push(`${p.name}/${model} ${String(e.message).slice(0, 60)}`); break; }
      break;
      }
    }
  }
  throw new Error("no platform brain answered: " + errs.join(" | "));
}
// Only the tools a question can plausibly need travel with it. The four core
// tools always go; the rest are picked by topic. Keeps a turn near 3k tokens.
const CORE_TOOLS = ["navigate", "fleet_status", "desk_api", "recall"];
const TOPICS = [
  [/\b(insider|13f|edgar|filing|sec\b|fred|yield curve|cpi|treasury|funding rate|perp|open interest|defi|tvl|stablecoin|solana token|mint|ens|whois|dns|tls|ocr|pdf|decode|jwt|hash|convert|black.?scholes|bond|ytm|irr|npv|forecast|holt|regression|correlation|toolbox|skill pack|dossier|earnings|geocode|fx rate|exchange rate)\b/i, ["toolbox_find", "toolbox_call", "toolbox_pack"]],
  [/\b(show me|zoom (to|in|out)|track|flying over|satellite|flights?|globe|the eye|night vision|thermal|sensor|crt|nvg|flir)\b/i, ["eye", "navigate"]],
  [/\b(buy|sell|short|close|take profit|get out|position|my book|manual book)\b/i, ["trade"]],
  [/\b(message|text|imessage|email|mail|tell|notify|send)\b/i, ["send_message"]],
  [/\bskill|routine|playbook|do the|again like|what (have|did) you do|actions? log|audit/i, ["save_skill", "list_skills", "run_skill", "actions_log"]],
  [/reallocat|all power|divert|focus (the )?(power|compute|brain|ai)|power (to|on|status)|tokens? (spent|used|left)|budget|quota/i, ["set_power", "power_status"]],
  [/which (ai|model|brain)|ai health|health of (the |your )?(ai|brain|models?)|latency|how fast|which model/i, ["desk_api"]],
  [/news|headline|world|happening|market.?s?\b|wire|crypto|geopolit|oil|war/i, ["news"]],
  [/research|paper|arxiv|scholar|study|read\b|literature|search the web|look up|google/i, ["arxiv_search", "scholar_search", "web_search", "read_url", "write_note"]],
  [/create|new bot|make a bot|build a bot|my bots|spec bot|pause|resume|retire/i, ["create_bot", "list_bots", "set_bot"]],
  [/fix|change|bug|code|why does|why is .* (losing|broken)|source|function|file/i, ["read_code", "search_code", "propose_fix"]],
  [/health|running|down|degraded|working|broken|status|everything ok/i, ["health_check"]],
  [/brief|morning|status|summary|what happened|since yesterday|overnight/i, ["morning_brief"]],
  [/backtest|strategy|sharpe|edge|blend|weights|overfit|holdout|momentum|rsi/i, ["backtest_results", "propose_strategy", "run_backtest"]],
  [/forecast|predict|scenario|will .* go up|monte|probability|odds|jev|typed/i, ["scenario_forecast", "typed_judgment"]],
  [/safe|safety|assert|invariant|cap|proving/i, ["safety_proof"]],
  [/venue|exchange|where can|trade from|canada|kraken|hyperliquid|polymarket|kalshi/i, ["venues"]],
  [/start|stop|pause|resume|halt|kill|turn (on|off)|switch (on|off)|restart|kick|log of|logs?\b|service|stop trading|trading/i, ["fleet_control"]],
  [/remember|note this|keep in mind|memory|desk state|forget/i, ["remember", "update_desk_state"]],
  [/second opinion|cross.?check|ask astra|ask the 550|deep think/i, ["second_opinion"]],
  [/test|pytest/i, ["run_tests"]],
];
const SMALL_TALK = /^(hi|hey|hello|yo|good (morning|evening|afternoon)|how are you|how'?s it going|what'?s up|thanks?|thank you|cheers|nice|cool|ok|okay|nothing|never ?mind|bye|goodnight|good night|see you|who are you|tell me a joke|talk to me|let'?s talk|i'?m (bored|tired|back))\b/i;
function pickTools(q) {
  if (SMALL_TALK.test(q.trim()) && q.trim().length < 60) return [];   // a friend answers, it does not go and fetch things
  const want = new Set(CORE_TOOLS);
  for (const [re, names] of TOPICS) if (re.test(q)) names.forEach((x) => want.add(x));
  if (want.size <= CORE_TOOLS.length) ["morning_brief", "news", "health_check"].forEach((x) => want.add(x));
  return REGISTRY.filter((t) => want.has(t.name));
}

// Something on screen within a few milliseconds, whichever brain ends up
// answering. Replaced by the real answer when it lands.
const ACK = { navigate: "Opening it.", morning_brief: "Pulling the briefing.", health_check: "Checking every feed.", news: "Reading the wire.", backtest_results: "Checking the backtests.",
  scenario_forecast: "Running the scenarios — about ten seconds.", propose_strategy: "Judging it on holdout — about twenty seconds.", create_bot: "Building it.", read_code: "Reading the code.", arxiv_search: "Searching the literature." };
function ack(q, picked) { if (!picked.length) return ""; const hit = picked.find((t) => ACK[t.name] && t.name !== "navigate" && t.name !== "desk_api" && t.name !== "fleet_status" && t.name !== "recall"); if (/open|show|go to|take me/i.test(q)) return ""; return hit ? ACK[hit.name] : "On it."; }

// Agent402 matches for a question, as OpenAI-style function tools with real
// schemas, each running against the local toolbox. Cheap (one /api/find), so
// every turn gets them; skipped silently if the toolbox is down.
const BLOCKED_A402 = /^(memory|x402|usdc|transfer|tx-status|gas|wallet|credits|my-usage|seller-payability|route-execute|buy)/;
async function nativeToolbox(q) {
  try {
    const r = await fetch(`${A402}/api/find?q=${encodeURIComponent(q.slice(0, 160))}`, { signal: AbortSignal.timeout(4000) }); const j = await r.json();
    return (j.results ?? []).filter((x) => x.slug && !BLOCKED_A402.test(x.slug) && (x.score ?? 0) > 25).slice(0, 4).map((x) => {
      const method = String(x.route ?? "POST").split(" ")[0]; const props = x.inputSchema?.properties ?? {};
      const def = { type: "function", function: { name: `a402_${x.slug.replace(/-/g, "_")}`, description: `${x.name}: ${String(x.description ?? "").slice(0, 220)} (live, via the toolbox)`, parameters: { type: "object", properties: props, required: x.inputSchema?.required ?? x.required ?? [] } } };
      const run = async (args) => {
        const t0 = Date.now();
        const res = method === "GET" ? await fetch(`${A402}/api/${x.slug}?${new URLSearchParams(Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [k, String(v)])))}`, { signal: AbortSignal.timeout(60_000) })
          : await fetch(`${A402}/api/${x.slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args ?? {}), signal: AbortSignal.timeout(60_000) });
        const body = (await res.text()).slice(0, 14_000); await audit("toolbox", { slug: x.slug, args }, res.ok ? `ok ${Date.now() - t0}ms` : `HTTP ${res.status}`);
        return res.ok ? body : `ERROR: ${body.slice(0, 600)}`;
      };
      return { def, run };
    });
  } catch { return []; }
}

// "Open the bots" should move the screen now, not after a model has thought
// about it. Match the page here, send the browser on its way, and let the turn
// narrate what is already in front of Sai.
function pageFor(q) {
  const t = q.toLowerCase();
  if (!/\b(open|show|go to|take me|bring up|pull up|switch to|let'?s see|jump to)\b/.test(t)) return null;
  let best = null, score = 0;
  for (const [href, name, about] of PAGES) {
    for (const w of `${name} ${href.slice(1)}`.split(/[\s,/]+/).filter((x) => x.length > 2)) {
      if (t.includes(w) && w.length > score) { best = { href, name, about, api: PAGES.find((p) => p[0] === href)?.[3] }; score = w.length; }
    }
  }
  return best;
}

async function platformTurn(q, send) {
  // the dock wraps the question in a [Context: ...] line; intent must be read
  // from Sai's own words, or "Answer about what they can see" opens /about
  const said = q.replace(/^\s*\[Context:[\s\S]*?\]\s*/, "").trim() || q;
  const jump = pageFor(said);
  if (jump) uiSend({ type: "ui", op: "navigate", href: jump.href });   // the screen moves first
  const chosen = pickTools(said);
  const opener = ack(said, chosen);
  if (opener) send({ type: "delta", text: opener + " " });
  const tools = chosen.map((t) => { const p = zodToJsonSchema(t.schema, { target: "openApi3" }); delete p.$schema;
    for (const v of Object.values(p.properties ?? {})) { if (v.enum && v.enum.length > 12) { v.description = `one of ${v.enum.length} known values; the tool corrects near-misses`; delete v.enum; } }
    return { type: "function", function: { name: t.name, description: t.description.split(/(?<=[.!?])\s/)[0].slice(0, 160), parameters: p } }; });
  // One system: the Agent402 tools that fit this question are not behind a
  // door — they join AXIOM's own tool list for the turn, callable by name.
  // Only when the question reaches outside the desk: the lookup costs a round
  // trip and most turns do not need it.
  const OUTSIDE = /\b(insider|13f|edgar|filing|sec|fred|yield|cpi|treasury|funding|perp|open interest|defi|tvl|stablecoin|token|mint|whois|dns|tls|ocr|pdf|decode|jwt|convert|black.?scholes|bond|ytm|irr|npv|forecast|holt|regression|correlation|geocode|fx|exchange rate|weather in|news about|price of)\b/i;
  const native = OUTSIDE.test(said) ? await nativeToolbox(said) : [];
  for (const n of native) tools.push(n.def);
  if (jump) { const i = tools.findIndex((t) => t.function.name === "navigate"); if (i >= 0) tools.splice(i, 1); }   // already there; do not open it twice
  // the page Sai is now looking at, read while the model is still warming up
  const pageData = jump?.api ? deskGet(jump.api).then((r) => String(r).slice(0, 3500)).catch(() => null) : null;
  let history = (await loadThread()).slice(-8).map((m) => (m.role === "tool" ? { ...m, content: String(m.content).slice(0, 500) } : m));
  const firstUser = history.findIndex((m) => m.role === "user"); history = firstUser >= 0 ? history.slice(firstUser) : [];   // never start on an orphaned tool result
  const light = !tools.length || (jump && chosen.length === 0);
  if (light) history = history.slice(-4);
  const messages = [{ role: "system", content: light ? await lightPrompt() : (await systemPrompt()).slice(0, 8000) }, ...history, { role: "user", content: q }];
  if (jump) {
    const d = await pageData;
    messages.push({ role: "system", content: `You have ALREADY opened ${jump.href} (${jump.name}) — it is on Sai's screen now. ${d ? `Its live data, just read: ${d}` : `It shows: ${jump.about}`}\nTell him what is on it in two or three spoken sentences, leading with the number or fact that matters most. No lists.` });
    tools.length = 0;   // the page's own data is in hand: answer in one breath, no round trips
    messages[0] = { role: "system", content: await lightPrompt() };
  }
  // A question about numbers always starts with a fleet_status call: a small
  // model will otherwise repeat a figure from an earlier turn instead of the
  // live one, and nothing on this desk may quote a stale P&L.
  const Q = said;
  const NUMBERS = /p&l|pnl|profit|\b(our|the) (loss|trades|book|books|balance|account)|losing|winning|win rate|how (is|are) .*(bot|fleet|book|desk|doing)|fleet|desk status|the numbers/i;
  // Likewise a command is an action, not a memory: "stop trading crypto" must
  // hit fleet_control this turn, whatever was said before.
  const has = (n) => tools.some((t) => t.function.name === n);
  const CONTROL = /\b(stop|pause|halt|kill|resume|start|restart|turn (on|off)|switch (on|off))\b/i, POWER = /reallocat|all power|divert|focus (the )?(power|compute|brain|ai)|power to/i;
  // a trade order names an action AND a size or a symbol; "the short version" is not an order
  const TRADE = /\b(buy|sell|short)\b[^.]{0,40}\b(\$?\d+|dollars?|usd|[A-Z]{2,5}(\/USD|-USD)?)\b|\bclose (my|the) [^.]{0,30}position|\btake profit on\b|\bget out of\b/, MSG = /\b(message|text|imessage|email|mail)\b.*\b(to|him|her|them)\b|\bsend (a |an )?(message|text|email|mail)/i;
  const OPEN = /\b(open|show me|go to|take me to|bring up|pull up|switch to)\b/i;
  let force = OPEN.test(Q) && has("eye") && /\b(eye|globe|world|map|satellite|flight)\b/i.test(q) ? "eye"
    : OPEN.test(Q) && has("navigate") ? "navigate"
    : TRADE.test(Q) && has("trade") ? "trade" : MSG.test(Q) && has("send_message") ? "send_message" : POWER.test(Q) && has("set_power") ? "set_power" : CONTROL.test(Q) && has("fleet_control") ? "fleet_control" : NUMBERS.test(Q) && has("fleet_status") ? "fleet_status" : undefined;
  let answer = "", brain = "";
  let lastSig = "", acts = 0;
  for (let step = 0; step < 24; step++) {
    let { msg, brain: b } = await chat(messages, tools, send, force); brain = b;
    if (force && !msg.tool_calls?.length) {
      // a forced tool that the model talked past is an act it did not do; insist once, then refuse to pretend
      messages.push({ role: "assistant", content: msg.content ?? "" }, { role: "user", content: `Do it: call ${force} now. Do not describe it, call it.` });
      ({ msg, brain: b } = await chat(messages, tools, send, force)); brain = b;
      if (!msg.tool_calls?.length) { answer = `I could not carry that out — the ${force} call did not go through. Nothing was changed.`; messages.push({ role: "assistant", content: answer }); break; }
    }
    force = undefined;
    if (msg.tool_calls?.length) {
      const sig = JSON.stringify(msg.tool_calls.map((c) => [c.function.name, c.function.arguments]));
      acts += msg.tool_calls.filter((c) => ["trade", "fleet_control", "send_message", "set_power"].includes(c.function.name)).length;
      if (sig === lastSig || acts > 3) { messages.push({ role: "user", content: "Stop calling tools. Answer now, in your own voice, from what you already have; say plainly if something could not be done." }); delete msg.tool_calls; const r2 = await chat(messages, [], send); answer = r2.msg.content ?? ""; messages.push({ role: "assistant", content: answer }); break; }
      lastSig = sig;
    }
    messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) { answer = msg.content ?? ""; break; }
    const results = await Promise.all(msg.tool_calls.map(async (call) => {
      const t = REGISTRY.find((x) => x.name === call.function.name);
      let args = {}; try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
      send({ type: "tool", name: call.function.name });
      const nat = native.find((n) => n.def.function.name === call.function.name);
      if (nat) { try { return { id: call.id, out: await nat.run(args) }; } catch (e) { return { id: call.id, out: "tool failed: " + String(e.message).slice(0, 200) }; } }
      if (!t) return { id: call.id, out: "unknown tool" };
      const parsed = t.schema.safeParse(nearest(t, args));
      if (!parsed.success) return { id: call.id, out: `bad arguments: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}` };
      try { const r = await t.handler(parsed.data); let out = (r.content ?? []).map((c) => c.text ?? "").join("\n"); if (r.isError) out = "ERROR: " + out; return { id: call.id, out }; }
      catch (e) { return { id: call.id, out: "tool failed: " + String(e.message).slice(0, 200) }; }
    }));
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: String(r.out).slice(0, 12_000) });
  }
  if (acts === 0 && /\bI\s+(stopped|paused|resumed|restarted|started|bought|sold|closed|moved|reallocated|sent|messaged)\b/i.test(answer)) {
    // it described an act it never performed this turn: no tool call, no act. Make it say so.
    messages.push({ role: "user", content: "Check yourself: you called no acting tool this turn (no pause, resume, stop, restart, trade, power move or message went through). Restate your answer without claiming any act; say what you would have done and that it was not done." });
    try { const { msg: m2 } = await chat(messages, [], send); if (m2.content?.trim()) { answer = m2.content; messages.push({ role: "assistant", content: answer }); } } catch {}
  }
  if (!answer.trim()) {
    // a long tool run can end on an empty assistant turn; ask once for the words
    messages.push({ role: "user", content: "You finished the work. Now say the spoken summary, in your own voice, four sentences at most, no markdown." });
    try { const { msg } = await chat(messages, [], send); answer = msg.content ?? ""; messages.push({ role: "assistant", content: answer }); } catch {}
  }
  await saveThread(messages.slice(1));   // everything but the system prompt
  // Asked for a brief, so the brief is kept: the same words he just heard,
  // written down and dated, without spending a second model turn on it.
  if (/\b(brief|catch me up|overnight|what happened|morning)\b/i.test(said) && answer.length > 80) {
    const day = new Date().toLocaleDateString("en-CA");   // Sai's day, not UTC's
    await mkdir(NOTES, { recursive: true }).catch(() => {});
    await writeFile(join(NOTES, `${day}-brief.md`), `# Briefing ${day}\n\n_${new Date().toISOString()}_\n\n${answer}\n`).catch(() => {});
    send({ type: "ui", op: "toast", text: `brief saved — jarvis/notes/${day}-brief.md` });
  }
  return { answer: answer || "I could not complete that.", brain };
}
const BRAIN = (process.env.JARVIS_BRAIN || "platform").toLowerCase();
async function saveState(s) { await writeFile(STATE, JSON.stringify(s)); }

const TOOLS = ["navigate", "fleet_status", "backtest_results", "safety_proof", "venues", "desk_api", "news", "morning_brief", "read_code", "search_code", "propose_fix",
  "arxiv_search", "scholar_search", "web_search", "read_url", "write_note", "second_opinion", "update_desk_state", "health_check", "set_power", "power_status", "trade", "send_message", "save_skill", "list_skills", "run_skill", "actions_log", "typed_judgment", "eye", "toolbox_find", "toolbox_call", "toolbox_pack", "scenario_forecast", "propose_strategy", "run_backtest", "run_tests", "fleet_control", "create_bot", "list_bots", "set_bot", "remember", "recall"];
const ALLOWED = TOOLS.map((t) => `mcp__axiom__${t}`);

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
console.log(`[jarvis] AXIOM bridge v3 on ws://127.0.0.1:${PORT}  (desk: ${DESK}, brain: ${BRAIN === "claude" ? "Claude Agent SDK" : "platform — Groq / NVIDIA / OpenAI, own loop"})`);

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin ?? "";
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { ws.close(1008, "origin"); return; }
  const send = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  send({ type: "ready", tools: TOOLS, brain: BRAIN === "claude" ? "claude" : "platform" });

  let busy = false;
  ws.on("message", async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === "forget") { await saveState({}); await saveThread([]); send({ type: "done", text: "Conversation reset. Memory notes kept." }); return; }
    if (m.type !== "ask" || typeof m.text !== "string" || !m.text.trim()) return;
    if (busy) { send({ type: "error", text: "still thinking" }); return; }
    busy = true; uiSend = send;
    const q = m.text.slice(0, 4000);
    let answer = "", sessionId = null;
    const state = await loadState();
    if (BRAIN !== "claude") {
      try { const r = await platformTurn(q, send); answer = r.answer; send({ type: "brain", brain: r.brain }); }
      catch (e) { answer = `Platform brain error: ${String(e.message ?? e).slice(0, 220)}`; send({ type: "error", text: answer }); }
      await appendFile(JOURNAL, compact({ ts: new Date().toISOString(), q, a: answer }) + "\n").catch(() => {});
      send({ type: "done", text: answer }); busy = false; return;
    }
    try {
      const session = query({ prompt: q, options: {
        systemPrompt: await systemPrompt(), mcpServers: { axiom }, allowedTools: ALLOWED,
        permissionMode: "default", cwd: ROOT, maxTurns: 28,
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
