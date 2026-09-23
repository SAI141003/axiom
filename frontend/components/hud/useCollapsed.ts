"use client";

import { useEffect, useState } from "react";

// A panel's open/closed state, remembered per browser so the home screen
// stays the way it was left.
export function useCollapsed(id: string, initial = false) {
  const key = `axiom:collapsed:${id}`;
  const [collapsed, setCollapsed] = useState(initial);
  useEffect(() => {
    try { const v = localStorage.getItem(key); if (v != null) setCollapsed(v === "1"); } catch {}
  }, [key]);
  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(key, c ? "0" : "1"); } catch {}
    return !c;
  });
  return [collapsed, toggle] as const;
}
