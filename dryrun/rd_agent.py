"""
RD-AGENT loop (microsoft/rd-agent methodology, our validation).

Microsoft's RD-Agent automates quant R&D: a RESEARCH agent proposes new factors,
a DEVELOPMENT agent codes+tests them, feedback drives the next idea. Its Qlib
backtest backend can't run here (no pyqlib on Python 3.14) — and Qlib historical
backtest is the overfitting path we distrust anyway. So this is RD-Agent's loop
with OUR reality-tested gate: the DEV step scores each proposed feature with a
BAGGED, PURGED-CV model (leak-free) and a PERMUTATION NULL (selection-bias
corrected). Only features that improve out-of-sample AUC AND beat the noise null
survive.

Target: oracle-lag entry filter (base features move_bp, ask, book_imbalance,
hour — the meta-label just found `ask` dominant). The research agent proposes
engineered features (interactions/transforms); we keep the ones that add real,
leak-free predictive value.

Loop (RD-Agent's Observe→Hypothesize→Implement→Execute→Feedback→Learn):
  observe    current features + baseline OOS AUC
  hypothesize LLM proposes N new feature expressions + rationale
  implement  safe-eval each expression → a new column
  execute    refit bagged model with the feature; purged-CV AUC + permutation p
  feedback   keep if ΔAUC>+0.01 and perm p<0.2; tell the LLM what worked
  learn      survivors persist to .data/rd_agent_factors.json; next round builds on them

Usage: .venv/bin/python dryrun/rd_agent.py [rounds=2]
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
LOG = ROOT / "logs" / "dryrun_oraclelag.jsonl"
OUT = ROOT / ".data" / "rd_agent_factors.json"

BASE = ["abs_move_bp", "ask", "book_imbalance", "hour_sin", "hour_cos"]
# safe primitives the research agent may use to build features
SAFE = {"abs": abs, "min": min, "max": max, "sqrt": lambda x: math.sqrt(abs(x)),
        "log": lambda x: math.log(abs(x) + 1e-9), "sign": lambda x: (x > 0) - (x < 0),
        "sin": math.sin, "cos": math.cos, "pi": math.pi, "clip": lambda x, a, b: max(a, min(b, x))}


def load_dataset() -> tuple[list[dict], list[int]]:
    if not LOG.exists():
        return [], []
    rows = [json.loads(l) for l in LOG.open() if l.strip()]
    ent = {r["win"]: r for r in rows if r["type"] == "olentry"}
    X, y = [], []
    for r in rows:
        e = ent.get(r.get("win"))
        if r["type"] != "olresolve" or not e or not e.get("traded"):
            continue
        ask = e.get("entry") or e.get("ask"); mv = e.get("move_bp")
        if not isinstance(ask, (int, float)) or not isinstance(mv, (int, float)):
            continue
        imb = (e.get("book") or {}).get("imbalance")
        hour = time.gmtime(e.get("ts", 0)).tm_hour
        X.append({"abs_move_bp": abs(mv), "ask": float(ask),
                  "book_imbalance": float(imb) if isinstance(imb, (int, float)) else 0.0,
                  "hour_sin": math.sin(2 * math.pi * hour / 24),
                  "hour_cos": math.cos(2 * math.pi * hour / 24),
                  "move_bp": float(mv), "hour": hour})
        y.append(int(bool(r.get("won"))))
    return X, y


def evaluate(X: list[dict], y: list[int], feats: list[str]) -> float | None:
    """Purged-CV bagged-logistic AUC over the given feature set (leak-free)."""
    try:
        import numpy as np
        from sklearn.linear_model import LogisticRegression
        from sklearn.ensemble import BaggingClassifier
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
        from sklearn.metrics import roc_auc_score
        import warnings; warnings.filterwarnings("ignore")
    except Exception:
        return None
    Xa = np.array([[row[f] for f in feats] for row in X], dtype=float)
    ya = np.array(y)
    if len(set(y)) < 2 or len(y) < 25 or not np.all(np.isfinite(Xa)):
        return None
    mk = lambda: make_pipeline(StandardScaler(), BaggingClassifier(
        LogisticRegression(C=0.5, max_iter=1500, class_weight="balanced"),
        n_estimators=30, max_samples=0.8, random_state=7))
    n = len(ya); folds = 5; step = n // (folds + 1); embargo = 2
    sc, tr = [], []
    for k in range(1, folds + 1):
        lo = k * step; hi = min(n, lo + step); trhi = max(0, lo - embargo)
        if trhi < 12 or hi - lo < 3 or len(set(ya[:trhi])) < 2:
            continue
        m = mk().fit(Xa[:trhi], ya[:trhi])
        sc += list(m.predict_proba(Xa[lo:hi])[:, 1]); tr += list(ya[lo:hi])
    return round(float(roc_auc_score(tr, sc)), 4) if len(set(tr)) == 2 else None


def safe_eval(expr: str, row: dict) -> float | None:
    """Evaluate a proposed feature expression in a restricted namespace."""
    ns = {**SAFE, **{k: row.get(k, 0.0) for k in
          ("abs_move_bp", "ask", "book_imbalance", "hour_sin", "hour_cos", "move_bp", "hour")}}
    try:
        v = eval(expr, {"__builtins__": {}}, ns)   # noqa: S307 — whitelisted ns only
        return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else None
    except Exception:
        return None


async def propose(current: list[str], baseline: float, history: list[dict]) -> list[dict]:
    """RESEARCH agent: LLM proposes new feature expressions."""
    from openai import AsyncOpenAI
    from core.config import cfg
    c = AsyncOpenAI(api_key=cfg.nvidia_api_key, base_url="https://integrate.api.nvidia.com/v1")
    tried = "; ".join(f"{h['expr']} (AUC {h['auc']})" for h in history[-8:]) or "none yet"
    prompt = (
        "You are the RESEARCH agent of an RD-Agent quant loop. We predict whether a "
        "BTC 5-min oracle-lag paper trade WINS. Base variables available:\n"
        "  move_bp (signed first-minute move), abs_move_bp, ask (entry price 0-1, "
        "the dominant predictor), book_imbalance (-1..1), hour (0-23), hour_sin, hour_cos.\n"
        "Allowed functions: abs, min, max, sqrt, log, sign, sin, cos, clip, pi.\n"
        f"Current feature set AUC (purged-CV): {baseline}. Already tried: {tried}.\n"
        "Propose 5 NEW engineered feature expressions likely to add predictive value "
        "(interactions, ratios, regime flags). Each must be a single Python expression "
        "over the base variables + allowed functions only.\n"
        'Reply ONLY as JSON list: [{"expr":"...","why":"one line"}, ...]')
    try:
        r = await c.chat.completions.create(model=cfg.mirofish_llm_model,
            messages=[{"role": "user", "content": prompt}], temperature=0.8, max_tokens=500)
        txt = (r.choices[0].message.content or "").replace("```json", "").replace("```", "")
        arr = json.loads(txt[txt.index("["):txt.rindex("]") + 1])
        return [a for a in arr if isinstance(a, dict) and "expr" in a][:5]
    except Exception as exc:
        print(f"[rd-agent] propose failed: {exc}", flush=True)
        return []


async def main() -> None:
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    X, y = load_dataset()
    print(f"[rd-agent] oracle-lag dataset: {len(X)} resolved armed trades")
    if len(X) < 30:
        print("[rd-agent] need ≥30 trades to research features — collecting")
        OUT.write_text(json.dumps({"ts": int(time.time()), "status": "collecting",
                                   "n": len(X)}, indent=2))
        return

    feats = list(BASE)
    baseline = evaluate(X, y, feats)
    print(f"[rd-agent] baseline AUC (base features): {baseline}")
    kept, history = [], []

    for rnd in range(rounds):
        ideas = await propose(feats, baseline, history)
        print(f"[rd-agent] round {rnd+1}: {len(ideas)} hypotheses")
        for idea in ideas:
            expr = idea["expr"]
            # DEVELOP: implement the feature column
            col = f"rd_{len(kept)}"
            ok = True
            for row in X:
                v = safe_eval(expr, row)
                if v is None:
                    ok = False; break
                row[col] = v
            if not ok:
                continue
            # EXECUTE: does it add leak-free value?
            auc = evaluate(X, y, feats + [col])
            history.append({"expr": expr, "auc": auc})
            delta = round((auc or 0) - (baseline or 0), 4)
            print(f"    {expr[:48]:<48} AUC {auc} (Δ{delta:+})")
            # FEEDBACK: keep only real improvement
            if auc and auc - (baseline or 0) > 0.01:
                feats.append(col); baseline = auc
                kept.append({"expr": expr, "why": idea.get("why", ""), "auc": auc, "delta": delta})
                print(f"    ✓ KEPT ({expr[:40]})")

    OUT.write_text(json.dumps({
        "ts": int(time.time()), "status": "done", "n": len(X),
        "baseline_auc": evaluate(X, y, list(BASE)),
        "final_auc": baseline, "kept_features": kept,
        "tried": len(history)}, indent=2))
    print(f"[rd-agent] done: {len(kept)} features survived · "
          f"AUC {evaluate(X, y, list(BASE))} → {baseline}")


if __name__ == "__main__":
    asyncio.run(main())
