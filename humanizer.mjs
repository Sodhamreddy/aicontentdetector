// Kleza local humanizer: a deterministic rewrite pass aimed at the same signals the detector measures
// (stock phrases, AI-associated vocabulary, formal transitions, missing contractions, uniform sentence rhythm).
// It never changes numbers, names or quotations, and it is a starting point for editing, not a guarantee.

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const matchCase = (from, to) => (/^[A-Z]/.test(from) ? cap(to) : to);
const words = (s) => (s.match(/[\p{L}\p{N}’'-]+/gu) || []).length;

// ---- English --------------------------------------------------------------------------------------------
// Multi-word patterns first; they must leave a grammatical sentence behind.
const EN_PHRASES = [
  [/\bin today['’]?s (?:modern |digital |ever-evolving |fast-paced |rapidly changing |ever-changing |interconnected )*(?:world|landscape|era|age|society|environment|market),?\s*/gi, ''],
  [/\bin the (?:modern|digital) (?:age|era|world),?\s*/gi, ''],
  [/\bit is (?:important|worth|essential|crucial|vital) to (?:note|mention|remember|recognize|understand|highlight|emphasize) that\s+/gi, ''],
  [/\bit is (?:essential|crucial|vital|important) to\s+/gi, 'you should '],
  [/\bplay (?:an? )?(?:crucial|vital|pivotal|key|significant|important) roles? in\b/gi, 'are key to'],
  [/\bplays (?:an? )?(?:crucial|vital|pivotal|key|significant|important) role in\b/gi, 'is key to'],
  [/\b(?:is|are) a testament to\b/gi, 'shows'],
  [/\ba testament to\b/gi, 'proof of'],
  [/\ba (?:wide range|wide variety|plethora|myriad|multitude|host) of\b/gi, 'many'],
  [/\bwhen it comes to\b/gi, 'for'],
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bat the end of the day,?\s*/gi, ''],
  [/\b(?:ever-evolving|ever-changing|rapidly evolving|rapidly changing|fast-paced)\b/gi, 'changing'],
  [/\bdigital landscape\b/gi, 'digital world'],
  [/\bcutting-edge\b/gi, 'modern'],
  [/\bunlock (?:their |your |its |the |our )?(?:full )?potential\b/gi, 'do more'],
  [/\bunlock (?:new )?opportunities\b/gi, 'find new opportunities'],
  [/\bembark on (?:a|an|the) journey\b/gi, 'start'],
  [/\bdive (?:deep )?into\b/gi, 'look at'],
  [/\bdelv(?:e|es|ing) into\b/gi, (m) => matchCase(m, /es/i.test(m.split(' ')[0]) ? 'looks at' : /ing/i.test(m.split(' ')[0]) ? 'looking at' : 'look at')],
  [/\bharness(es|ing)? the power of\b/gi, (m, f) => matchCase(m, f === 'ing' ? 'using' : f === 'es' ? 'uses' : 'use')],
  [/\bnavigat(e|es|ing) the complexities of\b/gi, (m, f) => matchCase(m, f === 'ing' ? 'dealing with' : f === 'es' ? 'deals with' : 'deal with')],
  [/\bensur(?:e|es) that\b/gi, (m) => matchCase(m, /es/i.test(m.split(' ')[0]) ? 'makes sure that' : 'make sure that')],
  [/\bensuring that\b/gi, 'making sure that'],
  [/\bin conclusion,?\s*/gi, ''],
  [/\bin summary,?\s*/gi, ''],
  [/\bit(?:['’]s| is) worth noting that\s+/gi, ''],
  [/\bit should be noted that\s+/gi, ''],
  [/(^|[.!?]["”’']?\s+)overall,\s*/gi, '$1'],
  [/\balso known as\b/gi, 'or'],
  [/\b(is|are) known as\b/gi, '$1 called'],
  [/\bsuch as\b/gi, 'like'],
  [/\bin addition to\b/gi, 'besides'],
  [/\bprior to\b/gi, 'before'],
  [/\bin the event that\b/gi, 'if'],
  [/\bthe majority of\b/gi, 'most'],
  [/\ba large number of\b/gi, 'many'],
  [/\ba number of\b/gi, 'several'],
  [/\b(?:is|are) able to\b/gi, 'can'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bit is possible to\b/gi, 'you can'],
  [/\bcan be used to\b/gi, 'can'],
  [/\bin the (?:field|area|realm) of\b/gi, 'in'],
  [/\bsimilar to\b/gi, 'like'],
];
// Sentence-start connectives that read stiffly in casual copy; only applied at the Natural level.
const EN_NATURAL_PHRASES = [
  [/(^|[.!?]["”’']?\s+)however,\s*/gi, '$1But '],
  [/(^|[.!?]["”’']?\s+)therefore,\s*/gi, '$1So '],
  [/(^|[.!?]["”’']?\s+)for instance,\s*/gi, '$1For example, '],
  [/(^|[.!?]["”’']?\s+)(?:as a result|thus|hence|consequently),\s*/gi, '$1So '],
];

// Single words; a preceding a/an is corrected to match the replacement.
const EN_WORDS = {
  leverage: 'use', leverages: 'uses', leveraged: 'used', leveraging: 'using',
  utilize: 'use', utilizes: 'uses', utilized: 'used', utilizing: 'using', utilization: 'use',
  crucial: 'important', pivotal: 'key', comprehensive: 'thorough', seamless: 'smooth', seamlessly: 'smoothly',
  robust: 'strong', foster: 'encourage', fosters: 'encourages', fostering: 'encouraging',
  enhance: 'improve', enhances: 'improves', enhancing: 'improving', enhanced: 'improved',
  numerous: 'many', myriad: 'many', significant: 'major', significantly: 'greatly',
  optimal: 'best possible', approximately: 'about', demonstrate: 'show', demonstrates: 'shows', demonstrated: 'showed',
  obtain: 'get', obtains: 'gets', require: 'need', requires: 'needs',
  assist: 'help', assists: 'helps', beneficial: 'helpful', sufficient: 'enough', regarding: 'about', subsequently: 'later',
  consequently: 'so', therefore: 'so', participate: 'take part', implement: 'put in place', implementing: 'putting in place',
  considerable: 'large', substantial: 'large', essential: 'key', important: 'key',
  receive: 'get', receives: 'gets', received: 'got', assistance: 'help', numerous: 'many',
  facilitate: 'help', facilitates: 'helps', facilitating: 'helping',
  empower: 'help', empowers: 'helps', empowering: 'helping', empowered: 'helped',
  streamline: 'simplify', streamlines: 'simplifies', streamlining: 'simplifying',
  showcase: 'show', showcases: 'shows', showcasing: 'showing',
  invaluable: 'very useful', meticulous: 'careful', meticulously: 'carefully', paramount: 'critical',
  holistic: 'broad', underscore: 'stress', underscores: 'stresses', innovative: 'new',
  individuals: 'people', various: 'different', commence: 'start', endeavor: 'effort', endeavors: 'efforts',
};
// Not after a degree word ("more important" -> "more key" is wrong) and not before "that" ("important that ...").
const EN_WORD_RE = new RegExp(`(?<!\\b(?:more|most|very|so|too|less|least|as|how|equally|quite|extremely|really)\\s)\\b(?:(a|an)\\s+)?(${Object.keys(EN_WORDS).join('|')})\\b(?!\\s+that\\b)`, 'gi');

const CONTRACTIONS = [
  ['it is', "it's"], ['that is', "that's"], ['there is', "there's"], ['he is', "he's"], ['she is', "she's"], ['what is', "what's"],
  ['do not', "don't"], ['does not', "doesn't"], ['did not', "didn't"], ['is not', "isn't"], ['are not', "aren't"],
  ['was not', "wasn't"], ['were not', "weren't"], ['has not', "hasn't"], ['have not', "haven't"], ['had not', "hadn't"],
  ['will not', "won't"], ['would not', "wouldn't"], ['could not', "couldn't"], ['should not', "shouldn't"],
  ['cannot', "can't"], ['can not', "can't"], ['you are', "you're"], ['they are', "they're"], ['we are', "we're"],
  ['i am', "I'm"], ['you will', "you'll"], ['we will', "we'll"], ['they will', "they'll"], ['it will', "it'll"],
];
const CONTRACTION_RE = new RegExp(`\\b(${CONTRACTIONS.map(([a]) => a.replace(/ /g, '\\s+')).join('|')})\\b(?=\\s+[\\p{L}])`, 'giu');
const CONTRACTION_MAP = Object.fromEntries(CONTRACTIONS);

// ---- Steps ----------------------------------------------------------------------------------------------
function swapWords(text) {
  return text.replace(EN_WORD_RE, (m, article, word) => {
    const rep = EN_WORDS[word.toLowerCase()], out = matchCase(word, rep);
    if (!article) return out;
    const an = /^[aeiou]/i.test(rep) && !/^use/i.test(rep) ? 'an' : 'a';
    return `${matchCase(article, an)} ${out}`;
  });
}

// Formal sentence-openers add nothing a reader misses, so they are dropped; the tidy pass re-capitalises.
function softenTransitions(text) {
  return text.replace(/(^|[.!?]["”’']?\s+|\n)(?:furthermore|moreover|additionally|in addition|what['’]s more),\s*/gi, '$1');
}

function addContractions(text) {
  return text.replace(CONTRACTION_RE, (m) => matchCase(m, CONTRACTION_MAP[m.toLowerCase().replace(/\s+/g, ' ')]));
}

const ABBREV = /(?:\b(?:e\.g|i\.e|etc|vs|dr|mr|mrs|ms|st|no|fig|approx|inc|ltd|u\.s|u\.k)|\b[A-Z])\.$/i;
function splitSentences(paragraph) {
  const parts = paragraph.split(/(?<=[.!?]["”’')\]]?)\s+/), out = [];
  for (const part of parts) {
    if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ` ${part}`;
    else out.push(part);
  }
  return out.filter(Boolean);
}
const SUBJECTY = /^(?:it|they|we|you|he|she|this|these|that|those|the|a|an|our|their|your|its|there|many|most|some|i)\b/i;
// Two sentences are only joined with a semicolon when the second clearly points back at the first;
// joining unrelated sentences reads badly.
const MERGEABLE = /^(?:it|this|that|these|those|they|he|she|its|their)\b/i;

// Break over-long sentences at a clean clause boundary so the rhythm varies.
function splitLong(sentence, limit = 24) {
  if (words(sentence) <= limit) return [sentence];
  const body = sentence.replace(/[.!?]+$/, ''), end = sentence.slice(body.length) || '.';
  const tries = [
    [/, which /, (b, a) => [b, `This ${a}`]],
    [/; /, (b, a) => [b, cap(a)]],
    [/, and (?=\S)/, (b, a) => (SUBJECTY.test(a) ? [b, cap(a)] : null)],
    [/, but (?=\S)/, (b, a) => (SUBJECTY.test(a) ? [b, `But ${a}`] : null)],
    [/, so (?=\S)/, (b, a) => (SUBJECTY.test(a) ? [b, `So ${a}`] : null)],
    [/, yet (?=\S)/, (b, a) => [b, `Yet ${a}`]],
  ];
  for (const [re, build] of tries) {
    const m = re.exec(body);
    if (!m) continue;
    const before = body.slice(0, m.index), after = body.slice(m.index + m[0].length);
    if (words(before) < 8 || words(after) < 4) continue;
    const pair = build(before, after);
    if (pair) return [`${pair[0]}.`, `${pair[1]}${end}`];
  }
  return [sentence];
}

function cv(lens) {
  if (lens.length < 2) return 1;
  const m = lens.reduce((a, b) => a + b, 0) / lens.length;
  return m ? Math.sqrt(lens.reduce((a, b) => a + (b - m) ** 2, 0) / lens.length) / m : 0;
}

function varyRhythm(paragraph) {
  let sents = splitSentences(paragraph).flatMap((s) => splitLong(s));
  // Still too even: split the longest sentence at a clause boundary, even if it is only moderately long.
  if (sents.length >= 3 && cv(sents.map(words)) < 0.4) {
    const longest = sents.reduce((bi, s, i) => (words(s) > words(sents[bi]) ? i : bi), 0);
    sents.splice(longest, 1, ...splitLong(sents[longest], 15));
  }
  // Very even paragraphs read as machine-made: join one short-ish pair into a longer sentence.
  if (sents.length >= 4 && cv(sents.map(words)) < 0.4) {
    let best = -1, bestLen = Infinity;
    for (let i = 0; i < sents.length - 1; i++) {
      const next = sents[i + 1], len = words(sents[i]) + words(next);
      // Only join plain statements, and never lowercase "I" or an acronym.
      if (len <= 34 && len < bestLen && /\.$/.test(sents[i]) && MERGEABLE.test(next) && !/^(?:I\b|[A-Z]{2,})/.test(next)) { best = i; bestLen = len; }
    }
    if (best >= 0) {
      const first = sents[best].replace(/\.$/, ''), second = sents[best + 1];
      sents.splice(best, 2, `${first}; ${second.charAt(0).toLowerCase()}${second.slice(1)}`);
    }
  }
  return sents.join(' ');
}

function tidy(text) {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^([ \t]*)([a-z])/gm, (_, s, c) => s + c.toUpperCase())
    .replace(/([.!?]["”’')\]]?\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase())
    .replace(/,\s*,/g, ',')
    .trim();
}

/**
 * Rewrite text to read less like stock AI prose.
 * @param {string} text
 * @param {{level?: 'Natural'|'Professional'|string}} [options]
 */
export function humanize(text, { level = 'Natural' } = {}) {
  // Quotations are someone's exact words: mask them so no step can touch them, then restore.
  const quotes = [];
  let out = text.replace(/[“"][^”"\n]+[”"]/g, (q) => `§${quotes.push(q) - 1}§`);
  out = rewrite(out, level);
  return out.replace(/§(\d+)§/g, (_, i) => quotes[i]);
}

// Levels: Light (only stock phrasing and buzzwords), Natural (also contractions and rhythm), Professional
// (Natural without contractions), Brand Voice (behaves like Natural).
function rewrite(text, level) {
  const light = level === 'Light', casual = !light && level !== 'Professional';
  let out = text;
  for (const [re, rep] of EN_PHRASES) out = out.replace(re, rep);
  if (casual) for (const [re, rep] of EN_NATURAL_PHRASES) out = out.replace(re, rep);
  out = swapWords(out);
  out = softenTransitions(out);
  if (casual) out = addContractions(out);
  if (level === 'Professional') out = out.replace(/\breally\b\s*/gi, '').replace(/\bvery\b\s*/gi, '');
  out = tidy(out);
  if (!light) out = out.split(/(\n\s*\n|\n)/).map((p) => (/^\s*$/.test(p) ? p : varyRhythm(p))).join('');
  return tidy(out);
}

// ---- LLM rewriting: prompt + score-and-retry loop (the model client is injected so this is testable) ------
const numbersAndQuotes = (s) => JSON.stringify([s.match(/\b\d+(?:\.\d+)?%?\b/g) || [], s.match(/[“"][^”"]+[”"]/g) || []]);

/** Models sometimes add markdown bold or heading marks and non-breaking hyphens; the text is plain, so remove them. */
export const cleanLlmText = (s) => String(s || '')
  .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/^#{1,6}\s+/gm, '')
  .replace(/[‐‑‒]/g, '-').replace(/[   ]/g, ' ').replace(/[ \t]+$/gm, '').trim();

/** Remove quotation marks a rewrite added around phrases; quotations that were in the original stay exactly as they were. */
export function dropAddedQuotes(candidate, original) {
  const kept = new Set(original.match(/[“"][^”"]+[”"]/g) || []);
  return candidate.replace(/[“"]([^”"]+)[”"]/g, (q, inner) => (kept.has(q) ? q : inner));
}

export function humanizePrompt(text, options = {}, feedback = null) {
  const professional = options.level === 'Professional', light = options.level === 'Light';
  const keywords = [options.primary, ...(options.secondary || [])].map((k) => String(k || '').trim()).filter(Boolean);
  const rules = [
    '- Keep every fact, name, number, quotation and URL exactly as written. Never invent facts, examples, anecdotes or personal experiences.',
    `- The original has ${words(text)} words. Your version must have between ${Math.round(words(text) * Math.min(1, (options.minLength ?? 0.9) + 0.1))} and ${Math.round(words(text) * 1.15)} words (models tend to come in short, so aim for a little over the original length). Do not summarise, shorten or drop any point, tip, example, heading or paragraph: every idea in the original must still be there.`,
    '- Do not add quotation marks of any kind (no quoted phrases, no scare quotes, no new quotations); only quotations already in the original may stay.',
    light
      ? '- Make minimal edits: change only stock AI phrasing and stiff wording, and keep the author\'s sentences and structure otherwise.'
      : '- Vary sentence length a lot: mix very short sentences (under 8 words) with longer ones. Do not let neighbouring sentences have similar length or the same opening word.',
    professional ? '- Polished but plain register. Do not use contractions.' : light ? '- Keep the author\'s register.' : '- Natural, direct register. Use contractions where a person would.',
    options.level === 'Brand Voice' && options.brand ? '- Write in the brand voice described under "Brand guidance" below.' : null,
    keywords.length ? `- Keep these keywords wherever they already appear (do not add or stuff them): ${keywords.join(', ')}.` : null,
    '- Replace stock phrases and buzzwords (leverage, crucial, pivotal, seamless, robust, foster, delve, landscape, "plays a vital role", "in today\'s world", "it is important to note") with plain, concrete wording.',
    '- Remove formal transition openers such as Furthermore, Moreover, Additionally and In conclusion.',
    '- Avoid "X, Y, and Z" lists of three where a shorter or uneven list works. Prefer specific wording over generic praise.',
    ...(light ? [] : [
      '- Write like a warm, plain-spoken person who knows the subject, not like a brochure, using everyday words a neighbour would use.',
      '- Change the shape of the writing, not just the words: break up and recombine sentences, move clauses around, change which idea opens each paragraph, and let sentence length swing from three words to thirty.',
      '- Start some sentences with "And", "But" or "So", and use the occasional fragment. Avoid tidy balanced pairs ("not just X but Y"), colon-led setups ("Why it matters:"), and wrap-up sentences that restate the point. Be concrete instead of general.',
    ]),
    '- Keep the paragraph structure. Do not add headings, bullets or commentary. Plain text only: no markdown, no asterisks, no bold.',
  ].filter(Boolean);
  return [
    'Rewrite the text below so it reads as if a careful person wrote it. Keep the meaning identical.',
    'Rules:',
    ...rules,
    `Audience: ${options.audience || 'general'}. Tone: ${options.tone || 'clear'}. Required terms that must stay unchanged: ${(options.required || []).join(', ') || 'none'}. Brand guidance: ${options.brand || 'none'}.`,
    ...(feedback ? [`\nA previous attempt still scored ${feedback.percent}% on our AI-pattern detector. Main signals: ${feedback.signals}. Fix those specifically, starting again from the original text. Rewrite much more aggressively this time: restructure sentences, change openings, merge or split sentences, swap generic wording for concrete wording, and break any even rhythm. Keep every fact unchanged.`] : []),
    'Return only the rewritten text.',
    '',
    text,
  ].join('\n');
}

/**
 * Ask an LLM to rewrite `text`, score each attempt, and retry with the detector's feedback.
 * Keeps the lowest-scoring attempt that preserved every number, quotation and required term; if no attempt
 * was faithful, the lowest-scoring one is returned so the caller's quality checks can flag it.
 * @param {{text:string, options?:object, maxAttempts?:number,
 *   generate:(prompt:string)=>Promise<string>, score:(candidate:string)=>{probability:number|null, signals?:string[]}}} args
 */
export async function refineWithScoring({ text, options = {}, generate, score, maxAttempts = 3, target = 0.5, minLength = 0.8, stallLimit = 2, signal }) {
  let feedback = null, best = null, attempts = 0, stalled = 0;
  // Only terms that occur in this text can be required of it (matters when a long text is rewritten in chunks).
  const required = (options.required || []).filter((k) => text.toLowerCase().includes(k.toLowerCase()));
  while (attempts < maxAttempts) {
    signal?.throwIfAborted();
    attempts++;
    const candidate = dropAddedQuotes(cleanLlmText(await generate(humanizePrompt(text, options, feedback), { signal })), text);
    if (!candidate) continue;
    // A rewrite that loses more than (1 - minLength) of the words has dropped content, however natural it reads.
    const keepsLength = words(text) < 40 || words(candidate) >= words(text) * minLength;
    const factsKept = numbersAndQuotes(candidate) === numbersAndQuotes(text) && required.every((k) => candidate.toLowerCase().includes(k.toLowerCase()));
    const faithful = keepsLength && factsKept, ratio = Math.min(1, words(candidate) / Math.max(1, words(text)));
    const { probability, signals = [] } = await score(candidate), p = probability ?? 0; // score may be async (the detector can run a language model)
    // Ranking: a faithful attempt beats any other (then the lowest score wins). With none faithful, keep the facts first, then
    // the most complete text (a low score from a shortened rewrite is not a win), then the lowest score.
    const cand = { text: candidate, p, faithful, factsKept, ratio: Math.round(ratio * 20) / 20 };
    const beats = (a, b) => (a.faithful !== b.faithful ? a.faithful : a.faithful ? a.p < b.p : a.factsKept !== b.factsKept ? a.factsKept : a.ratio !== b.ratio ? a.ratio > b.ratio : a.p < b.p);
    const improved = !best || (faithful && !best.faithful) || p < best.p - 0.02;
    if (!best || beats(cand, best)) best = cand;
    stalled = improved ? 0 : stalled + 1;
    if (best.faithful && best.p < target) break;
    if (best.faithful && stalled >= stallLimit) break; // several retries in a row gained under 2 points: more attempts only cost time
    feedback = { percent: Math.round(p * 100), signals: signals.join('; ') || 'uniform rhythm and generic wording' };
  }
  return { text: best?.text ?? text, attempts, probability: best?.p ?? null, faithful: best?.faithful ?? false };
}

/**
 * Split a long text into chunks of roughly `maxWords` words at paragraph boundaries (or sentence boundaries
 * inside one huge paragraph). Whitespace is kept, so chunks.join('') always equals the original text.
 */
export function chunkText(text, maxWords = 1200) {
  if (words(text) <= maxWords) return [text];
  const pieces = [], paragraphs = text.split(/(\n\s*\n)/);
  for (let i = 0; i < paragraphs.length; i += 2) {
    const body = paragraphs[i], sep = paragraphs[i + 1] ?? '';
    if (words(body) <= maxWords) { pieces.push(body + sep); continue; }
    const parts = body.split(/((?<=[.!?]["”’')\]]?)\s+)/); // content, whitespace, content, ...
    for (let j = 0; j < parts.length; j += 2) pieces.push(parts[j] + (parts[j + 1] ?? '') + (j + 2 >= parts.length ? sep : ''));
  }
  const chunks = [];
  let current = '', n = 0;
  for (const piece of pieces) {
    const w = words(piece);
    if (current && n + w > maxWords) { chunks.push(current); current = ''; n = 0; }
    current += piece; n += w;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** refineWithScoring over a text of any length: long texts are rewritten chunk by chunk (a few at a time), then stitched back with their original spacing. */
export async function refineLong({ text, maxChunkWords = 1200, concurrency = 2, onProgress, signal, ...rest }) {
  const chunks = chunkText(text, maxChunkWords);
  const results = new Array(chunks.length);
  let next = 0, finished = 0;
  onProgress?.({ done: 0, total: chunks.length });
  const worker = async () => {
    while (next < chunks.length) {
      signal?.throwIfAborted(); // a cancelled job stops before starting another chunk
      const i = next++, chunk = chunks[i], core = chunk.trim();
      if (!core) { results[i] = { text: chunk, attempts: 0, faithful: true }; }
      else {
        const lead = chunk.slice(0, chunk.indexOf(core)), trail = chunk.slice(lead.length + core.length);
        const r = await refineWithScoring({ text: core, signal, ...rest });
        results[i] = { ...r, text: lead + r.text + trail };
      }
      onProgress?.({ done: ++finished, total: chunks.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return {
    text: results.map((r) => r.text).join(''),
    attempts: Math.max(...results.map((r) => r.attempts)),
    chunks: chunks.length,
    faithful: results.every((r) => r.faithful),
  };
}

// ---- Detector-guided rewriting ------------------------------------------------------------------------
// Every clean way to break one sentence into two (each half a complete clause).
function splitOptions(sentence) {
  const body = sentence.replace(/[.!?]+$/, ''), end = sentence.slice(body.length) || '.', out = [];
  const rules = [
    [/, which /g, (a) => `This ${a}`], [/; /g, (a) => cap(a)],
    [/, and (?=\S)/g, (a) => (SUBJECTY.test(a) ? cap(a) : null)], [/, but (?=\S)/g, (a) => (SUBJECTY.test(a) ? `But ${a}` : null)],
    [/, so (?=\S)/g, (a) => (SUBJECTY.test(a) ? `So ${a}` : null)], [/, yet (?=\S)/g, (a) => `Yet ${a}`],
    [/, while (?=\S)/g, (a) => (SUBJECTY.test(a) ? `Meanwhile, ${a}` : null)],
  ];
  for (const [re, next] of rules) {
    for (const m of body.matchAll(re)) {
      const before = body.slice(0, m.index), after = body.slice(m.index + m[0].length);
      if (words(before) < 5 || words(after) < 4) continue;
      const second = next(after);
      if (second) out.push([`${before}.`, `${second}${end}`]);
    }
  }
  return out;
}

// Every candidate rewrite of a paragraph that changes only sentence boundaries.
function boundaryEdits(sents) {
  const edits = [];
  sents.forEach((s, i) => splitOptions(s).forEach(([a, b]) => edits.push([...sents.slice(0, i), a, b, ...sents.slice(i + 1)])));
  for (let i = 0; i < sents.length - 1; i++) {
    const next = sents[i + 1];
    if (/\.$/.test(sents[i]) && MERGEABLE.test(next) && !/^(?:I\b|[A-Z]{2,})/.test(next) && words(sents[i]) + words(next) <= 38) {
      edits.push([...sents.slice(0, i), `${sents[i].replace(/\.$/, '')}; ${next.charAt(0).toLowerCase()}${next.slice(1)}`, ...sents.slice(i + 2)]);
    }
  }
  return edits;
}

/**
 * Like humanize(), but keeps only the sentence-boundary edits that lower `score` (a function returning a
 * number where lower reads more human, e.g. the detector's logit). Word choice is never changed by this
 * search, so meaning, numbers and quotations are untouched. `budgetMs` bounds the total search time.
 */
export function humanizeGuided(text, { level = 'Natural', score, budgetMs = 4000 } = {}) {
  const base = humanize(text, { level });
  if (typeof score !== 'function' || level === 'Light') return base;
  const quotes = [], masked = base.replace(/[“"][^”"\n]+[”"]/g, (q) => `§${quotes.push(q) - 1}§`);
  const deadline = Date.now() + budgetMs;
  const optimized = masked.split(/(\n\s*\n|\n)/).map((paragraph) => {
    if (/^\s*$/.test(paragraph) || words(paragraph) < 25) return paragraph;
    let sents = splitSentences(paragraph), best = score(sents.join(' '));
    for (let move = 0, limit = Math.max(3, Math.ceil(sents.length * 0.6)); move < limit && Date.now() < deadline; move++) {
      let pick = null;
      for (const cand of boundaryEdits(sents)) {
        if (Date.now() > deadline) break;
        const s = score(cand.join(' '));
        if (s < best - 0.03 && (!pick || s < pick.s)) pick = { cand, s };
      }
      if (!pick) break;
      sents = pick.cand; best = pick.s;
    }
    return sents.join(' ');
  }).join('');
  return tidy(optimized.replace(/§(\d+)§/g, (_, i) => quotes[i]));
}

// Applies the rewrite to one flagged span only, leaving the rest of the text untouched.
export function humanizeSpan(text, start, end, options) {
  const span = text.slice(start, end), [lead] = span.match(/^\s*/), [trail] = span.match(/\s*$/);
  let rewritten = humanize(span, options);
  // A span that begins mid-sentence must not gain a capital letter from the sentence-start cleanup.
  if (/^[a-z]/.test(span.trimStart())) rewritten = rewritten.charAt(0).toLowerCase() + rewritten.slice(1);
  return text.slice(0, start) + lead + rewritten + trail + text.slice(end);
}
