// Tests the real neural models end to end: the runtime, agreement with the shipped signal cache, and the server.
// Needs both model files in data/models or KLEZA_MODELS_DIR; skips otherwise.
// Run: npm run test:neural
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = fileURLToPath(new URL('./', import.meta.url)), root = path.join(dir, '..');
const modelsDir = process.env.KLEZA_MODELS_DIR || path.join(root, 'data', 'models');
const need = [['Xenova__gpt2', 'onnx', 'decoder_model_quantized.onnx'], ['onnx-community__tmr-ai-text-detector-ONNX', 'onnx', 'model_quantized.onnx']];
const missing = need.filter((p) => !fs.existsSync(path.join(modelsDir, ...p)));
if (missing.length) {
  console.log(`SKIPPED: missing ${missing.map((p) => p.join('/')).join(', ')} in ${modelsDir}. Set KLEZA_MODELS_DIR if they are elsewhere.`);
  process.exit(0);
}
const { initNeural, neuralSignals, neuralStatus, textKey, signalsToArray } = await import('../neural.mjs');
const { loadSignalsCache } = await import('../signals-cache.mjs');
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); } };

await test('the model loads and reports ready', async () => {
  assert.equal(neuralStatus().status, 'idle');
  await initNeural({ dir: modelsDir, enabled: true });
  assert.equal(neuralStatus().status, 'ready', JSON.stringify(neuralStatus()));
});
const cache = loadSignalsCache(root);
const rows = fs.readFileSync(path.join(root, 'detector', 'holdout.mixed.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

await test('live signals match the shipped cache (the training data and the runtime agree)', async () => {
  for (const r of rows.slice(0, 3)) {
    const live = signalsToArray(await neuralSignals(r.text)), cached = signalsToArray(cache.signalsFor(r.text));
    const worst = Math.max(...live.map((v, i) => Math.abs(v - cached[i])));
    assert.ok(worst < 1e-3, `max difference ${worst}`);
  }
});
await test('predictable text has higher word predictability than surprising text', async () => {
  const predictable = await neuralSignals('The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.');
  const surprising = await neuralSignals('Quartz pylons hummed beneath marmalade thunder while Ignatius bartered seven violins for a lukewarm quasar yesterday.');
  assert.ok(predictable.lm.meanLP > surprising.lm.meanLP, `${predictable.lm.meanLP} vs ${surprising.lm.meanLP}`);
  assert.ok(predictable.lm.top1 > surprising.lm.top1);
});
await test('the RAID-trained classifier itself separates a clichéd AI paragraph from a casual human one', async () => {
  const ai = await neuralSignals('In today\'s fast-paced digital landscape, businesses must leverage cutting-edge technology to remain competitive. Furthermore, a strong online presence plays a pivotal role in building trust and fostering lasting customer relationships. Ultimately, success requires a comprehensive approach.');
  const human = await neuralSignals('Honestly I did not expect the move to be this exhausting. My brother dropped a box of plates on the stairs and half of them survived, which felt like a win.');
  assert.ok(ai.tmr > human.tmr, `${ai.tmr} vs ${human.tmr}`);
});
await test('a long text is scored from several windows and finishes in reasonable time', async () => {
  const long = rows.map((r) => r.text).join('\n\n').split(/\s+/).slice(0, 3000).join(' ');
  const t0 = Date.now(), sig = await neuralSignals(long);
  assert.ok(sig.windows >= 4 && sig.windows <= 12, `windows ${sig.windows}`);
  assert.ok(typeof sig.tmr === 'number' && Number.isFinite(sig.tmr));
  assert.ok(Date.now() - t0 < 60000, `took ${(Date.now() - t0) / 1000}s`);
});

// ---- the server, with the model enabled ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kleza-neural-'));
Object.assign(process.env, { KLEZA_DB_PATH: path.join(tmp, 'n.db'), PORT: '0', RATE_LIMIT_PER_MIN: '0' });
fs.cpSync(modelsDir, path.join(tmp, 'models'), { recursive: true }); // the server looks for models next to its database
for (const k of ['KLEZA_NEURAL', 'KLEZA_ACCESS_TOKEN']) delete process.env[k];
const { server, db } = await import('../server.mjs');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const base = `http://127.0.0.1:${server.address().port}/api`;
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
await test('the server reports the model as ready and the detector as combined', async () => {
  for (let i = 0; i < 60; i++) { const h = await (await fetch(base + '/health')).json(); if (h.neural.status === 'ready') { assert.equal(h.neural.combined, true); return; } await new Promise((r) => setTimeout(r, 500)); }
  assert.fail('the model never became ready in the server');
});
const ai = 'Vaccines work by training the immune system to recognize and fight specific pathogens without causing the disease itself. When a vaccine is administered, it introduces a harmless piece or weakened form of the germ, which prompts the body to produce antibodies. It is important to note that vaccines are rigorously tested for safety and effectiveness before they are approved for public use. Overall, they play a crucial role in protecting public health.';
const human = 'Honestly I did not expect the move to be this exhausting. We packed for three days, the truck showed up two hours late, and my brother dropped a box of plates on the stairs. Half of them survived, which felt like a win. The new place smells like fresh paint and someone else\'s cooking, and the neighbour already asked if we play drums. We do not. I keep opening the wrong cupboard for a glass.';
await test('analyze uses the combined model: AI text scores high, human text low, and the mode is reported', async () => {
  const a = await post('/analyze', { text: ai }), h = await post('/analyze', { text: human });
  assert.equal(a.detection.mode, 'style + word predictability'); assert.equal(h.detection.mode, 'style + word predictability');
  assert.ok(a.detection.percent >= 70, `AI text scored ${a.detection.percent}%`); assert.ok(h.detection.percent <= 30, `human text scored ${h.detection.percent}%`);
  assert.ok(a.sentenceSignals.every((s) => s.aiProbability == null || (s.aiProbability >= 0 && s.aiProbability <= 100)));
});
await test('rewrite reports before and after scores from the same detector', async () => {
  const r = await post('/rewrite', { text: ai, original: ai, options: { level: 'Natural' } });
  assert.ok(r.aiBefore >= 70 && r.aiAfter != null, `${r.aiBefore} -> ${r.aiAfter}`);
});

console.log(`${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true });
for (const f of [path.join(dir, 'detector-model.json')]) if (fs.existsSync(f)) fs.rmSync(f);
process.exit(failed ? 1 : 0);
