/**
 * Shared LLM helper — provider chain, fastest first:
 *   1. Groq      (free key: console.groq.com — Llama 3.3 70B, ~500 tok/s, ~1-2s)
 *   2. Cerebras  (free key: cloud.cerebras.ai — Llama 3.3 70B, ~2000 tok/s)
 *   3. Anthropic (claude-haiku-4-5)
 *   4. NVIDIA NIM (Gemma — 40-90s; kept as last resort)
 * First provider with a key wins; failures fall through to the next.
 */

interface Provider { name: string; key?: string; base: string; model: string }

function providers(): Provider[] {
  return [
    { name: "groq", key: process.env.GROQ_API_KEY,
      base: "https://api.groq.com/openai/v1",
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile" },
    { name: "cerebras", key: process.env.CEREBRAS_API_KEY,
      base: "https://api.cerebras.ai/v1",
      model: process.env.CEREBRAS_MODEL || "llama-3.3-70b" },
    { name: "nvidia", key: process.env.NVIDIA_API_KEY,
      base: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
      model: process.env.NVIDIA_MODEL || "google/gemma-4-31b-it" },
  ].filter((p) => !!p.key);
}

export async function askLLM(system: string, user: string, maxTokens = 1000): Promise<string> {
  const errors: string[] = [];
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const chain = providers();
  const nvidiaIdx = chain.findIndex((p) => p.name === "nvidia");
  const anthropicSlot = nvidiaIdx === -1 ? chain.length : nvidiaIdx;

  for (let i = 0; i <= chain.length; i++) {
    // Anthropic attempt goes just before the slow NVIDIA fallback
    if (anthropicKey && i === anthropicSlot) {
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, system,
            messages: [{ role: "user", content: user }],
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const data = await res.json();
          const text = data.content?.[0]?.text;
          if (text) return text;
        }
        errors.push(`anthropic ${res.status}`);
      } catch (e: any) { errors.push(`anthropic ${e?.name ?? e}`); }
    }
    const p = chain[i];
    if (!p) continue;
    try {
      const timeout = p.name === "nvidia" ? 110_000 : 30_000;
      const res = await fetch(`${p.base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: p.model, max_tokens: maxTokens,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return text;
      }
      errors.push(`${p.name} ${res.status}`);
    } catch (e: any) { errors.push(`${p.name} ${e?.name ?? e}`); }
  }

  throw new Error(
    errors.length
      ? `All LLM providers failed: ${errors.join(" | ")}`
      : "No LLM key set. Get a FREE fast key at console.groq.com and add GROQ_API_KEY to frontend/.env.local",
  );
}
