// Optional AI rewriting through any OpenAI-compatible chat endpoint, so one connector covers free hosted tiers (Groq,
// OpenRouter, Google's OpenAI-compatible Gemini endpoint) and a local Ollama server. It is off unless configured; with
// nothing set, rewrites use the built-in local engine and no text leaves this machine. When it is on, the text being
// rewritten is sent to the chosen service.
//   LLM_PROVIDER  groq | openrouter | gemini | ollama   (sets the defaults below; or leave empty and set the three below)
//   LLM_API_KEY   the service's key (not needed for ollama)
//   LLM_BASE_URL  override the endpoint, e.g. https://api.groq.com/openai/v1
//   LLM_MODEL     override the model name
const PRESETS = {
  groq: { base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', needsKey: true },
  openrouter: { base: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', needsKey: true },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.7-flash', needsKey: true },
  ollama: { base: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false },
};

/** The active configuration, or null when no LLM is set up. */
export function llmConfig(env = process.env) {
  const name = String(env.LLM_PROVIDER || '').toLowerCase(), preset = PRESETS[name] || null;
  const base = (env.LLM_BASE_URL || preset?.base || '').replace(/\/$/, ''), model = env.LLM_MODEL || preset?.model || '', key = env.LLM_API_KEY || '';
  if (!base || !model) return null;
  if ((preset ? preset.needsKey : true) && !key) return null; // a hosted service needs its key
  return { name: name || new URL(base).hostname, base, model, key };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true }); });

/** One chat completion. Retries rate limits and server errors with a short wait; throws a readable Error otherwise. */
export async function llmChat(cfg, prompt, { signal, maxTokens = 4096, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
      // Reasoning models (gpt-oss) count their thinking against max_tokens, so ask for little of it.
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: maxTokens, ...(/gpt-oss/i.test(cfg.model) ? { reasoning_effort: 'low' } : {}) }),
      signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const text = data.choices?.[0]?.message?.content;
      if (!text) {
        const why = data.choices?.[0]?.finish_reason;
        if (why === 'length' && maxTokens < 16000 && attempt < retries) { maxTokens = Math.min(16000, maxTokens * 2); continue; } // cut off before any answer: allow more room
        throw new Error(`${cfg.name} returned an empty response${why ? ` (${why})` : ''}.`);
      }
      return text;
    }
    if ((r.status === 429 || r.status >= 500) && attempt < retries) {
      const wait = Math.min(20000, (Number(r.headers.get('retry-after')) || 0) * 1000 || 2000 * 2 ** attempt);
      await sleep(wait, signal); continue;
    }
    throw new Error(data.error?.message || (typeof data.error === 'string' ? data.error : '') || `${cfg.name} returned ${r.status}.`);
  }
}
