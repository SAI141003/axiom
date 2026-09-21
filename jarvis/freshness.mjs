/**
 * AXIOM weekly freshness study. Every Sunday: probe every feed, then go and
 * check whether anything the desk depends on has changed -- API deprecations,
 * new model releases, new benchmark results, new papers on the desk's methods.
 * Writes a note and updates the desk state, so nothing quietly rots.
 */
import WebSocket from "ws";
const PROMPT = `Weekly freshness study, unattended:
1. Run health_check. List anything degraded or down.
2. For each of these, web_search for changes in the last 30 days and read_url the most authoritative hit: CCXT/Kraken API changes; Polymarket API changes; Open-Meteo API changes; DexScreener and PumpPortal API changes; the Claude Agent SDK; OpenAI's newest models and their ARC-AGI results; and any new arXiv papers (arxiv_search, last month) on order-flow trading, prediction-market microstructure, or LLM trading agents.
3. write_note titled "Weekly freshness <date>": what changed, what it means for the desk, and what should be updated, with URLs.
4. update_desk_state with the current picture.
5. Four spoken sentences for the morning brief. No markdown.`;
const ws = new WebSocket("ws://127.0.0.1:8788", { headers: { origin: "http://localhost:3000" } });
setTimeout(() => { console.error("[freshness] timed out"); process.exit(2); }, 20 * 60_000);
ws.on("open", () => ws.send(JSON.stringify({ type: "ask", text: PROMPT })));
ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "tool") process.stdout.write(`[freshness] ${m.name}\n`); if (m.type === "done") { console.log(`[freshness] ${new Date().toISOString()}\n${m.text}`); process.exit(0); } });
ws.on("error", (e) => { console.error("[freshness] bridge not reachable:", e.message); process.exit(1); });
