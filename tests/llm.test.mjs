// The optional LLM connector (llm.mjs) and the score-and-retry loop, tested against a mock OpenAI-compatible endpoint
// and through the real server. No key or network is needed. Run: node tests/llm.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { llmConfig, llmChat } from '../llm.mjs';
import { humanizePrompt, refineWithScoring, refineLong, chunkText, cleanLlmText, dropAddedQuotes } from '../humanizer.mjs';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } };

await test('config: off by default, presets fill in defaults, hosted services need a key, ollama does not', () => {
  assert.equal(llmConfig({}), null);
  assert.equal(llmConfig({ LLM_PROVIDER: 'groq' }), null);
  assert.deepEqual(llmConfig({ LLM_PROVIDER: 'groq', LLM_API_KEY: 'k' }), { name: 'groq', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', key: 'k' });
  assert.equal(llmConfig({ LLM_PROVIDER: 'ollama' }).base, 'http://localhost:11434/v1');
  assert.equal(llmConfig({ LLM_BASE_URL: 'https://x.test/v1/', LLM_MODEL: 'm', LLM_API_KEY: 'k' }).base, 'https://x.test/v1');
});

// ---- a mock OpenAI-compatible chat endpoint ----
const seen = { bodies: [], headers: [] };
let mode = 'normal', calls = 0;
const SOURCE = 'Sales grew 12% in 2024. It is important to note that home care matters a great deal to many families.';
const GOOD = 'Sales grew 12% in 2024. Home care matters to families.';
const mock = createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}; seen.bodies.push(body); seen.headers.push(req.headers); calls++;
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'bad-key') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'Invalid API key' } })); }
    if (mode === 'limited-once' && calls === 1) { res.statusCode = 429; res.setHeader('retry-after', '0'); return res.end(JSON.stringify({ error: { message: 'slow down' } })); }
    if (mode === 'cut-off-once' && calls === 1) return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }));
    const prompt = body.messages?.[0]?.content || '';
    const reply = /previous attempt/.test(prompt) ? GOOD : SOURCE;
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: mode === 'echo' ? prompt.split('Return only the rewritten text.\n\n')[1] : reply }, finish_reason: 'stop' }] }));
  });
});
await new Promise((r) => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}/v1`;
const cfg = { name: 'mock', base, model: 'test-model', key: 'secret' };

await test('llmChat: sends the key, model and prompt in the OpenAI chat format and returns the text', async () => {
  seen.bodies.length = 0; seen.headers.length = 0; mode = 'normal'; calls = 0;
  assert.equal(await llmChat(cfg, 'hello'), SOURCE);
  assert.equal(seen.headers[0].authorization, 'Bearer secret');
  assert.equal(seen.bodies[0].model, 'test-model'); assert.equal(seen.bodies[0].messages[0].content, 'hello');
});
await test('llmChat: retries a rate limit once, and reports a bad key clearly', async () => {
  mode = 'limited-once'; calls = 0;
  assert.equal(await llmChat(cfg, 'x'), SOURCE); assert.equal(calls, 2);
  mode = 'bad-key';
  await assert.rejects(() => llmChat(cfg, 'x'), /Invalid API key/);
});

await test('cleanup: removes markdown bold and heading marks and non-breaking hyphens, and keeps real content', () => {
  assert.equal(cleanLlmText('**Title here**  \n\n## Heading\nA heat‑related risk, 12% in 2024.'), 'Title here\n\nHeading\nA heat-related risk, 12% in 2024.');
  assert.equal(cleanLlmText('2 * 3 = 6 and snake_case stays'), '2 * 3 = 6 and snake_case stays');
});
await test('llmChat: asks reasoning models for little thinking, and retries with more room when the answer was cut off', async () => {
  seen.bodies.length = 0; mode = 'cut-off-once'; calls = 0;
  const gpt = { ...cfg, model: 'openai/gpt-oss-120b' };
  assert.equal(await llmChat(gpt, 'x', { maxTokens: 1000 }), SOURCE);
  assert.equal(seen.bodies[0].reasoning_effort, 'low');
  assert.deepEqual(seen.bodies.map((b) => b.max_tokens), [1000, 2000]);
});
await test('added quotation marks are removed but the original quotations stay', async () => {
  assert.equal(dropAddedQuotes('Say “drink water” and "we are thrilled" today.', 'He said "we are thrilled".'), 'Say drink water and "we are thrilled" today.');
  const r = await refineWithScoring({ text: 'Sales grew 12% in 2024 for the whole team.', generate: async () => 'Sales grew 12% in 2024, a “big” year for the whole team.', score: () => ({ probability: 0.1 }) });
  assert.ok(r.faithful && r.text.includes('a big year'), r.text);
});
await test('prompt carries required terms and detector feedback', () => {
  const p = humanizePrompt('Hello world.', { required: ['home care'], level: 'Professional' }, { percent: 91, signals: 'Uniform rhythm' });
  assert.ok(p.includes('home care') && p.includes('91%') && p.includes('Uniform rhythm') && p.includes('Do not use contractions'), p);
});
await test('loop retries with feedback until the score is below target', async () => {
  const prompts = [], scores = { A: 0.9, B: 0.7, C: 0.2 }, replies = ['A. 12% 2024', 'B. 12% 2024', 'C. 12% 2024'];
  const r = await refineWithScoring({
    text: 'Original 12% 2024.', generate: async (p) => { prompts.push(p); return replies[prompts.length - 1]; },
    score: (c) => ({ probability: scores[c[0]], signals: ['Uniform rhythm'] }),
  });
  assert.equal(r.attempts, 3); assert.equal(r.text, 'C. 12% 2024'); assert.ok(r.faithful);
  assert.ok(!prompts[0].includes('previous attempt') && prompts[1].includes('previous attempt') && prompts[1].includes('90%'), 'feedback only on retries');
});
await test('loop never prefers an attempt that changed a number over a faithful one', async () => {
  const replies = ['Sales grew 15% in 2024.', 'Sales grew 12% in 2024, roughly.'], scores = [0.05, 0.6];
  let i = 0;
  const r = await refineWithScoring({ text: 'Sales grew 12% in 2024.', maxAttempts: 2, generate: async () => replies[i], score: () => ({ probability: scores[i++] }) });
  assert.equal(r.text, 'Sales grew 12% in 2024, roughly.'); assert.ok(r.faithful);
});
await test('loop treats a rewrite that drops a fifth or more of the words as unfaithful and prefers a complete one', async () => {
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '.';
  const shortened = Array.from({ length: 30 }, (_, i) => `short${i}`).join(' ') + '.', complete = Array.from({ length: 58 }, (_, i) => `full${i}`).join(' ') + '.';
  let i = 0;
  const r = await refineWithScoring({ text: long, maxAttempts: 2, target: 0.01, generate: async () => [shortened, complete][i++], score: (c) => ({ probability: c === shortened ? 0.01 : 0.4 }) });
  assert.equal(r.text, complete); assert.ok(r.faithful);
});
await test('with no faithful attempt, the most complete one is returned, not the lowest-scoring shortened one', async () => {
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '.';
  const short = Array.from({ length: 20 }, (_, i) => `short${i}`).join(' ') + '.', mid = Array.from({ length: 45 }, (_, i) => `mid${i}`).join(' ') + '.';
  let i = 0;
  const r = await refineWithScoring({ text: long, maxAttempts: 2, target: 0.01, minLength: 0.9, generate: async () => [short, mid][i++], score: (c) => ({ probability: c === short ? 0.01 : 0.4 }) });
  assert.equal(r.text, mid); assert.equal(r.faithful, false);
});
await test('loop enforces required terms and stops early when retries stop helping', async () => {
  let i = 0;
  const r = await refineWithScoring({ text: 'Home care matters.', options: { required: ['home care'] }, maxAttempts: 2, generate: async () => ['Care matters.', 'Home care matters.'][i++], score: () => ({ probability: 0.1 }) });
  assert.equal(r.text, 'Home care matters.');
  let n = 0;
  await refineWithScoring({ text: 'Plain 5.', maxAttempts: 6, target: 0.01, generate: async () => (++n, 'Same 5.'), score: () => ({ probability: 0.8 }) });
  assert.ok(n <= 3, `stalled loop ran ${n} attempts`);
});
await test('refineLong: chunks rejoin to the original, and a failing chunk is reported', async () => {
  const longText = Array.from({ length: 400 }, (_, k) => `Paragraph ${k + 1} explains one step. It has a second sentence with a few more words.\n\n`).join('').trimEnd();
  const chunks = chunkText(longText, 500);
  assert.equal(chunks.join(''), longText); assert.ok(chunks.length > 5);
  const r = await refineLong({ text: longText, maxChunkWords: 500, generate: async (p) => p.split('Return only the rewritten text.\n\n')[1].toUpperCase(), score: () => ({ probability: 0.1 }) });
  assert.equal(r.text, longText.toUpperCase());
  await assert.rejects(() => refineLong({ text: longText, maxChunkWords: 500, generate: async () => { throw new Error('boom'); }, score: () => ({ probability: 0.1 }) }), /boom/);
});

// ---- through the real server ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kleza-llm-'));
Object.assign(process.env, { KLEZA_DB_PATH: path.join(dir, 'k.db'), PORT: '0', RATE_LIMIT_PER_MIN: '0', KLEZA_NEURAL: 'off', LLM_PROVIDER: '', LLM_API_KEY: 'secret', LLM_BASE_URL: base, LLM_MODEL: 'test-model', HUMANIZE_TARGET: '0.5', HUMANIZE_MAX_ATTEMPTS: '3' });
const { server, db } = await import('../server.mjs');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
{
  const api = `http://127.0.0.1:${server.address().port}/api`, post = async (p, b) => { const r = await fetch(api + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json() }; };
  await test('server: rewrites through the configured service and reports it in /health', async () => {
    mode = 'normal'; calls = 0;
    const h = await (await fetch(api + '/health')).json(); assert.equal(h.llm, '127.0.0.1'); // no preset named, so the service is named after its host
    const { status, data } = await post('/rewrite', { text: SOURCE, options: { level: 'Natural' } });
    assert.equal(status, 200, JSON.stringify(data)); assert.equal(data.provider, '127.0.0.1'); assert.equal(data.text, SOURCE); // under 30 words the detector gives no score, so the first reply is kept
  });
  await test('server: when the service fails, the built-in editor does the rewrite and says so', async () => {
    mode = 'bad-key';
    const { status, data } = await post('/rewrite', { text: SOURCE, options: { level: 'Natural' } });
    assert.equal(status, 200, JSON.stringify(data)); assert.equal(data.provider, 'Local pattern engine');
    assert.match(data.note, /failed \(Invalid API key\).*built-in editor/);
  });
}

mock.close(); server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
