import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const run = promisify(exec);

// Live agent census for the brain HUD:
//   - services: launchd-managed processes (daemons, bot, server) — running if
//     they have a live PID
//   - swarm: the in-bot MiroFish agents (from /api/brain, with alive flags)
export async function GET() {
  let svcTotal = 0, svcRunning = 0, svcScheduled = 0, svcDown = 0;
  const services: { name: string; state: "running" | "scheduled" | "down" }[] = [];
  try {
    const { stdout } = await run("launchctl list | grep com.polymarket");
    for (const line of stdout.trim().split("\n")) {
      const parts = line.split(/\s+/);
      const pid = parts[0], exit = parts[1], label = parts[2] ?? "";
      const name = label.replace("com.polymarket.", "").replace("dryrun.", "");
      // PID present = actively running; no PID + clean exit 0 = a periodic job
      // idle between fires (healthy); no PID + nonzero exit = actually down.
      const hasPid = pid !== "-" && pid !== "";
      const state = hasPid ? "running" : (exit === "0" ? "scheduled" : "down");
      services.push({ name, state });
      svcTotal++;
      if (state === "running") svcRunning++;
      else if (state === "scheduled") svcScheduled++;
      else svcDown++;
    }
  } catch { /* launchctl best-effort */ }
  const svcHealthy = svcRunning + svcScheduled;

  let swarmTotal = 0, swarmAlive = 0;
  try {
    const brain = await fetch("http://localhost:3000/api/brain", { cache: "no-store" }).then((r) => r.json());
    const agents = brain?.agents ?? [];
    swarmTotal = agents.length;
    swarmAlive = agents.filter((a: any) => a.alive).length;
  } catch { /* best-effort */ }

  // MiroFish micro-agent population (from the swarm backend on :5001)
  let mirofish = { online: false, population: 0, archetypes: 0, model: "" };
  try {
    const h = await fetch("http://localhost:5001/", { cache: "no-store", signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    mirofish = { online: true, population: h.population ?? 0, archetypes: h.archetypes ?? 0, model: h.micro_model ?? "" };
  } catch { /* swarm offline */ }

  return NextResponse.json({
    services: { total: svcTotal, running: svcRunning, scheduled: svcScheduled,
                down: svcDown, healthy: svcHealthy, list: services },
    swarm: { total: swarmTotal, alive: swarmAlive },
    mirofish,
    // headline total = system agents + the MiroFish micro-agent population
    total: svcTotal + swarmTotal + mirofish.population,
    running: svcHealthy + swarmAlive + (mirofish.online ? mirofish.population : 0),
    down: svcDown,
    generated: Date.now(),
  });
}
