"""
SEMANTIC MEMORY — the obsidian-brain capability (ruvnet/obsidian-brain:
a vector index over your own markdown so agents recall knowledge by MEANING),
built on our stack. No Obsidian app, no pi.ruv.io federation (trading lessons
never leave this machine).

Indexes everything the system has learned:
  - RESEARCH_*.md + HANDOFF.md + FABLE_METHOD (chunked by section)
  - brain principles (.data/brain_memory.json)
  - daily notes (logs/journal.jsonl brain-daily entries)
  - stable lessons (.data/brain_lessons.json)

recall(query, k) → the k most relevant memories by cosine similarity.
Consumers: brain.py (recalls related principles before consolidating),
/api/recall (frontend + agents), CLI for humans.

Model: all-MiniLM-L6-v2 (local, 90MB, no API). Index: .data/semantic_index.json
Usage:
  .venv/bin/python signals/semantic_memory.py reindex
  .venv/bin/python signals/semantic_memory.py "overconfident model lessons"
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / ".data" / "semantic_index.json"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

_model = None


def model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME)
    return _model


def gather_chunks() -> list[dict]:
    """Every unit of system knowledge as {source, text}."""
    chunks: list[dict] = []

    # markdown docs, chunked by heading section (like an Obsidian vault)
    docs = [ROOT / "HANDOFF.md", ROOT / "RESEARCH_NEURAL_TRADING.md",
            ROOT / "RESEARCH_FUNDS_PLAYBOOK.md",
            Path.home() / "Downloads" / "FABLE_METHOD.md"]
    for p in docs:
        if not p.exists():
            continue
        sections = re.split(r"\n(?=#{1,3} )", p.read_text())
        for s in sections:
            s = s.strip()
            if len(s) > 80:
                chunks.append({"source": p.name, "text": s[:1200]})

    # brain principles (semantic memory of the reflection loop)
    try:
        mem = json.loads((ROOT / ".data" / "brain_memory.json").read_text())
        for k, pr in mem.get("principles", {}).items():
            tag = "LONG-TERM" if pr.get("long_term") else f"strength {pr.get('strength')}"
            chunks.append({"source": f"brain-principle [{tag}]",
                           "text": pr.get("note", k)})
    except Exception:
        pass

    # stable lessons
    try:
        les = json.loads((ROOT / ".data" / "brain_lessons.json").read_text())
        for l in les.get("lessons", []):
            if l.get("stable"):
                chunks.append({"source": "brain-lesson", "text": l["note"]})
    except Exception:
        pass

    # daily notes
    jp = ROOT / "logs" / "journal.jsonl"
    if jp.exists():
        for line in jp.open():
            try:
                r = json.loads(line)
                if r.get("kind") == "brain-daily":
                    txt = f"Daily note {r['day']}: " + "; ".join(
                        f"{s}: {v['trades']}tr {v['wins']}W ${v['pnl']}"
                        for s, v in r.get("summary", {}).items())
                    if r.get("lessons"):
                        txt += " | lessons: " + " ".join(r["lessons"])
                    chunks.append({"source": f"daily-{r['day']}", "text": txt[:1200]})
            except Exception:
                pass
    return chunks


def reindex() -> int:
    chunks = gather_chunks()
    embs = model().encode([c["text"] for c in chunks], normalize_embeddings=True,
                          show_progress_bar=False)
    INDEX.parent.mkdir(exist_ok=True)
    INDEX.write_text(json.dumps({
        "ts": int(time.time()), "model": MODEL_NAME,
        "chunks": chunks,
        "vectors": [[round(float(x), 5) for x in v] for v in embs],
    }))
    return len(chunks)


def recall(query: str, k: int = 5) -> list[dict]:
    if not INDEX.exists():
        reindex()
    idx = json.loads(INDEX.read_text())
    qv = model().encode([query], normalize_embeddings=True)[0]
    scored = []
    for c, v in zip(idx["chunks"], idx["vectors"]):
        sim = sum(a * b for a, b in zip(qv, v))
        scored.append((float(sim), c))
    scored.sort(key=lambda t: -t[0])
    return [{"score": round(s, 3), **c} for s, c in scored[:k]]


if __name__ == "__main__":
    arg = " ".join(sys.argv[1:]) or "reindex"
    if arg == "reindex":
        n = reindex()
        print(f"[semantic-memory] indexed {n} knowledge chunks → {INDEX}")
    else:
        for r in recall(arg):
            print(f"  [{r['score']}] ({r['source']}) {r['text'][:140]}")
