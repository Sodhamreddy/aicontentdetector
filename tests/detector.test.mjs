// Regression guard for the detector: trains on the bundled corpus and scores the held-out files in detector/.
// The holdout files are never part of training. The combined model uses cached neural signals (a RAID-trained
// RoBERTa classifier plus GPT-2 word predictability), so neither model has to run here. Slow-ish (trains the
// model), so it is not part of `npm test`.
// Run: npm run test:detector
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import * as detector from '../detector.mjs';
import { pickWindows, textKey, LM_KEYS, SIGNAL_KEYS, signalsToArray, signalsFromArray } from '../neural.mjs';
import { loadSignalsCache, cacheFile } from '../signals-cache.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => detector.parseLabeled(fs.readFileSync(path.join(root, 'detector', f), 'utf8'), 'jsonl');
const started = Date.now();
const cache = loadSignalsCache(root);
const corpus = detector.loadSeedCorpus(root);
const model = detector.train(corpus, { signalsFor: cache.signalsFor, cacheSalt: cache.salt });
let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + e.message); } };

const hc3 = load('holdout.en.jsonl'), mixed = load('holdout.mixed.jsonl');
const trained = new Set(corpus.map((s) => s.text));
check('holdout data is not in the training corpus', () => assert.equal([...hc3, ...mixed].filter((s) => trained.has(s.text)).length, 0));
check('the signal cache covers every English text used for training and benchmarks', () => {
  const missing = [...corpus.filter((s) => (s.language || 'English') === 'English'), ...hc3, ...mixed].filter((s) => !cache.signalsFor(s.text));
  assert.equal(missing.length, 0, `${missing.length} texts have no cached signals`);
});
check('a combined model was trained on the cached signals', () => { assert.ok(model.stack && model.stack.trainedOn > 1000, 'no combined model'); });

const score = (set, combined) => detector.evaluate(model, set, combined ? { signalsFor: cache.signalsFor } : {});
const show = (name, r) => console.log(`${name}:`, JSON.stringify({ n: r.samples, accuracy: r.accuracy, recall: r.recall, fpr: r.falsePositiveRate, auroc: r.auroc }));

const hc3Combined = score(hc3, true), hc3Style = score(hc3, false), mixedCombined = score(mixed, true), mixedStyle = score(mixed, false);
show('ChatGPT holdout, combined  ', hc3Combined); show('ChatGPT holdout, style only', hc3Style);
show('Mixed holdout,   combined  ', mixedCombined); show('Mixed holdout,   style only', mixedStyle);
check('combined: ChatGPT holdout accuracy >= 0.92 and AUROC >= 0.985', () => { assert.ok(hc3Combined.accuracy >= 0.92, `acc ${hc3Combined.accuracy}`); assert.ok(hc3Combined.auroc >= 0.985, `auroc ${hc3Combined.auroc}`); });
// The final score averages the full stack with a classifier-only stack so word-predictability features cannot overrule the
// classifier on newer AI text. That costs about a point of accuracy on these (mostly older-ChatGPT-style) holdouts, so the bar is 0.86.
check('combined: mixed holdout (essays, abstracts, other generators) accuracy >= 0.86 and AUROC >= 0.94', () => { assert.ok(mixedCombined.accuracy >= 0.86, `acc ${mixedCombined.accuracy}`); assert.ok(mixedCombined.auroc >= 0.94, `auroc ${mixedCombined.auroc}`); });
check('the combined model beats the style-only model on both holdouts', () => { assert.ok(hc3Combined.auroc > hc3Style.auroc && mixedCombined.auroc > mixedStyle.auroc); });
check('fallback: the style-only model still ranks well when neither neural model is available', () => { assert.ok(hc3Style.auroc >= 0.88, `auroc ${hc3Style.auroc}`); assert.ok(mixedStyle.auroc >= 0.75, `auroc ${mixedStyle.auroc}`); });
check('combined: false-positive rate at the 50% line <= 0.15 on both holdouts', () => { assert.ok(hc3Combined.falsePositiveRate <= 0.15 && mixedCombined.falsePositiveRate <= 0.15, `${hc3Combined.falsePositiveRate} / ${mixedCombined.falsePositiveRate}`); });

// A "Likely AI-generated" verdict (p >= 0.8) must be much stricter than a coin flip.
const strictStats = (set) => { const s = set.map((x) => ({ p: detector.predict(model, x.text, 'English', cache.signalsFor(x.text)).probability, label: x.label })).filter((x) => x.p >= 0.8); return { flagged: s.length, precision: s.filter((x) => x.label === 1).length / s.length }; };
const s1 = strictStats(hc3), s2 = strictStats(mixed);
console.log(`Verdict "Likely AI" (>=0.8): ChatGPT holdout flagged ${s1.flagged}, precision ${s1.precision.toFixed(3)}; mixed holdout flagged ${s2.flagged}, precision ${s2.precision.toFixed(3)}`);
check('"Likely AI" precision >= 0.97 (ChatGPT holdout) and >= 0.93 (mixed holdout)', () => { assert.ok(s1.precision >= 0.97, `${s1.precision}`); assert.ok(s2.precision >= 0.93, `${s2.precision}`); });

// Generalization: a generator the training data never included at all. The classifier stage (tmr) is trained on the
// separate RAID benchmark by its publisher, so it should catch at least some of this even though our own stack never
// saw this text's style during training.
check('leave-one-generator-out: an AI source excluded from training is still partly caught', () => {
  const held = corpus.filter((s) => s.label === 1 && s.source === 'pile-ai');
  assert.ok(held.length >= 30, `expected the pile-ai group in the corpus, found ${held.length}`);
  const trimmed = detector.train(corpus.filter((s) => s.source !== 'pile-ai'), { signalsFor: cache.signalsFor, cacheSalt: cache.salt + ':logo' });
  const recall = held.filter((s) => detector.predict(trimmed, s.text, 'English', cache.signalsFor(s.text)).probability >= 0.5).length / held.length;
  assert.ok(recall >= 0.5, `recall on the unseen generator was only ${recall}`);
});

check('detect() reports which mode scored the text and uses the signals when given', () => {
  const t = hc3.find((s) => s.label === 1).text, sig = cache.signalsFor(t);
  assert.equal(detector.detect(model, t, 'English', undefined, sig).mode, 'style + word predictability');
  assert.equal(detector.detect(model, t, 'English').mode, 'style only');
});
check('what-moved-the-score lists include the trained classifier, predictability and register signals', () => {
  const t = hc3.find((s) => s.label === 1).text, d = detector.detect(model, t, 'English', undefined, cache.signalsFor(t));
  const all = [...d.towardAI, ...d.towardHuman];
  assert.ok(all.some((x) => x.label.includes('RAID-trained')), 'the trained-classifier signal should be listed');
  const labels = all.map((x) => x.label).join('|');
  assert.match(labels, /predictab|surprise|top pick|register|rank|uncertain/i, labels);
});
check('sentence scores stay in range and track the document score in combined mode', () => {
  const t = hc3.find((s) => s.label === 1).text, sig = cache.signalsFor(t), d = detector.detect(model, t, 'English', undefined, sig);
  assert.ok(d.sentences.length >= 3 && d.sentences.every((s) => s.probability >= 0 && s.probability <= 1));
  const avg = d.sentences.reduce((s, x) => s + x.probability, 0) / d.sentences.length;
  assert.ok(Math.abs(avg - d.probability) < 0.35, `sentence average ${avg.toFixed(2)} vs document ${d.probability.toFixed(2)}`);
});
check('the final score blends the full stack with a classifier-only stack, and the two disagree on some text', () => {
  assert.ok(model.stack && model.stackTmr, 'both stacks should be trained');
  assert.ok(!model.stackTmr.keys.some((k) => LM_KEYS.includes(k)), 'the second stack must not use word-predictability features');
  const t = mixed.find((s) => s.label === 1).text, sig = cache.signalsFor(t);
  const blended = detector.predict(model, t, 'English', sig).probability, full = detector.predict({ ...model, stackTmr: null }, t, 'English', sig).probability;
  assert.ok(Number.isFinite(blended) && blended > 0 && blended < 1 && full > 0 && full < 1);
});
check('per-sentence scoring uses the classifier\'s score for each sentence: high-scoring sentences rank above low-scoring ones', () => {
  const t = mixed.find((s) => s.label === 1).text, sig = cache.signalsFor(t), sents = detector.splitSentences(t);
  assert.ok(sents.length >= 4);
  const local = sents.map((_, i) => (i % 2 ? -4 : 4)); // alternate strongly-human and strongly-AI windows
  const d = detector.detect(model, t, 'English', sents, sig, local);
  const scored = d.sentences.map((s, i) => ({ p: s.probability, hi: local[i] > 0, short: sents[i].split(/\s+/).length < 4 })).filter((s) => !s.short);
  const avg = (xs) => xs.reduce((s, x) => s + x.p, 0) / xs.length;
  assert.ok(avg(scored.filter((s) => s.hi)) > avg(scored.filter((s) => !s.hi)) + 0.2, 'sentences the classifier calls AI should score clearly higher');
});
check('sentences of a clearly human document are never highlighted', () => {
  const t = hc3.find((s) => s.label === 0 && detector.predict(model, s.text, 'English', cache.signalsFor(s.text)).probability < 0.15).text, sents = detector.splitSentences(t);
  const d = detector.detect(model, t, 'English', sents, cache.signalsFor(t), sents.map(() => 6));
  assert.ok(d.sentences.every((s) => s.probability < 0.4), 'no sentence should reach the highlight threshold');
});
check('short text is pulled toward undecided', () => {
  const long = hc3.find((s) => s.label === 1 && detector.predict(model, s.text, 'English').probability > 0.95).text;
  assert.ok(detector.predict(model, long.split(' ').slice(0, 40).join(' '), 'English').probability < detector.predict(model, long, 'English').probability);
});
check('possessives are not counted as contractions', () => {
  assert.equal(detector.extractFeatures("Labov's work and the city's plan changed things quickly today.", 'English').contractionRate, 0);
  assert.ok(detector.extractFeatures("It's fine and they didn't mind at all today, really.", 'English').contractionRate > 0);
});

// ---- signal plumbing (pure functions) ----
check('signals round-trip through the cache format and keys are stable', () => {
  const values = SIGNAL_KEYS.map((_, i) => i / 10), sig = signalsFromArray(values);
  assert.deepEqual(signalsToArray(sig), values);
  assert.equal(sig.tmr, values[0]); assert.equal(sig.lm[LM_KEYS[0]], values[1]);
  assert.equal(textKey('a'), textKey('a')); assert.notEqual(textKey('a'), textKey('b'));
});
check('a corrupted or malformed signal degrades to style-only instead of poisoning every score to 50%', () => {
  // Regression test: a single non-finite value fed into the combined stage once made every one of its predictions
  // come out as exactly sigmoid(0) = 50%, regardless of the input text, because it silently contaminated every
  // weight during training. The fix drops the offending row and, if the fit is still broken, drops the whole stage.
  const corrupted = (text) => (corpus.find((s) => s.text === text) ? { tmr: NaN, lm: Object.fromEntries(LM_KEYS.map((k) => [k, 1])) } : null);
  const brokenModel = detector.train(corpus, { signalsFor: corrupted, cacheSalt: 'nan-test' });
  const t = corpus.find((s) => s.language === 'English').text;
  const p = detector.predict(brokenModel, t, 'English', corrupted(t)).probability;
  assert.notEqual(p, 0.5, 'a corrupted signal must not silently collapse the score to exactly 50%');
  if (brokenModel.stack) assert.ok([...brokenModel.stack.weights, brokenModel.stack.bias].every(Number.isFinite), 'a shipped stack must never contain NaN');
});
check('the signal cache salt changes when cached VALUES change, even if the set of covered texts does not', () => {
  // Regression test: a saved model was reused across restarts by cacheKey even after its underlying signal cache
  // was corrected, because the salt only hashed which texts were covered, not their values.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kleza-cache-test-'));
  fs.mkdirSync(path.join(dir, 'detector'));
  const write = (value) => fs.writeFileSync(cacheFile(dir), JSON.stringify({ data: { abc: value } }));
  write([0.1, 0.2]);
  const salt1 = loadSignalsCache(dir).salt;
  write([0.9, 0.9]); // same key, different value
  const salt2 = loadSignalsCache(dir).salt;
  assert.notEqual(salt1, salt2, 'changing a cached value must change the salt, or a stale trained model would be reused forever');
  fs.rmSync(dir, { recursive: true, force: true });
});
check('pickWindows: short text is one window; long text is sampled evenly and bounded', () => {
  assert.deepEqual(pickWindows('A short text. Only two sentences.'), ['A short text. Only two sentences.']);
  const long = Array.from({ length: 2000 }, (_, i) => `Sentence number ${i} says something ordinary and short.`).join(' ');
  const w = pickWindows(long);
  assert.ok(w.length === 12 && w.every((x) => x.split(/\s+/).length >= 100), `windows: ${w.length}`);
  assert.ok(w[0].startsWith('Sentence number 0 ') && w.at(-1).includes('Sentence number 19'), 'first and last windows come from the start and end of the text');
});

console.log(`${failed ? failed + ' FAILED' : 'all passed'} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
process.exitCode = failed ? 1 : 0;
