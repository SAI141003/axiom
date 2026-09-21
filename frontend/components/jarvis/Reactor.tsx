"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Brain } from "lucide-react";
import type { JarvisState } from "@/lib/jarvis";

export const toneFor = (state: JarvisState) =>
  state === "listening" ? "var(--hud-green)" : state === "thinking" ? "var(--hud-amber)" : state === "speaking" ? "var(--hud-accent-2)" : "var(--hud-accent)";

// The arc reactor. Three counter-rotating rings, a breathing core, the AXIOM
// mark cut into it. Speed and colour follow the assistant's state so you can
// read what it is doing from across the room.
export function Reactor({ state, size = 260, onClick, label = "talk to AXIOM" }: { state: JarvisState; size?: number; onClick?: () => void; label?: string }) {
  const reduced = useReducedMotion();
  const color = toneFor(state);
  const spin = reduced ? 0 : state === "thinking" ? 2.2 : state === "speaking" ? 6 : 16;
  const core = size * 0.3;
  return (
    <button onClick={onClick} aria-label={label} className="relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#070a12] cursor-pointer"
            style={{ width: size, height: size, background: "radial-gradient(circle, rgba(76,201,255,0.12) 0%, rgba(10,12,17,0) 68%)", ["--tw-ring-color" as any]: color }}>
      <motion.svg viewBox="0 0 200 200" className="absolute inset-0 w-full h-full" animate={spin ? { rotate: 360 } : {}} transition={{ repeat: Infinity, ease: "linear", duration: spin || 1 }}>
        <circle cx="100" cy="100" r="93" fill="none" stroke={color} strokeWidth="0.8" strokeDasharray="3 9" opacity="0.45" />
        <circle cx="100" cy="100" r="80" fill="none" stroke={color} strokeWidth="2.2" strokeDasharray="46 22" opacity="0.85" strokeLinecap="round" />
      </motion.svg>
      <motion.svg viewBox="0 0 200 200" className="absolute inset-0 w-full h-full" animate={spin ? { rotate: -360 } : {}} transition={{ repeat: Infinity, ease: "linear", duration: (spin || 1) * 1.7 }}>
        <circle cx="100" cy="100" r="64" fill="none" stroke={color} strokeWidth="1.4" strokeDasharray="12 7" opacity="0.7" />
        {Array.from({ length: 24 }).map((_, i) => (
          <line key={i} x1="100" y1="28" x2="100" y2={i % 3 === 0 ? 36 : 32} stroke={color} strokeWidth={i % 3 === 0 ? 2 : 1} opacity="0.55" transform={`rotate(${i * 15} 100 100)`} />
        ))}
      </motion.svg>
      <motion.svg viewBox="0 0 200 200" className="absolute inset-0 w-full h-full" animate={spin ? { rotate: 360 } : {}} transition={{ repeat: Infinity, ease: "linear", duration: (spin || 1) * 0.9 }}>
        <circle cx="100" cy="100" r="48" fill="none" stroke={color} strokeWidth="1" strokeDasharray="60 40" opacity="0.5" />
      </motion.svg>
      <motion.div className="absolute rounded-full" style={{ inset: (size - core) / 2, background: `radial-gradient(circle at 40% 35%, #ffffff 0%, ${color} 38%, var(--hud-accent-deep) 100%)`, boxShadow: `0 0 ${size * 0.15}px ${color}, 0 0 ${size * 0.35}px ${color}55` }}
                  animate={reduced ? {} : { scale: state === "listening" ? [1, 1.16, 1] : state === "speaking" ? [1, 1.08, 0.96, 1] : [1, 1.035, 1] }}
                  transition={{ repeat: Infinity, duration: state === "speaking" ? 0.5 : state === "listening" ? 1.1 : 2.4, ease: "easeInOut" }} />
      <span className="absolute inset-0 grid place-items-center" aria-hidden="true"><Brain size={core * 0.52} strokeWidth={1.6} color="#070a12" /></span>
    </button>
  );
}
