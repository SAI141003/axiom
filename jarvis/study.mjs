/**
 * JARVIS night study. Once a day, unattended: look at the fleet, pick the
 * weakest book, go read what the literature says about that failure, write a
 * note with citations, and leave one concrete proposal for the morning.
 *
 * Runs through the bridge like any other conversation, so it lands in the
 * same memory and the same journal; the morning brief reports what it found.
 *
 *   node jarvis/study.mjs           (launchd: com.polymarket.jarvis.study, 04:10 daily)
 */
import WebSocket from "ws";

const PROMPT = `Night study. Do this unattended and thoroughly:
1. Call fleet_status. Name the weakest paper book by P&L and win rate, and the strongest.
2. For the weakest: read its config, then search the literature (scholar_search and arxiv_search) for why that kind of strategy loses and what has been shown to fix it. Read at least two sources with read_url (PDFs are fine). Prefer peer-reviewed work and recent arXiv.
3. Write one note with write_note: what you read (title, authors, URL), the two or three findings that apply, and ONE concrete next step for that bot — a propose_fix with exact before/after if it is a code change, or a propose_strategy if it is a blend.
4. Finish with a four-sentence spoken summary for the morning brief. No markdown.`;

const ws = new WebSocket("ws://127.0.0.1:8788", { headers: { origin: "http://localhost:3000" } });
const bail = setTimeout(() => { console.error("[study] timed out"); process.exit(2); }, 15 * 60_000);
ws.on("open", () => ws.send(JSON.stringify({ type: "ask", text: PROMPT })));
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "tool") process.stdout.write(`[study] ${m.name}\n`);
  if (m.type === "done") { clearTimeout(bail); console.log(`[study] ${new Date().toISOString()}\n${m.text}`); process.exit(0); }
  if (m.type === "error") { console.error("[study] error:", m.text); }
});
ws.on("error", (e) => { console.error("[study] bridge not reachable:", e.message); process.exit(1); });
