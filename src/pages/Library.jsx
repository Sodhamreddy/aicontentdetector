import React, { useState } from "react";
import { api, copyText, countWords } from "../lib.js";
import { Empty, Icon, PageHead } from "../parts.jsx";

export default function Library({ items, reload, notify, open }) {
  const [q, setQ] = useState("");
  const shown = items.filter((x) => (x.title + x.body).toLowerCase().includes(q.toLowerCase()));
  const remove = async (id) => {
    try {
      await api("/content/" + id, { method: "DELETE" });
      await reload();
      notify("Removed from My Content");
    } catch (e) { notify(e.message); }
  };
  return (
    <>
      <PageHead title="My Content" sub="Text you saved from the Humanizer, ready to reuse." />
      <section className="card">
        <div className="library-tools">
          <label className="sr-only" htmlFor="lib-search">Search saved content</label>
          <input id="lib-search" className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved content…" />
          <span className="muted">{items.length} saved</span>
        </div>
        {shown.length ? (
          <ul className="rows">
            {shown.map((x) => (
              <li key={x.id} className="row">
                <div className="grow">
                  <b>{x.title}</b>
                  <p className="muted clamp">{x.body.slice(0, 160)}{x.body.length > 160 ? "…" : ""}</p>
                  <small className="muted">{countWords(x.body).toLocaleString()} words · saved {new Date(x.created_at).toLocaleDateString()}</small>
                </div>
                <div className="row-actions">
                  <button className="btn small" onClick={() => open(x, "detect")}><Icon name="shield" />Check</button>
                  <button className="btn small violet-btn" onClick={() => open(x, "humanize")}><Icon name="pen" />Humanize</button>
                  <button className="btn small" onClick={async () => { await copyText(x.body); notify("Copied"); }}><Icon name="copy" />Copy</button>
                  <button className="btn small danger" onClick={() => remove(x.id)} aria-label={`Delete ${x.title}`}><Icon name="trash" />Delete</button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={items.length ? "No matches" : "Nothing saved yet"} body={items.length ? "Try a different search." : "Humanize some text and choose Save to keep it here."} />
        )}
      </section>
    </>
  );
}
