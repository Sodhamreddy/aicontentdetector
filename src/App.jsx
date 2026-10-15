import React, { useEffect, useRef, useState } from "react";
import { api, copyText, countWords, downloadBlob, downloadDocx, level, MAX_WORDS, MIN_WORDS, postJson, safeName, setToken, titleFrom, tone } from "./lib.js";
import { Gauge, Highlighted, Icon, LEVEL_NAME } from "./parts.jsx";
import Library from "./pages/Library.jsx";
import Reports from "./pages/Reports.jsx";

const SAMPLE =
  "Vaccines work by training the immune system to recognize and fight specific pathogens without causing the disease itself. When a vaccine is administered, it introduces a harmless piece or weakened form of the germ, which prompts the body to produce antibodies. These antibodies remain in the system, allowing it to respond quickly if the real pathogen is encountered later. Vaccines have played a crucial role in eradicating diseases such as smallpox and significantly reducing the spread of others, including polio and measles. It is important to note that vaccines are rigorously tested for safety and effectiveness before they are approved for public use.";

const NAV = [
  ["detect", "AI Detector", "doc"], ["humanize", "Humanizer", "pen"], ["plagiarism", "Plagiarism Checker", "plagiarism"],
  ["library", "My Content", "folder"], ["reports", "Reports", "chart"],
];
const LEVELS = [
  ["Light", "Minimal edits"], ["Natural", "Conversational"], ["Professional", "Polished"], ["Brand Voice", "Your style"],
];
const FAQ = [
  ["How does the detector decide?", "It combines three kinds of evidence. Writing style: how much sentence length varies, stock phrases and buzzwords, contractions, word-choice habits and more. A trained classifier: a RoBERTa model trained directly to tell AI from human text across many AI generators (the RAID benchmark) — the same kind of trained classifier that commercial detectors use. Word predictability: a language model running on this machine measures how surprising each word is, since AI-written text tends to be more predictable. Both neural models run locally, not in the cloud. A calibrated statistical model turns all three into a probability, and each sentence is scored in context so you can see where the signal comes from."],
  ["How accurate is it?", "On held-out English text it was right about 94% of the time on ChatGPT-style answers and about 89% on a mixed set of essays, abstracts and other AI generators. When it says “Likely AI-generated” (80% or higher) it was right 95–98% of the time, so rely on that verdict rather than the raw 50% line, which still flags roughly 8–10% of human writing. It works best on text over 80 words, and it is weaker on scientific abstracts, very formal writing, AI models newer than roughly mid-2024, and edited or humanized text. English only."],
  ["Can it be wrong?", "Yes. Human writing can score high and edited AI text can score low. Treat a score as one signal, never as proof of who wrote something, and don’t use it alone to accuse anyone."],
  ["How does the plagiarism check work?", "It looks for runs of 8 or more words that are exactly the same, ignoring case, punctuation and spacing, in the sources you choose: Wikipedia (searched with your most distinctive sentences), pages you list, your own saved texts and history, and, if you set up a free search key on the server, the first web results for those sentences. It finds copied and lightly edited text. It can also flag sentences that say the same thing in other words (a sentence model running on this machine compares meanings); these are possible matches, listed apart from the exact percent. It cannot find translated copying, text behind a login or paywall, or sources it never reads, so a clean result does not prove a text is original. Quoted passages are shown separately and not counted. The text you check is not sent to a plagiarism service: only a few short phrases go to Wikipedia or to your search provider."],
  ["How does the humanizer work?", "It runs on this machine. It drops stock phrases, uses plainer words and contractions, varies sentence rhythm, and swaps some words for close synonyms that fit their sentence, keeping only as many swaps as the detector's score needs. That can lower the score but only moderately, because the trained detector reads deeper patterns of wording, and it takes about a minute for a long text. For a bigger change, rewrite the highlighted sentences in your own words. Numbers, names, keywords and quotations are kept."],
];

function Signals({ detection }) {
  const up = detection.towardAI || [], down = detection.towardHuman || [];
  if (!up.length && !down.length) return null;
  return (
    <div className="signals">
      {up.length > 0 && <div><h4>Pushed the score up</h4><ul>{up.map((s) => <li key={s.label}>{s.label}</li>)}</ul></div>}
      {down.length > 0 && <div><h4>Pushed the score down</h4><ul>{down.map((s) => <li key={s.label}>{s.label}</li>)}</ul></div>}
    </div>
  );
}

const readability = (n) => (n >= 70 ? "easy to read" : n >= 50 ? "fairly easy" : n >= 30 ? "difficult" : "very difficult");

function Issues({ result, onFix, busy }) {
  const [all, setAll] = useState(false);
  const issues = result.issues || [];
  const shown = all ? issues : issues.slice(0, 8);
  return (
    <>
      <h3>Writing patterns</h3>
      <p className="muted">
        {issues.length ? `${issues.length} phrasing issue${issues.length > 1 ? "s" : ""} found` : "No stock phrasing found"} · readability {result.readability}/100 ({readability(result.readability)}, {result.readabilityFormula})
      </p>
      {issues.length > 0 && (
        <ul className="issues">
          {shown.map((i) => (
            <li key={i.id} className="issue">
              <div className="issue-top"><span className={`sev ${i.severity.toLowerCase()}`}>{i.severity}</span><b>{i.type}</b></div>
              <blockquote>“{i.excerpt.slice(0, 120)}{i.excerpt.length > 120 ? "…" : ""}”</blockquote>
              <p className="muted">{i.suggestion}</p>
              <button className="btn small" disabled={busy} onClick={() => onFix(i)}>Fix this</button>
            </li>
          ))}
        </ul>
      )}
      {issues.length > 8 && <button className="link" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${issues.length}`}</button>}
    </>
  );
}

// Explains which model is scoring, so a score that changes once the extra model finishes loading is not a surprise.
function NeuralNotice({ neural }) {
  if (!neural || neural.status === "ready" || neural.status === "disabled" || neural.status === "idle") return null;
  if (neural.status === "unavailable")
    return <p className="notice">The extra accuracy model is not available, so scores use the basic writing-style model only. {neural.error}</p>;
  return (
    <p className="notice" role="status">
      The extra accuracy model is loading. Until it is ready, scores use the basic writing-style model and may change afterwards.
    </p>
  );
}

const strength = (p) => (p >= 80 ? "High" : p >= 60 ? "Moderate" : "Unclear");
const jumpTo = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
};

// Right-hand panel of the detector: the score, and the sentences that most look like AI (click one to find it in the text).
function ScorePanel({ result, busy, onHumanize, notify }) {
  if (busy) return (
    <aside className="card score-panel" aria-live="polite">
      <div className="skeleton round" /><div className="skeleton line" /><div className="skeleton line short" /><div className="skeleton block" />
      <p className="muted panel-empty" role="status">Analyzing your text…</p>
    </aside>
  );
  if (!result) return (
    <aside className="card score-panel" aria-live="polite">
      <h2 className="panel-title">How it works</h2>
      <ol className="steps">
        <li><i className="step-ico"><Icon name="doc" size={20} /></i><b>Paste or load a text</b><span>Type, paste, upload a file or import a page. 80 words or more gives the best estimate.</span></li>
        <li><i className="step-ico"><Icon name="search" size={20} /></i><b>Press Check for AI</b><span>You get a percentage, a verdict and how sure the detector is.</span></li>
        <li><i className="step-ico"><Icon name="list" size={20} /></i><b>Review the highlights</b><span>The sentences that look most like AI are marked, with a one-click fix for each writing issue.</span></li>
      </ol>
      <div className="formats"><i className="f-ico blue"><Icon name="doc" size={20} /></i><div><b>Supported formats</b><span>TXT, DOC, DOCX, PDF and web page addresses.</span></div></div>
    </aside>
  );
  const d = result.detection;
  if (d.probability == null) return <aside className="card score-panel" aria-live="polite"><p className="notice">{d.confidenceReason}</p></aside>;
  const scored = (result.sentenceSignals || []).filter((s) => s.aiProbability != null);
  const flagged = scored.filter((s) => s.aiProbability >= 40);
  const top = [...flagged].sort((a, b) => b.aiProbability - a.aiProbability).slice(0, 5);
  const human = 100 - d.percent;
  return (
    <aside className="card score-panel" aria-live="polite">
      <div className="score-head">
        <div className={`donut ${tone(d.percent)}`} style={{ "--p": d.percent }}>
          <div className={`big-score ${tone(d.percent)}`}><b>{d.percent}</b><span>%</span></div>
        </div>
        <div>
          <h2 className={`verdict ${tone(d.percent)}`}>{d.verdict}</h2>
          <p className="muted">of the text is likely AI</p>
        </div>
      </div>
      <ul className="split" aria-label="Score breakdown">
        <li><span className="dot ai" />AI-generated<b>{d.percent}%</b></li>
        <li><span className="dot human-dot" />Human-written<b>{human}%</b></li>
      </ul>
      <div className="bar" role="img" aria-label={`${d.percent} percent AI, ${human} percent human`}><i className={tone(d.percent)} style={{ width: `${d.percent}%` }} /></div>
      {scored.length > 1 && (
        <div className="heat" role="img" aria-label="Sentence by sentence AI likelihood">
          {scored.map((s) => <i key={s.start} className={`${tone(s.aiProbability)} lvl-${level(s.aiProbability)}`} style={{ flexGrow: Math.max(1, s.end - s.start) }} title={`${s.aiProbability}% AI`} />)}
        </div>
      )}
      <p className="meta">
        <span className={`pill conf-${d.confidence.toLowerCase()}`}>{d.confidence} confidence</span>
        {result.language} · {result.words.toLocaleString()} words
      </p>
      <p className="muted">{d.confidenceReason}</p>
      {result.scoringMode === 'style-only' && <p className="notice">Scored with the style-only model because the neural models were not available. It is less accurate; re-run the check once they have loaded.</p>}
      {result.classifierPercent != null && <p className="muted">Trained classifier on its own: {result.classifierPercent}% AI.</p>}
      {scored.length > 0 && <p className="muted">{flagged.length} of {scored.length} sentences flagged. Highlighted in the text.</p>}

      <h3>Your most AI sentences</h3>
      {top.length ? (
        <ul className="top-sentences">
          {top.map((s) => (
            <li key={s.start}>
              <button onClick={() => jumpTo(`sent-${s.start}`)} aria-label="Show this sentence in the text">
                <span className="ts-top"><span className={`sev lvl-${level(s.aiProbability)}`}>{LEVEL_NAME[level(s.aiProbability)]} confidence</span><small>{s.aiProbability}% AI</small></span>
                <span className="ts-text">{result.text.slice(s.start, s.end).trim()}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="muted">No sentence reads strongly like AI.</p>}

      <ul className="legend" aria-label="Highlight legend">
        <li><mark className="ai lvl-high">High</mark><small>80%+</small></li>
        <li><mark className="ai lvl-med">Medium</mark><small>60–79%</small></li>
        <li><mark className="mixed lvl-low">Low</mark><small>40–59%</small></li>
        <li><span className="plain">Reads human</span><small>&lt;40%</small></li>
      </ul>
      <div className="actions">
        <button className="btn primary" onClick={onHumanize}>Humanize this text →</button>
        <button className="btn" onClick={async () => {
          const lines = [`AI likelihood: ${d.percent}% (${d.verdict}, ${d.confidence} confidence)`, `${result.words} words · ${flagged.length} of ${scored.length} sentences flagged`,
            ...top.map((s) => `- ${s.aiProbability}%: ${result.text.slice(s.start, s.end).trim()}`)];
          await copyText(lines.join("\n")); notify("Summary copied");
        }}>Copy summary</button>
      </div>
    </aside>
  );
}

// Below the workspace: what moved the score, phrasing issues, and the caveat.
function DetectionDetails({ result, onFix, busy }) {
  const d = result.detection;
  if (d.probability == null) return null;
  return (
    <section className="card result" aria-live="polite">
      {d.mode && <p className="muted">Scored with: {d.mode}</p>}
      <Signals detection={d} />
      <Issues result={result} onFix={onFix} busy={busy} />
      <p className="disclaimer">{d.disclaimer}</p>
    </section>
  );
}

function HumanizeResult({ result, original, output, setOutput, title, setTitle, onCheck, onRetry, onSave, notify }) {
  return (
    <section className="card result" aria-live="polite">
      <div className="verdict-text">
        <h2>Humanized text</h2>
        {result.aiBefore != null && result.aiAfter != null && (
          <p className="score-change">AI likelihood <b className={tone(result.aiBefore)}>{result.aiBefore}%</b> → <b className={tone(result.aiAfter)}>{result.aiAfter}%</b></p>
        )}
        <p className="muted">Edited with: {result.provider}</p>
      </div>
      {result.note && <p className="notice">{result.note}</p>}
      <label className="sr-only" htmlFor="output">Humanized text (editable)</label>
      <textarea id="output" className="output" value={output} onChange={(e) => setOutput(e.target.value)} rows={10} />
      <div className="save-row">
        <label className="sr-only" htmlFor="title">Title</label>
        <input id="title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        <button className="btn" onClick={onSave}>Save to My Content</button>
      </div>
      <div className="actions">
        <button className="btn primary" onClick={async () => { await copyText(output); notify("Copied"); }}>Copy</button>
        <button className="btn" onClick={() => downloadBlob(new Blob([output], { type: "text/plain" }), `${safeName(title)}.txt`)}>Download .txt</button>
        <button className="btn" onClick={() => downloadDocx(output, title).catch((e) => notify(e.message))}>Download .docx</button>
        <button className="btn" onClick={onCheck}>Check for AI</button>
        <button className="btn ghost" onClick={onRetry}>Try again</button>
      </div>
      <details className="checks">
        <summary>Quality checks</summary>
        <ul>
          {result.checks.map((c) => (
            <li key={c.name}><span className={`dot ${c.status === "Passed" ? "ok" : "warn"}`} aria-hidden="true" /><b>{c.name}</b>: {c.status === "Passed" ? "Passed" : "Needs a quick look"} — {c.detail}</li>
          ))}
        </ul>
      </details>
      <details className="checks">
        <summary>Original text</summary>
        <p className="highlighted">{original}</p>
      </details>
    </section>
  );
}

// ---- Plagiarism check ----------------------------------------------------------------------------------------------------------
// Right-hand panel: which sources to read. Wikipedia needs no setup; web search needs a free key on the server (see .env.example).
function PlagiarismPanel({ opts, setOpts, search, busy }) {
  const set = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  const webOn = !!search && opts.web;
  const selected = [opts.wikipedia, opts.scholar, webOn, opts.library, opts.paraphrase].filter(Boolean).length;
  // One source row: tick box, a coloured icon and what it does (a plain function, not a component, so the inputs keep focus when it re-renders).
  const row = (key, checked, icon, tint, title, hint, off = false) => (
    <label className="check-row" key={key}><input type="checkbox" checked={checked} onChange={(e) => set(key, e.target.checked)} disabled={busy || off} />
      <span className={`src-icon ${tint}`}><Icon name={icon} size={18} /></span>
      <span className="src-text"><b>{title}</b><small>{hint}</small></span></label>
  );
  return (
    <aside className="card options-panel">
      <div className="panel-head"><h2 className="panel-title">Sources to check</h2><span className="badge">{selected} selected</span></div>
      {row("wikipedia", opts.wikipedia, "book", "blue", "Wikipedia", "Searches for your sentences. No setup needed.")}
      {row("scholar", opts.scholar, "flask", "red", "Scientific papers", "Europe PMC: the full text of open-access medical and science papers. Free, no key.")}
      {row("web", webOn, "globe", "violet", `The web${search ? ` (${search})` : ""}`, search ? "Searches for distinctive sentences and reads the top pages. Takes about a minute." : "Not set up. Point the server at a search engine you run yourself (SearXNG, free) or add a search key; see the README.", !search)}
      {row("library", opts.library, "folder", "amber", "My saved texts and history", "Finds text you have reused. An identical saved text is skipped.")}
      {row("paraphrase", opts.paraphrase, "nodes", "mint", "Include reworded matches", "Finds sentences that say the same thing in other words. Possible matches only; it adds a little time.")}
      <label htmlFor="plag-urls">Pages to compare with</label>
      <textarea id="plag-urls" className="field" rows={3} value={opts.urls} onChange={(e) => set("urls", e.target.value)} disabled={busy} placeholder={"One address per line, up to 5\nexample.com/article"} />
      {search && (<><label htmlFor="plag-ignore">Ignore my own site</label><input id="plag-ignore" className="field" value={opts.ignore} onChange={(e) => set("ignore", e.target.value)} disabled={busy} placeholder="mysite.com (where this text is published)" /></>)}
      <p className="hint">Only exact, word-for-word matches of 8 or more words are found. Paraphrased, translated or unlisted sources are not, so a clean result does not prove a text is original.</p>
    </aside>
  );
}

// The checked text with the matched passages marked.
function MatchedText({ text, passages, similar = [] }) {
  const parts = []; let cursor = 0;
  // Exact matches in one colour, reworded sentences in the other; they never overlap because reworded sentences skip exact matches.
  const marks = [...passages.map((p) => ({ ...p, kind: "ai", title: "Also found word for word in another source" })), ...similar.map((s) => ({ ...s, kind: "mixed", title: "Says the same as a sentence in another source, in different words" }))].sort((a, b) => a.start - b.start);
  for (const p of marks) { if (p.start < cursor) continue; if (p.start > cursor) parts.push(text.slice(cursor, p.start)); parts.push(<mark key={p.start} className={p.kind} title={p.title}>{text.slice(p.start, p.end)}</mark>); cursor = p.end; }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <p className="highlighted pane">{parts}</p>;
}

function PlagiarismResult({ result, onFix, fixing }) {
  const none = result.checkedSources === 0; // nothing was read, so there is no score to show
  const level = none ? "mixed" : result.percent >= 40 ? "ai" : result.percent >= 15 ? "mixed" : "human";
  const s = result.searched || {};
  const read = [s.wikipedia && `${s.wikipedia} Wikipedia`, s.scholar && `${s.scholar} papers`, s.web && `${s.web} web`, s.urls && `${s.urls} listed`, s.library && `${s.library} of your own`].filter(Boolean).join(", ");
  return (
    <section className="card result plagiarism-result" aria-live="polite">
      <div className="summary-bar">
        <div className={`donut ${level}`} style={{ "--p": none ? 0 : result.percent }}>
          <div className={`big-score ${level}`}>{none ? <b>—</b> : <><b>{result.percent}</b><span>%</span></>}</div>
        </div>
        <div className="summary-text">
          <h2 className={`verdict ${level}`}>{result.verdict}</h2>
          <p className="muted">{none ? `${result.words.toLocaleString()} words checked against no source.` : `${result.matchedWords.toLocaleString()} of ${result.words.toLocaleString()} words also appear elsewhere${result.quotedWords ? `; ${result.quotedWords} more are in quotation marks and not counted` : ""}.`}</p>
        </div>
        <div className="summary-stats">
          {[["doc", result.checkedSources, "Sources checked"], ["quote", result.passages.length, "Matching passages"], ["list", result.words, "Words analyzed"]].map(([ico, n, label]) => (
            <div key={label} className="sstat"><span className="sstat-ico"><Icon name={ico} size={26} /></span><b>{n.toLocaleString()}</b><span>{label}</span></div>
          ))}
        </div>
      </div>
      {!none && <p className="muted">{`Compared with ${result.checkedSources} source${result.checkedSources === 1 ? "" : "s"}${read ? ` (${read})` : ""}.`} A match is something to review, not a verdict.</p>}
      {(result.warnings || []).map((w) => <p key={w} className="notice">{w}</p>)}
      {(s.trace || []).length > 0 && (
        <details className="trace"><summary>What was searched ({s.trace.length} searches)</summary>
          <ul>{s.trace.map((t, i) => <li key={i}><b>{t.where}</b> · “{t.phrase}” → {t.found} result{t.found === 1 ? "" : "s"}{t.tries > 1 ? ` (after ${t.tries} tries)` : ""}</li>)}</ul>
        </details>
      )}
      {result.sources.length > 0 ? (
        <>
          <h3>Sources with matching passages</h3>
          <ul className="issues">
            {result.sources.map((src) => (
              <li key={src.id} className="issue">
                <div className="issue-top"><span className="sev medium">{src.type}</span><b>{src.url ? <a href={src.url} target="_blank" rel="noreferrer noopener">{src.title}</a> : src.title}</b><span className="muted"> · {src.percent}% of your text</span></div>
                {(src.pairs || []).length ? src.pairs.map((p) => (
                  <div key={p.start} className="pair">
                    <blockquote><b>Yours:</b> {p.yours}</blockquote>
                    <blockquote><b>Source:</b> {p.theirs}</blockquote>
                    <button className="btn small" onClick={() => onFix(p.start, p.end)} disabled={fixing}>Rewrite this passage</button>
                  </div>
                )) : src.excerpts.map((x) => <blockquote key={x}>{x}</blockquote>)}
              </li>
            ))}
          </ul>
        </>
      ) : result.checkedSources > 0 && <p className="hint">No passage of 8 or more words matched any source that was read.</p>}
      {(result.similar || []).length > 0 && (
        <>
          <h3>Possible rewording ({result.similar.length})</h3>
          <p className="muted">Sentences of yours that say the same thing as a sentence in a source, in different words — {result.similarPercent}% of your text. {result.similarMethod === "meaning" ? "Matched by meaning with a sentence model." : "Matched by word overlap only."} Facts that are simply true will match too, so read each pair before drawing a conclusion.</p>
          <ul className="issues">
            {result.similar.map((s) => (
              <li key={s.start} className="issue">
                <div className="issue-top"><span className="sev low">{s.method === "meaning" ? "Similar meaning" : "Similar wording"}</span><b>{s.source.url ? <a href={s.source.url} target="_blank" rel="noreferrer noopener">{s.source.title}</a> : s.source.title}</b><span className="muted"> · {Math.round(s.score * 100)}% alike</span></div>
                <blockquote><b>Yours:</b> {result.text.slice(s.start, s.end)}</blockquote>
                <blockquote><b>Source:</b> {s.matches}</blockquote>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function DetectorDashboard({ reports, setTab, fileRef, openUrl }) {
  return (
    <section className="dashboard-grid" aria-label="Detector dashboard">
      <article className="card activity-card">
        <div className="dash-head"><h2>Recent Activity</h2><button className="link" onClick={() => setTab("reports")}>View all <Icon name="arrow" /></button></div>
        {reports.length ? (
          <ul>
            {reports.slice(0, 5).map((r) => {
              const p = r.kind === "plagiarism" ? Math.round((r.plagiarism || 0) * 100) : Math.round((r.ai_probability || 0) * 100);
              return <li key={r.id}><span className={`activity-score ${p >= 60 ? "hot" : p >= 40 ? "warm" : "cool"}`}>{p}%</span><span><b>{r.title || "Untitled"}</b><small>#{r.id}{r.language ? ` · ${r.language}` : ""}</small></span><time>{new Date(String(r.created_at).replace(" ", "T") + "Z").toLocaleDateString()}</time></li>;
            })}
          </ul>
        ) : <p className="dash-empty">Your recent checks will appear here.</p>}
      </article>
      <article className="card quick-card">
        <div className="dash-head"><h2>Quick Actions</h2></div>
        <div className="quick-grid">
          <button onClick={() => fileRef.current?.click()}><i className="f-ico blue"><Icon name="doc" /></i><b>Check a document</b><small>Upload and scan a file</small></button>
          <button onClick={openUrl}><i className="f-ico blue"><Icon name="link" /></i><b>From URL</b><small>Scan a web page</small></button>
          <button onClick={() => setTab("humanize")}><i className="f-ico violet"><Icon name="pen" /></i><b>Humanize text</b><small>Rewrite with natural tone</small></button>
          <button onClick={() => setTab("reports")}><i className="f-ico blue"><Icon name="chart" /></i><b>View reports</b><small>See detailed history</small></button>
        </div>
      </article>
    </section>
  );
}

function ToolSwitcher({ tab, setTab }) {
  return (
    <nav className="tool-switcher" aria-label="AI content tools">
      {NAV.slice(0, 5).map(([id, label, icon]) => (
        <button key={id} className={tab === id ? "on" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
          <span className="tool-icon"><Icon name={icon} size={17} /></span>{label}
        </button>
      ))}
    </nav>
  );
}

export default function App() {
  const [tab, setTab] = useState("detect");
  const [text, setText] = useState(() => { try { return localStorage.getItem("kleza:draft") || ""; } catch { return ""; } });
  const [history, setHistory] = useState([]); // earlier versions of the text, for Undo after a fix
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(null); // detect | humanize | upload | url | fix
  const [error, setError] = useState("");
  const [detectResult, setDetectResult] = useState(null);
  const [humanResult, setHumanResult] = useState(null);
  const [plagResult, setPlagResult] = useState(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "light");
  const toggleTheme = () => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); document.documentElement.dataset.theme = next; try { localStorage.setItem("kleza-theme", next); } catch { /* the choice just is not remembered */ } };
  const [search, setSearch] = useState(null); // name of the configured web search service, or null
  const [plagOpts, setPlagOpts] = useState({ wikipedia: true, scholar: true, web: true, library: false, paraphrase: true, urls: "", ignore: "" });
  const [output, setOutput] = useState("");
  const [original, setOriginal] = useState("");
  const [toast, setToast] = useState("");
  const [items, setItems] = useState([]);
  const [dashboardReports, setDashboardReports] = useState([]);
  const [globalQuery, setGlobalQuery] = useState("");
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [importInfo, setImportInfo] = useState(null); // where the current text came from, when it was imported from a web page
  const [opts, setOpts] = useState({ level: "Natural", audience: "", tone: "", primary: "", secondary: "", required: "", brand: "" });
  const [neural, setNeural] = useState(null); // status of the word-predictability model, from /api/health
  const [llm, setLlm] = useState(null); // name of the configured AI rewrite service, or null for the built-in editor
  const [progress, setProgress] = useState(null); // { done, total } while a rewrite job runs
  const [authNeeded, setAuthNeeded] = useState(false);
  const [drag, setDrag] = useState(false); // a file is being dragged over the text box
  const [tokenInput, setTokenInput] = useState("");
  const fileRef = useRef(null);
  const resultRef = useRef(null);
  const jobRef = useRef(null);

  const words = countWords(text);
  const tooLong = words > MAX_WORDS;
  const isText = tab === "detect" || tab === "humanize" || tab === "plagiarism";
  const isDetect = tab === "detect";
  const isPlag = tab === "plagiarism";
  const isHuman = tab === "humanize";
  const notify = (m) => setToast(m);

  const reloadItems = () => api("/content").then(setItems).catch(() => {});
  const reloadDashboard = () => api("/reports").then(setDashboardReports).catch(() => {});
  // The neural models load from disk in the background at start; keep the status fresh until they settle.
  useEffect(() => {
    if (neural && neural.status !== "loading") return;
    const t = setTimeout(() => api("/health").then((h) => { setNeural(h.neural); setLlm(h.llm || null); setSearch(h.search || null); }).catch(() => {}), neural ? 3000 : 0);
    return () => clearTimeout(t);
  }, [neural]);
  useEffect(() => {
    reloadItems();
    reloadDashboard();
    api("/settings").then((s) => setOpts((o) => ({ ...o, level: s.defaultLevel || o.level, brand: s.brandVoice || o.brand }))).catch(() => {});
  }, []);
  useEffect(() => {
    const onAuth = () => setAuthNeeded(true);
    const onRetry = () => setToast("The server is restarting… trying again");
    window.addEventListener("kleza:auth", onAuth);
    window.addEventListener("kleza:reconnecting", onRetry);
    return () => { window.removeEventListener("kleza:auth", onAuth); window.removeEventListener("kleza:reconnecting", onRetry); };
  }, []);
  // Keep the draft so a reload or accidental close does not lose the text.
  useEffect(() => { try { localStorage.setItem("kleza:draft", text); } catch { /* storage unavailable */ } }, [text]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  const apiOptions = () => ({
    level: opts.level, audience: opts.audience || undefined, tone: opts.tone || undefined, brand: opts.brand || undefined, primary: opts.primary || undefined,
    secondary: opts.secondary.split(",").map((x) => x.trim()).filter(Boolean),
    required: opts.required.split(",").map((x) => x.trim()).filter(Boolean),
  });

  const clearResults = () => { setDetectResult(null); setHumanResult(null); setPlagResult(null); setError(""); };
  const edit = (value) => { setText(value); clearResults(); };
  const load = (value, newTitle = "") => { setHistory([]); setTitle(newTitle); setImportInfo(null); edit(value); };
  const scrollToResult = () => setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);

  const check = async (input = text) => {
    if (!input.trim()) return setError("Paste or type some text first.");
    setBusy("detect"); setError("");
    try {
      const r = await postJson("/analyze", { text: input, title: title || titleFrom(input) });
      setDetectResult({ ...r, text: input });
      reloadDashboard();
      scrollToResult();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  // The plagiarism check reads pages and searches, so it can take up to a minute or two.
  const checkPlagiarism = async (input = text) => {
    if (!input.trim()) return setError("Paste or type some text first.");
    setBusy("plagiarism"); setError("");
    try {
      const r = await postJson("/plagiarism", { text: input, title: title || titleFrom(input), options: { wikipedia: plagOpts.wikipedia, scholar: plagOpts.scholar, web: plagOpts.web, ignore: plagOpts.ignore.split(/[\s,]+/).filter(Boolean), library: plagOpts.library, paraphrase: plagOpts.paraphrase, urls: plagOpts.urls.split(/[\s,]+/).filter(Boolean) } });
      setPlagResult({ ...r, text: input });
      reloadDashboard();
      scrollToResult();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  // Rewrites just one matched passage in place with the humanizer, then checks the new text again.
  const fixPassage = async (start, end) => {
    setBusy("fix"); setError("");
    const before = plagResult.text;
    try {
      const r = await postJson("/rewrite", { text: before, original: before, options: apiOptions(), issue: { start, end } });
      if (r.text === before) { notify("Nothing to change for that passage"); return; }
      setHistory((h) => [...h, before]); setText(r.text);
      setBusy(null); await checkPlagiarism(r.text);
      notify("Rewritten and checked again");
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  // Rewrites run as a background job so long texts show progress and can be cancelled.
  const humanize = async () => {
    if (!text.trim()) return setError("Paste or type some text first.");
    setBusy("humanize"); setError(""); setProgress({ done: 0, total: 1 });
    try {
      const { id } = await postJson("/rewrite/jobs", { text, original: text, title: title || titleFrom(text), options: apiOptions() });
      jobRef.current = id;
      let job;
      for (;;) {
        job = await api(`/rewrite/jobs/${id}`);
        setProgress({ done: job.done, total: job.total });
        if (job.status !== "running") break;
        await new Promise((r) => setTimeout(r, 700));
      }
      if (job.status === "cancelled") { notify("Rewrite cancelled"); return; }
      if (job.status === "error") throw new Error(job.error);
      setHumanResult(job.result); setOutput(job.result.text); setOriginal(text);
      if (!title) setTitle(titleFrom(text));
      scrollToResult();
    } catch (e) { setError(e.message); } finally { jobRef.current = null; setProgress(null); setBusy(null); }
  };
  const cancelJob = () => { if (jobRef.current) api(`/rewrite/jobs/${jobRef.current}`, { method: "DELETE" }).catch(() => {}); };

  const fixIssue = async (issue) => {
    setBusy("fix"); setError("");
    const before = detectResult.text;
    try {
      const r = await postJson("/rewrite", { text: before, original: before, options: apiOptions(), issue, analysisId: detectResult.id });
      if (r.text === before) { notify("Nothing to change for that passage"); return; }
      setHistory((h) => [...h, before]); setText(r.text);
      setBusy(null); await check(r.text);
      notify("Fixed and re-checked");
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (prev == null) return;
    setHistory((h) => h.slice(0, -1)); edit(prev); notify("Undone");
  };

  const upload = async (file) => {
    if (!file) return;
    setBusy("upload"); setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await api("/upload", { method: "POST", body: form });
      load(r.text, r.title || "");
      notify(r.ocr ? "Text recovered from the scanned PDF" : "File loaded");
    } catch (e) { setError(e.message); } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
  };
  const importUrl = async () => {
    setBusy("url"); setError("");
    try {
      const r = await postJson("/url", { url: urlValue.trim() });
      load(r.text, r.title || ""); setUrlOpen(false); setUrlValue("");
      setImportInfo({ ...r.metadata, title: r.title, warnings: r.warnings || [] });
      notify(`Imported ${(r.metadata?.words ?? countWords(r.text)).toLocaleString()} words`);
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const paste = async () => {
    try { load(await navigator.clipboard.readText()); }
    catch { setError("Your browser blocked clipboard access. Paste with Ctrl+V instead."); }
  };

  const save = async () => {
    try {
      await postJson("/content", { title: title || titleFrom(output), body: output });
      await reloadItems(); notify("Saved to My Content");
    } catch (e) { notify(e.message); }
  };
  const saveDefaults = async () => {
    try { await postJson("/settings", { defaultLevel: opts.level, brandVoice: opts.brand }, "PUT"); notify("Saved as your defaults"); }
    catch (e) { notify(e.message); }
  };
  const checkHumanized = () => { setHistory((h) => [...h, text]); setText(output); setHumanResult(null); setDetectResult(null); setTab("detect"); check(output); };
  const openItem = (item, where) => { load(item.body, item.title); setTab(where); };

  const disabled = busy !== null || tooLong;
  // Once a text has been scored, the left box shows it with the AI-looking sentences highlighted.
  const showMarked = isDetect && detectResult && detectResult.text === text && detectResult.detection.probability != null;
  const tooShort = text.trim() && words < MIN_WORDS;

  if (authNeeded) {
    return (
      <div className="page">
        <section className="card auth-card">
          <h1>Access token needed</h1>
          <p className="muted">This server asks for an access token before it will analyze or rewrite text.</p>
          <form onSubmit={(e) => { e.preventDefault(); if (tokenInput.trim()) { setToken(tokenInput.trim()); window.location.reload(); } }}>
            <label className="sr-only" htmlFor="token">Access token</label>
            <input id="token" className="field" type="password" autoComplete="off" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="Access token" autoFocus />
            <div className="actions"><button className="btn primary" disabled={!tokenInput.trim()}>Continue</button></div>
          </form>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="/" aria-label="Kleza home"><span className="logo" aria-hidden="true">K</span>Kleza<small>AI Tools</small></a>
        <nav className="tabs" role="tablist" aria-label="Tools">
          {NAV.map(([id, label, icon]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}><Icon name={icon} size={20} />{label}</button>
          ))}
        </nav>
      </header>

      <main>
        <div className="topbar">
          <form className="global-search" onSubmit={(e) => { e.preventDefault(); const q = globalQuery.toLowerCase(); const hit = NAV.find(([, label]) => label.toLowerCase().includes(q)); if (hit) { setTab(hit[0]); setGlobalQuery(""); } else if (q) notify("No matching tool found"); }}>
            <Icon name="search" size={18} /><input aria-label="Search tools, content, or reports" value={globalQuery} onChange={(e) => setGlobalQuery(e.target.value)} placeholder="Search tools, content, or reports..." />
          </form>
          <button className="icon-btn" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title={theme === "dark" ? "Light mode" : "Dark mode"}><Icon name={theme === "dark" ? "sun" : "moon"} size={18} /></button>
          <button className="profile-btn" onClick={() => notify("Profile settings are not connected yet")}><span>K</span><b>Kleza</b></button>
        </div>
        {!isText && <ToolSwitcher tab={tab} setTab={setTab} />}
        {isText && (
          <>
            <section className="hero">
              {isDetect && <div className="hero-art" aria-hidden="true"><span className="art-sheet"><i /><i /><i /></span><span className="art-lens">AI</span><b className="spark one">✦</b><b className="spark two">✦</b></div>}
              <span className="eyebrow">{isDetect ? "AI content tools" : "Writing tools"}</span>
              <h1>{isDetect ? <>AI <span className="grad">Content Detector</span></> : isPlag ? <>Plagiarism <span className="grad">Checker</span></> : <>AI <span className="grad">Humanizer</span></>}</h1>
              <p>{isDetect ? "Check if your text is written by AI or human. Get detailed analysis and suggestions." : isPlag ? "Check your writing against trusted sources and make sure it's original." : "Rewrite AI-sounding text so it reads more naturally. Numbers, names and quotes stay as they are."}</p>
            </section>

            <ToolSwitcher tab={tab} setTab={setTab} />

            <NeuralNotice neural={neural} />
            <div className="workspace">
            <section className={`card input-card${drag ? " dragging" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files?.[0]); }}>
              <div className="toolbar">
                <div className="tool-buttons">
                  <button className="btn small" onClick={() => load(SAMPLE)} disabled={busy !== null}><Icon name="sample" />Try a sample</button>
                  <button className="btn small" onClick={paste} disabled={busy !== null}><Icon name="paste" />Paste</button>
                  <button className="btn small" onClick={() => fileRef.current?.click()} disabled={busy !== null}><Icon name="upload" />{busy === "upload" ? "Reading…" : "Upload file"}</button>
                  <button className="btn small" onClick={() => setUrlOpen(!urlOpen)} disabled={busy !== null} aria-expanded={urlOpen}><Icon name="link" />From URL</button>
                  {items.length > 0 && (
                    <select className="field small" aria-label="Load saved content" value="" onChange={(e) => { const it = items.find((x) => String(x.id) === e.target.value); if (it) load(it.body, it.title); }}>
                      <option value="">Saved…</option>
                      {items.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                    </select>
                  )}
                  <input ref={fileRef} type="file" hidden accept=".txt,.doc,.docx,.pdf" onChange={(e) => upload(e.target.files?.[0])} />
                </div>
                <span className={`count ${tooLong ? "over" : ""}`}>{words.toLocaleString()} / {MAX_WORDS.toLocaleString()} words</span>
              </div>
              {urlOpen && (
                <form className="url-row" onSubmit={(e) => { e.preventDefault(); if (urlValue.trim()) importUrl(); }}>
                  <label className="sr-only" htmlFor="url">Page address</label>
                  <input id="url" className="field" type="text" inputMode="url" autoComplete="off" spellCheck={false} value={urlValue} onChange={(e) => setUrlValue(e.target.value)} placeholder="example.com/article (https:// is optional)" />
                  <button className="btn primary" disabled={busy !== null || !urlValue.trim()}>{busy === "url" ? "Importing…" : "Import"}</button>
                </form>
              )}
              {importInfo && (
                <div className="import-info" role="status">
                  <p className="muted">
                    Imported from <a href={importInfo.url} target="_blank" rel="noreferrer noopener">{importInfo.siteName || "the page"}</a>
                    {importInfo.author ? ` · by ${importInfo.author}` : ""}
                    {importInfo.published && !Number.isNaN(Date.parse(importInfo.published)) ? ` · ${new Date(importInfo.published).toLocaleDateString()}` : ""}
                    {` · ${(importInfo.words ?? 0).toLocaleString()} words`}. Check that it holds only the article text before you use the result.
                  </p>
                  {importInfo.warnings.map((w) => <p key={w} className="notice">{w}</p>)}
                </div>
              )}
              <label className="sr-only" htmlFor="input">Text to analyze</label>
              {showMarked ? (
                <div className="marked-wrap">
                  <Highlighted text={detectResult.text} signals={detectResult.sentenceSignals} idPrefix="sent-" className="pane" />
                  <button className="btn small" onClick={clearResults}>Edit text</button>
                </div>
              ) : isPlag && plagResult && plagResult.text === text ? (
                <div className="marked-wrap">
                  <MatchedText text={plagResult.text} passages={plagResult.passages} similar={plagResult.similar || []} />
                  <button className="btn small" onClick={clearResults}>Edit text</button>
                </div>
              ) : (
                <div className="pane-wrap">
                  <textarea id="input" className="pane" value={text} onChange={(e) => edit(e.target.value)}
                    onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !disabled && text.trim()) { e.preventDefault(); isDetect ? check() : isPlag ? checkPlagiarism() : humanize(); } }} placeholder={isDetect ? "Enter or paste your text here to check for AI…" : isPlag ? "Enter or paste the text you want to check for plagiarism…" : "Enter or paste the text you want to rewrite…"} rows={isHuman ? 10 : 16} />
                  {!text && (
                    <div className="empty-prompt">
                      <button className="btn primary" onClick={paste} disabled={busy !== null}><Icon name="paste" />Paste Text</button>
                      <button className="btn" onClick={() => load(SAMPLE)} disabled={busy !== null}><Icon name="sample" />Try Sample Text</button>
                    </div>
                  )}
                </div>
              )}
              {tooShort && (isDetect || isPlag) && <p className="hint">Add at least {MIN_WORDS} words{isPlag ? " to check" : " for a score. 80 or more is best"}.</p>}
              {tooLong && <p className="error" role="alert">That is over the {MAX_WORDS.toLocaleString()}-word limit. Split it into parts.</p>}
              {error && <p className="error" role="alert">{error}</p>}

              <div className="actions">
                {isDetect ? (
                  <button className="btn primary big" onClick={() => check()} disabled={disabled || !text.trim()}>{busy === "detect" ? "Checking…" : "Check for AI"}<Icon name="arrow" size={18} /></button>
                ) : isPlag ? (
                  <button className="btn primary big" onClick={() => checkPlagiarism()} disabled={disabled || words < MIN_WORDS}>{busy === "plagiarism" ? "Checking sources…" : "Check for plagiarism"}<Icon name="arrow" size={18} /></button>
                ) : (
                  <button className="btn primary big" onClick={humanize} disabled={disabled || !text.trim()}>{busy === "humanize" ? "Rewriting…" : "Humanize"}<Icon name="arrow" size={18} /></button>
                )}
                {history.length > 0 && <button className="btn" onClick={undo} disabled={busy !== null}>Undo</button>}
                {text && <button className="btn ghost" onClick={() => load("")} disabled={busy !== null}><Icon name="trash" />Clear</button>}
              </div>

              {busy === "plagiarism" && <p className="hint" role="status">Reading sources. This can take up to a minute or two when it searches and fetches pages.</p>}
              {busy === "humanize" && progress && (
                <div className="progress-row" role="status">
                  <progress value={progress.done} max={progress.total} />
                  <span>{progress.total > 1 ? `Rewriting section ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : "Rewriting…"}</span>
                  <button className="btn small" onClick={cancelJob}>Cancel</button>
                </div>
              )}

            </section>
            {isPlag && <PlagiarismPanel opts={plagOpts} setOpts={setPlagOpts} search={search} busy={busy === "plagiarism"} />}
            {isHuman && (
              <aside className="card options-panel">
                <h2 className="panel-title">Style</h2>
                <div className="options">
                  <div className="levels" role="radiogroup" aria-label="Style">
                    {LEVELS.map(([l, hint]) => (
                      <button key={l} role="radio" aria-checked={opts.level === l} className={opts.level === l ? "on" : ""} onClick={() => setOpt("level", l)}>
                        <b>{l}</b><small>{hint}</small>
                      </button>
                    ))}
                  </div>
                  <details className="more">
                    <summary>More options</summary>
                    <div className="form-grid">
                      <div><label htmlFor="aud">Audience</label><input id="aud" className="field" value={opts.audience} onChange={(e) => setOpt("audience", e.target.value)} placeholder="e.g. homeowners and families" /></div>
                      <div><label htmlFor="tone">Tone</label><input id="tone" className="field" value={opts.tone} onChange={(e) => setOpt("tone", e.target.value)} placeholder="e.g. warm and trustworthy" /></div>
                      <div><label htmlFor="pk">Primary keyword</label><input id="pk" className="field" value={opts.primary} onChange={(e) => setOpt("primary", e.target.value)} placeholder="Optional" /></div>
                      <div><label htmlFor="sk">Secondary keywords</label><input id="sk" className="field" value={opts.secondary} onChange={(e) => setOpt("secondary", e.target.value)} placeholder="Comma-separated" /></div>
                    </div>
                    <label htmlFor="req">Terms to keep unchanged</label>
                    <input id="req" className="field" value={opts.required} onChange={(e) => setOpt("required", e.target.value)} placeholder="Names, terms, exact phrases (comma-separated)" />
                    <label htmlFor="brand">Brand voice {opts.level !== "Brand Voice" && <small className="muted">(used when the Brand Voice style is chosen)</small>}</label>
                    <textarea id="brand" className="field" rows={3} value={opts.brand} onChange={(e) => setOpt("brand", e.target.value)} placeholder="Describe vocabulary, tone and phrases to avoid, or paste a writing sample…" />
                    <div className="actions"><button className="btn small" onClick={saveDefaults}>Save style and brand voice as my defaults</button></div>
                  </details>
                </div>
                {llm
                  ? <p className="hint">Rewrites use {llm}: the text is sent to that service, and a long text can take a few minutes. If it fails, the built-in editor is used instead.</p>
                  : <p className="hint">The humanizer runs on a built-in editor on this machine. No text is sent to any AI service.</p>}
              </aside>
            )}
            {isDetect && <ScorePanel result={detectResult} busy={busy === "detect"} notify={notify}onHumanize={() => { setTab("humanize"); setDetectResult(null); }} />}
            </div>

            <div ref={resultRef}>
              {isDetect && detectResult && <DetectionDetails result={detectResult} busy={busy !== null} onFix={fixIssue} />}
              {isPlag && plagResult && <PlagiarismResult result={plagResult} onFix={fixPassage} fixing={busy === "fix" || busy === "plagiarism"} />}
              {isHuman && humanResult && (
                <HumanizeResult result={humanResult} original={original} output={output} setOutput={setOutput} title={title} setTitle={setTitle}
                  onCheck={checkHumanized} onRetry={humanize} onSave={save} notify={notify} />
              )}
            </div>

            {isDetect && (
              <section className="session-stats" aria-label="Session statistics">
                <div><i className="f-ico violet"><Icon name="doc" size={22} /></i><b>{detectResult ? 1 : 0}</b><span>Texts checked</span></div>
                <div><i className="f-ico blue"><Icon name="quote" size={22} /></i><b>0</b><span>Matching passages</span></div>
                <div><i className="f-ico blue"><Icon name="plagiarism" size={22} /></i><b>{detectResult?.words?.toLocaleString() || 0}</b><span>Words analyzed</span></div>
                <div><i className="f-ico blue"><Icon name="clock" size={22} /></i><b>{detectResult ? "<1s" : "0s"}</b><span>Avg. check time</span></div>
              </section>
            )}

            {isDetect && <DetectorDashboard reports={dashboardReports} setTab={setTab} fileRef={fileRef} openUrl={() => { setTab("detect"); setUrlOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }} />}

            <section className="faq" aria-label="Questions">
              <h2>Good to know</h2>
              <div className="card faq-list">
                {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
              </div>
            </section>
          </>
        )}

        {tab === "library" && <Library items={items} reload={reloadItems} notify={notify} open={openItem} />}
        {tab === "reports" && <Reports notify={notify} open={(body, title, where) => openItem({ body, title }, where)} />}
      </main>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
