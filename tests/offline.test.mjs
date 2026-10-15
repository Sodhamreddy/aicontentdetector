// Proves the neural layer stays offline: with files missing it makes no request and falls back to style-only;
// with the real files present (skipped otherwise) loading and scoring make no request either.
// Run: npm run test:offline
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(fileURLToPath(new URL('./', import.meta.url)), '..');
const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('network is forbidden in this test'); };

const { initNeural, neuralStatus, neuralSignals, missingModelFiles } = await import('../neural.mjs');
let passed = 0, failed = 0, skipped = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); } };

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kleza-nomodels-'));
await test('missing model files: no request is made and status is unavailable', async () => {
  assert.ok(missingModelFiles(empty).length > 0);
  await initNeural({ dir: empty, enabled: true });
  assert.equal(neuralStatus().status, 'unavailable');
  assert.deepEqual(calls, []);
});
await test('without models, scoring returns null (style-only fallback) and still makes no request', async () => {
  assert.equal(await neuralSignals('Some text to score that is long enough to matter.'), null);
  assert.deepEqual(calls, []);
});
await test('the module contains no download code or remote addresses', () => {
  const src = fs.readFileSync(path.join(root, 'neural.mjs'), 'utf8');
  assert.doesNotMatch(src, /https?:\/\/|fetch\(|createWriteStream/);
});
fs.rmSync(empty, { recursive: true, force: true });

const modelsDir = process.env.KLEZA_MODELS_DIR || path.join(root, 'data', 'models');
if (missingModelFiles(modelsDir).length) { skipped++; console.log(`SKIPPED (real models): files not in ${modelsDir}`); }
else {
  calls.length = 0;
  await test('real models: load from disk and score with zero network requests', async () => {
    await initNeural({ dir: modelsDir, enabled: true });
    assert.equal(neuralStatus().status, 'ready', JSON.stringify(neuralStatus()));
    const s = await neuralSignals('The committee reviewed the proposal and, after a lengthy discussion, decided to postpone the vote until the next quarter.');
    assert.ok(s && Number.isFinite(s.tmr) && Number.isFinite(s.lm.meanLP));
    assert.deepEqual(calls, []);
  });
}
globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
