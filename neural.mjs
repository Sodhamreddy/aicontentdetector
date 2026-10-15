// Optional neural signals for the detector, run locally on WebAssembly (no native binaries, no cloud calls):
//   lm  : "predictability of wording" from GPT-2 (Xenova/gpt2) - how surprising each word is to a language model.
//         The same idea competing tools call "perplexity": AI-written text tends to be more predictable.
//   tmr : a RoBERTa classifier (onnx-community/tmr-ai-text-detector-ONNX) trained directly to tell AI from human
//         text on the RAID benchmark (many generators, many domains). This is closer to what commercial detectors
//         (QuillBot, Scribbr, GPTZero) run - a trained classifier, not just a hand-built statistic.
// Together (about 250 MB) they live as plain files in data/models. The app makes no network request for them: the
// files are read from disk into memory at start, and checking a text uses only what is in memory. Everything is
// optional: if the files are absent the detector falls back to its style-only model. Set KLEZA_NEURAL=off to
// disable the neural models entirely.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const LM_KEYS = ['meanLP', 'stdLP', 'meanEnt', 'stdEnt', 'meanLogRank', 'top1', 'top10', 'top100', 'over1000', 'surpriseGap'];
export const SIGNAL_KEYS = ['tmr', ...LM_KEYS];
export const textKey = (text) => crypto.createHash('sha1').update(text).digest('hex');
export const signalsToArray = (s) => [s.tmr, ...LM_KEYS.map((k) => s.lm[k])];
export const signalsFromArray = (a) => ({ tmr: a[0], lm: Object.fromEntries(LM_KEYS.map((k, i) => [k, a[i + 1]])) });

const MODELS = {
  gpt2: { folder: 'Xenova__gpt2', files: ['tokenizer.json', 'tokenizer_config.json', 'onnx/decoder_model_quantized.onnx'] },
  tmr: { folder: 'onnx-community__tmr-ai-text-detector-ONNX', files: ['tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'] },
};
const MAX_LM_TOKENS = 320, MAX_TMR_TOKENS = 512, WINDOW_WORDS = 240, MAX_WINDOWS = 12; // 12 windows cover about 2,900 words; windows only apply past ~300 words, so the cached corpus signals are unchanged

const state = { status: 'idle', progress: 0, error: null }; // idle | disabled | loading | ready | unavailable
export const neuralStatus = () => ({ ...state });
let runtime = null;
/** Resolves once loading has finished (ready, unavailable or disabled), or after `ms` if it is still loading. */
export const neuralSettled = async (ms = 20000) => {
  const t0 = Date.now();
  while ((state.status === 'idle' || state.status === 'loading') && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
};
let queue = Promise.resolve(); // inference runs one text at a time so a busy server is not starved of CPU

const wordsIn = (s) => (s.match(/\S+/g) || []).length;

/** Up to MAX_WINDOWS windows of about WINDOW_WORDS words, evenly spaced through the text. A short text is one window. */
export function pickWindows(text, { windowWords = WINDOW_WORDS, maxWindows = MAX_WINDOWS } = {}) {
  if (wordsIn(text) <= windowWords * 1.25) return [text];
  const sentences = text.split(/(?<=[.!?]["”’')\]]?)\s+/), windows = [];
  let current = [], n = 0;
  for (const s of sentences) {
    current.push(s); n += wordsIn(s);
    if (n >= windowWords) { windows.push(current.join(' ')); current = []; n = 0; }
  }
  if (n >= windowWords / 2 || !windows.length) windows.push(current.join(' '));
  if (windows.length <= maxWindows) return windows;
  return Array.from({ length: maxWindows }, (_, i) => windows[Math.round((i * (windows.length - 1)) / (maxWindows - 1))]);
}

const modelFiles = (dir) => Object.values(MODELS).flatMap((m) => m.files.map((f) => path.join(dir, m.folder, f)));
const present = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;
/** Model files that are not on disk (empty when everything needed is present). */
export const missingModelFiles = (dir) => modelFiles(dir).filter((p) => !present(p)).map((p) => path.relative(dir, p));

async function load(dir) {
  const ort = await import('onnxruntime-web');
  const { Tokenizer } = await import('@huggingface/tokenizers');
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, os.cpus().length - 1));
  const open = async (m, modelFile) => {
    const base = path.join(dir, m.folder);
    const json = (f) => JSON.parse(fs.readFileSync(path.join(base, f), 'utf8'));
    return { tok: new Tokenizer(json('tokenizer.json'), json('tokenizer_config.json')), session: await ort.InferenceSession.create(fs.readFileSync(path.join(base, modelFile)), { executionProviders: ['wasm'] }) };
  };
  return { ort, gpt2: await open(MODELS.gpt2, 'onnx/decoder_model_quantized.onnx'), tmr: await open(MODELS.tmr, 'onnx/model_quantized.onnx') };
}

/** Loads the model files from disk into memory. Makes no network request. Never throws; check neuralStatus(). */
const isMemoryError = (e) => /bad_alloc|out of memory|ERROR_CODE: 6|allocat/i.test(String(e?.message || e));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The two models need about 600 MB of free memory to load. When another program is using it, loading fails with "bad_alloc"; that
// is usually temporary, so it is retried a few times (staying in "loading") before giving up with a message that says what to do.
export async function initNeural({ dir, enabled = process.env.KLEZA_NEURAL !== 'off', retries = 6, waitMs = 20000 } = {}) {
  if (!enabled) { state.status = 'disabled'; return; }
  try {
    const missing = missingModelFiles(dir);
    if (missing.length) {
      state.status = 'unavailable';
      state.error = `Model files not found in ${dir} (${missing.length} missing), so scores use the style-only model. Put the data/models folder there and restart.`;
      return;
    }
    state.status = 'loading';
    for (let attempt = 1; ; attempt++) {
      try { runtime = await load(dir); break; }
      catch (e) {
        if (!isMemoryError(e) || attempt >= retries) throw e;
        state.error = `Waiting for free memory to load the accuracy models (attempt ${attempt} of ${retries}).`;
        await pause(waitMs);
      }
    }
    state.status = 'ready'; state.progress = 1; state.error = null;
  } catch (e) {
    state.status = 'unavailable';
    state.error = isMemoryError(e)
      ? `There is not enough free memory to load the accuracy models (they need about 600 MB). Close other programs and restart the app, or set KLEZA_NEURAL=off to run without them. (${String(e.message || e).slice(0, 80)})`
      : String(e.message || e);
  }
}

const i64 = (ort, arr) => new ort.Tensor('int64', BigInt64Array.from(arr.map(BigInt)), [1, arr.length]);

// Single forward pass reading a 2-value logit (human vs AI); orders of magnitude cheaper than the GPT-2 loop below,
// since it never needs to walk the vocabulary, so it does not need the same event-loop yielding.
async function tmrLogit(text) {
  const { ort, tmr } = runtime;
  let ids = Array.from(tmr.tok.encode(text).ids);
  if (ids.length > MAX_TMR_TOKENS) ids = [...ids.slice(0, MAX_TMR_TOKENS - 1), ids[ids.length - 1]]; // keep the closing special token
  const out = await tmr.session.run({ input_ids: i64(ort, ids), attention_mask: i64(ort, ids.map(() => 1)) });
  const [human, ai] = out.logits.data;
  return ai - human;
}

async function lmFeatures(text) {
  const { ort, gpt2: { tok, session } } = runtime;
  const body = Array.from(tok.encode(text).ids).slice(0, MAX_LM_TOKENS - 1);
  const ids = [50256, ...body]; // <|endoftext|> first, so the first real token is scored too
  const out = await session.run({ input_ids: i64(ort, ids), attention_mask: i64(ort, ids.map(() => 1)) });
  const logits = out.logits.data, V = out.logits.dims[2];
  const lp = [], lr = [], ent = [];
  let top1 = 0, top10 = 0, top100 = 0, over1000 = 0;
  // A 50257-wide vocabulary means each token below costs two full passes over it; for a long text that is tens of
  // millions of synchronous float ops, enough to freeze Node's single event loop thread for whole seconds and stall
  // every other request the server is handling. Yielding every few tokens keeps the server responsive under load.
  const YIELD_EVERY = 16;
  for (let i = 0; i < ids.length - 1; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    const off = i * V, target = ids[i + 1];
    // One cheap pass for the max, then one pass that computes exp() once per word and gets everything from it: with
    // d = l - max, s = sum(exp(d)) and E = sum(exp(d) * d), the log-sum-exp is max + log(s) and the entropy is log(s) - E/s.
    // The rank is how many words scored above the target word. (Two exp() passes per token were the slow part.)
    const lt = logits[off + target];
    let max = -Infinity; for (let v = 0; v < V; v++) { const x = logits[off + v]; if (x > max) max = x; }
    let s = 0, E = 0, above = 0;
    for (let v = 0; v < V; v++) { const l = logits[off + v], d = l - max, ex = Math.exp(d); s += ex; E += ex * d; if (l > lt) above++; }
    const lse = max + Math.log(s), rank = above + 1, e = Math.log(s) - E / s;
    lp.push(lt - lse); lr.push(Math.log(rank)); ent.push(e);
    if (rank === 1) top1++; if (rank <= 10) top10++; if (rank <= 100) top100++; if (rank > 1000) over1000++;
  }
  const n = lp.length, mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  return { meanLP: mean(lp), stdLP: sd(lp), meanEnt: mean(ent), stdEnt: sd(ent), meanLogRank: mean(lr), top1: top1 / n, top10: top10 / n, top100: top100 / n, over1000: over1000 / n, surpriseGap: mean(lp) + mean(ent) };
}

async function compute(text) {
  const parts = [];
  for (const w of pickWindows(text)) {
    parts.push({ tmr: await tmrLogit(w), lm: await lmFeatures(w) });
    await new Promise((r) => setImmediate(r)); // yield between windows too
  }
  const avg = (f) => parts.reduce((s, p) => s + f(p), 0) / parts.length;
  return { tmr: avg((p) => p.tmr), lm: Object.fromEntries(LM_KEYS.map((k) => [k, avg((p) => p.lm[k])])), windows: parts.length };
}

/**
 * The trained classifier's AI-vs-human logit for each of `texts` (in practice, a sentence with its neighbours), used to
 * highlight which parts of a document look most like AI. Null when the model is not ready.
 */
export function neuralLocalLogits(texts) {
  if (state.status !== 'ready' || !runtime) return Promise.resolve(null);
  const run = queue.then(async () => {
    const out = [];
    for (const t of texts) { out.push(t ? await tmrLogit(t) : null); await new Promise((r) => setImmediate(r)); }
    return out;
  });
  queue = run.catch(() => {});
  return run.catch(() => null);
}

/**
 * How well each candidate word fits at each site of `text`, from GPT-2: the log-probability of the word's first token
 * given the text before the site. `sites` is [{ start, words: [...] }] (start = character offset of the word to replace).
 * Returns one array of log-probabilities per site (null for a site beyond the first MAX_LM_TOKENS tokens), or null when
 * the model is not ready. One forward pass covers every site in `text`, so pass one paragraph at a time.
 */
export function neuralWordFit(text, sites) {
  if (state.status !== 'ready' || !runtime || !sites.length) return Promise.resolve(null);
  const run = queue.then(async () => {
    const { ort, gpt2: { tok, session } } = runtime;
    const ids = [50256, ...Array.from(tok.encode(text).ids).slice(0, MAX_LM_TOKENS - 1)];
    const out = await session.run({ input_ids: i64(ort, ids), attention_mask: i64(ort, ids.map(() => 1)) });
    const logits = out.logits.data, V = out.logits.dims[2];
    const lseAt = (row) => { const off = row * V; let max = -Infinity; for (let v = 0; v < V; v++) if (logits[off + v] > max) max = logits[off + v]; let sum = 0; for (let v = 0; v < V; v++) sum += Math.exp(logits[off + v] - max); return max + Math.log(sum); };
    // Mean surprisal (nats) of the `n` tokens that follow character offset `at`: how unlikely the text right after a word is.
    const nextSurprisal = (at, n = 3) => {
      const k = tok.encode(text.slice(0, at)).ids.length; let total = 0, count = 0;
      for (let q = k; q < k + n && q < ids.length - 1; q++) { total -= logits[q * V + ids[q + 1]] - lseAt(q); count++; }
      return count ? total / count : null;
    };
    const rows = sites.map((s) => {
      const k = tok.encode(text.slice(0, s.start).replace(/\s+$/, '')).ids.length; // row k predicts the token that starts this site
      if (k >= ids.length - 1) return null;
      const off = k * V, lse = lseAt(k);
      // A word GPT-2 has to split into several pieces is rare, so only single-token words count (others score -Infinity).
      const lps = s.words.map((w) => { const t = tok.encode(' ' + w).ids; return t.length !== 1 ? -Infinity : logits[off + t[0]] - lse; });
      return Object.assign(lps, { next: s.after == null ? null : nextSurprisal(s.after) });
    });
    return rows;
  });
  queue = run.catch(() => {});
  return run.catch(() => null);
}

/** Predictability signals for a text, or null when the model is not ready (the caller then uses the style-only model). */
const signalsCache = new Map(); // text hash -> signals; the same text is scored again and again (analyse, then rewrite, then re-check)
const SIGNALS_CACHE_MAX = 64;
export function neuralSignals(text) {
  if (state.status !== 'ready' || !runtime) return Promise.resolve(null);
  const key = textKey(text.trim()), hit = signalsCache.get(key); // edge whitespace is ignored: a rewrite re-adds the original's, and the score does not change
  if (hit) { signalsCache.delete(key); signalsCache.set(key, hit); return Promise.resolve(structuredClone(hit)); } // refresh its place in the LRU order
  const run = queue.then(() => compute(text));
  queue = run.catch(() => {});
  return run.then((s) => {
    signalsCache.set(key, s);
    if (signalsCache.size > SIGNALS_CACHE_MAX) signalsCache.delete(signalsCache.keys().next().value);
    return structuredClone(s);
  }).catch(() => null);
}
