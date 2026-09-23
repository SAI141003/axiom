"""Figures for the AXIOM paper. Every number comes from the live desk or from a
measured benchmark run; nothing here is illustrative."""
import json, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

plt.rcParams.update({
    "font.family": "serif", "font.serif": ["Times New Roman", "DejaVu Serif"],
    "font.size": 8, "axes.labelsize": 8, "axes.titlesize": 8.5,
    "xtick.labelsize": 7, "ytick.labelsize": 7, "legend.fontsize": 7,
    "axes.spines.top": False, "axes.spines.right": False,
    "figure.dpi": 300, "savefig.bbox": "tight", "savefig.pad_inches": 0.02,
})
# colourblind-safe (Okabe-Ito)
C = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#F0E442", "#999999"]
D = json.load(open("paper/data.json"))
W = 3.4   # one IEEE column, inches

# ── Fig 1: where the losses actually come from ──────────────────────────────
s = D["strategies"]
loss = {k: -v["pnl"] for k, v in s.items() if v["pnl"] < 0}
tot = sum(loss.values())
lab = sorted(loss, key=loss.get, reverse=True)
vals = [loss[k] for k in lab]
fig, ax = plt.subplots(figsize=(W, 2.5))
wedges, *_ = ax.pie(vals, startangle=90, colors=C[:len(vals)],
                    wedgeprops=dict(width=0.45, edgecolor="white", linewidth=0.6))
ax.legend(wedges, [f"{k} — {v/tot*100:.1f}%  (\\${v:,.0f})" for k, v in zip(lab, vals)],
          loc="center left", bbox_to_anchor=(0.98, 0.5), frameon=False)
ax.set_title(f"Composition of gross loss (total \\${tot:,.0f})")
fig.savefig("paper/fig_loss_pie.pdf"); plt.close(fig)

# ── Fig 2: win rate vs robustness verdict ───────────────────────────────────
names = list(s)
wr = [s[k]["winRate"] * 100 for k in names]
verdict = [s[k].get("mcVerdict", "") for k in names]
col = ["#009E73" if v.startswith("ROBUST") else "#E69F00" if v.startswith("MARGINAL") else "#D55E00" for v in verdict]
fig, ax = plt.subplots(figsize=(W, 2.0))
y = np.arange(len(names))
ax.barh(y, wr, color=col, height=0.62)
ax.set_yticks(y); ax.set_yticklabels(names)
ax.invert_yaxis(); ax.set_xlabel("win rate (%)")
for i, (v, n) in enumerate(zip(wr, [s[k]["trades"] for k in names])):
    ax.text(v + 1, i, f"n={n}", va="center", fontsize=6)
ax.set_xlim(0, max(wr) * 1.28)
handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in ["#009E73", "#E69F00", "#D55E00"]]
ax.legend(handles, ["robust", "marginal", "not robust"], frameon=False, loc="lower right", fontsize=6)
ax.set_title("Win rate by strategy, shaded by Monte-Carlo verdict")
fig.savefig("paper/fig_winrate.pdf"); plt.close(fig)

# ── Fig 3: cumulative equity ────────────────────────────────────────────────
eq = D["equity"]
if eq and isinstance(eq[0], dict):
    keys = [k for k in eq[0] if k not in ("day", "date")]
    xs = np.arange(len(eq))
    fig, ax = plt.subplots(figsize=(W, 1.9))
    tot_series = [sum(float(r.get(k) or 0) for k in keys) for r in eq]
    ax.plot(xs, tot_series, color=C[0], lw=1.1)
    ax.axhline(0, color="#999", lw=0.5, ls="--")
    ax.set_xlabel("trading day"); ax.set_ylabel("cumulative P&L (\\$)")
    ax.set_title("Paper equity across all strategies")
    fig.savefig("paper/fig_equity.pdf"); plt.close(fig)

# ── Fig 4: voice pipeline, measured stage by stage ──────────────────────────
stages = ["voice-activity\nhold-off", "transcription\n(whisper.cpp)", "language model\n(first token)", "speech\n(Piper)"]
lo = [420, 105, 14, 148]; hi = [420, 215, 395, 360]
fig, ax = plt.subplots(figsize=(W, 1.9))
x = np.arange(len(stages))
ax.bar(x, lo, color=C[0], label="best observed", width=0.55)
ax.bar(x, np.array(hi) - np.array(lo), bottom=lo, color=C[5], label="to worst observed", width=0.55)
ax.set_xticks(x); ax.set_xticklabels(stages, fontsize=6.4)
ax.set_ylabel("latency (ms)")
ax.set_title(f"Spoken-turn budget (sum: {sum(lo)}–{sum(hi)} ms)")
ax.legend(frameon=False, fontsize=6)
fig.savefig("paper/fig_latency.pdf"); plt.close(fig)

# ── Fig 5: accuracy against latency for the speech models ───────────────────
models = ["tiny.en", "base.en", "small.en", "large-v3-turbo-q5"]
ms = [78, 148, 416, 2167]; wer = [None, 5.7, 4.2, 0.0]
fig, ax = plt.subplots(figsize=(W, 1.85))
pts = [(m, w, n) for m, w, n in zip(ms, wer, models) if w is not None]
ax.scatter([p[0] for p in pts], [p[1] for p in pts], s=26, color=C[1], zorder=3)
for m, w, n in pts:
    ax.annotate(n, (m, w), textcoords="offset points", xytext=(5, 4), fontsize=6.4)
ax.axvspan(0, 500, color="#009E73", alpha=0.08)
ax.text(250, max(w for _, w, _ in pts) * 0.92, "conversational", fontsize=6, ha="center", color="#009E73")
ax.set_xscale("log"); ax.set_xlabel("transcription time per utterance (ms, log)")
ax.set_ylabel("word error (%)")
ax.set_title("Speech recognition: accuracy against latency")
fig.savefig("paper/fig_asr.pdf"); plt.close(fig)

# ── Fig 6: what gating did to the weather book ──────────────────────────────
pr = {p["name"]: p for p in D["probes"]}
a, b = pr.get("weather v1 (retired)"), pr.get("weather (late-day)")
fig, ax = plt.subplots(figsize=(W, 1.8))
lbl = ["ungated\n(v1, retired)", "gated\n(late-day)"]
wrs = [a["winRate"] * 100, b["winRate"] * 100]
pnl = [a["pnl"], b["pnl"]]
x = np.arange(2)
bars = ax.bar(x - 0.18, wrs, width=0.34, color=C[0], label="win rate (%)")
ax2 = ax.twinx()
ax2.bar(x + 0.18, pnl, width=0.34, color=C[2], label="net P&L (\\$, fee-true)")
ax2.axhline(0, color="#999", lw=0.5)
ax.set_xticks(x); ax.set_xticklabels(lbl, fontsize=6.8)
ax.set_ylabel("win rate (%)"); ax2.set_ylabel("net P&L (\\$)")
ax.set_title("Effect of the entry gate on the same signal")
for i, (w_, p_) in enumerate(zip(wrs, pnl)):
    ax.text(i - 0.18, w_ + 1.5, f"{w_:.0f}%", ha="center", fontsize=6.5)
    ax2.text(i + 0.18, p_ + (8 if p_ > 0 else -18), f"{p_:+.0f}", ha="center", fontsize=6.5)
h1, l1 = ax.get_legend_handles_labels(); h2, l2 = ax2.get_legend_handles_labels()
ax.legend(h1 + h2, l1 + l2, frameon=False, fontsize=6, loc="upper left")
fig.savefig("paper/fig_gate.pdf"); plt.close(fig)

# ── Fig 7: correlation between strategy daily returns ───────────────────────
cor = D["correlations"]
ks = [k for k in cor]
M = np.array([[cor[a].get(b, 0) for b in ks] for a in ks], dtype=float)
fig, ax = plt.subplots(figsize=(W, 2.6))
im = ax.imshow(M, cmap="RdBu_r", vmin=-1, vmax=1)
ax.set_xticks(range(len(ks))); ax.set_xticklabels(ks, rotation=45, ha="right", fontsize=6)
ax.set_yticks(range(len(ks))); ax.set_yticklabels(ks, fontsize=6)
for i in range(len(ks)):
    for j in range(len(ks)):
        ax.text(j, i, f"{M[i,j]:.2f}", ha="center", va="center", fontsize=5.2,
                color="white" if abs(M[i, j]) > 0.55 else "black")
fig.colorbar(im, fraction=0.046, pad=0.03).set_label("Pearson r", fontsize=7)
ax.set_title("Daily-P&L correlation between strategies")
fig.savefig("paper/fig_corr.pdf"); plt.close(fig)

print("figures written:", sorted(f for f in __import__("os").listdir("paper") if f.endswith(".pdf")))
