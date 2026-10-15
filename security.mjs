// Guards for anything that fetches a user-supplied URL, plus rate limiting and an optional access token.
import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

// ---- Private-address blocking (SSRF) -------------------------------------------------------------------
const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(address, prefix, 'ipv6');

/** True for loopback, private, link-local, multicast and other non-public addresses (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (!family) return true; // anything that is not a valid IP is treated as unsafe
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

const allowPrivateByEnv = () => process.env.KLEZA_ALLOW_PRIVATE_URLS === 'true';

/** Validates the URL itself (scheme, credentials, obvious local names, and every address its hostname resolves to). */
export async function assertPublicUrl(value, { allowPrivate = allowPrivateByEnv() } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('That is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only public http or https URLs are supported.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not supported.');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) throw new Error('Local network URLs are not allowed.');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new Error('Private network URLs are not allowed.');
  return url;
}

/**
 * GET a public web page with the protections a plain fetch() lacks: every redirect hop is re-validated, the
 * address actually connected to is checked at connection time (so DNS tricks cannot swap in a private address),
 * only HTML or text is accepted, and the body is size-limited.
 */
export function safeGet(value, { timeoutMs = 12000, maxBytes = 5 * 1024 * 1024, maxRedirects = 5, headers = {}, allowPrivate = allowPrivateByEnv(), xml = false } = {}) {
  const guardedLookup = (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) return callback(new Error('Private network URLs are not allowed.'));
      return options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
    });
  };
  const deadline = Date.now() + timeoutMs;
  const hop = async (target, redirectsLeft) => {
    const url = await assertPublicUrl(target, { allowPrivate });
    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url, { lookup: guardedLookup, headers: { 'User-Agent': 'Mozilla/5.0 KlezaReader/1.0', Accept: xml ? 'application/xml,text/xml;q=0.9,text/plain;q=0.8' : 'text/html,text/plain;q=0.9', 'Accept-Encoding': 'identity', ...headers }, timeout: Math.max(1, deadline - Date.now()) }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('The page redirected too many times.'));
          let next;
          try { next = new URL(res.headers.location, url).href; } catch { return reject(new Error('The page redirected to an invalid address.')); }
          return hop(next, redirectsLeft - 1).then(resolve, reject);
        }
        const type = String(res.headers['content-type'] || 'text/html').toLowerCase();
        if (status < 400 && !(xml ? /^(text\/|application\/(xhtml|xml))/ : /^(text\/|application\/xhtml)/).test(type)) {
          res.resume();
          return reject(new Error(/application\/pdf/.test(type) ? 'That link is a PDF, not a web page. Download it and use "Upload file" instead.' : 'That address is not a web page or text file.'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(new Error('That page is too large to import.')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          // The encoding comes from the HTTP header, else from the page's own <meta charset>, else UTF-8.
          const charset = /charset=([\w-]+)/.exec(type)?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(raw.subarray(0, 4096).toString('latin1'))?.[1] || 'utf-8';
          let body;
          try { body = new TextDecoder(charset).decode(raw); } catch { body = raw.toString('utf8'); }
          resolve({ status, url: url.href, body, type: type.split(';')[0].trim() });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('The page took too long to respond.')));
      req.on('error', reject);
    });
  };
  return hop(value, maxRedirects);
}

// ---- Rate limiting --------------------------------------------------------------------------------------
const HEAVY = /^\/api\/(analyze|rewrite|upload|url|plagiarism|detector\/(train|evaluate|reset))/;

/** In-memory fixed-window limiter. `max` requests per window overall, and `heavyMax` for the costly endpoints. 0 disables it. */
export function rateLimiter({ windowMs = 60000, max = 300, heavyMax = 60 } = {}) {
  const buckets = new Map();
  let lastPrune = Date.now();
  return (req, res, next) => {
    if (!max) return next();
    const now = Date.now();
    if (now - lastPrune > windowMs) { for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k); lastPrune = now; }
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const limits = [['all', max]];
    if (req.method !== 'GET' && HEAVY.test(req.path)) limits.push(['heavy', heavyMax]);
    for (const [name, limit] of limits) {
      const key = `${ip}|${name}`;
      let b = buckets.get(key);
      if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
      if (++b.count > limit) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((b.reset - now) / 1000))));
        return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
      }
    }
    next();
  };
}

// ---- Optional access token ------------------------------------------------------------------------------
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** When a token is configured, every /api route except health requires it. */
export function accessGate(token) {
  return (req, res, next) => {
    if (!token || !req.path.startsWith('/api') || req.path === '/api/health') return next();
    const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-access-token') || '';
    if (crypto.timingSafeEqual(digest(given), digest(token))) return next();
    return res.status(401).json({ error: 'An access token is required.', auth: true });
  };
}
