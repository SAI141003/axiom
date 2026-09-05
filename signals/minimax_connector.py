"""
MINIMAX-M3 CONNECTOR — via NVIDIA NIM (langchain_nvidia_ai_endpoints).

A second LLM path alongside the existing NVIDIA Gemma classifier (classifier.py
uses cfg.nvidia_model="google/gemma-4-31b-it" through a raw OpenAI-compatible
client for fast news classification). This one is MiniMax-M3 through LangChain's
ChatNVIDIA — a larger reasoning model, for slower/deeper analysis calls (e.g. a
second opinion in Council, a deep-research pass) rather than the hot classify path.

Reuses the SAME key as the rest of the platform: cfg.nvidia_api_key, which
pydantic-settings loads from NVIDIA_API_KEY in .env — set it once, both this and
the Gemma classifier work. Never hardcode the key; never print it.

  python signals/minimax_connector.py "your prompt"     (one-off test call)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from core.config import cfg

MODEL = "minimaxai/minimax-m3"
_CLIENT = None


def configured() -> bool:
    return bool(cfg.nvidia_api_key)


def _client():
    """Lazy singleton — only imports/constructs once a key is actually present."""
    global _CLIENT
    if _CLIENT is None:
        from langchain_nvidia_ai_endpoints import ChatNVIDIA
        _CLIENT = ChatNVIDIA(
            model=MODEL,
            api_key=cfg.nvidia_api_key,
            temperature=1,
            top_p=0.95,
            max_completion_tokens=8192,
        )
    return _CLIENT


def ask(prompt: str, system: str | None = None) -> dict:
    """Single-turn call. Returns {'content': str, 'reasoning': str|None, 'model': MODEL}.
    Honest failure: if no key is configured, returns an error dict — never pretends."""
    if not configured():
        return {"content": "", "reasoning": None, "model": MODEL,
                "error": "NVIDIA_API_KEY not set — add it to .env"}
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    try:
        response = _client().invoke(messages)
    except Exception as e:
        return {"content": "", "reasoning": None, "model": MODEL, "error": str(e)[:200]}
    reasoning = None
    if response.additional_kwargs and "reasoning_content" in response.additional_kwargs:
        reasoning = response.additional_kwargs["reasoning_content"]
    return {"content": response.content, "reasoning": reasoning, "model": MODEL, "error": None}


def status() -> dict:
    return {"model": MODEL, "configured": configured(),
            "state": "ready" if configured() else "not configured — add NVIDIA_API_KEY to .env"}


if __name__ == "__main__":
    if not configured():
        print(f"[minimax] not configured — {status()['state']}")
        print("[minimax] add NVIDIA_API_KEY=... to .env, then re-run this to test")
        sys.exit(0)
    prompt = sys.argv[1] if len(sys.argv) > 1 else "Reply with exactly: MINIMAX CONNECTED"
    print(f"[minimax] asking {MODEL}: {prompt!r}")
    r = ask(prompt)
    if r["error"]:
        print(f"[minimax] ERROR: {r['error']}")
        sys.exit(1)
    if r["reasoning"]:
        print(f"[minimax] reasoning: {r['reasoning'][:300]}")
    print(f"[minimax] response: {r['content']}")
