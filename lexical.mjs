// Detector-guided word swaps. WordNet (the wordnet-db package, read from disk) proposes synonyms for adjectives, adverbs,
// nouns and verbs; GPT-2 (neural.mjs, local) rejects any swap that does not fit its sentence or makes the words after it
// unlikely; and the detector's own score decides how many of the surviving swaps to keep. Nothing leaves this machine.
// Numbers, names and quotations are never touched: only lowercase (or sentence-initial) plain words outside quotation
// marks are eligible, and a word whose part of speech or inflection is uncertain is left alone.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// Found the way Node finds any package, so it works wherever node_modules sits (the project folder or a parent folder).
// Looked up on first use, so a missing package only disables word swaps instead of stopping the whole server.
const dictDir = () => path.join(path.dirname(createRequire(import.meta.url).resolve('wordnet-db/package.json')), 'dict');
const words = (s) => s.split(',');
const SKIP = new Set(words('other,such,many,much,more,most,less,least,only,same,own,first,last,next,few,several,various,certain,able,likely,sure,just,even,also,still,already,again,often,never,always,ever,here,there,then,now,very,quite,rather,really,well,good,best,better,right,left,high,low,long,short,old,young,new,great,little,big,small,large,full,whole,half,real,true,free,open,hard,fast,late,early,far,near,away,back,down,up,off,out,over,under,about,around,once,twice,together,alone,else,too,so,not,no,yes,all,both,each,every,either,neither,any,some,important,key,local,common,general,public,private,major,main,total,final,available,possible,different,similar,special,specific,recent,current,simple,clear,usually,especially,particularly,specifically,generally,mainly,directly,exactly,actually,probably,perhaps,maybe,however,therefore,instead,' +
  'be,have,do,make,get,take,give,go,come,say,see,use,let,put,keep,set,run,know,think,want,need,seem,become,show,tell,ask,try,call,work,help,find,feel,leave,mean,turn,start,move,play,live,hold,bring,begin,write,sit,stand,lose,pay,meet,include,continue,change,follow,stop,create,speak,read,allow,add,spend,grow,open,walk,win,offer,remember,love,consider,appear,buy,wait,serve,die,send,expect,build,stay,fall,cut,reach,kill,remain,' +
  'thing,things,way,ways,time,times,year,years,people,man,woman,child,children,day,days,part,case,point,fact,group,number,area,place,world,life,state,family,system,program,question,government,company,problem,hand,week,month,home,water,room,mother,father,side,head,house,service,friend,power,hour,line,end,member,law,car,city,community,name,president,team,minute,idea,body,information,back,parent,face,level,office,door,health,person,art,war,history,party,result,change,morning,reason,research,girl,guy,moment,air,teacher,force,education'));
const ALPHA = /^[a-z]+$/;
const VOWEL = /[aeiou]/;

let wn = null;
function load() {
  if (wn) return wn;
  const DICT = dictDir();
  const lines = (f) => fs.readFileSync(path.join(DICT, f), 'utf8').split('\n').filter((l) => l && l[0] !== ' ');
  const data = (pos) => { const m = new Map(); for (const l of lines('data.' + pos)) { const t = l.split(' '), n = parseInt(t[3], 16), ws = []; for (let i = 0; i < n; i++) ws.push(t[4 + i * 2].replace(/\(.*\)$/, '').toLowerCase()); m.set(t[0], ws); } return m; };
  const index = (pos) => { const m = new Map(); for (const l of lines('index.' + pos)) { const t = l.split(' '), sc = parseInt(t[2], 10), pc = parseInt(t[3], 10); m.set(t[0], t.slice(4 + pc + 2, 4 + pc + 2 + sc)); } return m; };
  wn = { D: { a: data('adj'), r: data('adv'), n: data('noun'), v: data('verb') }, I: { a: index('adj'), r: index('adv'), n: index('noun'), v: index('verb') } };
  return wn;
}

// ---- inflection: only the regular patterns, and anything doubtful is rejected ----------------------------------------
const plural = (n) => (/[^aeiou]y$/.test(n) ? n.slice(0, -1) + 'ies' : /(?:s|x|z|ch|sh)$/.test(n) ? n + 'es' : n + 's');
const thirdPerson = plural;
const REGULAR_NOUN = (n) => !/(?:f|fe|o|us|is|um|a|on|man|men|ix|ex)$/.test(n);
const ING_OK = (v) => !/(?:ie|ye|ee|oe)$/.test(v) && !/^[^aeiou]*[aeiou][bdgmnprt]$/.test(v); // not die/dye, and no consonant doubling needed
const ing = (v) => (v.endsWith('e') ? v.slice(0, -1) : v) + 'ing';

/** Possible readings of a word: [{ pos: 'n'|'v', lemma, form: 'base'|'s'|'ing' }]. */
function readings(w) {
  const { I } = load(), out = [], add = (pos, lemma, form) => { if (I[pos].has(lemma)) out.push({ pos, lemma, form }); };
  if (w.endsWith('ing') && w.length > 5) { const b = w.slice(0, -3); [b, b + 'e'].forEach((l) => add('v', l, 'ing')); if (b.length > 2 && b.at(-1) === b.at(-2)) add('v', b.slice(0, -1), 'ing'); }
  if (w.endsWith('ies') && w.length > 4) { add('n', w.slice(0, -3) + 'y', 's'); add('v', w.slice(0, -3) + 'y', 's'); }
  else if (/(?:s|x|z|ch|sh)es$/.test(w)) { add('n', w.slice(0, -2), 's'); add('v', w.slice(0, -2), 's'); }
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) { add('n', w.slice(0, -1), 's'); add('v', w.slice(0, -1), 's'); }
  add('n', w, 'base'); add('v', w, 'base');
  return out;
}

/** Same-part-of-speech, same-inflection synonym candidates for a lowercase word, most common senses first. */
export function synonymsFor(word) {
  if (SKIP.has(word) || word.length < 4 || !ALPHA.test(word)) return [];
  const { D, I } = load();
  let pos, lemma, form;
  const adjAdv = (I.a.has(word) ? 'a' : null) || (I.r.has(word) ? 'r' : null);
  if (adjAdv && !I.n.has(word) && !I.v.has(word) && !(I.a.has(word) && I.r.has(word)) && !/(?:ing|ed|er|est)$/.test(word)) { pos = adjAdv; lemma = word; form = 'base'; }
  else {
    const r = readings(word);
    // The reading must be unambiguous: exactly one of noun/verb, and an -ing word must not also be a noun itself.
    const nouns = r.filter((x) => x.pos === 'n'), verbs = r.filter((x) => x.pos === 'v');
    if ((nouns.length && verbs.length) || r.length !== 1) return [];
    ({ pos, lemma, form } = r[0]);
    if (form === 'ing' && I.n.has(word)) return [];
    if (SKIP.has(lemma)) return [];
    if (pos === 'n' && form === 'base' && word !== lemma) return [];
  }
  const out = [];
  for (const off of (I[pos].get(lemma) || []).slice(0, 1)) { // the most common sense only: later senses drift in meaning
    for (const c of D[pos].get(off) || []) {
      if (c === lemma || out.some((x) => x.lemma === c) || !ALPHA.test(c) || c.length < 4 || SKIP.has(c)) continue;
      if (c.slice(0, 4) === lemma.slice(0, 4) || !I[pos].has(c)) continue;
      if (pos === 'n' || pos === 'v') { if ((pos === 'n' ? I.v : I.n).has(c) || I.a.has(c) || I.r.has(c)) continue; } // candidate must be unambiguous too
      else { const other = pos === 'a' ? 'r' : 'a'; if (I.n.has(c) || I.v.has(c) || I[other].has(c) || /(?:ing|ed|er|est)$/.test(c)) continue; if (pos === 'r' && !c.endsWith('ly')) continue; if (pos === 'a' && c.endsWith('ly')) continue; }
      let inflected = c;
      if (form === 's') { if (pos === 'n' && !REGULAR_NOUN(c)) continue; inflected = pos === 'n' ? plural(c) : thirdPerson(c); }
      else if (form === 'ing') { if (!ING_OK(c)) continue; inflected = ing(c); }
      else if (pos === 'n' && /[^aeiou]y$/.test(c) === false && false) continue;
      out.push({ lemma: c, word: inflected });
    }
  }
  return out.slice(0, 4).map((x) => x.word);
}

const QUOTE_RE = /[“"][^”"\n]+[”"]/g;
/** Eligible word sites in `text`: [{ start, end, word, cands }]. */
export function findSites(text) {
  const quoted = []; for (const m of text.matchAll(QUOTE_RE)) quoted.push([m.index, m.index + m[0].length]);
  const sites = [];
  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    const w = m[0], start = m.index, end = start + w.length, prev = text[start - 1] || ' ', next = text[end] || ' ';
    const initialCap = w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase() && (start === 0 || /(?:[.!?]["”’')\]]?\s+|\n\s*)$/.test(text.slice(Math.max(0, start - 8), start)));
    if (w !== w.toLowerCase() && !initialCap) continue;
    if (/[-'’@/\d]/.test(prev) || /[-'’@/\d]/.test(next)) continue; // part of a compound, contraction, address or number
    if (quoted.some(([a, b]) => start >= a && end <= b)) continue;
    const cands = synonymsFor(w.toLowerCase());
    if (!cands.length) continue;
    // "a"/"an" before the word must still agree, or the swap is skipped.
    const art = text.slice(0, start).match(/\b(a|an)\s+$/i);
    const ok = art ? cands.filter((c) => /^[aeiou]/i.test(c) === /^[aeiou]/i.test(w)) : cands;
    if (ok.length) sites.push({ start, end, word: w, cands: ok });
  }
  return sites;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const withCase = (orig, rep) => (orig[0] === orig[0].toUpperCase() ? cap(rep) : rep);
function applyChoices(text, choices) {
  let out = text;
  for (const c of [...choices].sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + withCase(c.word, c.replacement) + out.slice(c.end);
  return out;
}

/**
 * Swap words for fitting synonyms until the detector scores the text below `target`, using as few swaps as that
 * takes. `fit(paragraph, [{start, words, after}])` returns GPT-2 log-probabilities (see neural.mjs), and
 * `score(text)` the detector's AI probability; without `score`, a fixed share of the swaps is applied.
 */
export async function humanizeLexical(text, { fit, score, target = 0.3, delta = 2.5, followCost = 2, share = 0.6, fractions = [0.4, 0.7, 1], minWords = 25, protect = [], budgetMs = 90000, signal } = {}) {
  const parts = text.split(/(\n\s*\n|\n)/); // paragraphs and their separators
  const choices = [], deadline = Date.now() + budgetMs, keep = protect.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
  let base = 0, usable = false;
  for (const part of parts) {
    signal?.throwIfAborted();
    if (Date.now() < deadline && !/^\s*$/.test(part) && (part.match(/\S+/g) || []).length >= minWords) {
      // Words inside a term the caller wants kept as written (keywords, required terms) are never swapped.
      const low = part.toLowerCase(), guarded = [];
      for (const k of keep) for (let i = low.indexOf(k); i >= 0; i = low.indexOf(k, i + k.length)) guarded.push([i, i + k.length]);
      const sites = findSites(part).filter((s) => !guarded.some(([a, b]) => s.start < b && s.end > a));
      const rows = sites.length ? await fit(part, sites.map((s) => ({ start: s.start, words: [s.word.toLowerCase(), ...s.cands], after: s.end }))) : [];
      if (rows) usable = usable || sites.length > 0;
      const local = [];
      sites.forEach((s, i) => {
        const row = rows?.[i];
        if (!row || !Number.isFinite(row[0])) return;
        // Plausible = about as likely here as the original word; of those, take the least predictable (that is what reads less like a model).
        const ok = s.cands.map((c, j) => ({ c, lp: row[j + 1] })).filter((x) => x.lp >= row[0] - delta && x.lp > -13).sort((a, b) => a.lp - b.lp);
        if (ok.length) local.push({ start: s.start, end: s.end, word: s.word, replacement: ok[0].c, before: row.next });
      });
      if (local.length) {
        // Second check: with every swap in place, the words right after each swap must still be about as likely as before.
        let kept = local;
        const swapped = applyChoices(part, local); let shift = 0;
        const sitesAfter = local.map((c) => { const start = c.start + shift, len = c.replacement.length; shift += len - (c.end - c.start); return { start, words: [c.replacement], after: start + len }; });
        const vrows = await fit(swapped, sitesAfter);
        if (vrows) kept = local.filter((c, i) => vrows[i] == null || c.before == null || vrows[i].next == null || vrows[i].next <= c.before + followCost);
        for (const c of kept) choices.push({ ...c, start: base + c.start, end: base + c.end });
      }
    }
    base += part.length;
  }
  if (!choices.length) return { text, changes: 0, before: null, after: null, note: usable ? 'No swap fit its sentence.' : 'No eligible words, or the language model is not ready.' };
  // Spread the swaps evenly through the text for every fraction tried.
  const order = choices.map((c, i) => ({ c, k: (i * 0.6180339887) % 1 })).sort((a, b) => a.k - b.k).map((x) => x.c);
  const count = (f) => Math.max(1, Math.round(order.length * f));
  const build = (f) => applyChoices(text, order.slice(0, count(f)));
  if (!score) return { text: build(share), changes: count(share), before: null, after: null, available: order.length };
  const before = await score(text);
  let best = { text, p: before, changes: 0 };
  for (const f of fractions) {
    signal?.throwIfAborted();
    if (best.changes && Date.now() > deadline + 30000) break; // out of time: keep the best so far
    const t = build(f), p = await score(t);
    if (p != null && (best.p == null || p < best.p)) best = { text: t, p, changes: count(f) };
    if (p != null && p < target) break;
  }
  return { text: best.text, changes: best.changes, before, after: best.p, available: order.length };
}
