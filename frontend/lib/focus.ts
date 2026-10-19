import { exec } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

// STOCK FOCUS — one switch that gives the machine to the stock desk.
// On: every service that is not about stocks/options is stopped and disabled,
// so it stays down across restarts and logins and its memory and CPU go to
// the stock bots. Off: each is enabled and started again.
// Kept running either way: the dashboard, databases, AXIOM's voice/chat, the
// Council, the stock and options bots, macro data, news, reports, cleanup.

const run = promisify(exec);
export const NON_STOCK = [
  "dryrun.weather", "dryrun.oraclelag", "dryrun.crypto", "dryrun.kronos1h", "dryrun.newslag",
  "bot", "wsbridge", "weatheralerts", "dryrun.montecarlo", "autotuner", "worldmonitor", "agent402",
];
export const STOCK = ["dryrun.options", "dryrun.gammapulse", "dryrun.stocksbot", "dryrun.premarket", "dryrun.vwap", "data.openbb"];

const STATE = path.join(process.cwd(), "..", ".data", "focus.json");
const AGENTS = path.join(os.homedir(), "Library", "LaunchAgents");
const uid = () => process.getuid?.() ?? 501;

export async function focusState(): Promise<{ stocks: boolean; since: number | null }> {
  try { return JSON.parse(await fs.readFile(STATE, "utf-8")); } catch { return { stocks: false, since: null }; }
}

export async function setFocus(stocks: boolean) {
  const done: string[] = [];
  for (const name of NON_STOCK) {
    const label = `com.polymarket.${name}`, plist = path.join(AGENTS, `${label}.plist`);
    try { await fs.access(plist); } catch { continue; }          // not installed on this machine
    if (stocks) {
      await run(`launchctl disable gui/${uid()}/${label}`).catch(() => {});
      await run(`launchctl bootout gui/${uid()}/${label}`).catch(() => {});
    } else {
      await run(`launchctl enable gui/${uid()}/${label}`).catch(() => {});
      await run(`launchctl bootstrap gui/${uid()} "${plist}"`).catch(() => {});
    }
    done.push(name);
  }
  const state = { stocks, since: stocks ? Date.now() : null };
  await fs.writeFile(STATE, JSON.stringify(state));
  return { ...state, services: done };
}
