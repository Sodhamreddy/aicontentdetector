// Pulls the readable article out of a web page for the "From URL" import: finds the main content block (not the menus,
// sidebars, comments, related links or cookie notices), keeps headings and paragraphs in order, and works out a clean
// title, author, date and site name. Pure function over the HTML string, so it is easy to test.
import * as cheerio from 'cheerio';

const NOISE_TAGS = 'script,style,noscript,template,iframe,svg,canvas,form,button,select,input,textarea,nav,footer,aside,dialog,audio,video,picture,figure img,.sr-only,'
  + 'sup.reference,.mw-editsection,.noprint,.navbox,.infobox,.reflist,.references,.mw-references-wrap,.catlinks,.hatnote,.thumbcaption,.printfooter,.toc,#toc,.sidebar,.vector-toc,[class*="cookie"],[id*="cookie"]';
const NOISE_ROLES = '[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=dialog],[role=search],[role=alert],[hidden],[aria-hidden=true]';
// Class/id words that mark page furniture. An element is dropped only if it also does not look like the article body.
const NOISE_WORDS = /(?:^|[\s_-])(?:comments?|respond|sidebar|side-?bar|menu|masthead|banner|promo|advert\w*|ads?|sponsor\w*|related|recommend\w*|share|sharing|social|cookie\w*|consent|gdpr|popup|modal|newsletter|subscribe|subscription|breadcrumbs?|pagination|pager|widget|toolbar|search|login|signup|signin|paywall|outbrain|taboola|footer|byline-?bio|author-?bio|tags?|toc|skip)(?:$|[\s_-])/i;
const BODY_WORDS = /article-?body|entry-?content|post-?content|story-?body|article-?content|post-?body|main-?content|content-?body|prose|markdown-body|mw-parser-output|td-post-content|rich-?text/i;
const POSITIVE = /article|content|post|entry|story|text|prose|blog|page|body|main/i;
const BOILERPLATE = /^(?:share(?: this)?|tweet|follow us|read more|read next|related(?: articles| posts)?|advertisement|sponsored|sign up|subscribe|click here|all rights reserved|©|copyright|cookies?|privacy policy|terms of|skip to|back to top|previous|next|leave a comment|posted in|filed under|tags?:|categories?:|you may also like|more from|recommended)\b/i;

/** "example.com/page" -> "https://example.com/page"; an address that already has a scheme is left alone. */
export const withScheme = (s) => { const a = String(s || '').trim(); return a && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a) ? 'https://' + a : a; };

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const words = (s) => (s.match(/[\p{L}\p{N}’'-]+/gu) || []).length;
const meta = ($, ...names) => { for (const n of names) { const v = clean($(`meta[property="${n}"],meta[name="${n}"]`).first().attr('content')); if (v) return v; } return ''; };

/** "Headline | Site Name" -> "Headline": drop a trailing site name, keeping the longer, headline-like part. */
export function cleanTitle(raw, siteName = '', pageUrl = '') {
  let t = clean(raw);
  if (!t) return '';
  // "Photosynthesis - Wikipedia": a hyphen is also used inside headlines, so only strip it when the tail names the site (here, the host).
  const hostLabel = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, '').split('.').slice(-2, -1)[0] || ''; } catch { return ''; } })().toLowerCase();
  const tail = / [-–—] ([^-–—]{2,40})$/.exec(t);
  if (hostLabel && tail && (tail[1].toLowerCase().replace(/[^a-z0-9]/g, '').includes(hostLabel) || hostLabel.includes(tail[1].toLowerCase().replace(/[^a-z0-9]/g, '')))) t = t.slice(0, tail.index).trim();
  if (siteName) { const s = siteName.toLowerCase(); for (const sep of [' | ', ' – ', ' — ', ' - ', ' · ', ' :: ', ' » ']) { if (t.toLowerCase().endsWith(sep + s)) return t.slice(0, -(sep + siteName).length).trim(); if (t.toLowerCase().startsWith(s + sep)) return t.slice((s + sep).length).trim(); } }
  const parts = t.split(/ [|–—·»] | :: /).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) { const longest = parts.reduce((a, b) => (b.length > a.length ? b : a)); if (longest.length >= 15) return longest; }
  return t;
}

const linkDensity = ($, el) => { const total = clean($(el).text()).length; if (!total) return 0; let links = 0; $(el).find('a').each((_, a) => { links += clean($(a).text()).length; }); return links / total; };
const idClass = (el) => `${el.attribs?.class || ''} ${el.attribs?.id || ''}`;

export function extractArticle(html, pageUrl = '') {
  const $ = cheerio.load(String(html || ''));
  const host = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const siteName = meta($, 'og:site_name', 'application-name') || '';
  const jsonLd = (() => { for (const el of $('script[type="application/ld+json"]').toArray()) { try { const d = JSON.parse($(el).contents().text()); for (const x of Array.isArray(d) ? d : d['@graph'] || [d]) if (/Article|BlogPosting|NewsArticle|Report/i.test([].concat(x?.['@type'] || []).join(','))) return x; } catch { /* not JSON */ } } return null; })();
  const author = clean(meta($, 'author', 'article:author', 'og:article:author') || (typeof jsonLd?.author === 'string' ? jsonLd.author : [].concat(jsonLd?.author || [])[0]?.name) || '');
  const published = clean(meta($, 'article:published_time', 'og:article:published_time', 'date', 'pubdate') || jsonLd?.datePublished || $('time[datetime]').first().attr('datetime') || '');
  const description = meta($, 'og:description', 'description', 'twitter:description');
  const warnings = [];

  $(NOISE_TAGS).remove();
  $(NOISE_ROLES).remove();
  $('header').each((_, el) => { if (!$(el).closest('article,main,[role=main]').length) $(el).remove(); }); // keep a header that holds the article's own title
  const bodyLen = clean($('body').text()).length || 1;
  $('body *').each((_, el) => {
    const s = idClass(el);
    if (s.trim() && NOISE_WORDS.test(s) && !BODY_WORDS.test(s) && clean($(el).text()).length < bodyLen * 0.4) $(el).remove();
  });

  // ---- find the main block: score each container by the paragraph text under it, less its link density ----
  const scores = new Map(), bump = (el, v) => { if (el && el.type === 'tag') scores.set(el, (scores.get(el) || 0) + v); };
  // List items are not scored: reference lists and link lists would otherwise outscore the article's own paragraphs. Table cells count
  // only on old table-layout pages that have almost no <p> at all.
  const tableLayout = $('p').filter((_, p) => clean($(p).text()).length >= 30).length < 3;
  $(tableLayout ? 'p, pre, blockquote, td' : 'p, pre, blockquote').each((_, p) => {
    const text = clean($(p).text());
    if (text.length < 30) return;
    const v = 1 + (text.match(/[,;.]/g) || []).length + Math.min(Math.floor(text.length / 100), 4);
    bump(p.parent, v); bump(p.parent?.parent, v / 2);
  });
  let best = null, bestScore = 0;
  for (const [el, raw] of scores) {
    const s = idClass(el), weight = (BODY_WORDS.test(s) ? 30 : POSITIVE.test(s) ? 8 : 0) - (NOISE_WORDS.test(s) ? 20 : 0) + (el.name === 'article' ? 25 : el.name === 'main' || el.attribs?.role === 'main' ? 15 : 0);
    const score = (raw + weight) * (1 - Math.min(0.9, linkDensity($, el)));
    if (score > bestScore) { best = el; bestScore = score; }
  }
  // A container that is only one column of a wider article (e.g. a <div> around part of the text): widen to the parent when the parent holds mostly the same text.
  while (best && best.parent && best.parent.type === 'tag' && !['body', 'html'].includes(best.parent.name)) {
    const here = clean($(best).text()).length, up = clean($(best.parent).text()).length;
    if (up > 0 && here / up > 0.8 && !NOISE_WORDS.test(idClass(best.parent))) best = best.parent; else break;
  }
  // If the page itself marks an <article> or <main> around that block, the whole element is the content (the best block may be one section of it).
  if (best) { const marked = $(best).closest('article, main, [role=main]')[0]; if (marked && marked !== best && linkDensity($, marked) < 0.35) best = marked; }
  const root = best ? $(best) : $('body');

  // ---- collect blocks in reading order ----
  // The page's own title (social title first, then <title>) is what people expect; the first <h1> is only the fallback.
  const title = cleanTitle(meta($, 'og:title', 'twitter:title') || $('title').first().text() || clean($('h1').first().text()), siteName, pageUrl);
  const seen = new Set(), blocks = [];
  root.find('h1,h2,h3,h4,p,li,blockquote,pre').each((_, el) => {
    const tag = el.name, text = clean($(el).text());
    if (!text || seen.has(text)) return;
    if (tag === 'blockquote' && $(el).find('p').length) return; // its paragraphs are collected on their own
    if (tag === 'li' && $(el).find('p').length) return;
    if (/^h[1-4]$/.test(tag)) {
      if (text.length < 3 || text.length > 140 || (tag === 'h1' && (title.includes(text) || text.includes(title))) || linkDensity($, el) > 0.6 || BOILERPLATE.test(text)) return;
      seen.add(text); blocks.push(text); return;
    }
    if (text.length < 25 || BOILERPLATE.test(text) || linkDensity($, el) > (tag === 'li' ? 0.35 : 0.6)) return;
    seen.add(text); blocks.push(text);
  });
  let text = blocks.join('\n\n');
  let source = best ? 'article' : 'page';

  // Old-style pages (text in <font>/<br> runs instead of <p>): fall back to the container's raw text, split at line breaks.
  if (text.length < 300) {
    const holder = (best ? $(best) : $('body')).clone();
    holder.find('br').replaceWith('\n'); holder.find('p,div,tr,li,h1,h2,h3,h4').each((_, e) => { $(e).append('\n'); });
    const raw = holder.text().split(/\n\s*\n+|\n{2,}/).map(clean).filter((x) => x.length >= 25 && !BOILERPLATE.test(x));
    const alt = [...new Set(raw)].join('\n\n');
    if (alt.length > text.length) { text = alt; source = 'text-runs'; }
  }
  if (words(text) < 40) warnings.push('Very little text was found. The page may be built with JavaScript, need a login, or sit behind a paywall.');
  else if (best && linkDensity($, best) > 0.35) warnings.push('This page is mostly links, so the import may include menu or list text. Check it before using it.');

  return {
    title: title || host || 'Imported page', text,
    metadata: { url: pageUrl, siteName: siteName || host, author, published, description, words: words(text), extractor: source },
    warnings,
  };
}
