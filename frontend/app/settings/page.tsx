"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";
import { TOGGLES, getToggle, setToggle } from "@/lib/toggles";

interface KeyRow {
  name: string; scope: "frontend" | "backend"; label: string; group: string;
  set: boolean; disabled?: boolean; hint: string;
}

export default function SettingsPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [dryRun, setDryRun] = useState(true);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [restarting, setRestarting] = useState(false);
  const [tstate, setTstate] = useState<Record<string, boolean>>({});
  const [bots, setBots] = useState<{ key: string; name: string; desc: string; enabled: boolean }[]>([]);

  useEffect(() => {
    setTstate(Object.fromEntries(TOGGLES.map((t) => [t.key, getToggle(t.key)])));
    fetch("/api/bots").then((r) => r.json()).then((d) => setBots(d.bots ?? [])).catch(() => {});
  }, []);

  const flipBot = async (key: string, enabled: boolean) => {
    setBots((bs) => bs.map((b) => b.key === key ? { ...b, enabled } : b));
    await fetch("/api/bots", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, enabled }) });
  };

  const flip = (key: string) => {
    const next = !(tstate[key] ?? true);
    setToggle(key, next);
    setTstate((s) => ({ ...s, [key]: next }));
  };

  const toggleKey = async (name: string, disabled: boolean) => {
    const res = await fetch("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, action: disabled ? "enable" : "disable" }),
    });
    const d = await res.json();
    setMsg((m) => ({ ...m, [name]: res.ok ? `✓ ${d.note}` : `⚠ ${d.error}` }));
    load();
  };

  const load = async () => {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const d = await res.json();
      setKeys(d.keys ?? []);
      setDryRun(d.dryRun);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async (name: string) => {
    const value = edit[name] ?? "";
    const res = await fetch("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, value }),
    });
    const d = await res.json();
    setMsg((m) => ({ ...m, [name]: res.ok ? `✓ ${d.note}` : `⚠ ${d.error}` }));
    setEdit((e) => ({ ...e, [name]: "" }));
    load();
  };

  const restartBot = async () => {
    setRestarting(true);
    try {
      const res = await fetch("/api/settings/restart", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: "bot" }),
      });
      const d = await res.json();
      setMsg((m) => ({ ...m, _bot: res.ok ? "✓ bot restarted with new keys" : `⚠ ${d.error}` }));
    } finally {
      setRestarting(false);
    }
  };

  const groups = Array.from(new Set(keys.map((k) => k.group)));

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-3xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.2em] glow-cyan">⚙ SETTINGS — API KEYS</h1>
        <p className="text-xs mt-1 mb-6" style={{ color: "var(--hud-muted)" }}>
          Paste keys here instead of chat — they go straight to the local env files
          (gitignored, never leave this machine). Values are never displayed back, only last 4 chars.
        </p>

        {/* Trading mode banner */}
        <div className="hud-panel hud-panel-static p-4 mb-6 text-xs flex items-center gap-3">
          <span className="hud-led inline-block"
                style={{ color: dryRun ? "var(--hud-amber)" : "var(--hud-red)", background: dryRun ? "var(--hud-amber)" : "var(--hud-red)" }} />
          <div>
            <span className="font-bold" style={{ color: dryRun ? "var(--hud-amber)" : "var(--hud-red)" }}>
              {dryRun ? "DRY-RUN MODE — no real orders" : "⚠ LIVE TRADING ENABLED"}
            </span>
            <div style={{ color: "var(--hud-muted)" }} className="mt-0.5">
              By design there is no toggle here: going live requires manually setting DRY_RUN=false
              in the backend .env — a deliberate two-step safety barrier.
            </div>
          </div>
        </div>

        {/* Strategy bot master switches */}
        <div className="mb-6">
          <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-green)" }}>
            STRATEGY BOTS · MASTER ON / OFF
          </div>
          <div className="hud-panel hud-panel-static">
            {bots.map((b) => (
              <div key={b.key} className="flex items-center gap-3 px-4 py-2.5"
                   style={{ borderTop: "1px solid var(--hud-border)" }}>
                <div className="flex-1">
                  <div className="text-xs font-bold">{b.name}</div>
                  <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>{b.desc}</div>
                </div>
                <span className="text-[9px] tracking-widest mr-1"
                      style={{ color: b.enabled ? "var(--hud-green)" : "var(--hud-muted)" }}>
                  {b.enabled ? "TRADING" : "OFF"}
                </span>
                <button onClick={() => flipBot(b.key, !b.enabled)}
                        className="relative flex-shrink-0"
                        style={{ width: 38, height: 20, borderRadius: 99, cursor: "pointer",
                                 background: b.enabled ? "rgba(62,207,142,0.35)" : "var(--hud-border)",
                                 border: `1px solid ${b.enabled ? "var(--hud-green)" : "var(--hud-border)"}` }}>
                  <span style={{ position: "absolute", top: 2, left: b.enabled ? 19 : 2,
                                 width: 14, height: 14, borderRadius: 99,
                                 background: b.enabled ? "var(--hud-green)" : "var(--hud-muted)",
                                 transition: "left 0.2s" }} />
                </button>
              </div>
            ))}
          </div>
          <div className="text-[10px] mt-1.5" style={{ color: "var(--hud-muted)" }}>
            Off = the bot stops placing trades (still records data for the learner). Weather is off
            by default — it has been net-negative in testing.
          </div>
        </div>

        {/* Per-page automation toggles */}
        <div className="mb-6">
          <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-accent)" }}>
            AUTOMATION TOGGLES · PER PAGE
          </div>
          <div className="hud-panel hud-panel-static divide-y" style={{ borderColor: "var(--hud-border)" }}>
            {TOGGLES.map((t) => {
              const on = tstate[t.key] ?? true;
              return (
                <div key={t.key} className="flex items-center gap-3 px-4 py-2.5"
                     style={{ borderColor: "var(--hud-border)" }}>
                  <div className="flex-1">
                    <div className="text-xs">
                      <span className="font-bold">{t.page}</span>
                      <span className="ml-2" style={{ color: "var(--hud-muted)" }}>{t.label}</span>
                    </div>
                    <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>{t.desc}</div>
                  </div>
                  <button onClick={() => flip(t.key)}
                          className="relative flex-shrink-0"
                          style={{ width: 38, height: 20, borderRadius: 99, cursor: "pointer",
                                   background: on ? "rgba(62,207,142,0.35)" : "var(--hud-border)",
                                   border: `1px solid ${on ? "var(--hud-green)" : "var(--hud-border)"}`,
                                   transition: "all 0.2s" }}>
                    <span style={{ position: "absolute", top: 2, left: on ? 19 : 2,
                                   width: 14, height: 14, borderRadius: 99,
                                   background: on ? "var(--hud-green)" : "var(--hud-muted)",
                                   transition: "left 0.2s" }} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {groups.map((g) => (
          <div key={g} className="mb-6">
            <div className="text-[10px] tracking-widest mb-2"
                 style={{ color: g.includes("POLYMARKET") ? "var(--hud-red)" : "var(--hud-violet)" }}>
              {g}
            </div>
            <div className="flex flex-col gap-2">
              {keys.filter((k) => k.group === g).map((k) => (
                <div key={k.name} className="hud-panel hud-panel-static p-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="text-xs">
                      <span className="font-bold">{k.name}</span>
                      <span className="ml-2" style={{ color: "var(--hud-muted)" }}>{k.label}</span>
                    </div>
                    <span className="flex items-center gap-2">
                      <span className="text-[10px] px-2 py-0.5"
                            style={{
                              border: `1px solid ${k.disabled ? "rgba(226,177,88,0.4)" : k.set ? "rgba(52,211,153,0.4)" : "var(--hud-border)"}`,
                              color: k.disabled ? "var(--hud-amber)" : k.set ? "var(--hud-green)" : "var(--hud-muted)",
                            }}>
                        {k.disabled ? `OFF ${k.hint}` : k.set ? `SET ${k.hint}` : "NOT SET"}
                      </span>
                      {k.set && (
                        <button onClick={() => toggleKey(k.name, !!k.disabled)}
                                className="text-[9px] px-2 py-0.5"
                                style={{ border: "1px solid var(--hud-border)", cursor: "pointer",
                                         color: k.disabled ? "var(--hud-green)" : "var(--hud-muted)",
                                         background: "transparent", borderRadius: 99 }}>
                          {k.disabled ? "ENABLE" : "DISABLE"}
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <input
                      type="password"
                      value={edit[k.name] ?? ""}
                      onChange={(e) => setEdit((s) => ({ ...s, [k.name]: e.target.value }))}
                      placeholder={`paste new ${k.name}…`}
                      className="flex-1 px-3 py-1.5 text-xs outline-none"
                      style={{ background: "rgba(6,9,19,0.8)", border: "1px solid var(--hud-border)", color: "var(--hud-text)" }}
                    />
                    <button onClick={() => save(k.name)} disabled={!(edit[k.name] ?? "").trim()}
                            className="hud-chip"
                            style={{ color: "var(--hud-cyan)", cursor: "pointer", opacity: (edit[k.name] ?? "").trim() ? 1 : 0.4 }}>
                      SAVE
                    </button>
                  </div>
                  {msg[k.name] && (
                    <div className="text-[10px] mt-1"
                         style={{ color: msg[k.name].startsWith("✓") ? "var(--hud-green)" : "var(--hud-red)" }}>
                      {msg[k.name]}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Bot restart for backend keys */}
        <div className="hud-panel hud-panel-static p-4 text-xs flex items-center justify-between flex-wrap gap-3">
          <div style={{ color: "var(--hud-muted)" }}>
            Backend keys (Polymarket account, Kalshi, HF) load when the bot starts —
            restart it after saving those.
            {msg._bot && <div className="mt-1" style={{ color: msg._bot.startsWith("✓") ? "var(--hud-green)" : "var(--hud-red)" }}>{msg._bot}</div>}
          </div>
          <button onClick={restartBot} disabled={restarting}
                  className="hud-chip hud-nav-active" style={{ cursor: "pointer", height: 32 }}>
            {restarting ? "⟳ RESTARTING…" : "↻ RESTART BOT"}
          </button>
        </div>

        <p className="text-[10px] mt-6 pb-8" style={{ color: "var(--hud-muted)" }}>
          Storage: AI keys → frontend/.env.local (applied instantly) · account keys → backend .env.
          Both files are gitignored. This page is served only on localhost — do not expose port 3000
          to the internet with keys stored.
        </p>
      </main>
    </div>
  );
}
