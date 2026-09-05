"""
META-LABEL trainer (López de Prado) — learns WHEN the oracle-lag signal wins.

Primary signal: first-minute move direction (backtested). Secondary model:
logistic regression P(win | |move_bp|, entry ask, book imbalance, hour-sin/cos)
fit on RESOLVED armed trades only. Pure-python gradient descent — no sklearn.

Honesty gates:
  - status "collecting" until n >= MIN_TRADES (no model, no gating)
  - in-sample AUC reported, but ACTIVATION requires out-of-sample lift:
    fit on the first 70%, AUC on the last 30% must beat 0.55
  - the daemon only gates trades when status == "active"

Output: .data/metalabel_oraclelag.json
Usage:  .venv/bin/python dryrun/metalabel.py   (overnight loop runs it hourly)
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "dryrun_oraclelag.jsonl"
OUT = ROOT / ".data" / "metalabel_oraclelag.json"
MIN_TRADES = 60


def load_rows() -> list[dict]:
    if not LOG.exists():
        return []
    rows = []
    for line in LOG.open():
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    return rows


def features(e: dict) -> list[float] | None:
    """Base features + the multi-source upgrades (all 0-default so old rows
    keep training): exchange consensus/dispersion/agreement (Coinbase+Kraken+
    OKX — Chainlink aggregates venues, so consensus should predict the
    resolution print), Chainlink's OWN move (the resolution source's
    trajectory), and news_10m (event-shock regime)."""
    ask = e.get("entry") or e.get("ask")
    mv = e.get("move_bp")
    if not isinstance(ask, (int, float)) or not isinstance(mv, (int, float)):
        return None
    imb = (e.get("book") or {}).get("imbalance")
    hour = time.gmtime(e.get("ts", 0)).tm_hour
    exch = e.get("exch") or {}
    num = lambda v: float(v) if isinstance(v, (int, float)) else 0.0
    return [1.0, abs(mv), float(mv), float(ask),
            num(imb),
            math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24),
            num(exch.get("consensus_bp")), num(exch.get("dispersion_bp")),
            num(exch.get("agree")), num(e.get("cl_move_bp")),
            num(e.get("news_10m"))]


def fit_logistic(X: list[list[float]], y: list[int],
                 iters: int = 3000, lr: float = 0.05, l2: float = 0.01) -> list[float]:
    k = len(X[0])
    w = [0.0] * k
    n = len(X)
    for _ in range(iters):
        grad = [0.0] * k
        for xi, yi in zip(X, y):
            z = sum(wj * xj for wj, xj in zip(w, xi))
            p = 1 / (1 + math.exp(-max(-30, min(30, z))))
            err = p - yi
            for j in range(k):
                grad[j] += err * xi[j]
        for j in range(k):
            w[j] -= lr * (grad[j] / n + l2 * w[j] * (j > 0))
    return w


def predict(w: list[float], x: list[float]) -> float:
    z = sum(wj * xj for wj, xj in zip(w, x))
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


FEAT_NAMES = ["bias", "abs_move_bp", "signed_move", "ask", "book_imbalance",
              "hour_sin", "hour_cos", "exch_consensus", "exch_dispersion",
              "exch_agree", "cl_move_bp", "news_10m"]


def rigorous_eval(X: list[list[float]], y: list[int], embargo: int = 2) -> dict:
    """López-de-Prado-correct evaluation for a small, noisy sample:
    a BAGGED logistic ensemble (variance reduction), scored with PURGED
    walk-forward CV (drop `embargo` samples around each test fold to kill
    look-ahead leakage on time-adjacent trades), plus MDA feature importance.
    Returns {} if sklearn unavailable or a class is absent."""
    try:
        import warnings
        import numpy as np
        from sklearn.linear_model import LogisticRegression
        from sklearn.ensemble import BaggingClassifier
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
        from sklearn.metrics import roc_auc_score
        warnings.filterwarnings("ignore")           # degenerate-fold noise
    except Exception:
        return {}
    Xa, ya = np.array(X, dtype=float)[:, 1:], np.array(y)   # drop bias col (model adds intercept)
    if len(set(y)) < 2 or len(y) < 20:
        return {}

    def make():
        # StandardScaler → convergence; C=0.5 L2 → regularization; bagging 40 →
        # variance reduction (the real lever on noisy data, not complexity)
        return make_pipeline(
            StandardScaler(),
            BaggingClassifier(
                LogisticRegression(C=0.5, max_iter=2000, class_weight="balanced"),
                n_estimators=40, max_samples=0.8, bootstrap=True, random_state=7))

    # purged walk-forward: 5 expanding folds, embargo gap before each test block
    n = len(ya); folds = 5; step = n // (folds + 1)
    oos_scores, oos_true = [], []
    for k in range(1, folds + 1):
        te_lo = k * step; te_hi = min(n, te_lo + step)
        tr_hi = max(0, te_lo - embargo)                     # purge the gap
        if tr_hi < 12 or te_hi - te_lo < 3:
            continue
        Xtr, ytr = Xa[:tr_hi], ya[:tr_hi]
        if len(set(ytr)) < 2:
            continue
        m = make().fit(Xtr, ytr)
        p = m.predict_proba(Xa[te_lo:te_hi])[:, 1]
        oos_scores += list(p); oos_true += list(ya[te_lo:te_hi])
    cv_auc = (round(float(roc_auc_score(oos_true, oos_scores)), 4)
              if len(set(oos_true)) == 2 else None)

    # MDA importance: shuffle each feature, measure AUC drop (full-sample proxy)
    full = make().fit(Xa, ya)
    base = roc_auc_score(ya, full.predict_proba(Xa)[:, 1]) if len(set(ya)) == 2 else 0.5
    rng = np.random.default_rng(3)
    mda = {}
    for j in range(Xa.shape[1]):
        drops = []
        for _ in range(10):
            Xp = Xa.copy(); rng.shuffle(Xp[:, j])
            drops.append(base - roc_auc_score(ya, full.predict_proba(Xp)[:, 1]))
        mda[FEAT_NAMES[j + 1]] = round(float(np.mean(drops)), 4)
    top = max(mda, key=mda.get) if mda else None
    return {"cv_auc": cv_auc, "insample_auc": round(float(base), 4),
            "feature_importance": mda, "top_feature": top,
            "model": "bagged-logistic(40) · purged-walkforward-CV · MDA"}


def auc(scores: list[float], labels: list[int]) -> float | None:
    pos = [(s) for s, l in zip(scores, labels) if l == 1]
    neg = [(s) for s, l in zip(scores, labels) if l == 0]
    if not pos or not neg:
        return None
    wins = sum(1 for p in pos for q in neg if p > q) + 0.5 * sum(
        1 for p in pos for q in neg if p == q)
    return round(wins / (len(pos) * len(neg)), 4)


def main() -> None:
    rows = load_rows()
    ent = {r["win"]: r for r in rows if r["type"] == "olentry"}
    joined = []
    for r in rows:
        e = ent.get(r.get("win"))
        if (r["type"] == "olresolve" and e and e.get("traded")
                and isinstance(r.get("won"), bool)):
            x = features(e)
            if x:
                joined.append((e["ts"], x, int(r["won"])))
    joined.sort(key=lambda t: t[0])
    n = len(joined)

    doc: dict = {"ts": int(time.time()), "n": n, "min_trades": MIN_TRADES,
                 "features": FEAT_NAMES}

    if n < MIN_TRADES:
        doc["status"] = "collecting"
        doc["note"] = f"need {MIN_TRADES - n} more resolved armed trades"
    else:
        X = [x for _, x, _ in joined]
        y = [yy for _, _, yy in joined]
        # RIGOROUS EVAL (López de Prado for small noisy samples):
        #  - PURGED walk-forward CV (no look-ahead leakage across time)
        #  - BAGGED logistic ensemble (variance reduction — the real win on
        #    low signal-to-noise data; complexity would just overfit)
        #  - MDA feature importance (which features actually carry signal)
        rig = rigorous_eval(X, y)
        doc.update(rig)
        # the daemon gate uses a lightweight pure-python logistic coef, but it
        # is ONLY activated if the rigorous purged-CV bagged AUC clears 0.55
        w_full = fit_logistic(X, y)
        doc["coef"] = [round(c, 4) for c in w_full]
        # DEPLOY THE VALIDATED MODEL ITSELF (loophole fix): the AUC was earned
        # by the bagged sklearn pipeline, not the hand-rolled coef — pickle it
        # so the daemon gates with the exact model that was validated.
        try:
            import pickle
            import numpy as np
            from sklearn.linear_model import LogisticRegression
            from sklearn.ensemble import BaggingClassifier
            from sklearn.pipeline import make_pipeline
            from sklearn.preprocessing import StandardScaler
            full = make_pipeline(StandardScaler(), BaggingClassifier(
                LogisticRegression(C=0.5, max_iter=2000, class_weight="balanced"),
                n_estimators=40, max_samples=0.8, bootstrap=True, random_state=7))
            full.fit(np.array(X, dtype=float)[:, 1:], np.array(y))
            (OUT.parent / "metalabel_oraclelag.pkl").write_bytes(pickle.dumps(full))
            doc["model_file"] = "metalabel_oraclelag.pkl"
        except Exception as exc:
            doc["model_file"] = None
            print(f"[metalabel] pickle export failed: {exc}")
        cv = rig.get("cv_auc")
        if cv is not None and cv >= 0.55:
            doc["status"] = "active"
            doc["note"] = "gate: trade only if P(win) > entry ask (breakeven)"
        else:
            doc["status"] = "no_lift"
            doc["note"] = f"purged-CV bagged AUC {cv} < 0.55 — no real edge; not gating"

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=2))
    print(f"[metalabel] oraclelag: n={n} status={doc['status']}"
          + (f" cv_auc={doc.get('cv_auc')} top_feature={doc.get('top_feature')}"
             if n >= MIN_TRADES else ""))


if __name__ == "__main__":
    main()
