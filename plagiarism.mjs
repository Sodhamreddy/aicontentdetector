// Plagiarism check: find passages of a text that also appear in other sources.
// Matching is exact: a run of at least K words (default 8) that is word-for-word the same, ignoring case, punctuation and spacing.
// That finds copied and lightly re-pasted text; it does NOT find paraphrases or translated text, and it can only compare with the
// sources it can read: pages you list, Wikipedia, your own saved texts and, when a search key is set, the first results a web search
// returns for a few distinctive sentences. A result is evidence to review, never a verdict.
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;
const STOP = new Set('a,an,and,are,as,at,be,been,but,by,can,for,from,had,has,have,he,her,his,i,if,in,into,is,it,its,of,on,or,our,she,so,than,that,the,their,them,then,there,these,they,this,to,was,we,were,what,when,which,who,will,with,would,you,your'.split(','));

export const MIN_RUN = 8;

export function tokenize(text) {
  const out = [];
  for (const m of String(text || '').matchAll(WORD)) out.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });
  return out;
}

// A shingle made mostly of stop words ("it is one of the most of the") says nothing about copying.
const weak = (words) => words.filter((w) => !STOP.has(w)).length < 3;
function shingles(tokens, k) {
  const set = new Set();
  for (let i = 0; i + k <= tokens.length; i++) { const ws = []; for (let j = 0; j < k; j++) ws.push(tokens[i + j].w); if (!weak(ws)) set.add(ws.join(' ')); }
  return set;
}

/** Per-token flags: which words of the input sit inside a run of at least k words that also appears in `sourceTokens`. */
export function matchFlags(inputTokens, sourceTokens, k = MIN_RUN) {
  const flags = new Uint8Array(inputTokens.length);
  if (inputTokens.length < k || sourceTokens.length < k) return flags;
  const theirs = shingles(sourceTokens, k);
  for (let i = 0; i + k <= inputTokens.length; i++) {
    const ws = []; for (let j = 0; j < k; j++) ws.push(inputTokens[i + j].w);
    if (!weak(ws) && theirs.has(ws.join(' '))) for (let j = 0; j < k; j++) flags[i + j] = 1;
  }
  return flags;
}

// Quoted passages (at least k words inside quotation marks) are cited, so they are reported apart from the score.
function quotedFlags(text, tokens, k) {
  const spans = [...String(text).matchAll(/[“"]([^”"\n]{20,})[”"]/g)].map((m) => [m.index, m.index + m[0].length]);
  const flags = new Uint8Array(tokens.length);
  for (const [a, b] of spans) { const inside = []; tokens.forEach((t, i) => { if (t.start >= a && t.end <= b) inside.push(i); }); if (inside.length >= k) inside.forEach((i) => { flags[i] = 1; }); }
  return flags;
}

const clip = (s, n = 220) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/**
 * Compare `text` with `sources` ([{ id, type, title, url?, text }]).
 * Returns the share of the text that is matched, the matched passages with the sources they came from, and a summary per source.
 */
export function comparePlagiarism(text, sources, { k = MIN_RUN } = {}) {
  const tokens = tokenize(text), quoted = quotedFlags(text, tokens, k);
  const perSource = sources.map((s) => { const st = tokenize(s.text); return { s, st, flags: matchFlags(tokens, st, k) }; });
  const union = new Uint8Array(tokens.length), quotedUnion = new Uint8Array(tokens.length);
  for (const { flags } of perSource) flags.forEach((f, i) => { if (f) { if (quoted[i]) quotedUnion[i] = 1; else union[i] = 1; } });
  const matchedWords = union.reduce((n, f) => n + f, 0), quotedWords = quotedUnion.reduce((n, f) => n + f, 0);

  // Passages: runs of consecutive matched words in the union, each with the sources that match inside it.
  const passages = [];
  for (let i = 0; i < tokens.length;) {
    if (!union[i]) { i++; continue; }
    let j = i; while (j < tokens.length && union[j]) j++;
    const from = tokens[i].start, to = tokens[j - 1].end;
    const ids = perSource.filter(({ flags }) => { for (let t = i; t < j; t++) if (flags[t]) return true; return false; }).map(({ s }) => s.id);
    passages.push({ start: from, end: to, words: j - i, sources: ids });
    i = j;
  }
  // The source's own wording for a matched run: find where the run's first words occur in the source and follow it while the words agree.
  const counterpart = (st, t) => {
    for (let a = 0; a + k <= st.length; a++) {
      let n = 0; while (n < k && st[a + n].w === tokens[t + n]?.w) n++;
      if (n < k) continue;
      let e = k; while (a + e < st.length && t + e < tokens.length && st[a + e].w === tokens[t + e].w) e++;
      return { from: st[a].start, to: st[a + e - 1].end };
    }
    return null;
  };
  const out = perSource.map(({ s, st, flags }) => {
    const mine = flags.reduce((n, f, i) => n + (f && !quoted[i] ? 1 : 0), 0);
    const runs = passages.filter((p) => p.sources.includes(s.id)).sort((a, b) => b.words - a.words);
    return { id: s.id, type: s.type, title: s.title, url: s.url || '', matchedWords: mine, percent: tokens.length ? Math.round((mine / tokens.length) * 1000) / 10 : 0, excerpts: runs.slice(0, 2).map((p) => clip(text.slice(p.start, p.end))),
      pairs: runs.slice(0, 3).map((p) => { const t = tokens.findIndex((x, i) => x.start >= p.start && flags[i]); const c = t < 0 ? null : counterpart(st, t); return c ? { start: p.start, end: p.end, yours: clip(text.slice(p.start, p.end), 400), theirs: clip(s.text.slice(c.from, c.to), 400) } : null; }).filter(Boolean) };
  }).filter((s) => s.matchedWords > 0).sort((a, b) => b.matchedWords - a.matchedWords);

  const percent = tokens.length ? Math.round((matchedWords / tokens.length) * 1000) / 10 : 0;
  const verdict = percent < 5 ? 'No significant matches' : percent < 15 ? 'Low overlap' : percent < 40 ? 'Moderate overlap' : 'High overlap';
  return { percent, verdict, words: tokens.length, matchedWords, quotedWords, passages, sources: out };
}

/** How many sentences to search for: 5 for a short text, one more per 150 words, at most 10 (each is one search, so this also bounds the quota used). */
export const probeCount = (text) => Math.min(10, Math.max(5, Math.ceil(tokenize(text).length / 150)));

/**
 * Up to `n` distinctive sentences, spread through the text. Each gives `norm` (its first words, lowercased without punctuation: for Wikipedia and
 * Europe PMC), `orig` (the same words exactly as written, hyphens and all: what a web search should be given, since an exact-phrase search
 * for "trick or treaters" does not find "trick-or-treaters") and `tail` (the last words, a second place to look; empty for a short sentence).
 */
function probeList(text, n, take) {
  const sentences = [...String(text).matchAll(/[^.!?\n]+[.!?]?/g)].map((m) => ({ pos: m.index, s: m[0].trim() })).filter((x) => tokenize(x.s).length >= 10);
  const scored = sentences.map((x) => { const t = tokenize(x.s); return { ...x, score: t.filter((w) => w.w.length >= 7).length + 2 * t.filter((w) => /\d/.test(w.w)).length + new Set(t.map((w) => w.w)).size / t.length * 4 }; });
  scored.sort((a, b) => b.score - a.score);
  const picked = [], gap = Math.max(1, text.length / (n * 2));
  for (const x of scored) { if (picked.length >= n) break; if (picked.every((p) => Math.abs(p.pos - x.pos) >= gap)) picked.push(x); }
  return picked.sort((a, b) => a.pos - b.pos).map((x) => {
    const t = tokenize(x.s), cut = (a, b) => x.s.slice(t[a].start, t[b - 1].end).replace(/["\u201c\u201d]/g, '').replace(/\s+/g, ' ').trim();
    return { norm: t.slice(0, take).map((w) => w.w).join(' '), orig: cut(0, Math.min(take, t.length)), tail: t.length > take + 3 ? cut(t.length - take, t.length) : '' };
  });
}

/** The phrases searched for: each distinctive sentence cut to its first words (lowercased, no punctuation). */
export const pickProbes = (text, n = probeCount(text), take = 14) => probeList(text, n, take).map((p) => p.norm);

/** The most recently changed pages listed in a site's sitemap (up to 6), or []. Follows a sitemap index into its post/blog/news sitemaps. */
export async function newestPosts(origin, readXml, n = 6) {
  const locs = (xml) => [...String(xml).matchAll(/<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/g)].map((m) => ({ loc: (/<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1]) || [])[1], mod: (/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1]) || [])[1] || '' })).filter((x) => x.loc);
  const same = (u) => { try { return new URL(u).origin === origin; } catch { return false; } };
  let root = null;
  for (const path of ['/sitemap_index.xml', '/sitemap.xml', '/wp-sitemap.xml']) { try { root = await readXml(origin + path); if (/<(urlset|sitemapindex)/.test(root)) break; root = null; } catch { root = null; } }
  if (!root) return [];
  let pages = [];
  if (/<sitemapindex/.test(root)) {
    const kids = locs(root).filter((k) => same(k.loc)), posts = kids.filter((k) => /post|blog|news|article/i.test(k.loc));
    for (const k of (posts.length ? posts : kids).slice(0, 2)) { try { pages.push(...locs(await readXml(k.loc))); } catch { /* skip an unreadable sitemap */ } }
  } else pages = locs(root);
  return pages.filter((p) => same(p.loc) && !/\.(xml|jpe?g|png|gif|pdf)$/i.test(p.loc)).sort((a, b) => b.mod.localeCompare(a.mod)).slice(0, n).map((p) => p.loc);
}

const limited = async (items, limit, fn) => { const out = []; let next = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } })); return out; };

/**
 * Collect the sources to compare with. `deps` supplies the network and database access (so this is testable):
 *   fetchPage(url) -> { title, text, url }       wikiSearch(phrase) -> [title]      wikiPage(title) -> { title, url, text }
 *   scholarSearch(phrase) -> [{ id, title }]    scholarPage(id) -> { title, url, text }     (Europe PMC: free full text of open-access papers)
 *   sitemap(url) -> xml text (a site's sitemap, to find posts a search index has not picked up yet)
 *   webSearch(phrase) -> [{ url, title }] | undefined     library() -> [{ id, type, title, text }]
 */
export async function gatherSources(text, options = {}, deps = {}, { budgetMs = 90000 } = {}) {
  const deadline = Date.now() + budgetMs, warnings = [], sources = [], seen = new Set();
  const searched = { urls: 0, wikipedia: 0, scholar: 0, web: 0, library: 0, failed: { wikipedia: 0, scholar: 0, web: 0 } };
  const add = (s) => { const key = s.url || s.id; if (seen.has(key) || !s.text || s.text.length < 100) return; seen.add(key); sources.push(s); };
  const timeLeft = () => deadline - Date.now() > 0;

  for (const url of (options.urls || []).slice(0, 5)) {
    if (!timeLeft()) break;
    try { const p = await deps.fetchPage(url); add({ id: 'url:' + url, type: 'Page you listed', title: p.title || url, url: p.url || url, text: p.text }); searched.urls++; }
    catch (e) { warnings.push(`Could not read ${url}: ${e.message}`); }
  }
  const plist = probeList(text, probeCount(text), 14), probes = plist.map((p) => p.norm);
  searched.trace = []; // what was searched for and how many results came back, so a 0% can be explained
  searched.wikipediaPhrases = options.wikipedia !== false && deps.wikiSearch ? probes.length : 0;
  if (options.wikipedia !== false && deps.wikiSearch && probes.length) {
    const titles = new Set();
    await limited(probes, 1, async (p) => { if (!timeLeft()) return; try { const found = (await deps.wikiSearch(p)).slice(0, 2); searched.trace.push({ where: 'Wikipedia', phrase: p, found: found.length }); for (const t of found) titles.add(t); } catch (e) { searched.failed.wikipedia++; if (!warnings.some((w) => /^Wikipedia search failed/.test(w))) warnings.push(`Wikipedia search failed: ${e.message}`); } });
    await limited([...titles].slice(0, 6), 3, async (t) => { if (!timeLeft()) return; try { const p = await deps.wikiPage(t); add({ id: 'wiki:' + p.title, type: 'Wikipedia', title: p.title, url: p.url, text: p.text }); searched.wikipedia++; } catch (e) { warnings.push(`Could not read Wikipedia page "${t}": ${e.message}`); } });
  }
  // Scientific papers: Europe PMC searches the full text of open-access papers, free and with no key.
  searched.scholarPhrases = options.scholar !== false && deps.scholarSearch ? probes.length : 0;
  if (options.scholar !== false && deps.scholarSearch && probes.length) {
    const ids = new Map();
    await limited(probes, 2, async (p) => { if (!timeLeft()) return; try { const found = (await deps.scholarSearch(p)).slice(0, 2); searched.trace.push({ where: 'Europe PMC', phrase: p, found: found.length }); for (const r of found) if (!ids.has(r.id)) ids.set(r.id, r); } catch (e) { searched.failed.scholar++; if (!warnings.some((w) => /^Europe PMC/.test(w))) warnings.push(`Europe PMC search failed: ${e.message}`); } });
    await limited([...ids.values()].slice(0, 6), 3, async (r) => { if (!timeLeft()) return; try { const p = await deps.scholarPage(r.id); add({ id: 'epmc:' + r.id, type: 'Scientific paper', title: p.title || r.title, url: p.url, text: p.text }); searched.scholar++; } catch { /* a paper whose full text is not available is skipped quietly */ } });
  }
  // The web: search for the same distinctive sentences, then read the top pages. Searches go one at a time (free plans allow about one a
  // second) and stop at the first failure (a wrong key would fail every time). Results from the user's own site(s) are skipped, since a
  // published copy of the text would otherwise match itself.
  const ignored = (options.ignore || []).map((h) => String(h).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '')).filter(Boolean);
  const isIgnored = (url) => { try { const h = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); return ignored.some((i) => h === i || h.endsWith('.' + i)); } catch { return false; } };
  searched.webPhrases = options.web !== false && deps.webSearch ? probes.length : 0; searched.webIgnored = 0;
  if (options.web !== false && deps.webSearch && probes.length) {
    const found = new Map();
    // Each sentence is searched as an exact phrase as written; if that finds nothing, again with the last words of the sentence.
    let failed = false;
    for (const p of plist) {
      if (!timeLeft() || failed) break;
      const tries = [{ q: p.orig }, ...(p.tail ? [{ q: p.tail }] : [])];
      let kept = 0, used = 0;
      for (const t of tries) {
        used++;
        try {
          const list = ((await deps.webSearch(t.q)) || []).slice(0, 5); let n = 0;
          for (const r of list) { if (isIgnored(r.url)) { searched.webIgnored++; continue; } n++; if (!found.has(r.url)) found.set(r.url, r); }
          kept = n;
        } catch (e) { searched.failed.web++; warnings.push(`Web search failed: ${e.message}`); failed = true; break; }
        if (kept) break;
      }
      searched.trace.push({ where: 'Web', phrase: p.orig, found: kept, tries: used });
    }
    // Search indexes lag days behind new posts, and a text is often copied from a site's newest post. So when the results keep pointing
    // at the same site (two or more pages), also read that site's most recently changed posts, found through its sitemap.
    searched.webSitemap = 0;
    if (deps.sitemap) {
      const byOrigin = new Map();
      for (const r of found.values()) { try { const o = new URL(r.url).origin; byOrigin.set(o, (byOrigin.get(o) || 0) + 1); } catch { /* not a URL */ } }
      for (const [origin] of [...byOrigin].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2)) {
        if (!timeLeft()) break;
        for (const u of await newestPosts(origin, deps.sitemap)) if (!found.has(u) && !isIgnored(u)) { found.set(u, { url: u, title: u }); searched.webSitemap++; }
      }
    }
    await limited([...found.values()].slice(0, 20), 4, async (r) => { if (!timeLeft()) return; try { const p = await deps.fetchPage(r.url); add({ id: 'web:' + r.url, type: 'Web page', title: p.title || r.title || r.url, url: p.url || r.url, text: p.text }); searched.web++; } catch { /* a page that cannot be read is skipped quietly */ } });
  }
  if (options.library && deps.library) { for (const l of deps.library()) { add({ ...l, url: '' }); searched.library++; } }
  if (!timeLeft()) warnings.push('The check stopped after the time limit, so some sources were not read.');
  return { sources, searched, warnings, probes };
}

// ---- Similar wording / similar meaning (paraphrase) ---------------------------------------------------------------------------
// Exact matching cannot see a sentence that was reworded. Two steps find those, only in sentences the exact step did not already flag:
//  1. TF-IDF + cosine (word overlap, weighted so rare words count more) shortlists the few source sentences closest to each sentence.
//  2. A sentence-embedding model (embed.mjs) checks whether the shortlisted sentence MEANS the same. Without that model, only a much
//     higher word overlap is accepted, and the match is labelled "similar wording" instead of "similar meaning".
// Paraphrase detection is a judgement call: facts that are simply true will match, so these are possible matches to read, not proof.
// MEANING_THRESHOLD was measured, not guessed: against a real 7,000-word Wikipedia article, hand-written rewordings of its sentences scored
// 0.60 to 0.88 (median 0.79), same-topic sentences that say something different scored at most 0.50, and 60 unrelated sentences at most 0.58.
// 0.65 catches most rewordings with margin above the highest false score seen. It is still a rough setting, from a small sample.
export const MEANING_THRESHOLD = 0.65, WORDING_THRESHOLD = 0.6, MIN_SENTENCE_WORDS = 8;

const stem = (w) => (w.length > 5 ? w.replace(/(?:ing|ed|es|s|ly)$/, '') : w);
const termsOf = (tokens) => tokens.map((t) => t.w).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);

export function splitSentences(text) {
  const out = [];
  for (const m of String(text).matchAll(/[^.!?\n]+[.!?]?/g)) {
    const raw = m[0], lead = raw.length - raw.trimStart().length, s = raw.trim(), tokens = tokenize(s);
    if (tokens.length >= MIN_SENTENCE_WORDS && tokens.length <= 80) out.push({ text: s, start: m.index + lead, end: m.index + lead + s.length, tokens });
  }
  return out;
}

/** For each of `queries` (arrays of terms), the `topK` `docs` (arrays of terms) with the highest TF-IDF cosine: [[{ doc, cos }]]. */
export function tfidfNearest(queries, docs, { topK = 3, minCos = 0.2 } = {}) {
  const N = queries.length + docs.length, df = new Map();
  for (const list of [queries, docs]) for (const terms of list) for (const t of new Set(terms)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
  const vec = (terms) => { const tf = new Map(); for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1); let norm = 0; const v = new Map(); for (const [t, c] of tf) { const w = (1 + Math.log(c)) * idf(t); v.set(t, w); norm += w * w; } norm = Math.sqrt(norm) || 1; for (const [t, w] of v) v.set(t, w / norm); return v; };
  const docVecs = docs.map(vec), index = new Map();
  docVecs.forEach((v, i) => { for (const t of v.keys()) { if (!index.has(t)) index.set(t, []); index.get(t).push(i); } });
  return queries.map((terms) => {
    const q = vec(terms), score = new Map();
    for (const [t, w] of q) for (const i of index.get(t) || []) score.set(i, (score.get(i) || 0) + w * docVecs[i].get(t));
    return [...score].map(([doc, cos]) => ({ doc, cos })).filter((x) => x.cos >= minCos).sort((a, b) => b.cos - a.cos).slice(0, topK);
  });
}

const overlapShare = (a, b, ranges) => { let covered = 0; for (const r of ranges) covered += Math.max(0, Math.min(b, r.end) - Math.max(a, r.start)); return covered / Math.max(1, b - a); };

export async function findSimilar(text, sources, passages, { embed, maxSentences = 150, maxSourceSentences = 8000, maxEmbed = 500, signal } = {}) {
  const quotes = [...String(text).matchAll(/[“"]([^”"\n]{20,})[”"]/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const mine = splitSentences(text).filter((s) => overlapShare(s.start, s.end, passages) < 0.6 && overlapShare(s.start, s.end, quotes) < 0.5).slice(0, maxSentences);
  const theirs = [];
  for (const src of sources) for (const s of splitSentences(src.text)) { if (theirs.length < maxSourceSentences) theirs.push({ ...s, src }); }
  const none = { similar: [], similarWords: 0, similarPercent: 0, similarMethod: null };
  if (!mine.length || !theirs.length) return none;
  // A wide shortlist (5 candidates, low cut-off): a reworded sentence shares few exact words with its source, so word overlap alone ranks it low.
  const near = tfidfNearest(mine.map((s) => termsOf(s.tokens)), theirs.map((s) => termsOf(s.tokens)), { topK: 5, minCos: 0.1 });
  const total = tokenize(text).length;
  const pick = [];
  let method = 'wording', vectors = null;
  const shortlisted = near.map((c, i) => ({ i, c })).filter((x) => x.c.length).sort((a, b) => b.c[0].cos - a.c[0].cos);
  if (embed && shortlisted.length) {
    const ask = [], ids = new Map(), want = (t) => { if (!ids.has(t)) { ids.set(t, ask.length); ask.push(t); } return ids.get(t); };
    for (const x of shortlisted) { if (ask.length + 1 + x.c.length > maxEmbed) break; want(mine[x.i].text); x.c.forEach((c) => want(theirs[c.doc].text)); }
    vectors = ask.length ? await embed(ask) : null;
    if (vectors) {
      method = 'meaning';
      for (const x of shortlisted) {
        const qi = ids.get(mine[x.i].text); if (qi === undefined) continue;
        let best = null;
        for (const c of x.c) { const di = ids.get(theirs[c.doc].text); if (di === undefined) continue; let s = 0; const a = vectors[qi], b = vectors[di]; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; if (!best || s > best.score) best = { doc: c.doc, score: s, cos: c.cos }; }
        if (best && best.score >= MEANING_THRESHOLD) pick.push({ i: x.i, ...best });
      }
    }
  }
  if (!vectors) for (const x of shortlisted) if (x.c[0].cos >= WORDING_THRESHOLD) pick.push({ i: x.i, doc: x.c[0].doc, score: x.c[0].cos, cos: x.c[0].cos });
  const similar = pick.sort((a, b) => mine[a.i].start - mine[b.i].start).map((p) => {
    const s = mine[p.i], t = theirs[p.doc];
    return { start: s.start, end: s.end, words: s.tokens.length, score: Math.round(p.score * 100) / 100, method, matches: clip(t.text, 200), source: { id: t.src.id, type: t.src.type, title: t.src.title, url: t.src.url || '' } };
  });
  const similarWords = similar.reduce((n, s) => n + s.words, 0);
  return { similar, similarWords, similarPercent: total ? Math.round((similarWords / total) * 1000) / 10 : 0, similarMethod: similar.length ? method : (vectors ? 'meaning' : 'wording') };
}

export async function checkPlagiarism(text, options, deps, config) {
  const { sources, searched, warnings, probes } = await gatherSources(text, options, deps, config);
  const result = comparePlagiarism(text, sources, config);
  let similar = { similar: [], similarWords: 0, similarPercent: 0, similarMethod: null };
  if (options.paraphrase !== false && sources.length) {
    try { similar = await findSimilar(text, sources, result.passages, { embed: deps.embed }); }
    catch (e) { warnings.push(`The similar-wording step was skipped (${String(e.message).slice(0, 80)}).`); }
    if (similar.similarMethod === 'wording' && deps.embed) warnings.push('The sentence model is not available, so similar wording was judged by word overlap only. That finds close rewordings but not rewrites that change most of the words.');
  }
  if (!sources.length) {
    // A 0% here means "nothing was compared", not "this text is original", so say exactly what was and was not searched.
    const parts = [];
    const sentences = (n) => `${n} sentence${n === 1 ? '' : 's'}`, unreachable = (name, n, total) => n >= total && total > 0 ? `${name} could not be searched (see the notice above)` : null;
    if (searched.wikipediaPhrases) parts.push(unreachable('Wikipedia', searched.failed.wikipedia, searched.wikipediaPhrases) || `Wikipedia was searched with ${sentences(searched.wikipediaPhrases)} from your text and has no page that contains them${searched.failed.wikipedia ? ` (${searched.failed.wikipedia} of the searches failed)` : ''}`);
    else if (options.wikipedia === false) parts.push('Wikipedia was switched off');
    else parts.push('There were not enough long, distinctive sentences to search Wikipedia with');
    if (searched.scholarPhrases) parts.push(unreachable('Europe PMC (scientific papers)', searched.failed.scholar, searched.scholarPhrases) || `Europe PMC (scientific papers) was searched with ${sentences(searched.scholarPhrases)} and has no paper that contains them`);
    if (searched.webPhrases) parts.push(searched.failed.web ? 'the web could not be searched (see the notice above)' : `the web was searched with ${sentences(searched.webPhrases)} and no readable page contained them${searched.webIgnored ? ` (${searched.webIgnored} result${searched.webIgnored === 1 ? '' : 's'} from your own site ${searched.webIgnored === 1 ? 'was' : 'were'} skipped)` : ''}`);
    if (!(options.urls || []).length) parts.push('no page addresses were listed');
    if (!options.library) parts.push('your saved texts were not included');
    warnings.push(`Nothing was compared: ${parts.join('; ')}. ${deps.webSearch ? 'To check against a particular page, paste its address under "Pages to compare with".' : 'Web search is not set up (it needs a free key, see the README), so to check against a particular page (for example an article you suspect was copied), paste its address under "Pages to compare with".'}`);
  }
  return { ...result, ...similar, verdict: sources.length ? result.verdict : 'Nothing was compared', searched, warnings, probes: probes.length, checkedSources: sources.length };
}

// ---- network helpers for the real server --------------------------------------------------------------------------------------
const UA = { 'User-Agent': 'KlezaPlagiarismCheck/1.0 (self-hosted plagiarism checker; short exact-phrase queries only)', 'Api-User-Agent': 'KlezaPlagiarismCheck/1.0 (self-hosted plagiarism checker)' };
const getJson = async (url, headers = {}) => {
  const go = () => fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(15000) });
  let r;
  try {
    r = await go();
    if (r.status === 429) { const wait = Number(r.headers.get('retry-after')); await new Promise((ok) => setTimeout(ok, Math.min(5, Number.isFinite(wait) ? wait : 2) * 1000)); r = await go(); } // rate-limited: wait once, then try again
  } catch { const u = new URL(url); throw new Error(`could not connect to ${u.host}${/^(localhost|127\.)/.test(u.hostname) ? ' (is the search engine running? Start Docker Desktop and the searxng container)' : ''}`); }
  if (!r.ok) throw new Error(`${new URL(url).hostname} returned ${r.status}`);
  return r.json();
};

/** Wikipedia's own search and page text (free, no key). `base` can be changed for tests. */
export function wikipedia(base = 'https://en.wikipedia.org/w/api.php') {
  return {
    wikiSearch: async (phrase) => ((await getJson(`${base}?action=query&list=search&srsearch=${encodeURIComponent('"' + phrase + '"')}&srlimit=3&format=json&origin=*`)).query?.search || []).map((x) => x.title),
    wikiPage: async (title) => {
      const d = await getJson(`${base}?action=query&prop=extracts&explaintext=1&exlimit=1&titles=${encodeURIComponent(title)}&format=json&origin=*&redirects=1`);
      const page = Object.values(d.query?.pages || {})[0];
      if (!page?.extract) throw new Error('no text');
      return { title: page.title, url: `${new URL(base).origin}/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`, text: page.extract };
    },
  };
}

/**
 * A web search provider from the environment, or null. SEARCH_PROVIDER = searxng | brave | google.
 * Free plans limit how fast you may search (Brave: about one a second), so calls are spaced out and a "429 too many requests" is retried once.
 * SEARCH_MIN_INTERVAL_MS overrides the spacing (the tests set it to 0).
 */
let lastSearchAt = 0;
const quoted = (phrase, { loose } = {}) => { const p = String(phrase).replace(/["\u201c\u201d]/g, ''); return loose ? p : '"' + p + '"'; };
export function searchProvider(env = process.env) {
  const kind = String(env.SEARCH_PROVIDER || '').toLowerCase(), key = env.SEARCH_API_KEY || '';
  const gap = Number.isFinite(Number(env.SEARCH_MIN_INTERVAL_MS)) && env.SEARCH_MIN_INTERVAL_MS !== undefined && env.SEARCH_MIN_INTERVAL_MS !== '' ? Number(env.SEARCH_MIN_INTERVAL_MS) : (kind === 'brave' ? 1100 : kind === 'searxng' ? 1500 : 0);
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const paced = async (call) => {
    const wait = Math.max(0, lastSearchAt + gap - Date.now()); lastSearchAt = Date.now() + wait; if (wait) await nap(wait);
    try { return await call(); } catch (e) { if (!/ 429\b/.test(e.message)) throw e; await nap(Math.max(gap, 2000)); lastSearchAt = Date.now(); return call(); }
  };
  if (kind === 'brave' && key) {
    const base = env.SEARCH_BASE_URL || 'https://api.search.brave.com/res/v1/web/search';
    return { name: 'brave', search: (phrase, o = {}) => paced(async () => ((await getJson(`${base}?q=${encodeURIComponent(quoted(phrase, o))}&count=5`, { 'X-Subscription-Token': key, Accept: 'application/json' })).web?.results || []).map((r) => ({ url: r.url, title: r.title }))) };
  }
  // SearXNG: a search engine you run yourself (no key). SEARCH_BASE_URL is your instance, for example http://localhost:8080; its settings must allow format=json.
  if (kind === 'searxng' && env.SEARCH_BASE_URL) {
    const base = env.SEARCH_BASE_URL.replace(/\/+$/, '');
    // An empty answer is only "no match" if the engines behind SearXNG actually answered. When two or more of them are suspended or timing out
    // (they rate-limit a busy client) and nothing came back, say that instead, so it is not mistaken for a clean result.
    return { name: 'searxng', search: (phrase, o = {}) => paced(async () => {
      const d = await getJson(`${base}/search?q=${encodeURIComponent(quoted(phrase, o))}&format=json&safesearch=0`);
      const down = (d.unresponsive_engines || []).map((e) => [].concat(e)[0]);
      if (!(d.results || []).length && down.length >= 2) throw new Error(`the search engines behind SearXNG are rate-limited or not answering (${down.join(', ')}). Wait a while and try again`);
      return (d.results || []).slice(0, 5).map((r) => ({ url: r.url, title: r.title }));
    }) };
  }
  if (kind === 'google' && key && env.SEARCH_CX) {
    const base = env.SEARCH_BASE_URL || 'https://www.googleapis.com/customsearch/v1';
    return { name: 'google', search: (phrase, o = {}) => paced(async () => ((await getJson(`${base}?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(env.SEARCH_CX)}&q=${encodeURIComponent(quoted(phrase, o))}&num=5`)).items || []).map((r) => ({ url: r.link, title: r.title }))) };
  }
  return null;
}

/** Europe PMC (free, no key): phrase search over the full text of open-access papers, and the paper text itself. `base` can be changed for tests. */
export function europePmc(base = 'https://www.ebi.ac.uk/europepmc/webservices/rest') {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return {
    scholarSearch: async (phrase) => ((await getJson(`${base}/search?query=${encodeURIComponent('OPEN_ACCESS:y AND "' + phrase + '"')}&format=json&pageSize=3&resultType=lite`)).resultList?.result || []).filter((r) => r.pmcid).map((r) => ({ id: r.pmcid, title: r.title })),
    scholarPage: async (id) => {
      const res = await fetch(`${base}/${encodeURIComponent(id)}/fullTextXML`, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`full text returned ${res.status}`);
      const xml = (await res.text()).slice(0, 2_000_000);
      const title = (xml.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/) || [])[1] || id;
      const clean = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entities[e] ?? ' ')).replace(/\s+/g, ' ').trim();
      const body = clean(xml.replace(/<ref-list[\s\S]*?<\/ref-list>/g, ' ').replace(/<\/(p|title|sec)>/g, '$&\n'));
      return { title: clean(title), url: `https://europepmc.org/article/PMC/${id.replace(/^PMC/, '')}`, text: body };
    },
  };
}
