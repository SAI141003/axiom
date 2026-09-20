"""
AXIOM CONNECTOME — the desk's own wiring diagram, built from the code and lit
by today's activity.

After the MaleCNS fruit-fly connectome (Google Research / Janelia, Cell, Sept
2026): a fixed, sparse map of every neuron and synapse, which people then
drive with real inputs. The transferable idea is not "a brain"; it is that a
system whose wiring you can see, from sense to action, with activity visible
on the wires, is a system you can trust and repair. This module builds that
for AXIOM: sensors (feeds) -> signal modules -> bots -> books -> JARVIS, with
edges read from the actual imports and activity read from the actual logs.

  python signals/connectome.py   ->  .data/connectome.json
"""
from __future__ import annotations

import ast
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "connectome.json"
LOGS = ROOT / "logs"

LAYERS = ["sensor", "signal", "research", "execution", "bot", "book", "mind"]
SENSORS = {   # the outside world, by the host the code reaches
    "kraken.com": "Kraken (CCXT)", "api.kraken": "Kraken (CCXT)", "ccxt": "Kraken (CCXT)", "gamma-api.polymarket": "Polymarket Gamma",
    "clob.polymarket": "Polymarket CLOB", "kalshi": "Kalshi", "binance": "Binance", "open-meteo": "Open-Meteo", "aviationweather": "METAR stations",
    "coingecko": "CoinGecko", "dexscreener": "DexScreener", "pumpportal": "PumpPortal", "jup.ag": "Jupiter", "deribit": "Deribit",
    "finance.yahoo": "Yahoo Finance", "news.google": "Google News", "reuters|bbci|nytimes|coindesk|cointelegraph|feedburner|arstechnica": "News RSS",
    "nvidia.com": "NVIDIA NIM", "groq.com": "Groq", "huggingface": "Hugging Face", "questrade": "Questrade", "clubelo|ufcstats": "Sports data",
    "usgs.gov": "USGS", "youtube": "YouTube live", "arxiv|semanticscholar|duckduckgo": "Research web",
}
BOOKS = {"dryrun/weather_daemon.py": "weather", "dryrun/options_daemon.py": "options", "dryrun/gamma_pulse_daemon.py": "gamma-pulse", "dryrun/stocks_bot_daemon.py": "stocks-bot",
         "dryrun/meme_bot_daemon.py": "meme-coin", "dryrun/ccxt_strategy_daemon.py": "ccxt-strategy", "dryrun/flow_bot_daemon.py": "flow-bot", "dryrun/botos.py": "your bots"}
LOG_FOR = {"weather": "dryrun_weather.jsonl", "options": "dryrun_options.jsonl", "gamma-pulse": "gamma_pulse_paper.jsonl", "stocks-bot": "stocks_bot.jsonl",
           "meme-coin": "meme_bot.jsonl", "ccxt-strategy": "ccxt_bot.jsonl", "flow-bot": "flow_bot.jsonl"}


def layer_of(rel: str) -> str:
    if rel.startswith("dryrun/") and (rel.endswith("_daemon.py") or rel == "dryrun/botos.py"): return "bot"
    if rel.startswith("dryrun/brain.py") or rel.startswith("jarvis/"): return "mind"
    if rel.startswith(("execution/", "execute/", "risk/")): return "execution"
    if rel.startswith(("backtest/", "dryrun/")): return "research"
    return "signal"


def scan() -> dict:
    files = [p for d in ("signals", "dryrun", "backtest", "execution", "execute", "risk", "ingest", "match") for p in (ROOT / d).glob("*.py") if p.name != "__init__.py"]
    nodes: dict[str, dict] = {}
    edges: set[tuple[str, str]] = set()
    modmap = {f"{p.parent.name}.{p.stem}": str(p.relative_to(ROOT)) for p in files}
    for p in files:
        rel = str(p.relative_to(ROOT)); src = p.read_text(errors="ignore")
        nodes[rel] = {"id": rel, "label": p.stem.replace("_", " "), "layer": layer_of(rel), "lines": src.count("\n")}
        try:
            tree = ast.parse(src)
        except Exception:
            continue
        for n in ast.walk(tree):
            names = [a.name for a in n.names] if isinstance(n, ast.Import) else ([f"{n.module}"] if isinstance(n, ast.ImportFrom) and n.module else [])
            for name in names:
                for key, target in modmap.items():
                    if name == key or name.startswith(key + ".") or (isinstance(n, ast.ImportFrom) and n.module == key):
                        if target != rel: edges.add((target, rel))
        for pat, label in SENSORS.items():
            if re.search(pat, src):
                sid = f"sensor:{label}"
                nodes.setdefault(sid, {"id": sid, "label": label, "layer": "sensor"})
                edges.add((sid, rel))
    # books and the mind
    now = time.time()
    for rel, book in BOOKS.items():
        if rel in nodes:
            bid = f"book:{book}"; nodes[bid] = {"id": bid, "label": book, "layer": "book"}; edges.add((rel, bid))
    nodes["jarvis/bridge.mjs"] = {"id": "jarvis/bridge.mjs", "label": "JARVIS", "layer": "mind"}
    for bid in [k for k in nodes if k.startswith("book:")]: edges.add((bid, "jarvis/bridge.mjs"))
    for s in [k for k in nodes if k.startswith("sensor:") and nodes[k]["label"] in ("Research web", "News RSS", "Google News", "NVIDIA NIM", "Groq")]: edges.add((s, "jarvis/bridge.mjs"))
    # activity: which bots acted in the last 24h, which sensors were touched by them
    active: dict[str, int] = {}
    for book, log in LOG_FOR.items():
        p = LOGS / log
        if not p.exists(): continue
        try:
            with p.open("rb") as fh:
                fh.seek(max(0, p.stat().st_size - 300_000)); tail = fh.read().decode("utf-8", "ignore").split("\n")[1:]
            n = 0
            for l in tail:
                try: r = json.loads(l)
                except Exception: continue
                if now - (r.get("ts") or 0) < 86400 and r.get("type") in ("wtrade", "position", "close", "gentry", "gresolve", "sentry", "sclose", "mentry", "mclose", "fentry", "fclose", "resolve"): n += 1
            active[f"book:{book}"] = n
        except Exception: pass
    try:
        st = json.loads((ROOT / ".data" / "engine_status.json").read_text()).get("engines", {})
        for k, v in st.items():
            name = k.replace(" ($100 acct)", "").replace(" (late-day)", "").replace(" (retired)", " v1")
            bid = f"book:{name}"
            if bid in nodes: nodes[bid].update({"pnl": v.get("pnl"), "account": v.get("account"), "win_rate": v.get("win_rate"), "trades": v.get("trades")})
    except Exception: pass
    for bid, n in active.items():
        if bid in nodes: nodes[bid]["events_24h"] = n
    lit = {bid for bid, n in active.items() if n}
    # a wire is lit if it feeds a lit book (one hop back), so the active pathway reads from sensor to book
    lit_edges = set()
    for _ in range(4):
        for a, b in edges:
            if b in lit or b in {x for x, _ in lit_edges}: lit_edges.add((a, b)); lit.add(a)
    return {"ts": int(now), "layers": LAYERS,
            "nodes": [{**v, "lit": v["id"] in lit} for v in nodes.values()],
            "edges": [{"from": a, "to": b, "lit": (a, b) in lit_edges} for a, b in sorted(edges)],
            "stats": {"nodes": len(nodes), "edges": len(edges), "sensors": sum(1 for v in nodes.values() if v["layer"] == "sensor"), "lit_nodes": len(lit)}}


if __name__ == "__main__":
    d = scan()
    OUT.parent.mkdir(exist_ok=True); OUT.write_text(json.dumps(d))
    print(f"[connectome] {d['stats']}")
