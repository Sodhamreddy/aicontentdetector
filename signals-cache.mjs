// Pre-computed neural signals (a RAID-trained classifier plus GPT-2 word predictability, see neural.mjs) for the
// bundled training corpus (detector/neural-cache.json), keyed by a hash of each text. Training the combined
// detector needs these signals for every English sample; computing them takes about a second per text, so they
// are shipped instead of being recomputed at every start.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { signalsFromArray } from './neural.mjs';

export const cacheFile = (dir) => path.join(dir, 'detector', 'neural-cache.json');

export function loadSignalsCache(dir) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8')).data || {}; } catch { /* no cache: style-only model */ }
  const keys = Object.keys(data).sort();
  // The salt must change whenever the cached VALUES change, not just which texts are covered - otherwise a saved
  // model trained on a since-corrected (or since-corrupted) cache would keep being reused forever, because the key
  // set alone can stay identical across a content fix. Hashing each key together with its value catches that.
  const salt = keys.length ? crypto.createHash('sha256').update(keys.map((k) => `${k}:${data[k].join(',')}`).join('\n')).digest('hex').slice(0, 12) : '';
  return {
    size: keys.length, salt,
    signalsFor: (text) => { const a = data[crypto.createHash('sha1').update(text).digest('hex')]; return a ? signalsFromArray(a) : null; },
  };
}
