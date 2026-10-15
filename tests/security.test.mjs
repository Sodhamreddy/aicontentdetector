// Tests for the URL-fetch guard (SSRF), rate limiting, the access token and CORS. No network needed.
// Run: npm run test:security
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import { accessGate, assertPublicUrl, isPrivateAddress, rateLimiter, safeGet } from '../security.mjs';

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + e.message); } };

// ---- private addresses ----
await test('private, loopback and metadata addresses are blocked; public ones are not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'not-an-ip'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});
await test('assertPublicUrl rejects local targets however they are written', async () => {
  for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'http://localhost/', 'http://app.localhost/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/', 'http://box.internal/', 'http://user:pw@93.184.216.34/', 'not a url'])
    await assert.rejects(() => assertPublicUrl(u, { allowPrivate: false }), undefined, u);
  assert.equal((await assertPublicUrl('http://93.184.216.34/page', { allowPrivate: false })).hostname, '93.184.216.34');
});

// ---- safeGet against a local fixture server ----
const hits = [];
const fixture = http.createServer((req, res) => {
  hits.push(req.url);
  const send = (status, type, body, extra = {}) => { res.writeHead(status, { 'Content-Type': type, ...extra }); res.end(body); };
  if (req.url === '/ok') return send(200, 'text/html; charset=utf-8', '<html><body><p>Café hello</p></body></html>');
  if (req.url === '/redirect') return send(302, 'text/plain', '', { Location: '/ok' });
  if (req.url === '/loop') return send(302, 'text/plain', '', { Location: '/loop' });
  if (req.url === '/to-file') return send(302, 'text/plain', '', { Location: 'file:///etc/passwd' });
  if (req.url === '/big') return send(200, 'text/html', 'x'.repeat(200000));
  if (req.url === '/json') return send(200, 'application/json', '{"a":1}');
  if (req.url === '/sitemap') return send(200, 'application/xml; charset=utf-8', '<urlset></urlset>');
  if (req.url === '/slow') return; // never answers
  send(404, 'text/html', 'nope');
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fixture.address().port}`;

await test('safeGet refuses a private target by default, without connecting', async () => {
  hits.length = 0;
  await assert.rejects(() => safeGet(base + '/ok', { allowPrivate: false }), /Private network|not allowed/);
  assert.equal(hits.length, 0, 'no request may reach the private server');
});
await test('safeGet fetches, follows a redirect and decodes text (when private targets are allowed)', async () => {
  const r = await safeGet(base + '/redirect', { allowPrivate: true });
  assert.equal(r.status, 200); assert.ok(r.body.includes('Café hello'), r.body); assert.ok(r.url.endsWith('/ok'));
});
await test('safeGet stops redirect loops, non-http redirects, huge bodies, non-text types and slow servers', async () => {
  await assert.rejects(() => safeGet(base + '/loop', { allowPrivate: true, maxRedirects: 3 }), /too many times/);
  await assert.rejects(() => safeGet(base + '/to-file', { allowPrivate: true }), /http or https/);
  await assert.rejects(() => safeGet(base + '/big', { allowPrivate: true, maxBytes: 1000 }), /too large/);
  await assert.rejects(() => safeGet(base + '/json', { allowPrivate: true }), /not a web page/);
  await assert.rejects(() => safeGet(base + '/sitemap', { allowPrivate: true }), /not a web page/, 'XML is refused unless asked for');
  assert.equal((await safeGet(base + '/sitemap', { allowPrivate: true, xml: true })).body, '<urlset></urlset>', 'a sitemap served as application/xml is read when xml is allowed');
  await assert.rejects(() => safeGet(base + '/json', { allowPrivate: true, xml: true }), /not a web page/, 'xml does not open the door to JSON');
  await assert.rejects(() => safeGet(base + '/slow', { allowPrivate: true, timeoutMs: 300 }), /too long|timeout|socket/i);
});

// ---- rate limiter and access gate (middleware, driven directly) ----
const call = (mw, { method = 'GET', path = '/api/x', ip = '1.2.3.4', headers = {} } = {}) => {
  const res = { code: 200, headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  let nexted = false;
  mw({ method, path, ip, get: (h) => headers[h.toLowerCase()], socket: {} }, res, () => { nexted = true; });
  return { nexted, res };
};
await test('rateLimiter: overall and heavy limits, per-client buckets, Retry-After', () => {
  const mw = rateLimiter({ windowMs: 60000, max: 5, heavyMax: 2 });
  assert.ok(call(mw, { method: 'POST', path: '/api/analyze' }).nexted); assert.ok(call(mw, { method: 'POST', path: '/api/analyze' }).nexted);
  const blockedHeavy = call(mw, { method: 'POST', path: '/api/analyze' });
  assert.equal(blockedHeavy.res.code, 429); assert.ok(Number(blockedHeavy.res.headers['Retry-After']) >= 1);
  assert.ok(call(mw, { method: 'GET', path: '/api/reports' }).nexted, 'cheap GETs are not heavy-limited');
  assert.ok(call(mw, { method: 'POST', path: '/api/analyze', ip: '9.9.9.9' }).nexted, 'another client has its own bucket');
  for (let i = 0; i < 3; i++) call(mw, { path: '/api/settings' });
  assert.equal(call(mw, { path: '/api/settings' }).res.code, 429, 'the overall limit applies too');
  assert.ok(call(rateLimiter({ max: 0 }), { method: 'POST', path: '/api/analyze' }).nexted, '0 disables limiting');
});
await test('accessGate: token required on /api except health; Bearer and header both work', () => {
  const gate = accessGate('s3cret');
  assert.equal(call(gate, { path: '/api/analyze' }).res.code, 401);
  assert.equal(call(gate, { path: '/api/analyze', headers: { 'x-access-token': 'wrong' } }).res.code, 401);
  assert.ok(call(gate, { path: '/api/analyze', headers: { 'x-access-token': 's3cret' } }).nexted);
  assert.ok(call(gate, { path: '/api/analyze', headers: { authorization: 'Bearer s3cret' } }).nexted);
  assert.ok(call(gate, { path: '/api/health' }).nexted); assert.ok(call(gate, { path: '/assets/app.js' }).nexted);
  assert.ok(call(accessGate(''), { path: '/api/analyze' }).nexted, 'no token configured means open');
});

// ---- the real server, with a token and a small heavy limit ----
const dir = fileURLToPath(new URL('./', import.meta.url)), dbFile = dir + 'security.db';
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm', dir + 'detector-model.json']) if (fs.existsSync(f)) fs.rmSync(f);
Object.assign(process.env, { KLEZA_DB_PATH: dbFile, PORT: '0', KLEZA_ACCESS_TOKEN: 's3cret', KLEZA_NEURAL: 'off', RATE_LIMIT_PER_MIN: '1000', RATE_LIMIT_HEAVY_PER_MIN: '6' });
delete process.env.KLEZA_ALLOW_PRIVATE_URLS;
const { server, db } = await import('../server.mjs');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const api = `http://127.0.0.1:${server.address().port}/api`;
const send = (path, body, headers = {}) => fetch(api + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
const auth = { 'x-access-token': 's3cret' };

await test('server: health is open; everything else needs the token', async () => {
  assert.equal((await send('/health')).status, 200);
  assert.equal((await send('/reports')).status, 401);
  assert.equal((await send('/reports', null, auth)).status, 200);
});
await test('server: URL import refuses private and metadata addresses', async () => {
  hits.length = 0;
  for (const url of [base + '/ok', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:80/', 'http://localhost:3001/api/health']) {
    const r = await send('/url', { url }, auth); const j = await r.json();
    assert.equal(r.status, 422, url); assert.match(j.error, /Private|Local|not allowed/i, j.error);
  }
  assert.equal(hits.length, 0, 'the private fixture server must never receive a request');
});
await test('server: no CORS headers are sent to other origins', async () => {
  const r = await send('/health', null, { Origin: 'http://evil.example' });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});
await test('server: the heavy-endpoint limit returns 429 with Retry-After', async () => {
  const codes = [];
  let retry = null;
  for (let i = 0; i < 8; i++) { const r = await send('/analyze', { text: 'short text here' }, auth); codes.push(r.status); if (r.status === 429) retry = r.headers.get('retry-after'); }
  assert.ok(codes.includes(429), codes.join(','));
  assert.ok(Number(retry) >= 1, 'Retry-After: ' + retry);
});

console.log(`${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
fixture.close(); server.close(); db.close();
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm', dir + 'detector-model.json']) if (fs.existsSync(f)) fs.rmSync(f);
process.exit(failed ? 1 : 0);
