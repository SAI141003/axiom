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
const NOTES = join(HERE, "notes");
const PERSONA = join(HERE, "persona.md");
const DESK_STATE = join(HERE, "desk_state.md");
// Optional second brain. GPT-6 Astra (OpenAI, Sept 2026) or any OpenAI-compatible model:
// set OPENAI_API_KEY (and OPENAI_MODEL, default gpt-6-astra) in .env. Loaded here so the
// key never enters the browser or the prompt.
async function dotenv() { const out = {}; for (const l of (await readText(join(ROOT, ".env"))).split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/); if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return out; }

// ── Research: the free corners of the internet, read directly ────────────────
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
async function get(url, ms = 20_000) { const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": "Mozilla/5.0 (AXIOM JARVIS research)" } }); return r.text(); }
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

// ── The pages JARVIS can open by voice, each with the endpoint that feeds it ──
const PAGES = [
  ["/", "home", "the desk at a glance", "/api/fleet"], ["/jarvis", "jarvis", "the assistant", null], ["/terminal", "terminal", "order book, signal feed, kill switch", "/api/markets"],
  ["/brain", "brain", "the reflection loop and daily scoreboard", "/api/brain"], ["/council", "council", "eight role agents debate and rule", "/api/council/review/latest"],
  ["/workforce", "workforce", "the agent roster", "/api/workforce"], ["/connectome", "connectome wiring", "the desk's nervous system read from the code", "/api/connectome"], ["/bots", "bots fleet", "every paper account on one screen", "/api/fleet"],
  ["/bots?tab=create", "create a bot", "the Bot OS", "/api/botos"], ["/crypto", "crypto auto-bot", "5-minute crypto engine", "/api/crypto/trades"],
  ["/weather", "weather", "station observations vs market buckets", "/api/weather/picks"], ["/premarket", "pre-market", "first-20-minute stock picks", "/api/premarket"],
  ["/options", "options", "chains, vol, Kelly-sized recommendations", "/api/options"], ["/stocks", "stocks", "sizing and factor view", "/api/stocks"],
  ["/arbitrage", "arbitrage arb", "neg-risk and cross-venue arbitrage", "/api/arb"], ["/live", "markets", "live market list", "/api/markets"],
  ["/tape", "tape replay", "the flow bot replayed frame by frame", "/api/tape"], ["/lab", "lab research", "backtests, proving ground, scenarios, benchmarks", "/api/backtest-lab"],
  ["/lab?tab=proving", "proving ground safety", "the fault-injection proof", "/api/proving-ground"], ["/lab?tab=scenario", "scenario", "scenario forecasts", "/api/scenario"],
  ["/ai", "ai desk", "stock analyst, market intel, risk engine, macro, alpha hunter", null], ["/oracle", "oracle", "the oracle-lag probe", "/api/oracle"],
  ["/intel", "intel", "news read by the classifier", "/api/intel"], ["/news", "news", "live wall, live summary, the world wire", "/api/world/summary"],
  ["/world", "world monitor map", "World Monitor: the live map, chokepoints, cables, missions", null], ["/journal", "journal", "every trade, every lesson", "/api/journal"],
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
  "/api/stocks", "/api/stocks-bot", "/api/tape", "/api/valuation", "/api/venues", "/api/weather", "/api/weather-trades", "/api/weather/picks", "/api/workforce", "/api/world", "/api/world/summary", "/api/botos"];

// Files JARVIS may read: source only, inside the repo, never secrets.
const UNREADABLE = /(^|\/)\.env|\.key$|\.pem$|id_rsa|(^|\/)\.claude\/|(^|\/)\.git\/|(^|\/)node_modules\/|(^|\/)\.venv\//;
function safePath(p) {
  const abs = isAbsolute(p) ? p : join(ROOT, p);
  if (relative(ROOT, abs).startsWith("..") || UNREADABLE.test(abs)) return null;
  return abs;
}

// Paper bots JARVIS may start, stop or restart. The dashboard and the live
// executor are not on the list.
const CONTROLLABLE = /^com\.polymarket\.(dryrun\.[a-z0-9]+|autotuner|data\.openbb|data\.pumpsmart|newsdesk\.poll|eod\.council|jarvis|worldmonitor)$/;

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
      const body = `# ${title}\n\n**File:** \`${file}\`\n\n## Diagnosis\n${diagnosis}\n\n## Change\n\n### Before\n\`\`\`\n${before}\n\`\`\`\n\n### After\n\`\`\`\n${after}\n\`\`\`\n\n## Verify\n${verify}\n\n_Proposed by JARVIS. Apply in a Claude Code session: "apply jarvis/proposals/${name}"._\n`;
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
        if (!r.ok) return text(`second brain error (${model}): ${JSON.stringify(j.error ?? j).slice(0, 300)}`, true);
        return text({ model, answer: j.choices?.[0]?.message?.content ?? "" });
      } catch (e) { return text(`second brain unreachable: ${String(e.message).slice(0, 120)}`, true); } }),
  tool("update_desk_state", "Rewrite jarvis/desk_state.md: a DENSE, compact symbolic state of the desk — the facts you would otherwise re-derive every time. One line per item: bot → book, P&L, win rate, status; open problems; standing decisions; what last night's study found; pending proposals. Under 60 lines. Do this at the end of every briefing and every study, and whenever a fact changes. Replace the whole file; do not append.",
    { state: z.string().min(20).max(8000) }, async ({ state }) => { await writeFile(DESK_STATE, `# Desk state — ${new Date().toISOString()}\n\n${state}\n`); return text("desk state updated"); }),
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

async function systemPrompt() {
  const memory = await readText(MEMORY, await readText(join(HERE, "memory.example.md"), "(empty)"));
  const persona = await readText(PERSONA, "");
  const state = await readText(DESK_STATE, "(no desk state yet — build it with update_desk_state after your first briefing)");
  return `${persona}

DESK STATE (your compact working model — trust it, verify with tools when it matters, and keep it current with update_desk_state)
${state.slice(0, 2400)}

You speak for the desk's own data and act only on the user's instruction.

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
- If greeted with only "hey Jarvis", "good morning", or asked for status: call morning_brief and deliver it like a chief of staff — fleet P&L today and overall, who traded, anything broken (a stopped service, an error, low disk), then the two or three headlines that matter to the positions. Lead with what changed.

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
  // JARVIS's own NIM key first (no contention with the classifier, no free-tier
  // rate limits), then Groq for speed, then the shared NIM key, then OpenAI.
  const nvKey = env.NVIDIA_API_KEY_JARVIS || env.NVIDIA_API_KEY;
  const nvModels = [env.NVIDIA_MODEL_JARVIS || env.NVIDIA_MODEL_TOOLS || "nvidia/nemotron-3-super-120b-a12b", "deepseek-ai/deepseek-v4-flash-0731", "mistralai/mistral-large-2-instruct", "nvidia/nemotron-3-ultra-550b-a55b"];   // measured: Super 5-7s, DeepSeek 5-19s, Kimi/GLM 48-90s
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

async function chat(messages, tools, send) {
  const errs = [];
  for (const p of await providers()) {
    const order = p.name === "groq" ? [...p.models.slice(groqTurn++ % p.models.length), ...p.models.slice(0, groqTurn % p.models.length)] : [picked.get(p.name), ...p.models];
    for (const model of order.filter((v, i, a) => v && a.indexOf(v) === i)) {
      try {
        const r = await fetch(`${p.base}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(p.name === "nvidia" ? 120_000 : 60_000),
          headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
          body: JSON.stringify({ model, messages, tools, tool_choice: "auto", max_tokens: 900, temperature: 0.3, stream: true }) });
        if (!r.ok) { let j = {}; try { j = await r.json(); } catch {} const e = `${p.name}/${model} ${r.status} ${JSON.stringify(j.error ?? "").slice(0, 160)}`; errs.push(e); console.error("[brain] fallback:", e); if (![400, 404, 410, 429, 503].includes(r.status)) break; continue; }
        // stream: text deltas go to the browser as they arrive; tool calls are assembled
        const msg = { role: "assistant", content: "", tool_calls: [] }; const calls = new Map(); let buf = "";
        const reader = r.body.getReader(); const dec = new TextDecoder();
        while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line.startsWith("data:")) continue; const data = line.slice(5).trim(); if (data === "[DONE]") continue;
            let ev; try { ev = JSON.parse(data); } catch { continue; } const d = ev.choices?.[0]?.delta; if (!d) continue;
            if (d.content) { msg.content += d.content; send?.({ type: "delta", text: d.content }); }
            for (const tc of d.tool_calls ?? []) { const c = calls.get(tc.index) ?? { id: tc.id, type: "function", function: { name: "", arguments: "" } }; if (tc.id) c.id = tc.id; if (tc.function?.name) c.function.name += tc.function.name; if (tc.function?.arguments) c.function.arguments += tc.function.arguments; calls.set(tc.index, c); } } }
        for (const line of buf.split("\n")) { const l = line.trim(); if (!l.startsWith("data:") || l.slice(5).trim() === "[DONE]") continue; try { const d = JSON.parse(l.slice(5)).choices?.[0]?.delta; if (d?.content) { msg.content += d.content; send?.({ type: "delta", text: d.content }); } } catch {} }
        msg.tool_calls = [...calls.values()]; if (!msg.tool_calls.length) delete msg.tool_calls;
        picked.set(p.name, model); return { msg, brain: `${p.name}/${model}` };
      } catch (e) { errs.push(`${p.name}/${model} ${String(e.message).slice(0, 60)}`); break; }
    }
  }
  throw new Error("no platform brain answered: " + errs.join(" | "));
}
// Only the tools a question can plausibly need travel with it. The four core
// tools always go; the rest are picked by topic. Keeps a turn near 3k tokens.
const CORE_TOOLS = ["navigate", "fleet_status", "desk_api", "recall"];
const TOPICS = [
  [/news|headline|world|happening|market.?s?\b|wire|crypto|geopolit|oil|war/i, ["news"]],
  [/research|paper|arxiv|scholar|study|read\b|literature|search the web|look up|google/i, ["arxiv_search", "scholar_search", "web_search", "read_url", "write_note"]],
  [/create|new bot|make a bot|build a bot|my bots|spec bot|pause|resume|retire/i, ["create_bot", "list_bots", "set_bot"]],
  [/fix|change|bug|code|why does|why is .* (losing|broken)|source|function|file/i, ["read_code", "search_code", "propose_fix"]],
  [/health|running|down|degraded|working|broken|status|everything ok/i, ["health_check"]],
  [/brief|morning|status|summary|what happened|since yesterday|overnight/i, ["morning_brief"]],
  [/backtest|strategy|sharpe|edge|blend|weights|overfit|holdout|momentum|rsi/i, ["backtest_results", "propose_strategy", "run_backtest"]],
  [/forecast|predict|scenario|will .* go up|monte/i, ["scenario_forecast"]],
  [/safe|safety|assert|invariant|cap|proving/i, ["safety_proof"]],
  [/venue|exchange|where can|trade from|canada|kraken|hyperliquid|polymarket|kalshi/i, ["venues"]],
  [/start|stop|restart|kick|log of|logs?\b|service/i, ["fleet_control"]],
  [/remember|note this|keep in mind|memory|desk state|forget/i, ["remember", "update_desk_state"]],
  [/second opinion|cross.?check|ask astra|ask the 550|deep think/i, ["second_opinion"]],
  [/test|pytest/i, ["run_tests"]],
];
function pickTools(q) {
  const want = new Set(CORE_TOOLS);
  for (const [re, names] of TOPICS) if (re.test(q)) names.forEach((x) => want.add(x));
  if (want.size <= CORE_TOOLS.length) ["morning_brief", "news", "health_check"].forEach((x) => want.add(x));
  return REGISTRY.filter((t) => want.has(t.name));
}

// Something on screen within a few milliseconds, whichever brain ends up
// answering. Replaced by the real answer when it lands.
const ACK = { navigate: "Opening it.", morning_brief: "Pulling the briefing.", health_check: "Checking every feed.", news: "Reading the wire.", backtest_results: "Checking the backtests.",
  scenario_forecast: "Running the scenarios — about ten seconds.", propose_strategy: "Judging it on holdout — about twenty seconds.", create_bot: "Building it.", read_code: "Reading the code.", arxiv_search: "Searching the literature." };
function ack(q, picked) { const hit = picked.find((t) => ACK[t.name] && t.name !== "navigate" && t.name !== "desk_api" && t.name !== "fleet_status" && t.name !== "recall"); if (/open|show|go to|take me/i.test(q)) return ACK.navigate; return hit ? ACK[hit.name] : "On it."; }

async function platformTurn(q, send) {
  const chosen = pickTools(q);
  send({ type: "delta", text: ack(q, chosen) + " " });
  const tools = chosen.map((t) => { const p = zodToJsonSchema(t.schema, { target: "openApi3" }); delete p.$schema;
    for (const v of Object.values(p.properties ?? {})) { if (v.enum && v.enum.length > 12) { v.description = `one of ${v.enum.length} known values; the tool corrects near-misses`; delete v.enum; } }
    return { type: "function", function: { name: t.name, description: t.description.split(/(?<=[.!?])\s/)[0].slice(0, 160), parameters: p } }; });
  let history = (await loadThread()).slice(-8).map((m) => (m.role === "tool" ? { ...m, content: String(m.content).slice(0, 500) } : m));
  const firstUser = history.findIndex((m) => m.role === "user"); history = firstUser >= 0 ? history.slice(firstUser) : [];   // never start on an orphaned tool result
  const messages = [{ role: "system", content: (await systemPrompt()).slice(0, 5200) }, ...history, { role: "user", content: q }];
  let answer = "", brain = "";
  for (let step = 0; step < 24; step++) {
    const { msg, brain: b } = await chat(messages, tools, send); brain = b;
    messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) { answer = msg.content ?? ""; break; }
    const results = await Promise.all(msg.tool_calls.map(async (call) => {
      const t = REGISTRY.find((x) => x.name === call.function.name);
      let args = {}; try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
      send({ type: "tool", name: call.function.name });
      if (!t) return { id: call.id, out: "unknown tool" };
      const parsed = t.schema.safeParse(nearest(t, args));
      if (!parsed.success) return { id: call.id, out: `bad arguments: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}` };
      try { const r = await t.handler(parsed.data); let out = (r.content ?? []).map((c) => c.text ?? "").join("\n"); if (r.isError) out = "ERROR: " + out; return { id: call.id, out }; }
      catch (e) { return { id: call.id, out: "tool failed: " + String(e.message).slice(0, 200) }; }
    }));
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: String(r.out).slice(0, 12_000) });
  }
  await saveThread(messages.slice(1));   // everything but the system prompt
  return { answer: answer || "I could not complete that.", brain };
}
const BRAIN = (process.env.JARVIS_BRAIN || "platform").toLowerCase();
async function saveState(s) { await writeFile(STATE, JSON.stringify(s)); }

const TOOLS = ["navigate", "fleet_status", "backtest_results", "safety_proof", "venues", "desk_api", "news", "morning_brief", "read_code", "search_code", "propose_fix",
  "arxiv_search", "scholar_search", "web_search", "read_url", "write_note", "second_opinion", "update_desk_state", "health_check", "scenario_forecast", "propose_strategy", "run_backtest", "run_tests", "fleet_control", "create_bot", "list_bots", "set_bot", "remember", "recall"];
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
