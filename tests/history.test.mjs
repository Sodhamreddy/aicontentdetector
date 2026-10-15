// History (Reports): every check and every humanizer run is stored, can be opened in full, and exports to a CSV that works in Excel.
// Run: node tests/history.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kleza-history-'));
Object.assign(process.env, { KLEZA_DB_PATH: path.join(dir, 'k.db'), PORT: '0', RATE_LIMIT_PER_MIN: '0', KLEZA_NEURAL: 'off', LLM_PROVIDER: '', LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '' });
const { server, db } = await import('../server.mjs');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const api = `http://127.0.0.1:${server.address().port}/api`;
const post = async (p, b) => { const r = await fetch(api + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json() }; };
const get = async (p) => { const r = await fetch(api + p); return { status: r.status, data: await r.json() }; };

const TEXT = 'Furthermore, it is important to note that organizations leverage robust tools to foster seamless collaboration across teams in 2024. Moreover, many experts believe that adaptation is crucial for long term success in a competitive market, and the landscape continues to evolve rapidly.';
const TRICKY = '=cmd|calc, "quoted", and a comma; plus a second line.\nSales grew 12% in 2024. It is important to note that the plan keeps improving over time for the whole community of readers and writers.';

await test('a detector check is saved as a history entry', async () => {
  const a = await post('/analyze', { text: TEXT, title: 'First check' });
  assert.equal(a.status, 200); assert.ok(a.data.id);
  const list = await get('/reports');
  const row = list.data.find((r) => r.id === a.data.id);
  assert.ok(row && row.title === 'First check' && row.kind === 'check' && row.ai_probability != null, JSON.stringify(row));
});

await test('a humanizer run with no linked check is saved as its own entry with before and after scores and the full texts', async () => {
  const r = await post('/rewrite', { text: TEXT, original: TEXT, title: 'My rewrite', options: { level: 'Natural' } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.historyId, 'the response says where it was saved');
  const d = (await get('/reports/' + r.data.historyId)).data;
  assert.equal(d.kind, 'rewrite'); assert.equal(d.title, 'My rewrite');
  assert.equal(d.original, TEXT); assert.equal(d.revised, r.data.text); assert.notEqual(d.revised, TEXT);
  assert.ok(d.ai_probability != null && d.ai_after != null && d.provider, JSON.stringify({ p: d.ai_probability, a: d.ai_after, pr: d.provider }));
  assert.ok(d.checks.length >= 4 && d.versions.length === 1 && /Full rewrite/.test(d.versions[0].label) && d.versions[0].body === r.data.text);
});

await test('a rewrite linked to a check updates that entry and adds a version instead of creating a new one', async () => {
  const a = await post('/analyze', { text: TEXT, title: 'Linked check' });
  const before = (await get('/reports')).data.length;
  const r = await post('/rewrite', { text: TEXT, original: TEXT, analysisId: a.data.id, options: { level: 'Natural' } });
  assert.equal(r.data.historyId, a.data.id);
  assert.equal((await get('/reports')).data.length, before, 'no extra entry');
  const d = (await get('/reports/' + a.data.id)).data;
  assert.equal(d.kind, 'check'); assert.equal(d.revised, r.data.text); assert.equal(d.versions.length, 1);
  await post('/rewrite', { text: r.data.text, original: TEXT, analysisId: a.data.id, options: { level: 'Natural' } });
  assert.equal((await get('/reports/' + a.data.id)).data.versions.length, 2, 'every run is kept as a version');
});

await test('a single-passage fix with no linked check is not saved on its own', async () => {
  const before = (await get('/reports')).data.length;
  const start = TEXT.indexOf('leverage');
  await post('/rewrite', { text: TEXT, original: TEXT, issue: { start, end: start + 8 }, options: { level: 'Natural' } });
  assert.equal((await get('/reports')).data.length, before);
});

await test('the list leaves texts out, newest first; an unknown id is a clear 404', async () => {
  const list = (await get('/reports')).data;
  assert.ok(list.length >= 3 && list.every((r) => r.original === undefined && r.revised !== undefined));
  assert.ok(list.every((r, i) => i === 0 || list[i - 1].id > r.id || list[i - 1].created_at >= r.created_at), 'newest first');
  const miss = await get('/reports/99999'); assert.equal(miss.status, 404); assert.match(miss.data.error, /not found/i);
});

await test('CSV export: opens in Excel (BOM, CRLF), keeps commas, quotes and line breaks inside cells, and neutralises formulas', async () => {
  const t = await post('/rewrite', { text: TRICKY, original: TRICKY, title: '=HYPERLINK("x")', options: { level: 'Natural' } });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const r = await fetch(api + '/reports/export.csv');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/); assert.match(r.headers.get('content-disposition'), /attachment; filename="kleza-history\.csv"/);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with a UTF-8 BOM');
  assert.ok(bytes.includes('\r\n'), 'rows end with CRLF');
  const csv = bytes.subarray(3).toString('utf8');
  // a small CSV reader that honours quotes, to prove the cells survive intact
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (q) { if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r') { /* part of CRLF */ } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  const head = rows[0], mine = rows.find((x) => x[0] === String(t.data.historyId));
  assert.deepEqual(head.slice(0, 4), ['ID', 'Type', 'Title', 'Date (UTC)']); assert.ok(head.includes('Original text') && head.includes('Revised text'));
  assert.ok(mine, 'the new entry is in the file'); assert.ok(rows.every((x) => x.length === head.length), 'every row has every column');
  assert.equal(mine[1], 'Rewrite'); assert.equal(mine[2], "'=HYPERLINK(\"x\")", 'a title starting with = is stored as text, not a formula');
  assert.equal(mine[head.indexOf('Original text')], "'" + TRICKY, 'a text starting with = is neutralised but otherwise intact, with its comma, quotes and line break');
  assert.equal(mine[head.indexOf('Revised text')], "'" + t.data.text, 'the rewrite (which also starts with =) gets the same guard');
  assert.equal(rows.length - 1, (await get('/reports')).data.length, 'one row per history entry');
});

await test('an empty history still exports a header-only CSV', async () => {
  db.exec('DELETE FROM versions; DELETE FROM analyses;');
  const csv = await (await fetch(api + '/reports/export.csv')).text();
  assert.equal(csv.split('\r\n').filter(Boolean).length, 1);
});

server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
