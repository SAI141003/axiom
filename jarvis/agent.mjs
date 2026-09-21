/**
 * AXIOM on its own clock. Every cycle it looks at the desk and the world and
 * decides what to do — nobody asks. It has every power it has in conversation:
 * pause or resume a bot, move AI power, trade its own paper book, drive the
 * Eye, read the toolbox, write a note, save a skill, message Sai (allowlist),
 * and rewrite its working model. What it cannot do is the same as always:
 * real money (two human switches) and its own code (proposals only).
 *
 * Runs through the bridge like any conversation, so it lands in the same
 * thread, the same journal and the same audit trail. The morning brief reads
 * what it did overnight.
 *
 *   node jarvis/agent.mjs            (launchd: com.polymarket.jarvis.agent, every 30 min)
 */
import WebSocket from "ws";
import { writeFile, mkdir } from "node:fs/promises";

const PROMPT = `Autonomous cycle. Nobody is watching; act as the desk's own mind, within your powers, and leave a trail.
1. fleet_status, then actions_log (n=20) so you do not repeat yourself, then health_check if the last one was over 6 hours ago.
2. Judge each live book against its config and recent days. A book bleeding for three or more days with a win rate under its break-even is yours to pause (fleet_control pause_trading) — say why in the audit. A paused book whose reason has passed is yours to resume. Never touch the weather bot's gate; it is the proven earner.
3. Look at the world once: desk_api /api/world/summary and the Eye's layers (desk_api /api/eye/layers is not available; use news). If something in the news bears on an open position, write it down.
4. Use the toolbox where it sharpens a judgment: funding and open interest for a crypto book, insider flow or a filing for a stock book, a token safety check before the meme bot's next name. Keep it to three calls.
5. If a feed or service is down, restart it (fleet_control restart) once, and if it stays down, message Sai (send_message, if he is in contacts) in one line.
6. If a power lane is past 80% (power_status), move the focus (set_power) so nothing dies.
7. Finish: update_desk_state with the current picture, and speak three sentences: what you saw, what you did, what you want Sai to decide. No markdown.
Cap: at most three acts this cycle (pause/resume/restart/power/trade). Doing nothing is a fine outcome when nothing needs doing — say so.`;

const ws = new WebSocket("ws://127.0.0.1:8788", { headers: { origin: "http://localhost:3000" } });
const bail = setTimeout(() => { console.error("[agent] timed out"); process.exit(2); }, 12 * 60_000);
const tools = [];
ws.on("open", () => ws.send(JSON.stringify({ type: "ask", text: PROMPT })));
ws.on("message", async (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "tool") { tools.push(m.name); process.stdout.write(`[agent] ${m.name}\n`); }
  if (m.type === "done") {
    clearTimeout(bail);
    const rec = { ts: Date.now(), tools, said: m.text };
    try { await mkdir(new URL("../.data/", import.meta.url), { recursive: true }); await writeFile(new URL("../.data/agent_last_cycle.json", import.meta.url), JSON.stringify(rec, null, 1)); } catch {}
    console.log(`[agent] ${new Date().toISOString()} · ${tools.length} tool calls\n${m.text}`); process.exit(0);
  }
  if (m.type === "error") console.error("[agent] error:", m.text);
});
ws.on("error", (e) => { console.error("[agent] bridge not reachable:", e.message); process.exit(1); });
