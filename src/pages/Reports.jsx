import React, { useEffect, useMemo, useState } from "react";
import { API, api, authHeaders, copyText, countWords, downloadBlob, pct, tone } from "../lib.js";
import { Empty, PageHead, Stat } from "../parts.jsx";

// The server stores times as UTC text ("2026-10-02 12:44:07"); read them as UTC and show them in the viewer's time zone.
const when = (s) => { const d = new Date(String(s).replace(" ", "T") + "Z"); return Number.isNaN(d.getTime()) ? String(s) : d; };
const dateOnly = (s) => (when(s) instanceof Date ? when(s).toLocaleDateString() : String(s));
const dateTime = (s) => (when(s) instanceof Date ? when(s).toLocaleString() : String(s));
const typeName = (r) => (r.kind === "rewrite" ? "Rewrite" : r.kind === "plagiarism" ? "Plagiarism" : "Check");

// A plagiarism entry stores the share of the text matched elsewhere (0 to 1); the colour scale is gentler than the AI one.
const matchTone = (p) => (p >= 0.4 ? "ai" : p >= 0.15 ? "mixed" : "human");

function Score({ before, after, match }) {
  if (match != null) return <span className={`pill tone-${matchTone(match)}`}>{pct(match)} matched</span>;
  if (before == null && after == null) return <>—</>;
  const t = (p) => <span className={`pill tone-${tone(Math.round(p * 100))}`}>{pct(p)}</span>;
  return after == null ? t(before) : <>{before == null ? "—" : t(before)} → {t(after)}</>;
}

function TextBlock({ label, text, notify }) {
  return (
    <div className="history-text-block">
      <div className="history-text-head">
        <b>{label}</b>
        <span className="muted">{countWords(text).toLocaleString()} words</span>
        <button className="btn small" onClick={() => copyText(text).then(() => notify("Copied"))}>Copy</button>
      </div>
      <div className="history-text">{text}</div>
    </div>
  );
}

function Detail({ id, onBack, onOpen, notify }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api(`/reports/${id}`).then(setD).catch((e) => { notify(e.message); onBack(); }); }, [id]);
  if (!d) return <p className="muted center">Loading…</p>;
  const title = d.title || "Untitled";
  return (
    <>
      <PageHead
        title={title}
        sub={`#${d.id} · ${typeName(d)} · ${dateTime(d.created_at)}${d.provider ? ` · edited with ${d.provider}` : ""}`}
        action={<button className="btn" onClick={onBack}>← Back to history</button>}
      />
      <div className="stats">
        {d.kind === "plagiarism" ? (
          <>
            <Stat label="Matched elsewhere" value={pct(d.plagiarism)} sub="exact runs of 8+ words" />
            <Stat label="Sources with matches" value={d.checks.length} />
          </>
        ) : (
          <>
            <Stat label="AI likelihood" value={d.ai_probability == null ? "—" : pct(d.ai_probability)} sub={d.kind === "rewrite" ? "before the rewrite" : undefined} />
            {d.ai_after != null && <Stat label="After rewrite" value={pct(d.ai_after)} />}
            {d.score != null && <Stat label="Pattern score" value={`${d.score}/100`} />}
            {d.kind !== "rewrite" && <Stat label="Writing issues" value={d.issues.length} />}
          </>
        )}
      </div>
      {d.checks.length > 0 && (
        <section className="card">
          <h2>{d.kind === "plagiarism" ? "Sources with matching passages" : "Quality checks"}</h2>
          <ul className="check-list">
            {d.checks.map((c) => <li key={c.name}><b>{c.name}</b> <span className={`pill ${d.kind === "plagiarism" ? "tone-mixed" : c.status === "Passed" ? "tone-human" : "tone-mixed"}`}>{c.status}</span><small className="muted"> {c.detail}</small></li>)}
          </ul>
        </section>
      )}
      <section className="card">
        <div className="history-cols">
          <TextBlock label={d.revised ? "Original text" : "Text"} text={d.original} notify={notify} />
          {d.revised && <TextBlock label="Rewritten text" text={d.revised} notify={notify} />}
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => onOpen(d.original, title, d.kind === "plagiarism" ? "plagiarism" : "detect")}>{d.kind === "plagiarism" ? "Open in the plagiarism checker" : "Open original in the detector"}</button>
          {d.revised && <button className="btn" onClick={() => onOpen(d.revised, title, "detect")}>Open rewrite in the detector</button>}
          <button className="btn" onClick={() => onOpen(d.original, title, "humanize")}>Humanize this text again</button>
        </div>
      </section>
      {d.versions.length > 0 && (
        <section className="card">
          <h2>Versions ({d.versions.length})</h2>
          {d.versions.map((v) => (
            <details key={v.id} className="version">
              <summary>{v.label || "Version"} <span className="muted">· {dateTime(v.created_at)}</span></summary>
              <TextBlock label="Text" text={v.body} notify={notify} />
            </details>
          ))}
        </section>
      )}
    </>
  );
}

export default function Reports({ notify, open }) {
  const [reports, setReports] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [limit, setLimit] = useState(25); // rows shown; the rest load on request so a long history does not make a very long page
  const load = () => api("/reports").then(setReports).catch((e) => { notify(e.message); setReports([]); });
  useEffect(() => { load(); }, []);

  // The CSV is built on the server (it has every text, quoted properly, with a BOM so Excel reads it as UTF-8).
  const exportCsv = async () => {
    try {
      const r = await fetch(`${API}/reports/export.csv`, { headers: authHeaders() });
      if (!r.ok) throw new Error("Could not create the CSV file.");
      downloadBlob(await r.blob(), "kleza-history.csv");
      notify("History exported");
    } catch (e) { notify(e.message); }
  };

  const shown = useMemo(() => (reports || []).filter((r) => (kind === "all" || r.kind === kind || (kind === "check" && !r.kind)) && (!query.trim() || `${r.title} #${r.id}`.toLowerCase().includes(query.trim().toLowerCase()))), [reports, query, kind]);

  if (selected != null) return <Detail id={selected} onBack={() => { setSelected(null); load(); }} onOpen={open} notify={notify} />;
  if (!reports) return <p className="muted center">Loading…</p>;
  return (
    <>
      <PageHead
        title="Reports"
        sub="A history of every text you checked and every rewrite you ran. Open an entry to see the full text."
        action={<button className="btn" onClick={exportCsv} disabled={!reports.length}>Export CSV</button>}
      />
      <div className="stats">
        <Stat label="Entries" value={reports.length} icon="doc" />
        <Stat label="AI checks" value={reports.filter((r) => r.kind !== "rewrite" && r.kind !== "plagiarism").length} icon="plagiarism" tone="violet" />
        <Stat label="Rewrites" value={reports.filter((r) => r.revised).length} icon="wand" tone="mint" />
        <Stat label="Flagged 60%+ AI" value={reports.filter((r) => (r.ai_probability ?? 0) >= 0.6).length} icon="shield" tone="red" />
      </div>
      <section className="card">
        {reports.length > 0 && (
          <div className="history-filter">
            <input className="field" type="search" placeholder="Search by title or #id" aria-label="Search history" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="field" aria-label="Show" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">All entries</option><option value="check">AI checks</option><option value="rewrite">Rewrites</option><option value="plagiarism">Plagiarism</option>
            </select>
          </div>
        )}
        {shown.length ? (
          <div className="table-scroll">
            <table className="data">
              <thead><tr><th>Text</th><th>Type</th><th>AI likelihood</th><th>Pattern score</th><th>Date</th></tr></thead>
              <tbody>
                {shown.slice(0, limit).map((r) => (
                  <tr key={r.id} className="history-row" onClick={() => setSelected(r.id)}>
                    <th scope="row">
                      <button className="link-btn" onClick={(e) => { e.stopPropagation(); setSelected(r.id); }}>{r.title || "Untitled"}</button>
                      <small>#{r.id}{r.language ? ` · ${r.language}` : ""}</small>
                    </th>
                    <td>{typeName(r)}{r.revised && r.kind !== "rewrite" ? " + rewrite" : ""}</td>
                    <td><Score before={r.ai_probability} after={r.ai_after} match={r.kind === "plagiarism" ? r.plagiarism : null} /></td>
                    <td>{r.score == null ? "—" : `${r.score}/100`}</td>
                    <td>{dateOnly(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > limit && (
              <div className="more-row">
                <span className="muted">Showing {limit} of {shown.length}</span>
                <button className="btn small" onClick={() => setLimit((n) => n + 25)}>Show 25 more</button>
                <button className="btn small ghost" onClick={() => setLimit(shown.length)}>Show all</button>
              </div>
            )}
          </div>
        ) : reports.length ? (
          <Empty title="Nothing matches" body="Try a different search or filter." />
        ) : (
          <Empty title="No history yet" body="Every check in the AI Detector and every rewrite in the Humanizer is saved here." />
        )}
      </section>
    </>
  );
}
