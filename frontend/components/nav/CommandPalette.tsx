"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Search, Sparkles, CornerDownLeft } from "lucide-react";
import { PAGES } from "./pages";

// ⌘K. Type a page name to jump, or type a question and press enter to ask
// JARVIS — the palette hands it to the dock, which opens with the answer.
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const reduced = useReducedMotion();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const openH = () => setOpen(true);
    window.addEventListener("axiom:palette-open", openH);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("axiom:palette-open", openH); };
  }, []);
  useEffect(() => { if (open) { setQ(""); setI(0); setTimeout(() => input.current?.focus(), 30); } }, [open]);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return PAGES;
    return PAGES.filter((p) => `${p.label} ${p.hint} ${p.keywords ?? ""} ${p.href}`.toLowerCase().includes(s));
  }, [q]);
  const askable = q.trim().length > 2;
  const rows = askable ? hits.length + 1 : hits.length;

  const go = (idx: number) => {
    if (askable && idx === hits.length) { window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: q.trim() })); setOpen(false); return; }
    const p = hits[idx]; if (!p) return;
    router.push(p.href); setOpen(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div key="pal" className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
                    style={{ background: "rgba(5,7,12,0.55)", backdropFilter: "blur(6px)" }} onClick={() => setOpen(false)}>
          <motion.div role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}
                      initial={reduced ? false : { opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
                      transition={{ type: "spring", damping: 26, stiffness: 300 }} className="hud-glass w-full max-w-xl rounded-2xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 h-14 border-b" style={{ borderColor: "var(--hud-border)" }}>
              <Search size={16} style={{ color: "var(--hud-muted)" }} aria-hidden />
              <label htmlFor="palette-input" className="sr-only">Go to a page or ask JARVIS</label>
              <input id="palette-input" ref={input} value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} placeholder="go to a page, or ask JARVIS anything…" autoComplete="off"
                     onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(rows - 1, x + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); } if (e.key === "Enter") { e.preventDefault(); go(i); } }}
                     className="flex-1 bg-transparent outline-none text-[14px] prose-sans" style={{ color: "var(--hud-text)" }} />
              <kbd className="hud-kbd">esc</kbd>
            </div>
            <ul role="listbox" className="max-h-[52vh] overflow-y-auto py-2">
              {hits.map((p, idx) => {
                const Icon = p.icon; const active = idx === i;
                return (
                  <li key={p.href} role="option" aria-selected={active} onMouseEnter={() => setI(idx)} onClick={() => go(idx)}
                      className="flex items-center gap-3 px-4 min-h-[44px] cursor-pointer" style={{ background: active ? "var(--hud-accent-soft)" : "transparent" }}>
                    <Icon size={16} style={{ color: active ? "var(--hud-accent)" : "var(--hud-muted)" }} aria-hidden />
                    <span className="text-[13px] font-medium prose-sans" style={{ color: "var(--hud-text)" }}>{p.label}</span>
                    <span className="text-[12px] truncate prose-sans" style={{ color: "var(--hud-muted)" }}>{p.hint}</span>
                    <span className="flex-1" />
                    <span className="text-[10px] font-mono" style={{ color: "var(--hud-muted)" }}>{p.href}</span>
                  </li>
                );
              })}
              {askable && (
                <li role="option" aria-selected={i === hits.length} onMouseEnter={() => setI(hits.length)} onClick={() => go(hits.length)}
                    className="flex items-center gap-3 px-4 min-h-[48px] cursor-pointer border-t mt-1" style={{ background: i === hits.length ? "var(--hud-accent-soft)" : "transparent", borderColor: "var(--hud-border)" }}>
                  <Sparkles size={16} style={{ color: "var(--hud-accent)" }} aria-hidden />
                  <span className="text-[13px] prose-sans" style={{ color: "var(--hud-text)" }}>Ask JARVIS: <em style={{ color: "var(--hud-accent-2)" }}>{q.trim()}</em></span>
                  <span className="flex-1" />
                  <CornerDownLeft size={14} style={{ color: "var(--hud-muted)" }} aria-hidden />
                </li>
              )}
              {!hits.length && !askable && <li className="px-4 py-6 text-[12px] text-center prose-sans" style={{ color: "var(--hud-muted)" }}>nothing matches</li>}
            </ul>
            <div className="flex items-center gap-4 px-4 h-9 border-t text-[10px] font-mono" style={{ borderColor: "var(--hud-border)", color: "var(--hud-muted)" }}>
              <span><kbd className="hud-kbd">↑↓</kbd> move</span><span><kbd className="hud-kbd">↵</kbd> open</span><span><kbd className="hud-kbd">⌘J</kbd> JARVIS</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
