// The "From URL" import: article extraction from messy pages, title cleaning, and the /api/url route (errors, plain text, encodings).
// Run: node tests/extract.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractArticle, cleanTitle, withScheme } from '../extract.mjs';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } };

const P = (s) => `<p>${s}</p>`;
const BODY_PARAS = [
  'Tomatoes need at least six hours of direct sun each day, so pick the brightest spot on the balcony, and turn the pots now and then.',
  'Water deeply but rarely, because shallow watering teaches the roots to stay near the surface, where the soil dries out first.',
  'Feed them every two weeks once the first flowers open, and pinch out the small shoots that grow between the stem and a branch.',
];
const BLOG = `<!doctype html><html><head><title>Growing Tomatoes on a Balcony | Garden Weekly</title>
<meta property="og:site_name" content="Garden Weekly"><meta name="author" content="Ana Pérez"><meta property="article:published_time" content="2025-03-04T09:00:00Z">
<meta name="description" content="A short guide."></head><body>
<div class="cookie-banner"><p>We use cookies to improve your experience on this website, accept them all to continue.</p></div>
<header class="site-header"><nav><ul><li><a href="/">Home page of the garden weekly site</a></li><li><a href="/about">About the garden weekly team</a></li></ul></nav></header>
<main><article><header><h1>Growing Tomatoes on a Balcony</h1><p class="byline">By Ana Pérez</p></header>
<h2>Sun and water</h2>${BODY_PARAS.map(P).join('')}
<div class="share-buttons"><p>Share this article with your friends and family on every social network.</p></div>
<section class="related-posts"><h3>Related articles</h3><ul><li><a href="/a">Ten ways to grow peppers in small spaces</a></li><li><a href="/b">How to make compost at home this spring</a></li></ul></section>
<section id="comments" class="comments"><h2>Comments</h2><p>Great guide, thank you so much for sharing this with everybody here today!</p></section>
</article><aside class="sidebar"><h3>Popular</h3><ul><li><a href="/c">The best tools for a small garden this year</a></li></ul></aside></main>
<footer><p>© 2025 Garden Weekly. All rights reserved. Privacy policy and terms of use apply to everything here.</p></footer></body></html>`;

await test('a typical blog page: the article only, with clean title, author, date and site name', () => {
  const r = extractArticle(BLOG, 'https://gardenweekly.example/tomatoes');
  assert.equal(r.title, 'Growing Tomatoes on a Balcony');
  for (const p of BODY_PARAS) assert.ok(r.text.includes(p), 'missing: ' + p.slice(0, 40));
  assert.ok(r.text.includes('Sun and water'), 'keeps the section heading');
  for (const junk of ['cookies', 'Home page of the garden', 'Share this article', 'Related articles', 'peppers in small spaces', 'Great guide', 'Popular', 'All rights reserved', 'By Ana']) assert.ok(!r.text.includes(junk), 'should be left out: ' + junk);
  assert.equal(r.metadata.author, 'Ana Pérez'); assert.equal(r.metadata.siteName, 'Garden Weekly'); assert.match(r.metadata.published, /^2025-03-04/);
  assert.deepEqual(r.warnings, []); assert.ok(r.metadata.words > 50);
});

await test('a page with no <article> or <main>: the content div wins over the sidebar and the menus', () => {
  const html = `<html><head><title>Notes</title></head><body><div class="menu"><a href="/1">First menu link text here</a><a href="/2">Second menu link text here</a></div>
    <div id="page"><div class="sidebar"><ul><li><a href="/x">A link to something that is long enough to count</a></li></ul></div>
    <div class="post-content">${BODY_PARAS.map(P).join('')}</div></div><div id="footer">Copyright and other small print for the whole site goes here.</div></body></html>`;
  const r = extractArticle(html, 'https://x.example/notes');
  for (const p of BODY_PARAS) assert.ok(r.text.includes(p));
  assert.ok(!/menu link|something that is long enough|small print/.test(r.text), r.text);
});

await test('an old page with text in <br> runs and no <p> (the old extractor found nothing here)', () => {
  const html = `<html><head><title>Essay</title></head><body><table><tr><td><font size=2>${BODY_PARAS.join('<br><br>')}<br><br>Thanks to a friend for reading drafts of this long piece before it went out.</font></td></tr></table></body></html>`;
  const r = extractArticle(html, 'https://old.example/essay.html');
  assert.equal(r.metadata.extractor, 'text-runs');
  for (const p of BODY_PARAS) assert.ok(r.text.includes(p));
});

await test('reference lists and citation marks are not the article', () => {
  const html = `<html><head><title>Topic - Wikipedia</title></head><body><div id="mw-content-text"><div class="mw-parser-output">
    <p>Photosynthesis is a process used by plants, algae and some bacteria<sup class="reference">[1]</sup> to turn light into chemical energy that is stored in sugars.</p>
    <p>It supplies most of the oxygen in the air and the food of nearly every living thing, which is why it matters so much for life on this planet.</p>
    <ol class="references">${Array.from({ length: 12 }, (_, i) => `<li>Author ${i}, A. (2001). A long reference title, with several commas, in a Journal of Things, 12 (3): 45-67. doi:10.1000/${i}</li>`).join('')}</ol></div></div></body></html>`;
  const r = extractArticle(html, 'https://en.wikipedia.org/wiki/Topic');
  assert.ok(r.text.startsWith('Photosynthesis is a process') && !/\[1\]|doi:|Journal of Things/.test(r.text), r.text);
  assert.equal(r.title, 'Topic');
});

await test('a page with almost no text (a JavaScript app shell) gives a clear warning', () => {
  const r = extractArticle('<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>', 'https://app.example/');
  assert.ok(r.warnings.length && /JavaScript|login|paywall/.test(r.warnings[0]), JSON.stringify(r.warnings));
});

await test('title cleaning: removes the site name, but not a hyphen that is part of the headline', () => {
  assert.equal(cleanTitle('Photosynthesis - Wikipedia', '', 'https://en.wikipedia.org/wiki/Photosynthesis'), 'Photosynthesis');
  assert.equal(cleanTitle('How to Win - Part 2', '', 'https://blog.example.com/x'), 'How to Win - Part 2');
  assert.equal(cleanTitle('My Post | Site'), 'My Post | Site', 'with no site name known and no clearly longer part, a short title is left as it is');
  assert.equal(cleanTitle('Site | A much longer headline about tomatoes'), 'A much longer headline about tomatoes');
  assert.equal(cleanTitle('Growing Tomatoes | Garden Weekly', 'Garden Weekly'), 'Growing Tomatoes');
  assert.equal(cleanTitle('   '), '');
});

// ---- the route, through the real server and a fixture web server ----
const big = Array.from({ length: 52000 }, (_, i) => `word${i % 900}`).join(' ');
const latin1 = Buffer.concat([Buffer.from('<html><head><meta charset="iso-8859-1"><title>Caf'), Buffer.from([0xe9]), Buffer.from('</title></head><body><article><p>Le caf'), Buffer.from([0xe9]), Buffer.from(' est ouvert tous les jours de la semaine, et les clients aiment s\'y asseoir longtemps pour lire le journal du matin.</p><p>On y sert aussi du chocolat chaud, des tartes aux pommes et un excellent th'), Buffer.from([0xe9]), Buffer.from(' glac'), Buffer.from([0xe9]), Buffer.from(' en été.</p></article></body></html>')]);
const fixture = createServer((req, res) => {
  const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
  if (req.url === '/blog') return send(200, 'text/html; charset=utf-8', BLOG);
  if (req.url === '/plain.txt') return send(200, 'text/plain; charset=utf-8', 'First paragraph of a plain text file that is long enough to count as text.\r\nIt wraps onto a second line.\r\n\r\nSecond paragraph of the same plain text file, also long enough to count.');
  if (req.url === '/pdf') return send(200, 'application/pdf', '%PDF-1.4');
  if (req.url === '/forbidden') return send(403, 'text/html', '<html>no</html>');
  if (req.url === '/missing') return send(404, 'text/html', '<html>gone</html>');
  if (req.url === '/latin1') return send(200, 'text/html', latin1); // no charset in the header: only the <meta> says so
  if (req.url === '/huge') return send(200, 'text/html', `<html><body><article><p>${big}</p></article></body></html>`);
  if (req.url === '/empty') return send(200, 'text/html', '<html><body><div id="root"></div></body></html>');
  send(404, 'text/plain', 'x');
});
await new Promise((r) => fixture.listen(0, r));
const fx = `127.0.0.1:${fixture.address().port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kleza-url-'));
Object.assign(process.env, { KLEZA_DB_PATH: path.join(dir, 'k.db'), PORT: '0', RATE_LIMIT_PER_MIN: '0', KLEZA_NEURAL: 'off', KLEZA_ALLOW_PRIVATE_URLS: 'true', LLM_PROVIDER: '', LLM_API_KEY: '' });
const { server, db } = await import('../server.mjs');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const api = `http://127.0.0.1:${server.address().port}/api`;
const imp = async (url) => { const r = await fetch(api + '/url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }); return { status: r.status, d: await r.json() }; };

await test('an address typed without https:// gets one, and an explicit scheme is left alone', () => {
  assert.equal(withScheme('example.com/page'), 'https://example.com/page'); assert.equal(withScheme('  www.example.com '), 'https://www.example.com');
  assert.equal(withScheme('http://example.com/a'), 'http://example.com/a'); assert.equal(withScheme('HTTPS://Example.com'), 'HTTPS://Example.com'); assert.equal(withScheme(''), '');
});
await test('route: the result carries title, metadata and word count', async () => {
  const ok = await imp(`http://${fx}/blog`);
  assert.equal(ok.status, 200, JSON.stringify(ok.d)); assert.equal(ok.d.title, 'Growing Tomatoes on a Balcony'); assert.equal(ok.d.metadata.author, 'Ana Pérez'); assert.ok(ok.d.metadata.words > 50 && Array.isArray(ok.d.warnings));
});
await test('route: plain-text links are used as text, with paragraphs kept', async () => {
  const { status, d } = await imp(`http://${fx}/plain.txt`);
  assert.equal(status, 200); assert.equal(d.title, 'plain.txt'); assert.equal(d.text.split('\n\n').length, 2); assert.ok(d.text.includes('First paragraph of a plain text file that is long enough to count as text. It wraps onto a second line.'));
});
await test('route: a page that declares its encoding only in <meta> is decoded correctly', async () => {
  const { status, d } = await imp(`http://${fx}/latin1`);
  assert.equal(status, 200, JSON.stringify(d)); assert.ok(d.text.includes('Le café est ouvert') && d.text.includes('thé glacé') && d.title === 'Café', d.title + ' | ' + d.text.slice(0, 60));
});
await test('route: clear messages for a PDF link, a blocked page, a missing page and an empty app shell', async () => {
  assert.match((await imp(`http://${fx}/pdf`)).d.error, /PDF.*Upload file/);
  assert.match((await imp(`http://${fx}/forbidden`)).d.error, /refused automated access|login/);
  assert.match((await imp(`http://${fx}/missing`)).d.error, /not found/i);
  assert.match((await imp(`http://${fx}/empty`)).d.error, /JavaScript|login|paywall|No usable/);
  assert.match((await imp('')).d.error, /Enter a page address/);
});
await test('route: a page longer than the limit is cut to the limit, with a warning', async () => {
  const { status, d } = await imp(`http://${fx}/huge`);
  assert.equal(status, 200); assert.ok(d.metadata.words <= 50000 && d.metadata.words > 49000, String(d.metadata.words)); assert.ok(d.warnings.some((w) => /first 50,000 words/.test(w)), JSON.stringify(d.warnings));
});

fixture.close(); server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
