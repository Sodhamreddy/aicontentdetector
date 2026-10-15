// Unit tests for the built-in humanizer (no external AI service is used).
// Run: node tests/humanizer.test.mjs
import assert from 'node:assert/strict';
import { humanize, humanizeSpan, humanizeGuided } from '../humanizer.mjs';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } };

const SOURCE = 'Sales grew 12% in 2024, and the team said "we are thrilled". It is important to note that home care matters.';

await test('local rewrite keeps numbers and quotations', () => {
  const out = humanize(SOURCE);
  assert.ok(out.includes('12%') && out.includes('2024') && out.includes('"we are thrilled"'), out);
});
await test('local rewrite removes stock phrases and formal openers', () => {
  const out = humanize('Furthermore, businesses leverage cutting-edge tools. Moreover, it is crucial to plan.');
  assert.ok(!/furthermore|moreover|leverage|cutting-edge/i.test(out), out);
  assert.match(out, /^Businesses use modern tools/);
});
await test('phrase swaps keep the verb form', () => {
  assert.match(humanize('By harnessing the power of data, we win.'), /By using data/);
  assert.match(humanize('Teams that harness the power of data win.'), /use data/);
  assert.match(humanize('Navigating the complexities of tax law is hard.'), /Dealing with tax law/);
});
await test('a/an follows the replacement word', () => {
  assert.match(humanize('This is an innovative plan.'), /a new plan/);
  assert.match(humanize('It is a seamless fit.'), /a smooth fit/);
});
await test('Professional level does not add contractions; Natural does', () => {
  assert.match(humanize('It is a plan that will not fail.', { level: 'Natural' }), /It's a plan that won't fail/);
  assert.match(humanize('It is a plan that will not fail.', { level: 'Professional' }), /It is a plan that will not fail/);
});
await test('span rewrite leaves surrounding text and spacing untouched', () => {
  const text = 'Keep this. We leverage tools daily. Keep that.';
  const start = text.indexOf('leverage'), end = start + 'leverage'.length;
  assert.equal(humanizeSpan(text, start, end), 'Keep this. We use tools daily. Keep that.');
});
await test('Light level only swaps stock phrasing: no contractions, no sentence changes', () => {
  const src = 'It is important to note that we do not leverage tools. The plan is long and it has many parts, and each part matters to the team.';
  const out = humanize(src, { level: 'Light' });
  assert.ok(!/leverage/.test(out) && !/'/.test(out), out);
  assert.ok(out.includes('The plan is long and it has many parts, and each part matters to the team.'), out);
});
await test('guided rewrite never changes numbers or quotations and respects its time budget', () => {
  const para = 'The team grew 12% in 2024, and it said "we are thrilled". The plan is long and it has many parts, and each part matters to the whole team and the budget.';
  const t0 = Date.now();
  const out = humanizeGuided(para, { level: 'Natural', budgetMs: 200, score: (t) => t.length });
  assert.ok(out.includes('12%') && out.includes('2024') && out.includes('"we are thrilled"'), out);
  assert.ok(Date.now() - t0 < 2000);
});

// ---- lexical.mjs: detector-guided word swaps (the language-model and detector are faked here) ----
import { synonymsFor, findSites, humanizeLexical } from '../lexical.mjs';
const PARA = 'The team reported 12% growth in 2024 and said "we quickly realized the results". We quickly noticed how the group responds to every change, and the plan keeps improving over time for the whole community.';
await test('lexical: synonyms keep the part of speech and the inflection', () => {
  assert.ok(synonymsFor('quickly').every((w) => w.endsWith('ly')), synonymsFor('quickly').join());
  assert.ok(synonymsFor('noticing').every((w) => w.endsWith('ing')), synonymsFor('noticing').join());
  assert.deepEqual(synonymsFor('the'), []); assert.deepEqual(synonymsFor('make'), []);
});
await test('lexical: numbers, quotations, compounds and contractions are never eligible', () => {
  const sites = findSites('It is 5th in a well-known list, "quickly said" and don\'t quickly go.');
  assert.deepEqual(sites.map((s) => s.word), ['quickly']);
});
await test('lexical: only fitting swaps are applied, and numbers, quotations and protected terms stay as written', async () => {
  const fit = async (para, sites) => sites.map((s) => Object.assign(s.words.map((w, j) => (j === 0 ? -3 : -3.5)), { next: 2 }));
  const res = await humanizeLexical(PARA, { fit, protect: ['group'], share: 1 });
  assert.ok(res.changes > 0 && res.text !== PARA);
  assert.ok(res.text.includes('12%') && res.text.includes('2024') && res.text.includes('"we quickly realized the results"'), res.text);
  assert.ok(res.text.includes('the group responds') || res.text.includes('the group'), res.text);
  const none = await humanizeLexical(PARA, { fit: async (p, sites) => sites.map((s) => Object.assign(s.words.map((w, j) => (j === 0 ? -2 : -9)), { next: 2 })), share: 1 });
  assert.equal(none.changes, 0); assert.equal(none.text, PARA);
});
await test('lexical: uses as few swaps as the target needs, and rejects swaps that break the words after them', async () => {
  const fit = async (p, sites) => sites.map((s) => Object.assign(s.words.map((w, j) => (j === 0 ? -3 : -3.2)), { next: 2 }));
  let calls = 0;
  const res = await humanizeLexical(PARA, { fit, score: async (t) => { calls++; return t === PARA ? 0.9 : 0.1; }, target: 0.3, fractions: [0.4, 0.7, 1] });
  assert.ok(res.after < 0.3 && calls <= 3, `calls ${calls}`);
  const breaking = async (p, sites) => sites.map((s) => Object.assign(s.words.map((w, j) => (j === 0 ? -3 : -3.2)), { next: s.words.length === 1 ? 9 : 1 })); // after a swap the next words become very unlikely
  const rej = await humanizeLexical(PARA, { fit: breaking, share: 1 });
  assert.equal(rej.changes, 0);
});

console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
