// Kleza statistical AI-likelihood detector.
// A trained, calibrated logistic-regression classifier over stylometric features.
// Training data: detector/corpus.seed.jsonl plus any labeled samples added by the user.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LM_KEYS, SIGNAL_KEYS, signalsToArray } from './neural.mjs';

export const MODEL_VERSION = 'kleza-style-lm-tmr-en-1';

// Plain-language names for the neural signals (see neural.mjs) shown in "what moved the score".
const LM_LABELS = {
  tmr: 'Trained AI-text classifier (RAID-trained)',
  meanLP: 'Word predictability (average surprise)', stdLP: 'Surprise variation across words', meanEnt: 'Language-model uncertainty',
  stdEnt: 'Uncertainty variation', meanLogRank: 'Typical rank of the words chosen', top1: 'Words that were the language model’s top pick',
  top10: 'Words in the language model’s top 10', top100: 'Words in the language model’s top 100', over1000: 'Rare, unexpected words',
  surpriseGap: 'Surprise compared with expectation',
};

// English only. Spanish support (a separate lexicon, isSpanish feature, and style-only fallback) was removed.
const LEXICON = {
  English: {
    ai: new Set(['delve','delves','delving','crucial','pivotal','furthermore','moreover','additionally','landscape','tapestry','seamless','seamlessly','robust','leverage','leveraging','leverages','foster','fostering','fosters','navigate','navigating','realm','comprehensive','ensure','ensuring','ensures','enhance','enhancing','enhances','vital','embark','unlock','unlocking','elevate','elevating','streamline','streamlining','empower','empowering','empowers','holistic','myriad','paramount','underscore','underscores','testament','vibrant','dynamic','innovative','transformative','intricate','nuanced','showcase','showcasing','optimal','utilize','utilizing','ultimately','essential','numerous','significant','significantly','invaluable','meticulous','meticulously','resonate','resonates','commitment','journey','harness','harnessing','key','overall','various','valuable','effectively','efficiently']),
    phrases: ["it is important to note","in today's","in today’s","in conclusion","plays a crucial role","plays a vital role","plays a pivotal role","a wide range of","when it comes to","in the realm of","it is worth noting","ever-evolving","fast-paced","whether you're","whether you’re","in summary","by leveraging","not only","serves as a","a testament to","it is essential to","in the world of","look no further","dive into","stands as","at its core"],
    hedge: new Set(['maybe','probably','kinda','sorta','honestly','actually','pretty','guess','stuff','basically','anyway','though','yeah','okay','ok','weird','lol','totally','literally','super','nope','yep','dunno','gonna','wanna','hmm','ugh','huh']),
    first: new Set(['i','me','my','mine','myself','we','our','us']),
    second: new Set(['you','your','yours','yourself','yourselves',"you're","you’re","you'll","you’ll","you've","you’ve"]),
    modal: new Set(['can','could','may','might','often','typically','generally','usually','sometimes','tend','tends','various','several','different','specific','certain','common','commonly','many']),
    passive: /\b(?:is|are|was|were|been|being|be)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/gi,
    transition: /^(furthermore|moreover|additionally|however|overall|ultimately|in conclusion|in summary|consequently|therefore|as a result|by |in addition|notably|importantly)\b/i,
    // Real contractions only; a bare 's is usually a possessive ("Labov's work"), not a contraction.
    contraction: /\b[\p{L}]+n['’]t\b|\b[\p{L}]+['’](?:re|ve|ll|d|m)\b|\b(?:it|that|he|she|there|here|what|let|who|where|how)['’]s\b/giu,
  },
};

export const FEATURES = [
  ['sentLenMean', 'Average sentence length'],
  ['sentLenCV', 'Sentence-length variation (burstiness)'],
  ['mattr', 'Vocabulary variety'],
  ['aiLexRate', 'AI-associated vocabulary'],
  ['aiPhraseRate', 'AI-associated stock phrases'],
  ['hedgeRate', 'Casual or hedging words'],
  ['firstPersonRate', 'First-person voice'],
  ['contractionRate', 'Contractions'],
  ['punctVariety', 'Expressive punctuation (! ? ; — … parentheses)'],
  ['digitRate', 'Specific numbers and figures'],
  ['commasPerSentence', 'Commas per sentence'],
  ['avgWordLen', 'Average word length'],
  ['longWordRate', 'Long words (10+ letters)'],
  ['transitionStartRate', 'Sentences opening with formal transitions'],
  ['startRepetition', 'Repeated sentence openings'],
  ['paragraphCV', 'Paragraph-length variation'],
  ['triadRate', '“X, Y, and Z” list patterns'],
  ['shortSentenceRate', 'Short sentences and fragments'],
  ['questionRate', 'Questions'],
  ['capsRate', 'Named entities and capitalised terms'],
  ['secondPersonRate', 'Second-person address (you)'],
  ['modalRate', 'Hedged generalisations (can, may, often, typically)'],
  ['passiveRate', 'Passive constructions'],
];
const FEATURE_KEYS = FEATURES.map(([k]) => k);
const FEATURE_LABELS = Object.fromEntries(FEATURES);

export function splitSentences(text) {
  return text.match(/[^.!?\n]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [];
}
function tokens(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}’'-]+/gu) || [];
}
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a) { const m = mean(a); return a.length ? Math.sqrt(mean(a.map((x) => (x - m) ** 2))) : 0; }
function per100(n, words) { return (n / Math.max(1, words)) * 100; }
function countPhrases(lower, phrases) { let n = 0; for (const p of phrases) n += lower.split(p).length - 1; return n; }
function mattr(words, window = 40) {
  if (words.length <= window) return words.length ? new Set(words).size / words.length : 0;
  let total = 0, count = 0;
  for (let i = 0; i + window <= words.length; i += Math.max(1, Math.floor(window / 4))) {
    total += new Set(words.slice(i, i + window)).size / window; count++;
  }
  return total / count;
}

// Kept for API compatibility; only English is supported now.
export function detectLanguage() {
  return 'English';
}

export function extractFeatures(text) {
  const lex = LEXICON.English;
  const lower = text.toLowerCase();
  const words = tokens(text);
  const wc = Math.max(1, words.length);
  const sents = splitSentences(text);
  const sentLens = sents.map((s) => tokens(s).length).filter((n) => n > 0);
  const sentMean = mean(sentLens);
  const paragraphs = text.split(/\n\s*\n/).map((p) => tokens(p).length).filter((n) => n > 0);
  const firstWords = sents.map((s) => tokens(s)[0]).filter(Boolean);
  const expressive = (text.match(/[!?;()…]|—|–| - /g) || []).length;
  return {
    sentLenMean: sentMean / 20,
    sentLenCV: sentMean ? std(sentLens) / sentMean : 0,
    mattr: mattr(words),
    aiLexRate: per100(words.filter((w) => lex.ai.has(w)).length, wc),
    aiPhraseRate: per100(countPhrases(lower, lex.phrases), wc),
    hedgeRate: per100(words.filter((w) => lex.hedge.has(w)).length, wc),
    firstPersonRate: per100(words.filter((w) => lex.first.has(w)).length, wc),
    contractionRate: per100((text.match(lex.contraction) || []).length, wc),
    punctVariety: expressive / Math.max(1, sents.length),
    digitRate: per100((text.match(/\d+/g) || []).length, wc),
    commasPerSentence: (text.match(/,/g) || []).length / Math.max(1, sents.length),
    avgWordLen: mean(words.map((w) => w.length)) / 5,
    longWordRate: per100(words.filter((w) => w.length >= 10).length, wc),
    transitionStartRate: sents.length ? sents.filter((s) => lex.transition.test(s)).length / sents.length : 0,
    startRepetition: firstWords.length > 1 ? 1 - new Set(firstWords).size / firstWords.length : 0,
    paragraphCV: paragraphs.length > 1 ? std(paragraphs) / Math.max(1, mean(paragraphs)) : 0.5,
    triadRate: (text.match(/[\p{L}-]+, [\p{L}\s-]{1,30}?,? (?:and|or|y|e|o) [\p{L}-]+/gu) || []).length / Math.max(1, sents.length),
    shortSentenceRate: sentLens.length ? sentLens.filter((n) => n <= 6).length / sentLens.length : 0,
    questionRate: (text.match(/\?/g) || []).length / Math.max(1, sents.length),
    capsRate: per100(sents.reduce((n, s) => n + s.split(/\s+/).slice(1).filter((w) => /^\p{Lu}[\p{L}'’-]+/u.test(w)).length, 0), wc),
    secondPersonRate: per100(words.filter((w) => lex.second.has(w)).length, wc),
    modalRate: per100(words.filter((w) => lex.modal.has(w)).length, wc),
    passiveRate: (text.match(lex.passive) || []).length / Math.max(1, sents.length),
  };
}
function vector(features) { return FEATURE_KEYS.map((k) => features[k] ?? 0); }

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));
const toLogit = (p) => Math.log(Math.min(1 - 1e-9, Math.max(1e-9, p)) / (1 - Math.min(1 - 1e-9, Math.max(1e-9, p))));

function fitLogistic(X, y, { lambda = 0.08, epochs = 2500, lr = 0.15 } = {}) {
  const d = X[0].length, n = X.length;
  const mu = Array.from({ length: d }, (_, j) => mean(X.map((r) => r[j])));
  const sd = Array.from({ length: d }, (_, j) => std(X.map((r) => r[j])) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const w = new Array(d).fill(0); let b = 0;
  const pos = y.filter(Boolean).length, wPos = n / (2 * Math.max(1, pos)), wNeg = n / (2 * Math.max(1, n - pos));
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const row = Z[i]; let z = b;
      for (let j = 0; j < d; j++) z += row[j] * w[j];
      const err = (sigmoid(z) - y[i]) * (y[i] ? wPos : wNeg);
      for (let j = 0; j < d; j++) gw[j] += err * row[j];
      gb += err;
    }
    let maxGrad = Math.abs(gb / n);
    for (let j = 0; j < d; j++) { const g = gw[j] / n + lambda * w[j]; w[j] -= lr * g; maxGrad = Math.max(maxGrad, Math.abs(g)); }
    b -= lr * (gb / n);
    if (maxGrad < 1e-5) break; // converged; the objective is convex
  }
  return { weights: w, bias: b, mean: mu, std: sd };
}
function rawLogit(model, vec) {
  return vec.reduce((s, v, j) => s + ((v - model.mean[j]) / model.std[j]) * model.weights[j], model.bias);
}
// Platt scaling: p = sigmoid(a * logit + b), fitted on out-of-fold predictions.
function fitPlatt(logits, y) {
  let a = 1, b = 0;
  const pos = y.filter(Boolean).length, neg = y.length - pos;
  const tPos = (pos + 1) / (pos + 2), tNeg = 1 / (neg + 2); // Platt's smoothed targets
  for (let e = 0; e < 3000; e++) {
    let ga = 0, gb = 0;
    logits.forEach((z, i) => { const p = sigmoid(a * z + b), t = y[i] ? tPos : tNeg; ga += (p - t) * z; gb += p - t; });
    ga /= logits.length; gb /= logits.length;
    a -= 0.05 * ga; b -= 0.05 * gb;
    if (Math.abs(ga) < 1e-6 && Math.abs(gb) < 1e-6) break;
  }
  return { a, b };
}

function seededShuffle(arr, seed = 7) {
  const out = [...arr]; let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function stratifiedFolds(samples, k) {
  const folds = Array.from({ length: k }, () => []);
  for (const label of [0, 1]) seededShuffle(samples.map((s, i) => i).filter((i) => samples[i].y === label)).forEach((idx, n) => folds[n % k].push(idx));
  return folds;
}

export function metrics(probs, labels) {
  const n = labels.length;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  probs.forEach((p, i) => { const pred = p >= 0.5 ? 1 : 0; if (pred && labels[i]) tp++; else if (pred) fp++; else if (labels[i]) fn++; else tn++; });
  const precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0;
  // AUROC via the Mann-Whitney statistic.
  const pos = probs.filter((_, i) => labels[i]), neg = probs.filter((_, i) => !labels[i]);
  let auc = null;
  if (pos.length && neg.length) { let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0; auc = s / (pos.length * neg.length); }
  // Expected calibration error over 10 bins.
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const idx = probs.map((p, i) => i).filter((i) => probs[i] >= b / 10 && (b === 9 ? probs[i] <= 1 : probs[i] < (b + 1) / 10));
    if (idx.length) ece += (idx.length / n) * Math.abs(mean(idx.map((i) => probs[i])) - mean(idx.map((i) => labels[i])));
  }
  const r = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  return {
    samples: n, positives: pos.length, negatives: neg.length,
    accuracy: r((tp + tn) / Math.max(1, n)), precision: r(precision), recall: r(recall),
    f1: r(precision + recall ? (2 * precision * recall) / (precision + recall) : 0),
    falsePositiveRate: r(fp + tn ? fp / (fp + tn) : 0),
    auroc: r(auc), brier: r(mean(probs.map((p, i) => (p - labels[i]) ** 2))), ece: r(ece),
    confusion: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn },
  };
}

// Function-word rates: how often each of the most common words appears per 100 words. Common words carry
// authorial habit (hedges, "can", "it's", "however") without tying the model to any topic. The vocabulary is
// chosen without looking at labels, so it cannot leak them into cross-validation.
const VOCAB_SIZE = 100;
function buildVocab(samples) {
  const counts = new Map();
  for (const s of samples) for (const w of tokens(s.text)) if (/^\p{L}[\p{L}'’]*$/u.test(w)) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, VOCAB_SIZE).map(([w]) => w).sort();
}
function wordRates(text, vocab) {
  if (!vocab?.length) return [];
  const toks = tokens(text), counts = new Map();
  for (const w of toks) counts.set(w, (counts.get(w) || 0) + 1);
  const n = Math.max(1, toks.length);
  return vocab.map((w) => ((counts.get(w) || 0) / n) * 100);
}
const fullVector = (text, language, vocab) => [...vector(extractFeatures(text, language)), ...wordRates(text, vocab)];

function prepare(samples, vocab) {
  return samples
    .filter((s) => s.text && tokens(s.text).length >= 20)
    .map((s) => { const language = s.language || detectLanguage(s.text); return { ...s, language, y: s.label, x: fullVector(s.text, language, vocab) }; });
}

export function crossValidate(rawSamples, k = 5) {
  const usable = rawSamples.filter((s) => s.text && tokens(s.text).length >= 20);
  const vocab = buildVocab(usable), samples = prepare(rawSamples, vocab);
  if (samples.length < k * 2 || !samples.some((s) => s.y) || !samples.some((s) => !s.y)) return { oof: [], samples, vocab };
  const folds = stratifiedFolds(samples, k), oof = new Array(samples.length);
  for (const test of folds) {
    const testSet = new Set(test), train = samples.filter((_, i) => !testSet.has(i));
    const m = fitLogistic(train.map((s) => s.x), train.map((s) => s.y));
    test.forEach((i) => { oof[i] = rawLogit(m, samples[i].x); });
  }
  return { oof, samples, vocab };
}

// Cache key over the raw training input, so an unchanged corpus can reuse a saved model.
export function corpusKey(rawSamples, salt = '') {
  return crypto.createHash('sha256').update(MODEL_VERSION + '\n' + salt + '\n' + rawSamples.map((s) => `${s.label}:${s.language || ''}:${s.text}`).join('\n')).digest('hex');
}
// Kept for API compatibility (labeled-data upload); only English is supported now.
export function normalizeLanguage() {
  return 'English';
}

// Second stage: combines the style model's out-of-fold score with the word-predictability signals. The signals come
// from a fixed pre-trained language model, so they cannot leak labels. Only English samples that have signals are used.
// Register features let the combiner adjust for formal or technical writing, where predictability means something
// different (scientific abstracts fooled a combiner without them).
const REGISTER_KEYS = ['avgWordLen', 'longWordRate', 'digitRate', 'capsRate', 'commasPerSentence', 'sentLenMean', 'mattr', 'passiveRate', 'triadRate'];
const REGISTER_LABEL = 'Formal or technical register';
const signalValue = (sig, k) => (k === 'tmr' ? sig.tmr : sig.lm[k]);
function trainStack(samples, oof, signalsFor, sigKeys = SIGNAL_KEYS) {
  const rows = [];
  samples.forEach((s, i) => {
    const sig = signalsFor(s.text);
    if (!sig?.lm) return;
    const x = [oof[i], ...sigKeys.map((k) => signalValue(sig, k)), ...REGISTER_KEYS.map((k) => s.x[FEATURE_KEYS.indexOf(k)])];
    // A single non-finite value (a malformed cache entry, a signal computed from an empty window, ...) would
    // otherwise contaminate the whole fit: fitLogistic's running sums turn NaN from the first sample onward, and
    // every weight comes out NaN, silently collapsing every future score to exactly 50%. Drop only that row.
    if (x.every(Number.isFinite)) rows.push({ y: s.y, x });
  });
  if (rows.length < 100 || !rows.some((r) => r.y) || !rows.some((r) => !r.y)) return null;
  const X = rows.map((r) => r.x), y = rows.map((r) => r.y), stackOof = new Array(rows.length);
  for (const test of stratifiedFolds(rows, 5)) {
    const held = new Set(test), idx = rows.map((_, i) => i).filter((i) => !held.has(i));
    const m = fitLogistic(idx.map((i) => X[i]), idx.map((i) => y[i]));
    test.forEach((i) => { stackOof[i] = rawLogit(m, X[i]); });
  }
  const platt = fitPlatt(stackOof, y), core = fitLogistic(X, y);
  // Last-resort guard: if the fit still came out non-finite for any reason, skip the combined stage entirely rather
  // than ship a model whose every prediction silently reduces to sigmoid(0) = exactly 50%, regardless of the text.
  if (![...core.weights, core.bias, platt.a, platt.b].every(Number.isFinite)) return null;
  return {
    ...core, platt, keys: ['style', ...sigKeys, ...REGISTER_KEYS], trainedOn: rows.length,
    benchmark: { method: '5-fold cross-validation of the combined model (style, a RAID-trained classifier, and word predictability)', overall: metrics(stackOof.map((z) => sigmoid(platt.a * z + platt.b)), y) },
  };
}

/**
 * @param {Array} rawSamples labeled samples
 * @param {{source?: string, signalsFor?: (text: string) => ({lm: object}|null|undefined), cacheSalt?: string}} [opts]
 *   signalsFor supplies pre-computed word-predictability signals (English) so a combined model can be trained.
 */
export function train(rawSamples, { source = 'seed corpus', signalsFor, cacheSalt = '', stackSignals = SIGNAL_KEYS } = {}) {
  const { oof, samples, vocab } = crossValidate(rawSamples);
  if (!oof.length) throw new Error('Training needs at least 10 samples of 20+ words, including both AI and human labels.');
  const platt = fitPlatt(oof, samples.map((s) => s.y));
  const calibrated = oof.map((z) => sigmoid(platt.a * z + platt.b));
  const byLanguage = {};
  for (const lang of [...new Set(samples.map((s) => s.language))]) {
    const idx = samples.map((s, i) => i).filter((i) => samples[i].language === lang);
    byLanguage[lang] = metrics(idx.map((i) => calibrated[i]), idx.map((i) => samples[i].y));
  }
  const core = fitLogistic(samples.map((s) => s.x), samples.map((s) => s.y));
  const hash = crypto.createHash('sha256').update(samples.map((s) => `${s.y}:${s.text}`).join('\n')).digest('hex').slice(0, 16);
  return {
    version: MODEL_VERSION, trainedAt: new Date().toISOString(), corpusHash: hash, cacheKey: corpusKey(rawSamples, cacheSalt), source,
    features: FEATURE_KEYS, vocab, ...core, platt, stack: signalsFor ? trainStack(samples, oof, signalsFor, stackSignals) : null,
    stackTmr: signalsFor && stackSignals === SIGNAL_KEYS ? trainStack(samples, oof, signalsFor, ['tmr']) : null,
    training: {
      samples: samples.length,
      ai: samples.filter((s) => s.y).length,
      human: samples.filter((s) => !s.y).length,
      languages: Object.fromEntries([...new Set(samples.map((s) => s.language))].map((l) => [l, samples.filter((s) => s.language === l).length])),
    },
    benchmark: {
      method: '5-fold stratified cross-validation with Platt calibration fitted on out-of-fold scores',
      overall: metrics(calibrated, samples.map((s) => s.y)),
      byLanguage,
    },
  };
}

/**
 * Scores a text. With `signals` (word-predictability, see neural.mjs) and a combined model, English text is scored by
 * the combined model; otherwise by the style model alone.
 */
export function predict(model, text, language = detectLanguage(text), signals = null) {
  const f = extractFeatures(text, language), vec = [...vector(f), ...wordRates(text, model.vocab)];
  // Short passages carry few signals, so pull their evidence toward "undecided" instead of trusting it fully.
  const shrink = Math.min(1, Math.max(0.35, tokens(text).length / 100));
  const baseRaw = rawLogit(model, vec);
  const impact = (j) => ((vec[j] - model.mean[j]) / model.std[j]) * model.weights[j];
  const contributions = FEATURE_KEYS.map((key, j) => ({ key, label: FEATURE_LABELS[key], impact: impact(j) }));
  // The many function-word rates are shown as one combined signal rather than a hundred tiny ones.
  if (vec.length > FEATURE_KEYS.length) contributions.push({ key: 'wordChoice', label: 'Common-word habits (function-word usage)', impact: vec.slice(FEATURE_KEYS.length).reduce((s, _, k) => s + impact(FEATURE_KEYS.length + k), 0) });

  if (signals?.lm && model.stack) {
    const run = (st) => {
      const sigKeys = st.keys.filter((k) => SIGNAL_KEYS.includes(k));
      const x = [baseRaw, ...sigKeys.map((k) => signalValue(signals, k)), ...REGISTER_KEYS.map((k) => f[k] ?? 0)];
      const logit = rawLogit(st, x) * shrink;
      return { st, sigKeys, x, logit, p: sigmoid(st.platt.a * logit + st.platt.b) };
    };
    const main = run(model.stack), alt = model.stackTmr ? run(model.stackTmr) : null, { st, sigKeys, x, logit } = main;
    const scale = st.weights[0] / st.std[0]; // how much one unit of the style logit moves the combined logit
    const term = (j) => ((x[j] - st.mean[j]) / st.std[j]) * st.weights[j];
    const combined = contributions.map((c) => ({ ...c, impact: c.impact * scale }));
    sigKeys.forEach((k, j) => combined.push({ key: k, label: LM_LABELS[k], impact: term(j + 1) }));
    combined.push({ key: 'register', label: REGISTER_LABEL, impact: REGISTER_KEYS.reduce((s, _, r) => s + term(1 + sigKeys.length + r), 0) });
    // The word-predictability features were learned on mostly older ChatGPT-era text and lose strength on newer models,
    // while the classifier saw many generators. So the final score averages (in logit space) the full model with a
    // second one that has no word-predictability features, instead of letting those features overrule the classifier.
    const probability = alt ? sigmoid((toLogit(main.p) + toLogit(alt.p)) / 2) : main.p;
    return { probability, logit, baseLogit: baseRaw, shrink, stacked: true, features: f, contributions: combined };
  }
  const logit = baseRaw * shrink;
  return { probability: sigmoid(model.platt.a * logit + model.platt.b), logit, baseLogit: baseRaw, shrink, stacked: false, features: f, contributions };
}

function confidenceFor(probability, words) {
  const margin = Math.abs(probability - 0.5);
  if (words < 80) return { level: 'Low', reason: 'Under 80 words; short texts carry too few signals for a reliable estimate.' };
  if (margin < 0.15) return { level: 'Low', reason: 'The score sits near the decision boundary.' };
  if (words >= 250 && margin >= 0.3) return { level: 'High', reason: 'Long text with a clear, consistent signal.' };
  return { level: 'Medium', reason: words < 250 ? 'Moderate text length; more text improves reliability.' : 'The signal is present but not decisive.' };
}
export function verdictFor(p) {
  if (p >= 0.8) return 'Likely AI-generated';
  if (p >= 0.6) return 'Possibly AI-assisted';
  if (p > 0.4) return 'Uncertain / mixed';
  if (p > 0.2) return 'Possibly human-written';
  return 'Likely human-written';
}

// Per-sentence scoring when the classifier has also scored each sentence with its neighbours (`localTmr`). Fitted on
// human+AI documents stitched together from the training corpus (whole-document, mixed and pure), then checked on
// stitched holdout documents: sentence-level AUROC 0.90 / accuracy 82%, against 0.77 / 68% for a style-only shift.
// z = docZ * a + localClassifierLogit * b + styleDelta * c + bias, where docZ is the document's own calibrated logit.
const SENTENCE_FIT = { doc: 0.277, tmr: 0.537, style: 0.686, bias: -1.675 };

export function detect(model, text, language, sentenceTexts, signals = null, localTmr = null) {
  const words = tokens(text).length;
  if (words < 30) return { probability: null, verdict: 'Not enough text', confidence: 'Low', confidenceReason: 'Add at least 30 words (80+ recommended) for an AI-likelihood estimate.', sentences: [], model: modelSummary(model) };
  const doc = predict(model, text, language, signals);
  const calib = doc.stacked ? model.stack.platt : model.platt;
  const styleWeight = doc.stacked ? model.stack.weights[0] / model.stack.std[0] : 1;
  const sorted = [...doc.contributions].sort((a, b) => b.impact - a.impact);
  const conf = confidenceFor(doc.probability, words);
  const sents = sentenceTexts || splitSentences(text);
  const sentences = sents.map((s, i) => {
    const windowText = sents.slice(Math.max(0, i - 1), i + 2).join(' ');
    const sw = tokens(s).length;
    if (sw < 4) return { probability: doc.probability, confidence: 'Low' };
    const local = predict(model, windowText, language); // style-only: scoring every sentence with a language model would be far too slow
    // Single sentences are noisy. Style-only: blend the local window with the document score. Combined model: start from the
    // document score and shift it by how much more (or less) AI-like this window's style is than the document's average.
    const styleDelta = local.baseLogit * local.shrink - doc.baseLogit * doc.shrink;
    let p;
    if (doc.stacked && Number.isFinite(localTmr?.[i])) p = sigmoid(SENTENCE_FIT.doc * toLogit(doc.probability) + SENTENCE_FIT.tmr * localTmr[i] + SENTENCE_FIT.style * styleDelta + SENTENCE_FIT.bias);
    else if (doc.stacked) p = sigmoid(toLogit(doc.probability) + calib.a * 0.6 * styleWeight * styleDelta);
    else p = sigmoid(calib.a * (0.6 * local.logit + 0.4 * doc.logit) + calib.b);
    // Do not highlight sentences of a document the detector judged clearly human (it would contradict the verdict).
    if (doc.probability < 0.2) p = Math.min(p, 0.39);
    const margin = Math.abs(p - 0.5);
    return { probability: p, confidence: sw >= 18 && margin >= 0.3 ? 'High' : sw >= 8 && margin >= 0.15 ? 'Medium' : 'Low' };
  });
  return {
    probability: doc.probability,
    percent: Math.round(doc.probability * 100),
    verdict: verdictFor(doc.probability),
    confidence: conf.level,
    confidenceReason: conf.reason,
    towardAI: sorted.filter((c) => c.impact > 0.15).slice(0, 3).map(({ label, impact }) => ({ label, impact: Math.round(impact * 100) / 100 })),
    towardHuman: sorted.reverse().filter((c) => c.impact < -0.15).slice(0, 3).map(({ label, impact }) => ({ label, impact: Math.round(impact * 100) / 100 })),
    sentences,
    mode: doc.stacked ? 'style + word predictability' : 'style only',
    model: modelSummary(model),
    disclaimer: 'A calibrated statistical estimate, not proof of authorship. Human writing can score high and edited AI text can score low.',
  };
}
export function modelSummary(model) {
  return { version: model.version, trainedAt: model.trainedAt, samples: model.training.samples, languages: Object.keys(model.training.languages), source: model.source, combined: !!model.stack };
}

// Labeled data parsing: JSONL ({"text","label"}) or CSV with text,label columns.
export function normalizeLabel(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'ai', 'machine', 'generated', 'ai-generated', 'true', 'yes'].includes(s)) return 1;
  if (['0', 'human', 'person', 'human-written', 'false', 'no'].includes(s)) return 0;
  return null;
}
function parseCsv(input) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) { if (c === '"' && input[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && input[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
export function parseLabeled(data, format) {
  const text = String(data || '').replace(/^﻿/, '').trim();
  if (!text) return [];
  const fmt = format || (text.startsWith('{') || text.startsWith('[') ? 'jsonl' : 'csv');
  let items;
  if (fmt === 'jsonl') {
    let whole;
    try { whole = JSON.parse(text); } catch {}
    if (whole !== undefined) items = Array.isArray(whole) ? whole : [whole];
    else items = text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`Line ${i + 1} is not valid JSON. Use one JSON object per line, or a JSON array.`); } });
  } else {
    const rows = parseCsv(text), head = rows[0].map((h) => h.trim().toLowerCase());
    const ti = head.indexOf('text'), li = head.indexOf('label'), gi = head.indexOf('language');
    if (ti < 0 || li < 0) throw new Error('CSV needs a header row with "text" and "label" columns.');
    items = rows.slice(1).map((r) => ({ text: r[ti], label: r[li], language: gi >= 0 ? r[gi] : undefined }));
  }
  return items.map((x) => ({ text: String(x?.text || '').trim(), label: normalizeLabel(x?.label), language: normalizeLanguage(x?.language), source: x?.source ? String(x.source) : undefined }))
    .filter((x) => x.text && x.label !== null);
}

/** `signalsFor(text)` may supply cached word-predictability signals so the combined model can be evaluated offline. */
export function evaluate(model, samples, { signalsFor } = {}) {
  const usable = samples.filter((s) => tokens(s.text).length >= 20);
  if (!usable.length) throw new Error('No sample has 20 or more words, so nothing could be scored.');
  const probs = usable.map((s) => predict(model, s.text, s.language || detectLanguage(s.text), signalsFor?.(s.text)).probability);
  return { ...metrics(probs, usable.map((s) => s.label)), skipped: samples.length - usable.length };
}

export function loadSeedCorpus(dir) {
  const file = path.join(dir, 'detector', 'corpus.seed.jsonl');
  return parseLabeled(fs.readFileSync(file, 'utf8'), 'jsonl');
}
