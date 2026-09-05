"use client";

/**
 * Per-page automation toggles — user-controlled kill switches for every
 * automatic behavior. Stored in localStorage (single-user local app),
 * readable synchronously, live-updated across tabs via the storage event.
 */

import { useEffect, useState } from "react";

export const TOGGLES: { key: string; label: string; page: string; desc: string }[] = [
  { key: "crypto.autoTrade",   page: "Auto-Bot",    label: "Auto paper-trading",
    desc: "Enter 5-min positions automatically while the page is open" },
  { key: "intel.autoAnalyze",  page: "Intel",       label: "AI auto-review",
    desc: "Run the LLM desk review every 10 minutes (uses Groq calls)" },
  { key: "mirofish.autoRefresh", page: "MiroFish",  label: "Live brain refresh",
    desc: "Poll agents + trades every 5 seconds" },
  { key: "premarket.liveTicks", page: "Pre-Market", label: "Live price ticks",
    desc: "Re-quote prices and gaps every 10 seconds" },
  { key: "options.liveTicks",  page: "Options",     label: "Live underlying ticks",
    desc: "Refresh underlying prices every 15 seconds after a scan" },
  { key: "stocks.liveTicks",   page: "Stocks",      label: "Live quotes",
    desc: "Refresh playbook quotes every 15 seconds" },
  { key: "weather.autoRefresh", page: "Weather",    label: "Auto rescan",
    desc: "Re-run the city scan every 2 minutes" },
  { key: "weatherbot.autoRefresh", page: "Auto-Bot 2", label: "Live refresh",
    desc: "Refresh weather-bot trades every 30 seconds" },
];

const LS = (key: string) => `qd:toggle:${key}`;

export function getToggle(key: string, def = true): boolean {
  if (typeof window === "undefined") return def;
  const v = localStorage.getItem(LS(key));
  return v === null ? def : v === "1";
}

export function setToggle(key: string, on: boolean): void {
  localStorage.setItem(LS(key), on ? "1" : "0");
  window.dispatchEvent(new StorageEvent("storage", { key: LS(key), newValue: on ? "1" : "0" }));
}

/** Reactive hook — re-renders when the toggle changes (any tab). */
export function useToggle(key: string, def = true): boolean {
  const [on, setOn] = useState(def);
  useEffect(() => {
    setOn(getToggle(key, def));
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS(key)) setOn(e.newValue !== "0");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, def]);
  return on;
}
