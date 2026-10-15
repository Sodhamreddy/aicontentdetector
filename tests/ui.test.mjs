// Browser end-to-end test: drives the built app in a real browser against the real server.
// Needs puppeteer-core and an installed Chrome/Edge (set BROWSER_PATH to override). Skips cleanly without one.
// Run: npm run test:ui   (builds first)
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = fileURLToPath(new URL('./', import.meta.url)), root = path.join(dir, '..');
const candidates = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const browserPath = candidates.find((p) => fs.existsSync(p));
let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* handled below */ }
if (!browserPath || !puppeteer || !fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.log(`SKIPPED: needs puppeteer-core, an installed Chrome or Edge (or BROWSER_PATH), and a build (npm run build). Found browser: ${browserPath || 'none'}`);
  process.exit(0);
}

// A small article server for the "From URL" import.
const ARTICLE = 'Tomatoes need at least six hours of direct sun each day, so pick the brightest spot on the balcony or in the garden.';
const article = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><head><title>Fixture Article</title></head><body><nav>menu</nav><article><h1>Growing tomatoes at home</h1><p>${ARTICLE}</p><p>Water deeply but not too often, and feed the plants every two weeks once the first flowers appear on the vines.</p></article></body></html>`);
}).listen(0, '127.0.0.1');
await new Promise((r) => article.once('listening', r));
const articleUrl = `http://127.0.0.1:${article.address().port}/tomatoes`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kleza-ui-'));
Object.assign(process.env, { KLEZA_DB_PATH: path.join(tmp, 'ui.db'), PORT: '0', NODE_ENV: 'production', RATE_LIMIT_PER_MIN: '0', KLEZA_NEURAL: 'off', KLEZA_ALLOW_PRIVATE_URLS: 'true' });
for (const k of ['LLM_PROVIDER', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'KLEZA_ACCESS_TOKEN']) delete process.env[k];
const { server, db } = await import('../server.mjs');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const base = `http://127.0.0.1:${server.address().port}`;

// ~46,000 words of real text from the held-out set
const rows = fs.readFileSync(path.join(root, 'detector', 'holdout.en.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const bigParts = []; let bigWords = 0;
for (const r of rows) { if (bigWords >= 46000) break; bigParts.push(r.text); bigWords += r.text.split(/\s+/).length; }
const bigText = bigParts.join('\n\n');

const browser = await puppeteer.launch({ executablePath: browserPath, headless: 'new', args: ['--no-sandbox'] });
const problems = [];
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(width = 1100, height = 900, expectedError = null) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  page.on('console', (m) => { if (m.type() === 'error' && !(expectedError && expectedError.test(m.text()))) problems.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push('[pageerror] ' + e.message));
  page.on('dialog', (d) => d.accept());
  return page;
}
const helpers = (page) => ({
  // The page scrolls smoothly to a new result; a click aimed at a button that is still moving misses it, so wait until the scrolling has stopped.
  click: async (text) => {
    await page.evaluate(() => new Promise((resolve) => { let last = -1, still = 0; const t = setInterval(() => { still = window.scrollY === last ? still + 1 : 0; last = window.scrollY; if (still >= 2) { clearInterval(t); resolve(); } }, 100); }));
    const [b] = await page.$$(`xpath/.//button[normalize-space()="${text}"]`); assert.ok(b, 'no button: ' + text); await b.click();
  },
  level: (name) => page.$$eval('.levels button', (bs, n) => bs.find((b) => b.querySelector('b').textContent === n).click(), name),
  setText: (sel, value) => page.$eval(sel, (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value),
  val: (sel) => page.$eval(sel, (el) => el.value),
  text: (sel) => page.$eval(sel, (el) => el.textContent),
  exists: async (sel) => !!(await page.$(sel)),
  wait: (sel, t = 20000) => page.waitForSelector(sel, { timeout: t }),
  activeTab: () => page.$eval('.tabs button.on', (b) => b.textContent),
});

const page = await open();
await page.goto(base, { waitUntil: 'networkidle0' });
const { click, level, setText, val, text, exists, wait, activeTab } = helpers(page);

await test('navigation has all tools', async () => {
  const tabs = await page.$$eval('.tabs button', (b) => b.map((x) => x.textContent));
  for (const t of ['AI Detector', 'Humanizer', 'Plagiarism Checker', 'My Content', 'Reports']) assert.ok(tabs.includes(t), t);
  assert.ok(!tabs.includes('Model'), 'the Model tab has been removed');
});
await test('detector: verdict, writing issues and readability', async () => {
  await click('Try a sample'); await click('Check for AI'); await wait('.big-score');
  assert.match(await text('.verdict'), /AI/); assert.ok(await exists('.issue')); assert.match(await text('.result'), /readability/);
});
await test('detector layout: text and score side by side, AI sentences highlighted and clickable', async () => {
  const box = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; });
  // The score panel is sticky and the page scrolls to the result, so measure from the top of the page, not mid-scroll.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await sleep(300);
  const [left, right] = [await box('.highlighted'), await box('.score-panel')];
  assert.ok(left.right <= right.left + 1, 'the score panel should sit to the right of the text');
  assert.ok(Math.abs(left.top - right.top) < 200, 'both should start at about the same height');
  assert.ok((await page.$$('.highlighted mark')).length > 0, 'expected highlighted sentences in the text');
  assert.ok((await page.$$('.top-sentences li')).length > 0, 'expected a list of the most AI sentences');
  await page.$eval('.top-sentences button', (b) => b.click());
  await page.waitForSelector('.highlighted mark.flash', { timeout: 3000 });
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
});
await test('"Fix this" edits the text and re-checks; Undo restores it', async () => {
  const before = await text('.highlighted'); // the scored text is shown with its AI sentences marked
  await click('Fix this');
  await page.waitForFunction((b) => document.querySelector('.highlighted') && document.querySelector('.highlighted').textContent !== b, { timeout: 20000 }, before);
  await wait('.big-score');
  await click('Undo'); await sleep(300);
  assert.equal(await val('#input'), before);
});
await test('humanizer: level, options, keyword kept, result with score change', async () => {
  await click('Humanizer'); await level('Light');
  assert.equal(await page.$eval('.levels button.on b', (e) => e.textContent), 'Light');
  await page.$eval('details.more summary', (s) => s.click());
  await setText('#req', 'vaccine'); await setText('#pk', 'immune system'); await setText('#brand', 'Warm and plain');
  await level('Natural'); await click('Humanize'); await wait('.output');
  assert.ok((await val('#output')).length > 100 && /vaccine/i.test(await val('#output')));
  assert.match(await text('.score-change'), /→/);
});
await test('save, saved-picker, DOCX export', async () => {
  // The save notice is on screen for only 2.4 s, and waiting for it frame by frame can miss it when the browser draws few frames (a
  // background or busy tab). So record every notice as it appears, from before the click, and check the record on a timer.
  await page.evaluate(() => { window.__notices = []; new MutationObserver(() => { const t = document.querySelector('.toast'); if (t && window.__notices.at(-1) !== t.textContent) window.__notices.push(t.textContent); }).observe(document.body, { childList: true, subtree: true, characterData: true }); });
  await setText('#title', 'Vaccine explainer'); await click('Save to My Content');
  await page.waitForFunction(() => window.__notices.some((n) => /Saved to My Content/.test(n)), { timeout: 40000, polling: 200 }).catch(async () => assert.fail(`no "Saved to My Content" notice; the page showed: ${JSON.stringify(await page.evaluate(() => window.__notices))}`));
  await wait('select[aria-label="Load saved content"]', 15000);
  const docx = await page.evaluate(async () => { const r = await fetch('/api/download/docx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello world', title: 'x' }) }); return [r.status, (await r.blob()).size]; });
  assert.ok(docx[0] === 200 && docx[1] > 1000, docx.join('/'));
});
await test('humanized text can be re-checked in one click', async () => {
  await click('Check for AI'); await wait('.big-score'); assert.equal(await activeTab(), 'AI Detector');
});
await test('file upload and URL import fill the text box', async () => {
  const file = path.join(tmp, 'upload.txt');
  fs.writeFileSync(file, 'This uploaded file talks about the way small teams plan their week. They list the tasks, pick the three that matter most, and leave room for the unexpected things that always come up on a Tuesday afternoon.');
  await (await page.$('input[type=file]')).uploadFile(file);
  await page.waitForFunction(() => document.querySelector('#input')?.value.includes('small teams plan their week'), { timeout: 20000 });
  await click('From URL'); await setText('#url', articleUrl); await click('Import');
  await page.waitForFunction(() => document.querySelector('#input')?.value.includes('Tomatoes need at least six hours'), { timeout: 20000 });
  assert.match(await text('.import-info'), /Imported from.*\d+ words/, 'the source line says where the text came from');
});
await test('saved picker loads content', async () => {
  const value = await page.$eval('select[aria-label="Load saved content"] option:nth-child(2)', (o) => o.value);
  await page.select('select[aria-label="Load saved content"]', value);
  await page.waitForFunction(() => (document.querySelector('#input')?.value.length || 0) > 100, { timeout: 10000 });
});
await test('My Content lists the item and opens it in the detector', async () => {
  await click('My Content'); await wait('.row');
  assert.match(await text('.rows'), /Vaccine explainer/);
  await click('Check'); await wait('#input');
  assert.equal(await activeTab(), 'AI Detector'); assert.ok((await val('#input')).length > 100);
});
await test('Plagiarism: a listed page is compared, the copied passage is marked and the source is named, and the check lands in Reports', async () => {
  await click('Plagiarism Checker'); await click('Clear');
  assert.equal(await text('h1'), 'Plagiarism Checker');
  const boxes = await page.$$eval('.check-row input', (els) => els.map((e) => ({ checked: e.checked, disabled: e.disabled })));
  assert.deepEqual(boxes.map((b) => b.disabled), [false, false, true, false, false], 'only web search is unavailable (no search key in the test environment): ' + JSON.stringify(boxes));
  assert.deepEqual(boxes.map((b) => b.checked), [true, true, false, false, true], 'Wikipedia, papers and rewording are on by default, web (not set up) and saved texts off');
  await page.$eval('.check-row input', (e) => e.click()); // turn Wikipedia off: the test must not depend on the internet
  await setText('#input', `My own notes start here and say the following. ${ARTICLE} I then added a few more words of my own about watering the plants regularly each week.`);
  await setText('#plag-urls', articleUrl);
  // The click must reach the button: a notification used to sit on top of it and swallow the click.
  assert.equal(await page.$eval('button.big', (b) => { const r = b.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return top === b || b.contains(top); }), true, 'nothing covers the button');
  await click('Check for plagiarism');
  await wait('.plagiarism-result', 40000).catch(async () => assert.fail(`no result. page error: "${await text('.error').catch(() => '(none)')}" | button: "${await text('button.big').catch(() => '?')}"`));
  const percent = Number(await text('.plagiarism-result .big-score b'));
  assert.ok(percent > 25 && percent < 90, 'share matched: ' + percent);
  assert.match(await text('.plagiarism-result'), /Sources with matching passages[\s\S]*Fixture Article/);
  assert.match(await page.$eval('.highlighted mark', (m) => m.textContent), /Tomatoes need at least six hours/, 'the copied passage is marked in the text');
  await click('Reports'); await wait('table.data');
  const types = await page.$$eval('table.data tbody tr td:nth-child(2)', (c) => c.map((x) => x.textContent));
  assert.ok(types.includes('Plagiarism'), types.join('|')); assert.match(await text('table.data'), /\d+% matched/);
  await click('AI Detector');
});
await test('Reports keeps the history: checks and humanizer runs, each openable in full', async () => {
  await click('Reports'); await wait('table.data');
  assert.ok((await page.$$eval('table.data tbody tr', (r) => r.length)) >= 2);
  const types = await page.$$eval('table.data tbody tr td:nth-child(2)', (c) => c.map((x) => x.textContent));
  assert.ok(types.some((t) => /^Check/.test(t)) && types.includes('Rewrite'), 'both checks and rewrites are listed: ' + types.join('|'));
  // open the rewrite entry: both texts, the scores and the quality checks are there
  const rowIndex = types.indexOf('Rewrite') + 1;
  await page.$eval(`table.data tbody tr:nth-child(${rowIndex}) .link-btn`, (b) => b.click());
  await wait('.history-text');
  assert.ok((await page.$$('.history-text')).length >= 2, 'original and rewritten text');
  assert.match(await text('.history-text'), /vaccine/i); assert.match(await text('main'), /Quality checks/);
  assert.match(await text('main'), /Rewritten text/); assert.match(await text('.stats'), /AI likelihood/);
  await click('← Back to history'); await wait('table.data');
});
await test('Reports: Export CSV downloads a file that opens in Excel, and the search box filters the list', async () => {
  const dl = path.join(tmp, 'downloads'); fs.mkdirSync(dl, { recursive: true });
  const cdp = await page.createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await click('Export CSV');
  const file = path.join(dl, 'kleza-history.csv');
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) await sleep(200);
  assert.ok(fs.existsSync(file), 'the CSV was not downloaded');
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const csv = bytes.subarray(3).toString('utf8');
  assert.match(csv.split('\r\n')[0], /"ID","Type","Title"/); assert.match(csv, /"Rewrite"/); assert.match(csv, /"Check"/);
  await setText('input[aria-label="Search history"]', 'zzz-no-such-title'); await sleep(200);
  assert.match(await text('.empty'), /Nothing matches/);
  await setText('input[aria-label="Search history"]', '');
});
await test('a ~46,000-word document is analysed in the browser; over the limit is refused', async () => {
  await click('AI Detector'); await click('Clear'); await setText('#input', bigText);
  assert.match(await text('.count'), /\/ 50,000/);
  const t0 = Date.now(); await click('Check for AI'); await wait('.big-score', 60000);
  assert.ok(Date.now() - t0 < 30000, `took ${(Date.now() - t0) / 1000}s`);
  await click('Edit text');
  await setText('#input', 'word '.repeat(50001));
  assert.match(await text('.error'), /50,000/); assert.ok(await page.$eval('button.big', (b) => b.disabled));
});
await page.close();

// ---- progress and cancel, using a scripted server response for a long-running job ----
await test('a long rewrite shows section progress and can be cancelled', async () => {
  const p = await open(); const h = helpers(p);
  let deleted = false;
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const url = req.url(), reply = (status, body) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!url.includes('/api/rewrite/jobs')) return req.continue();
    if (req.method() === 'POST') return reply(202, { id: 'job1' });
    if (req.method() === 'DELETE') { deleted = true; return reply(200, { status: 'cancelled' }); }
    return reply(200, deleted ? { status: 'cancelled', done: 2, total: 9 } : { status: 'running', done: 2, total: 9 });
  });
  await p.goto(base, { waitUntil: 'networkidle0' });
  await h.click('Humanizer'); await h.click('Try a sample'); await h.click('Humanize');
  await h.wait('.progress-row');
  assert.match(await h.text('.progress-row'), /Rewriting section 3 of 9/);
  await h.click('Cancel'); await sleep(1500);
  assert.ok(deleted, 'DELETE was sent'); assert.equal(await h.exists('.progress-row'), false);
  assert.equal(await p.$eval('button.big', (b) => b.disabled), false, 'Humanize is usable again');
  await p.close();
});

// ---- a server that is restarting: the app retries instead of showing "Something went wrong" ----
await test('while the server is restarting the app retries quietly, then works; if it stays down it says so clearly', async () => {
  const p = await open(1100, 900, /502|503|ERR_FAILED|Failed to load resource/);
  const h = helpers(p);
  let reports = 0, down = true;
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    if (req.url().includes('/api/reports') && req.method() === 'GET' && !req.url().includes('export')) { reports++; if (down && reports <= 2) return req.respond({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }); }
    if (req.url().includes('/api/analyze') && down) return req.abort('connectionreset'); // the connection is dropped, as when the process dies
    return req.continue();
  });
  await p.goto(base, { waitUntil: 'networkidle0' });
  await h.click('Reports');
  await h.wait('table.data, .empty', 20000);
  assert.ok(reports >= 3, `the page asked again after the 502s (${reports} requests)`);
  assert.match(await h.text('.toast').catch(() => 'The server is restarting'), /restarting|Reports|Entries/i);
  // a request that keeps failing ends with the explanation, not the generic message
  await h.click('AI Detector'); await h.click('Try a sample'); await h.click('Check for AI');
  await p.waitForSelector('.error', { timeout: 60000 });
  const message = await h.text('.error');
  assert.match(message, /could not be reached.*restarting/i, message); assert.doesNotMatch(message, /Something went wrong/);
  await p.close();
});

// ---- access token prompt ----
await test('a server that requires a token prompts for it and then sends it', async () => {
  const p = await open(1100, 900, /401 \(Unauthorized\)/); // this test deliberately makes the server answer 401
  const h = helpers(p);
  const seenTokens = [];
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    if (!req.url().includes('/api/')) return req.continue();
    const token = req.headers()['x-access-token'];
    if (token) { seenTokens.push(token); return req.continue(); }
    return req.respond({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'An access token is required.', auth: true }) });
  });
  await p.goto(base, { waitUntil: 'domcontentloaded' });
  await h.wait('.auth-card');
  assert.match(await h.text('.auth-card'), /Access token needed/);
  await h.setText('#token', 'my-token'); await h.click('Continue');
  await p.waitForSelector('.tabs', { timeout: 15000 });
  assert.ok(seenTokens.includes('my-token'), 'the token is sent on later requests');
  await p.close();
});

await test('no horizontal overflow on a phone-sized screen', async () => {
  const m = await open(390, 800); await m.goto(base, { waitUntil: 'networkidle0' });
  assert.equal(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await m.close();
});
await test('no unexpected console errors during the run', async () => assert.deepEqual(problems, [], problems.join('\n')));

console.log(`${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
await browser.close(); article.close(); server.close(); db.close();
fs.rmSync(tmp, { recursive: true, force: true });
for (const f of [path.join(dir, 'detector-model.json')]) if (fs.existsSync(f)) fs.rmSync(f);
process.exit(failed ? 1 : 0);
