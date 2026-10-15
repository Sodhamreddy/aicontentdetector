// Plagiarism check: the matching rules, and the whole feature through the real server with mock Wikipedia and web pages. It must also stay free: no keyed service is ever contacted.
// Run: node tests/plagiarism.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokenize, matchFlags, comparePlagiarism, pickProbes, probeCount, splitSentences, tfidfNearest, findSimilar, MEANING_THRESHOLD, searchProvider, wikipedia } from '../plagiarism.mjs';
import { checkPlagiarism, newestPosts } from '../plagiarism.mjs';
import { initEmbedder, embedTexts, cosine, missingEmbedFiles, EMBED_FOLDER } from '../embed.mjs';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } };

const SOURCE = 'Tomatoes need at least six hours of direct sun each day, so pick the brightest spot on the balcony and turn the pots every few days. ' +
  'Water deeply but rarely, because shallow watering teaches the roots to stay near the surface, where the soil dries out first and the plant suffers in the heat. ' +
  'Feed them every two weeks once the first flowers open, and pinch out the small shoots that grow between the stem and a branch.';
const COPIED = 'Water deeply but rarely, because shallow watering teaches the roots to stay near the surface, where the soil dries out first and the plant suffers in the heat.';
const OWN_A = 'My neighbour asked me last spring how I keep a small garden going through the summer months, so I wrote down what works for me in plain words.';
const OWN_B = 'None of this needs special tools, and most of it comes down to patience and a little attention every morning before work starts.';
const INPUT = `${OWN_A} ${COPIED} ${OWN_B}`;

await test('tokenizer: words with positions, case and punctuation ignored, apostrophes kept', () => {
  const t = tokenize('Hello, World! It’s 2024.');
  assert.deepEqual(t.map((x) => x.w), ['hello', 'world', "it's", '2024']);
  assert.equal('Hello, World! It’s 2024.'.slice(t[1].start, t[1].end), 'World');
});

await test('an exact run of 8+ words is a match; a paraphrase and a short shared phrase are not', () => {
  const src = tokenize(SOURCE);
  assert.ok(matchFlags(tokenize(COPIED), src).every(Boolean), 'the copied sentence is matched word for word');
  assert.ok(matchFlags(tokenize('Give them lots of water, but not too often, since shallow watering keeps the roots near the top of the soil.'), src).every((f) => !f), 'a paraphrase is not found');
  assert.ok(matchFlags(tokenize('Tomatoes need at least six hours of sun, but ours get far less than that on the north side.'), src).every((f) => !f), 'a 7-word overlap is below the 8-word minimum');
  assert.ok(matchFlags(tokenize('WATER DEEPLY, but rarely -- because shallow watering teaches the roots to stay near the surface!'), src).filter(Boolean).length >= 8, 'case, punctuation and spacing are ignored');
});

await test('common filler is not evidence: a run made mostly of stop words is ignored', () => {
  const filler = 'it is in the of the and to be at the that is on the and it is'; // every word is a stop word
  assert.ok(matchFlags(tokenize(filler), tokenize('x ' + filler + ' y')).every((f) => !f), 'only stop words: not evidence');
  assert.ok(matchFlags(tokenize('one of the most important things in the world today'), tokenize('x one of the most important things in the world today y')).every(Boolean), 'the same length with real words is a match');
});

await test('percent, passages and per-source figures come out right', () => {
  const sources = [{ id: 'a', type: 'Web page', title: 'Garden page', url: 'https://a.example/x', text: SOURCE }, { id: 'b', type: 'Wikipedia', title: 'Unrelated', url: 'https://b.example', text: 'Completely different words about a very different subject, with nothing shared at all, and enough length to be a source on its own.' }];
  const r = comparePlagiarism(INPUT, sources);
  const copiedWords = tokenize(COPIED).length, total = tokenize(INPUT).length;
  assert.equal(r.matchedWords, copiedWords); assert.equal(r.words, total);
  assert.equal(r.percent, Math.round((copiedWords / total) * 1000) / 10);
  assert.equal(r.passages.length, 1); assert.equal(INPUT.slice(r.passages[0].start, r.passages[0].end), COPIED.replace(/\.$/, ''));
  assert.deepEqual(r.passages[0].sources, ['a']);
  assert.equal(r.sources.length, 1, 'a source with no match is left out'); assert.equal(r.sources[0].id, 'a'); assert.ok(r.sources[0].excerpts[0].includes('Water deeply but rarely'));
  const pr = r.sources[0].pairs[0]; assert.ok(pr.yours.includes('Water deeply but rarely') && pr.theirs.includes('Water deeply but rarely'), 'the source side of the pair is the source\'s own wording: ' + JSON.stringify(pr)); assert.equal(INPUT.slice(pr.start, pr.end).slice(0, 12), 'Water deeply');
  assert.match(r.verdict, /overlap/);
});

await test('a quotation is cited, so it is reported apart and left out of the percent', () => {
  const quoted = `${OWN_A} "${COPIED}" ${OWN_B}`;
  const r = comparePlagiarism(quoted, [{ id: 'a', type: 'Web page', title: 'Garden page', text: SOURCE }]);
  assert.equal(r.percent, 0); assert.ok(r.quotedWords >= 20, String(r.quotedWords));
  assert.equal(r.verdict, 'No significant matches');
});

await test('text with no matches at all scores 0', () => {
  assert.equal(comparePlagiarism(INPUT, [{ id: 'z', type: 'x', title: 'z', text: 'nothing in common here whatsoever, just a different set of ordinary words that never repeat anything above.' }]).percent, 0);
  assert.equal(comparePlagiarism('', []).percent, 0);
});

await test('search phrases: at most n, from sentences of 10+ words, spread through the text, 14 words long at most', () => {
  const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} talks about ${['gardens', 'engines', 'rivers', 'planets', 'recipes', 'markets'][i % 6]} with distinctive vocabulary like ${['photosynthesis', 'turbocharger', 'meandering', 'constellation', 'caramelised', 'wholesalers'][i % 6]} and more filler words here.`).join(' ');
  const probes = pickProbes(long, 4);
  assert.ok(probes.length > 0 && probes.length <= 4, String(probes.length)); assert.ok(probes.every((p) => p.split(' ').length <= 14 && long.toLowerCase().includes(p.split(' ').slice(0, 5).join(' '))));
  assert.deepEqual(pickProbes('Too short to search for.', 5), []);
  const words = (n) => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');
  assert.equal(probeCount(words(100)), 5); assert.equal(probeCount(words(900)), 6); assert.equal(probeCount(words(5000)), 10, 'capped at 10 searches');
});

// ---- similar wording and meaning (paraphrase) ----
const SRC_SENTENCES = 'Photosynthesis is the process by which green plants turn sunlight into chemical energy that is stored in sugars. The Roman aqueducts carried fresh water into cities over many kilometres using gravity alone. Interest rates set by central banks influence the cost of borrowing for households and for companies.';
const PARAPHRASE = 'Green plants use the light of the sun to build sugars that store chemical energy, and this is called photosynthesis.';
const UNRELATED = 'My neighbour asked me last spring how I keep a small garden going through the summer months, so I wrote it down.';
// A stand-in for the sentence model, to test the logic without the model files: sentences listed in the same group "mean the same"
// (identical vectors, cosine 1); every other sentence gets its own direction (cosine 0 with all the others).
const MEANING_GROUPS = [[PARAPHRASE, SRC_SENTENCES.split('. ')[0] + '.']];
let fakeDirection = 0;
const fakeEmbed = async (texts) => texts.map((t) => { const g = MEANING_GROUPS.findIndex((grp) => grp.includes(t)); const v = new Float32Array(512); v[g >= 0 ? g : 100 + (fakeDirection++ % 400)] = 1; return v; });

await test('sentences: split with positions, short ones dropped', () => {
  const s = splitSentences('Too short. ' + PARAPHRASE + ' ' + UNRELATED);
  assert.equal(s.length, 2); assert.equal(('Too short. ' + PARAPHRASE + ' ' + UNRELATED).slice(s[0].start, s[0].end), PARAPHRASE);
});

await test('TF-IDF + cosine: the reworded sentence ranks its source sentence first, an unrelated one finds nothing close', () => {
  const docs = splitSentences(SRC_SENTENCES), terms = (t) => tokenize(t).map((x) => x.w).filter((w) => w.length > 2);
  const [para, other] = tfidfNearest([terms(PARAPHRASE), terms(UNRELATED)], docs.map((d) => terms(d.text)), { topK: 2, minCos: 0.05 });
  assert.equal(para[0].doc, 0, JSON.stringify(para)); assert.ok(para[0].cos > 0.15 && para[0].cos < 1);
  assert.ok(!other.length || other[0].cos < para[0].cos, 'the unrelated sentence is not closer than the paraphrase');
});

await test('similar meaning: a paraphrase is found, an unrelated sentence is not, and a copied sentence is left to the exact step', async () => {
  const input = `${UNRELATED} ${PARAPHRASE} The Roman aqueducts carried fresh water into cities over many kilometres using gravity alone.`;
  const sources = [{ id: 's', type: 'Wikipedia', title: 'Photosynthesis', url: 'https://x.example', text: SRC_SENTENCES }];
  const exact = comparePlagiarism(input, sources);
  const r = await findSimilar(input, sources, exact.passages, { embed: fakeEmbed });
  assert.equal(r.similarMethod, 'meaning'); assert.equal(r.similar.length, 1, JSON.stringify(r.similar.map((x) => x.matches)));
  assert.equal(input.slice(r.similar[0].start, r.similar[0].end), PARAPHRASE); assert.equal(r.similar[0].source.title, 'Photosynthesis'); assert.ok(r.similar[0].score >= MEANING_THRESHOLD);
  assert.ok(r.similarPercent > 0 && r.similarPercent < 100);
});

await test('without the sentence model, only very close rewording is reported, and it is labelled as wording', async () => {
  const reworded = 'Photosynthesis is the process by which green plants turn the sunlight into chemical energy that is stored in the sugars.';
  const sources = [{ id: 's', type: 'Web page', title: 'p', text: SRC_SENTENCES }];
  const close = await findSimilar(`${UNRELATED} ${reworded}`, sources, [], { embed: null });
  assert.equal(close.similarMethod, 'wording'); assert.equal(close.similar.length, 1);
  const loose = await findSimilar(`${UNRELATED} ${PARAPHRASE}`, sources, [], { embed: null });
  assert.equal(loose.similar.length, 0, 'a loose paraphrase needs the sentence model');
});

await test('quoted sentences and sentences already matched exactly are not reported twice', async () => {
  const sources = [{ id: 's', type: 'Web page', title: 'p', text: SRC_SENTENCES }];
  const quoted = `${UNRELATED} "${PARAPHRASE}" ${UNRELATED}`;
  assert.equal((await findSimilar(quoted, sources, [], { embed: fakeEmbed })).similar.length, 0, 'a quotation is cited');
  const copied = `${UNRELATED} ${SRC_SENTENCES.split('. ')[0]}.`; const exact = comparePlagiarism(copied, sources);
  assert.ok(exact.percent > 0); assert.equal((await findSimilar(copied, sources, exact.passages, { embed: fakeEmbed })).similar.length, 0);
});

const MODELS_HERE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'data', 'models');
const haveModel = missingEmbedFiles(decodeURIComponent(MODELS_HERE)).length === 0;
await test(haveModel ? 'the real sentence model: paraphrases score high, a same-topic different claim and an unrelated sentence score low' : 'SKIPPED (the sentence model is not in data/models)', async () => {
  if (!haveModel) return;
  assert.equal(await initEmbedder(decodeURIComponent(MODELS_HERE)), true);
  const v = await embedTexts([PARAPHRASE, SRC_SENTENCES.split('. ')[0] + '.', 'Plants need water, soil and warmth to grow well in the garden.', UNRELATED, 'Interest rates set by central banks influence the cost of borrowing.']);
  assert.equal(v.length, 5); assert.equal(v[0].length, 384); assert.ok(Math.abs(cosine(v[0], v[0]) - 1) < 1e-4, 'unit length');
  assert.ok(cosine(v[0], v[1]) >= MEANING_THRESHOLD, 'paraphrase ' + cosine(v[0], v[1]));
  assert.ok(cosine(v[0], v[2]) < MEANING_THRESHOLD - 0.05, 'same topic, different claim ' + cosine(v[0], v[2])); assert.ok(cosine(v[0], v[3]) < 0.4 && cosine(v[0], v[4]) < 0.4, 'unrelated');
});

// ---- the whole feature, through the real server ----
let epmcOn = false;
const pages = {
  '/photo': `<html><head><title>Plants and light</title></head><body><article><h1>Plants and light</h1><p>${SRC_SENTENCES.split('. ')[0]}.</p><p>The Roman aqueducts carried fresh water into cities over many kilometres using gravity alone, and some of them are still standing today.</p></article></body></html>`,
  '/garden': `<html><head><title>Balcony Tomatoes</title></head><body><article><h1>Balcony Tomatoes</h1><p>${SOURCE.split('. ')[0]}.</p><p>${COPIED}</p><p>Feed them every two weeks once the first flowers open, and pinch out the small shoots that grow between the stem and a branch.</p></article></body></html>`,
  '/other': '<html><head><title>Other</title></head><body><article><p>An entirely different article about harbours and ships and the long history of trade across the northern seas, written for a different purpose altogether.</p><p>It goes on for a while about timber, rope and the work of the people who built the quays in the nineteenth century.</p></article></body></html>',
};
const fixture = createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), send = (s, type, body) => { res.writeHead(s, { 'Content-Type': type }); res.end(body); };
  if (pages[u.pathname]) return send(200, 'text/html', pages[u.pathname]);
  if (u.pathname === '/w/api.php') { // mock Wikipedia
    if (u.searchParams.get('list') === 'search') return send(200, 'application/json', JSON.stringify({ query: { search: /water deeply/i.test(u.searchParams.get('srsearch')) ? [{ title: 'Container gardening' }] : [] } }));
    if (u.searchParams.get('prop') === 'extracts') return send(200, 'application/json', JSON.stringify({ query: { pages: { 1: { title: 'Container gardening', extract: `Container gardening is the growing of plants in pots. ${COPIED} Many vegetables do well in containers when they get enough light and a regular feed.` } } } }));
  }
  if (u.pathname === '/epmc/search') { // mock Europe PMC: it only knows the paper while epmcOn is set, so other tests are unaffected
    return send(200, 'application/json', JSON.stringify({ resultList: { result: epmcOn && /water deeply/i.test(u.searchParams.get('query')) ? [{ pmcid: 'PMC1', title: 'Container crops' }, { title: 'no full text id' }] : [] } }));
  }
  if (u.pathname === '/epmc/PMC1/fullTextXML') return send(200, 'application/xml', `<article><front><article-meta><title-group><article-title>Container &amp; balcony crops</article-title></title-group></article-meta></front><body><sec><title>Methods</title><p>Pots were set out in June. ${COPIED}</p><p>Yields were recorded weekly over the whole season by two people.</p></sec></body><back><ref-list><ref>Water deeply but rarely so the roots grow down toward moisture</ref></ref-list></back></article>`);
  if (u.pathname === '/searx/search' && /^"blocked/.test(u.searchParams.get('q'))) return send(200, 'application/json', JSON.stringify({ results: [], unresponsive_engines: [['brave', 'too many requests'], ['google cse', 'Suspended: too many requests'], ['duckduckgo', 'timeout']] }));
  if (u.pathname === '/searx/search') { // mock SearXNG: JSON only when asked for, and the phrase arrives in quotes
    if (u.searchParams.get('format') !== 'json' || !/^"water deeply/.test(u.searchParams.get('q'))) return send(400, 'text/plain', 'bad');
    return send(200, 'application/json', JSON.stringify({ results: [{ url: `http://127.0.0.1:${fixture.address().port}/garden`, title: 'Balcony Tomatoes' }] }));
  }
  if (u.pathname === '/brave') { // mock Brave Search: answers only when the key is sent in the right header
    if (req.headers['x-subscription-token'] !== 'test-key') return send(401, 'application/json', '{}');
    const base = `http://127.0.0.1:${fixture.address().port}`;
    return send(200, 'application/json', JSON.stringify({ web: { results: [{ url: `${base}/garden`, title: 'Balcony Tomatoes' }, { url: 'http://mysite.test/mine', title: 'My own copy' }] } }));
  }
  send(404, 'text/plain', 'x');
});
await new Promise((r) => fixture.listen(0, r));
const fx = `http://127.0.0.1:${fixture.address().port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kleza-plag-'));
if (haveModel) fs.cpSync(path.join(decodeURIComponent(MODELS_HERE), EMBED_FOLDER), path.join(dir, 'models', EMBED_FOLDER), { recursive: true }); // the server looks for models next to its database
Object.assign(process.env, { KLEZA_DB_PATH: path.join(dir, 'k.db'), PORT: '0', RATE_LIMIT_PER_MIN: '0', KLEZA_NEURAL: 'off', KLEZA_ALLOW_PRIVATE_URLS: 'true', LLM_PROVIDER: '', LLM_API_KEY: '', WIKI_API: `${fx}/w/api.php`, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: 'test-key', SEARCH_BASE_URL: `${fx}/brave`, SEARCH_MIN_INTERVAL_MS: '0', EUROPEPMC_API: `${fx}/epmc` });
const { server, db } = await import('../server.mjs');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const api = `http://127.0.0.1:${server.address().port}/api`;
const post = async (p, b) => { const r = await fetch(api + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, d: await r.json() }; };
const get = async (p) => (await fetch(api + p)).json();

await test('route: a page you list is read and compared; the copied passage is found, an unrelated page is not', async () => {
  const { status, d } = await post('/plagiarism', { text: INPUT, title: 'My notes', options: { wikipedia: false, urls: [`${fx}/garden`, `${fx}/other`] } });
  assert.equal(status, 200, JSON.stringify(d));
  assert.ok(d.percent > 30 && d.percent < 80, String(d.percent)); assert.equal(d.sources.length, 1); assert.equal(d.sources[0].title, 'Balcony Tomatoes'); assert.equal(d.sources[0].type, 'Page you listed');
  assert.equal(d.checkedSources, 2); assert.equal(d.searched.urls, 2); assert.ok(INPUT.slice(d.passages[0].start, d.passages[0].end).startsWith('Water deeply but rarely'));
});

await test('route: Wikipedia is searched with no key and its page is compared', async () => {
  const { status, d } = await post('/plagiarism', { text: INPUT, options: { wikipedia: true } });
  assert.equal(status, 200, JSON.stringify(d)); assert.equal(d.searched.wikipedia, 1); assert.equal(d.sources[0].type, 'Wikipedia'); assert.equal(d.sources[0].title, 'Container gardening'); assert.ok(d.percent > 30);
});

await test('route: Europe PMC full text is searched with no key, its article text (not the reference list) is compared', async () => {
  epmcOn = true;
  const { status, d } = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, web: false, scholar: true } }); epmcOn = false;
  assert.equal(status, 200, JSON.stringify(d)); assert.equal(d.searched.scholar, 1, JSON.stringify(d.searched)); assert.equal(d.sources[0].type, 'Scientific paper'); assert.equal(d.sources[0].title, 'Container & balcony crops'); assert.equal(d.sources[0].url, 'https://europepmc.org/article/PMC/1'); assert.ok(d.percent > 30);
  const off = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, web: false, scholar: false } });
  assert.equal(off.d.searched.scholar, 0); assert.equal(off.d.checkedSources, 0);
});

await test('search providers are built from the environment, and off without a key', () => {
  assert.equal(searchProvider({}), null); assert.equal(searchProvider({ SEARCH_PROVIDER: 'brave' }), null, 'brave needs a key');
  assert.equal(searchProvider({ SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: 'k' }).name, 'brave');
  assert.equal(searchProvider({ SEARCH_PROVIDER: 'google', SEARCH_API_KEY: 'k' }), null, 'google also needs SEARCH_CX');
  assert.equal(searchProvider({ SEARCH_PROVIDER: 'google', SEARCH_API_KEY: 'k', SEARCH_CX: 'c' }).name, 'google'); assert.equal(searchProvider({ SEARCH_PROVIDER: 'bing', SEARCH_API_KEY: 'k' }), null);
  assert.equal(searchProvider({ SEARCH_PROVIDER: 'searxng' }), null, 'searxng needs its address'); assert.equal(searchProvider({ SEARCH_PROVIDER: 'searxng', SEARCH_BASE_URL: 'http://localhost:8080/' }).name, 'searxng');
});

await test('route: web search finds a page the user did not list; the Brave key goes in the header; pages from the ignored site are skipped', async () => {
  assert.equal((await get('/health')).search, 'brave');
  const { status, d } = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, web: true } });
  assert.equal(status, 200, JSON.stringify(d)); assert.equal(d.searched.web, 1, JSON.stringify(d.searched)); assert.equal(d.sources[0].type, 'Web page'); assert.equal(d.sources[0].title, 'Balcony Tomatoes'); assert.ok(d.percent > 30); assert.equal(d.search, 'brave');
  const ign = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, web: true, ignore: 'nothing.example' } });
  assert.equal(ign.d.searched.web, 1, 'a host that is not listed is still read');
  const own = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, web: true, ignore: ['127.0.0.1'] } });
  assert.equal(own.d.searched.web, 0, 'every result came from the ignored host'); assert.equal(own.d.verdict, 'Nothing was compared'); assert.match(own.d.warnings.find((w) => /Nothing was compared/.test(w)), /the web was searched with \d+ sentences? and no readable page contained them \(\d+ results? from your own site/);
  const off = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, web: false } });
  assert.equal(off.d.searched.web, 0); assert.equal(off.d.checkedSources, 0);
});

await test('searxng: needs no key, is asked for json, and its results are read', async () => {
  const sx = searchProvider({ SEARCH_PROVIDER: 'searxng', SEARCH_BASE_URL: `${fx}/searx/`, SEARCH_MIN_INTERVAL_MS: '0' });
  const r = await sx.search('water deeply but rarely so the roots grow');
  assert.deepEqual(r, [{ url: `${fx}/garden`, title: 'Balcony Tomatoes' }]);
  await assert.rejects(() => sx.search('blocked phrase about nothing in particular'), /rate-limited or not answering \(brave, google cse, duckduckgo\)/, 'an empty answer from suspended engines is reported, not taken as "no match"');
});

await test('a site that keeps appearing in the results has its newest posts read, even when the search index has not found them yet', async () => {
  const site = 'https://blog.test', asked = [];
  const page = (t) => ({ title: t, text: `An article called ${t}. ` + (t === 'fresh' ? COPIED : 'Nothing at all in common with the text being checked, just words about something else entirely, long enough to count as a page.'), url: `${site}/${t}` });
  const xml = (rows) => `<urlset>${rows.map(([u, d]) => `<url><loc>${site}/${u}</loc><lastmod>${d}</lastmod></url>`).join('')}</urlset>`;
  const deps = (hits) => ({ fetchPage: async (u) => page(u.split('/').pop()), webSearch: async () => hits.map((u) => ({ url: `${site}/${u}`, title: u })), sitemap: async (u) => { asked.push(u); if (u.endsWith('/sitemap_index.xml')) throw new Error('404'); return xml([['a', '2025-01-01'], ['fresh', '2026-10-07'], ['b', '2024-05-05']]); } });
  const two = await checkPlagiarism(INPUT, { wikipedia: false, scholar: false, paraphrase: false }, deps(['a', 'b']), {});
  assert.ok(two.sources.some((s) => s.title === 'fresh'), 'the unindexed newest post was read and matched: ' + JSON.stringify(two.searched)); assert.equal(two.searched.webSitemap, 1); assert.ok(asked[0].endsWith('/sitemap_index.xml') && asked[1].endsWith('/sitemap.xml'));
  asked.length = 0; const one = await checkPlagiarism(INPUT, { wikipedia: false, scholar: false, paraphrase: false }, deps(['a']), {});
  assert.equal(asked.length, 0, 'one page from a site is not a hint'); assert.ok(!one.sources.some((s) => s.title === 'fresh'));
  assert.deepEqual(await newestPosts('https://x.test', async (u) => (u.endsWith('/sitemap_index.xml') ? '<sitemapindex><sitemap><loc>https://x.test/post-sitemap.xml</loc></sitemap><sitemap><loc>https://x.test/page-sitemap.xml</loc></sitemap></sitemapindex>' : u.endsWith('/post-sitemap.xml') ? '<urlset><url><loc>https://x.test/old</loc><lastmod>2020-01-01</lastmod></url><url><loc>https://x.test/new</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://other.test/zz</loc><lastmod>2027-01-01</lastmod></url></urlset>' : (() => { throw new Error('should not read the page sitemap'); })())), ['https://x.test/new', 'https://x.test/old'], 'index followed into the post sitemap only, newest first, same site only');
});

await test('web search is given the sentence as written, tries the end of it, and the trace says what happened', async () => {
  const sentence = 'Trick-or-treaters across Michigan prepare spooky decorations, costumes and festive treats before the October evenings arrive for everyone.';
  const asked = [];
  const deps = { fetchPage: async () => { throw new Error('no pages expected'); }, webSearch: async (q, o = {}) => { asked.push({ q, loose: !!o.loose }); return []; } };
  const r = await checkPlagiarism(sentence + ' ' + 'A second sentence about something entirely different follows here, describing harbour cranes and the winter schedule of the ferries.', { wikipedia: false, scholar: false, paraphrase: false }, deps, {});
  assert.ok(asked[0].q.includes('Trick-or-treaters across Michigan'), 'the first search keeps hyphens and capitals: ' + asked[0].q); assert.ok(!asked[0].loose);
  assert.ok(asked.some((a) => a.q !== asked[0].q), 'then the end of the sentence: ' + JSON.stringify(asked.slice(0, 4))); assert.ok(asked.every((a) => !a.loose), 'no loose searches');
  assert.ok(r.searched.trace.length >= 1 && r.searched.trace[0].found === 0 && r.searched.trace[0].tries === 2, JSON.stringify(r.searched.trace[0])); assert.equal(r.verdict, 'Nothing was compared');
  asked.length = 0; await checkPlagiarism(sentence, { wikipedia: false, scholar: false, paraphrase: false }, { ...deps, webSearch: async (q) => { asked.push(q); return [{ url: 'https://x.test/a', title: 'a' }]; }, fetchPage: async () => ({ title: 'a', text: 'short' }) }, {});
  assert.equal(asked.length, 1, 'a search that finds something is not repeated');
});

await test('route: a failing search service is reported, and the other sources are still used', async () => {
  const saved = process.env.SEARCH_API_KEY; process.env.SEARCH_API_KEY = 'wrong-key';
  try { const { d } = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, web: true, urls: [`${fx}/garden`] } });
    assert.ok(d.warnings.some((w) => /Web search failed/.test(w)), JSON.stringify(d.warnings)); assert.equal(d.searched.urls, 1); assert.ok(d.percent > 30); }
  finally { process.env.SEARCH_API_KEY = saved; }
});

await test('Wikipedia on but nothing found there and nothing else selected: it says "nothing was compared" and what was searched, never "no matches"', async () => {
  const blog = 'As October arrives, families across Michigan prepare for spooky decorations, trick-or-treaters and festive fun at home. But this lively holiday can also bring hazards and stress for our elderly loved ones, and a night that should be fun can quickly become a worry. The good news is that a few simple steps can help everyone enjoy the evening with peace of mind and a calm, cozy night.';
  const { status, d } = await post('/plagiarism', { text: blog, options: { wikipedia: true, web: false } });
  assert.equal(status, 200, JSON.stringify(d)); assert.equal(d.checkedSources, 0); assert.equal(d.verdict, 'Nothing was compared');
  const w = d.warnings.find((x) => /Nothing was compared/.test(x)) || '';
  assert.match(w, /Wikipedia was searched with \d+ sentences? from your text and has no page that contains them/); assert.match(w, /no page addresses were listed/); assert.match(w, /Pages to compare with/);
});

await test('route: your own saved texts are compared when asked, but a text never matches itself', async () => {
  db.prepare('INSERT INTO content(title,body) VALUES(?,?)').run('Old garden note', `Notes from last year. ${COPIED} More notes follow here about other jobs in the garden.`);
  db.prepare('INSERT INTO content(title,body) VALUES(?,?)').run('Same text', INPUT);
  const off = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, web: false, library: false } });
  assert.equal(off.d.sources.length, 0);
  const on = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, web: false, library: true } });
  assert.ok(on.d.sources.some((s) => s.type === 'My Content' && s.title === 'Old garden note'), JSON.stringify(on.d.sources.map((s) => s.title)));
  assert.ok(!on.d.sources.some((s) => s.title === 'Same text'), 'the identical saved text is skipped');
});

await test('route: every check is saved in the history with its match share and sources', async () => {
  const { d } = await post('/plagiarism', { text: INPUT, title: 'Saved check', options: { wikipedia: false, urls: [`${fx}/garden`] } });
  const row = await get('/reports/' + d.historyId);
  assert.equal(row.kind, 'plagiarism'); assert.equal(row.title, 'Saved check'); assert.equal(Math.round(row.plagiarism * 1000) / 10, d.percent);
  assert.ok(row.checks.length === 1 && /% matched/.test(row.checks[0].status) && row.checks[0].name === 'Balcony Tomatoes', JSON.stringify(row.checks));
  const listed = (await get('/reports')).find((r) => r.id === d.historyId); assert.equal(listed.kind, 'plagiarism');
  const csv = await (await fetch(api + '/reports/export.csv')).text(); assert.ok(csv.includes('"Plagiarism match"') && csv.includes('"Plagiarism"'));
});

await test('route: bad input and unreadable sources give clear answers, and private addresses are not read without permission', async () => {
  assert.match((await post('/plagiarism', { text: 'too short' })).d.error, /at least 30 words/);
  const odd = await post('/plagiarism', { text: INPUT, options: { wikipedia: false, urls: [`${fx}/nothing-here`, 'not a url at all'] } });
  assert.equal(odd.status, 200); assert.ok(odd.d.warnings.filter((w) => /Could not read/.test(w)).length === 2, JSON.stringify(odd.d.warnings));
});

await test(haveModel ? 'route: a reworded sentence is reported as similar meaning, apart from the exact-match percent' : 'SKIPPED route paraphrase (no sentence model)', async () => {
  if (!haveModel) return;
  const input = `${UNRELATED} ${PARAPHRASE} My own conclusion is that gardens teach patience and a little humility about how much we really control.`;
  const { status, d } = await post('/plagiarism', { text: input, options: { wikipedia: false, urls: [`${fx}/photo`] } });
  assert.equal(status, 200, JSON.stringify(d));
  assert.equal(d.percent, 0, 'nothing is copied word for word'); assert.equal(d.similarMethod, 'meaning'); assert.equal(d.similar.length, 1, JSON.stringify(d.similar));
  assert.equal(input.slice(d.similar[0].start, d.similar[0].end), PARAPHRASE); assert.equal(d.similar[0].source.title, 'Plants and light'); assert.ok(d.similarPercent > 15 && d.similarPercent < 60);
  assert.equal((await get('/health')).embedder, 'ready');
  const row = await get('/reports/' + d.historyId); assert.ok(row.checks.some((c) => /1 similar sentence/.test(c.status) && c.name === 'Plants and light'), JSON.stringify(row.checks));
  const off = await post('/plagiarism', { text: input, options: { wikipedia: false, urls: [`${fx}/photo`], paraphrase: false } });
  assert.equal(off.d.similar.length, 0, 'it can be switched off');
});

fixture.close(); server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
