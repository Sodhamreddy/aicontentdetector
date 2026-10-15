// Train or benchmark Kleza's statistical detector from the command line.
//   node scripts/detector.mjs benchmark                      cross-validate on the seed corpus
//   node scripts/detector.mjs benchmark --data labeled.jsonl  score the seed-trained model on held-out data
//   node scripts/detector.mjs train --data labeled.csv [--replace] [--out model.json]
// Labeled data (English only): JSONL lines {"text": "...", "label": "ai"|"human"}
// or CSV with a header row containing text,label.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as detector from '../detector.mjs';
import { loadSignalsCache } from '../signals-cache.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'benchmark', ...rest] = process.argv.slice(2);
const arg = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const flag = (name) => rest.includes(`--${name}`);
const readData = (file) => detector.parseLabeled(fs.readFileSync(path.resolve(file), 'utf8'), /\.csv$/i.test(file) ? 'csv' : 'jsonl');
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const show = (title, m) => {
  console.log(`\n${title}`);
  console.table({ samples: m.samples, accuracy: pct(m.accuracy), precision: pct(m.precision), recall: pct(m.recall), f1: pct(m.f1), falsePositiveRate: pct(m.falsePositiveRate), auroc: m.auroc, brier: m.brier, ece: m.ece });
  console.log('confusion', m.confusion);
};

const seed = detector.loadSeedCorpus(root);
const cache = loadSignalsCache(root); // pre-computed word-predictability signals for the bundled corpus and benchmark files
const trainOptions = { signalsFor: cache.signalsFor, cacheSalt: cache.salt };
if (command === 'benchmark') {
  const data = arg('data');
  if (data) {
    const model = detector.train(seed, trainOptions), samples = readData(data);
    show(`Held-out evaluation on ${data}: style-only model`, detector.evaluate(model, samples));
    if (model.stack) {
      const covered = samples.filter((s) => cache.signalsFor(s.text)).length;
      if (covered < samples.length) console.log(`\nCombined model: signals are cached for only ${covered} of ${samples.length} samples in this file, so it cannot be scored here (the running app computes them live).`);
      else show(`Held-out evaluation on ${data}: combined model (style + word predictability)`, detector.evaluate(model, samples, { signalsFor: cache.signalsFor }));
    }
  } else {
    const model = detector.train(seed, trainOptions);
    show('5-fold cross-validation on the seed corpus (style-only model)', model.benchmark.overall);
    if (model.stack) show('5-fold cross-validation of the combined model (style + word predictability)', model.stack.benchmark.overall);
    for (const [lang, m] of Object.entries(model.benchmark.byLanguage)) show(`  ${lang}`, m);
    console.log('\nNote: the seed corpus is small and illustrative. Benchmark on real labeled data before trusting these numbers.');
  }
} else if (command === 'train') {
  const data = arg('data');
  if (!data) throw new Error('Pass --data <file.jsonl|file.csv>.');
  const extra = readData(data);
  const model = detector.train(flag('replace') ? extra : [...seed, ...extra], { source: flag('replace') ? path.basename(data) : `seed corpus + ${path.basename(data)}`, ...trainOptions });
  const out = arg('out') || path.join(root, 'data', 'detector-model.cli.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(model, null, 2));
  show(`Trained on ${model.training.samples} samples; cross-validated metrics`, model.benchmark.overall);
  console.log(`\nModel written to ${out}. To make the running app use this data, add it on the Detection Model page, which stores samples in the workspace database.`);
} else {
  console.log('Usage: node scripts/detector.mjs <benchmark|train> [--data file] [--replace] [--out file]');
}
