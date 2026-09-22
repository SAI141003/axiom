"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X, Mic, Sparkles, Send } from "lucide-react";
import { useJarvis } from "@/lib/jarvis";
import { Reactor, toneFor } from "./Reactor";
import { Transcript } from "./Transcript";

const PAGE_NAMES: Record<string, string> = {
  "/": "the home page", "/bots": "the bot fleet", "/lab": "the research lab", "/tape": "the tape replay", "/terminal": "the terminal",
  "/council": "the council", "/brain": "the brain", "/workforce": "the workforce", "/crypto": "the crypto auto-bot", "/weather": "the weather desk",
  "/premarket": "the pre-market scanner", "/options": "the options desk", "/stocks": "the stocks desk", "/arbitrage": "the arbitrage scanner",
  "/live": "the markets page", "/oracle": "the oracle", "/intel": "the intel desk", "/news": "the news desk", "/journal": "the journal",
  "/live-account": "the live account page", "/venues": "the venues map", "/settings": "the keys and settings page",
};
const PAGE_API: Record<string, string> = {
  "/bots": "/api/fleet", "/lab": "/api/backtest-lab", "/tape": "/api/tape", "/council": "/api/council/review/latest", "/brain": "/api/brain",
  "/crypto": "/api/crypto/trades", "/weather": "/api/weather/picks", "/options": "/api/options", "/stocks": "/api/stocks", "/arbitrage": "/api/arb",
  "/live": "/api/markets", "/oracle": "/api/oracle", "/intel": "/api/intel", "/news": "/api/newsdesk", "/journal": "/api/journal",
  "/live-account": "/api/live/balance", "/venues": "/api/venues", "/premarket": "/api/premarket",
};

// AXIOM on every page. A reactor in the corner; click it and the desk's voice
// slides in already knowing which page you are looking at and which endpoint
// feeds it, so "what am I looking at?" and "why is this red?" just work.
export default function JarvisDock() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const j = useJarvis({
    voice: true,
    listen: pathname !== "/mind",   // the AXIOM page owns the mic there; the dock owns it everywhere else
    context: () => `[Context: the user is looking at ${PAGE_NAMES[pathname] ?? pathname}${PAGE_API[pathname] ? `; its data comes from desk_api ${PAGE_API[pathname]}` : ""}. Answer about what they can see when it is relevant.]`,
  });
  const [input, setInput] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { const h = () => setOpen(true); window.addEventListener("axiom:jarvis-open", h); return () => window.removeEventListener("axiom:jarvis-open", h); }, []);
  // Arrival briefing: coming back to the desk after six hours away, AXIOM
  // opens and briefs without being asked -- the OS greets you.
  useEffect(() => {
    if (pathname !== "/" || j.bridge !== "online") return;
    try {
      const last = Number(localStorage.getItem("axiom.lastBrief") || 0);
      if (Date.now() - last > 6 * 3600_000) { localStorage.setItem("axiom.lastBrief", String(Date.now())); setOpen(true); const t = setTimeout(() => j.ask("Good to have you back. Give me the status briefing."), 1200); return () => clearTimeout(t); }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, j.bridge]);
  useEffect(() => { const h = (e: Event) => { setOpen(true); j.ask((e as CustomEvent).detail); }; window.addEventListener("axiom:jarvis-ask", h); return () => window.removeEventListener("axiom:jarvis-ask", h); }, [j]);

  useEffect(() => { if (j.state === "thinking" || j.state === "speaking") setOpen(true); }, [j.state]);
  if (pathname === "/mind") return null;
  const tone = toneFor(j.state);

  return (
    <>
      <div className="fixed z-[90] right-5 bottom-5 flex items-center gap-3">
        <AnimatePresence>
          {j.micOk === false && <motion.button key="mic" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => j.listen(true)} className="hud-chip" style={{ color: "var(--hud-red)" }} title="Chrome blocked the microphone — click the lock icon in the address bar, allow Microphone, then click here">mic blocked — allow it</motion.button>}
          {j.voiceLocked && <motion.span key="voice" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="hud-chip" style={{ color: "var(--hud-amber)" }}>tap anywhere once to unlock voice</motion.span>}
          {!open && j.state !== "idle" && (
            <motion.span key="state" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="hud-chip" style={{ color: tone }}>{j.state === "listening" ? "listening for “hey Axiom”" : j.state}</motion.span>
          )}
        </AnimatePresence>
        <motion.div whileTap={reduced ? {} : { scale: 0.96 }}>
          <Reactor state={j.state} size={64} onClick={() => setOpen((o) => !o)} label={open ? "close AXIOM" : "open AXIOM (⌘J)"} />
        </motion.div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.aside key="dock" role="dialog" aria-label="AXIOM" aria-modal="false"
                        initial={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.98 }}
                        transition={{ type: "spring", damping: 24, stiffness: 220 }}
                        className="fixed z-[89] right-5 bottom-24 w-[min(420px,calc(100vw-2.5rem))] h-[min(620px,calc(100vh-8rem))] flex flex-col rounded-2xl overflow-hidden hud-glass">
            <header className="flex items-center gap-3 px-4 h-12 border-b shrink-0" style={{ borderColor: "var(--hud-border)" }}>
              <Sparkles size={15} style={{ color: tone }} aria-hidden />
              <div className="min-w-0">
                <div className="text-[11px] font-bold tracking-[0.22em] font-mono" style={{ color: "var(--hud-text)" }}>AXIOM</div>
                <div className="text-[9px] truncate font-mono" style={{ color: "var(--hud-muted)" }}>{j.bridge === "online" ? `${j.brainName || "platform AI"} · on ${PAGE_NAMES[pathname] ?? pathname}` : j.bridge === "connecting" ? "connecting…" : "local fallback — start the bridge for full power"}</div>
              </div>
              <div className="flex-1" />
              <button onClick={j.brief} className="hud-btn hud-btn-accent" title="status briefing">BRIEF</button>
              <button onClick={() => setOpen(false)} aria-label="close" className="hud-icon-btn"><X size={16} /></button>
            </header>
            <Transcript msgs={j.msgs} state={j.state} className="flex-1 p-4"
                        suggestions={["What am I looking at?", "Anything broken right now?", "What changed since yesterday?", "Which bot should I watch today?"]} onPick={j.ask} />
            <form onSubmit={(e) => { e.preventDefault(); j.ask(input); setInput(""); }} className="flex items-center gap-2 p-3 border-t shrink-0" style={{ borderColor: "var(--hud-border)" }}>
              <button type="button" onClick={() => (j.state === "listening" ? j.stopListening() : j.listen(false))} aria-label={j.state === "listening" ? "stop listening" : "talk"} aria-pressed={j.state === "listening"}
                      className="hud-icon-btn" style={{ color: j.state === "listening" ? "var(--hud-green)" : undefined }}><Mic size={16} /></button>
              <label className="sr-only" htmlFor="jarvis-dock-input">Ask AXIOM</label>
              <input id="jarvis-dock-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ask about this page…" autoComplete="off"
                     className="hud-input flex-1 min-w-0" />
              <button type="submit" disabled={j.state === "thinking" || !input.trim()} aria-label="send" className="hud-icon-btn hud-icon-btn-accent"><Send size={16} /></button>
            </form>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
