// Sentence embeddings for the plagiarism checker's "similar meaning" step: all-MiniLM-L6-v2 (Sentence-BERT family, Apache-2.0), run on
// this machine with the same ONNX runtime as the other models. Two sentences that say the same thing in different words get vectors that
// point the same way (cosine near 1). It is optional: if the model files are missing or cannot load, the checker falls back to TF-IDF
// word overlap. Nothing is sent anywhere; the files are read from data/models.
import fs from 'fs';
import path from 'path';

export const EMBED_FOLDER = 'Xenova__all-MiniLM-L6-v2';
const FILES = ['tokenizer.json', 'tokenizer_config.json', path.join('onnx', 'model_quantized.onnx')];
const state = { status: 'idle', error: null }; // idle | loading | ready | unavailable
let runtime = null, loading = null, queue = Promise.resolve();
export const embedderStatus = () => ({ ...state });

export const missingEmbedFiles = (dir) => FILES.map((f) => path.join(dir, EMBED_FOLDER, f)).filter((p) => !fs.existsSync(p) || fs.statSync(p).size === 0);

/** Load the model (once). Resolves to true when ready; never throws. */
export function initEmbedder(dir) {
  if (state.status === 'ready') return Promise.resolve(true);
  if (loading) return loading;
  loading = (async () => {
    try {
      const missing = missingEmbedFiles(dir);
      if (missing.length) { state.status = 'unavailable'; state.error = `Sentence model not found in ${dir} (${missing.length} file(s) missing), so similar-meaning detection is off.`; return false; }
      state.status = 'loading';
      const ort = await import('onnxruntime-web'), { Tokenizer } = await import('@huggingface/tokenizers');
      ort.env.wasm.numThreads = 1; // small model; one thread keeps memory low next to the other two models
      const base = path.join(dir, EMBED_FOLDER), json = (f) => JSON.parse(fs.readFileSync(path.join(base, f), 'utf8'));
      const tok = new Tokenizer(json('tokenizer.json'), json('tokenizer_config.json'));
      const session = await ort.InferenceSession.create(fs.readFileSync(path.join(base, 'onnx', 'model_quantized.onnx')), { executionProviders: ['wasm'] });
      runtime = { ort, tok, session }; state.status = 'ready'; state.error = null; return true;
    } catch (e) {
      state.status = 'unavailable'; state.error = String(e.message || e).slice(0, 160); loading = null; return false;
    }
  })();
  return loading;
}

const i64 = (ort, rows, len) => { const a = new BigInt64Array(rows.length * len); rows.forEach((r, i) => r.forEach((v, j) => { a[i * len + j] = BigInt(v); })); return new ort.Tensor('int64', a, [rows.length, len]); };

async function embedBatch(texts, maxTokens) {
  const { ort, tok, session } = runtime;
  const ids = texts.map((t) => { const x = Array.from(tok.encode(String(t)).ids); return x.length > maxTokens ? [...x.slice(0, maxTokens - 1), x[x.length - 1]] : x; }); // keep the closing [SEP]
  const len = Math.max(...ids.map((x) => x.length));
  const input = ids.map((x) => [...x, ...Array(len - x.length).fill(0)]), mask = ids.map((x) => [...x.map(() => 1), ...Array(len - x.length).fill(0)]);
  const out = await session.run({ input_ids: i64(ort, input, len), attention_mask: i64(ort, mask, len), token_type_ids: i64(ort, input.map((r) => r.map(() => 0)), len) });
  const hidden = out.last_hidden_state.data, dim = out.last_hidden_state.dims[2], vectors = [];
  for (let b = 0; b < texts.length; b++) { // mean of the token vectors (padding excluded), then scaled to length 1
    const v = new Float32Array(dim); let n = 0;
    for (let t = 0; t < len; t++) { if (!mask[b][t]) continue; n++; const off = (b * len + t) * dim; for (let d = 0; d < dim; d++) v[d] += hidden[off + d]; }
    let norm = 0; for (let d = 0; d < dim; d++) { v[d] /= Math.max(1, n); norm += v[d] * v[d]; }
    norm = Math.sqrt(norm) || 1; for (let d = 0; d < dim; d++) v[d] /= norm;
    vectors.push(v);
  }
  return vectors;
}

/** One unit-length vector per text, or null when the model is not ready. Texts are embedded in small batches, one job at a time. */
export function embedTexts(texts, { maxTokens = 96, batch = 16, signal } = {}) {
  if (state.status !== 'ready' || !runtime) return Promise.resolve(null);
  const run = queue.then(async () => {
    const out = [];
    for (let i = 0; i < texts.length; i += batch) {
      signal?.throwIfAborted();
      out.push(...await embedBatch(texts.slice(i, i + batch), maxTokens));
      await new Promise((r) => setImmediate(r)); // let the server answer other requests between batches
    }
    return out;
  });
  queue = run.catch(() => {});
  return run.catch(() => null);
}

/** Cosine of two unit-length vectors. */
export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
