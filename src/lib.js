export const API = "/api";
export const MAX_WORDS = 50000;
export const MIN_WORDS = 30;

export const countWords = (s) => (s.match(/[\p{L}\p{N}’'-]+/gu) || []).length;
export const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
// One colour scale for gauges, verdicts and highlights.
// Confidence tier of one sentence's AI probability: high 80+, medium 60-79, low 40-59 (below 40 is not flagged).
export const level = (p) => (p >= 80 ? "high" : p >= 60 ? "med" : p >= 40 ? "low" : "none");
export const tone =(percent) => (percent >= 60 ? "ai" : percent >= 40 ? "mixed" : "human");

// When the server sets KLEZA_ACCESS_TOKEN, the token is asked for once and kept for this browser session.
const TOKEN_KEY = "kleza-token";
export const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };
export const setToken = (token) => { try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* private mode: the prompt will simply reappear */ } };
export const authHeaders = () => (getToken() ? { "x-access-token": getToken() } : {});

// A server that is restarting (or not up yet) answers 502/503/504 or drops the connection. That is not the user's mistake, so the
// request is retried quietly for about 25 seconds, with a "reconnecting" signal the page shows, before giving up with a clear message.
const TRANSIENT = new Set([502, 503, 504]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const SERVER_DOWN = "The server could not be reached. It may be restarting: wait a few seconds and try again. If it keeps happening, look at the terminal running `npm run dev`: both the page server and the API server must be running. Stop it with Ctrl+C and start it again.";

export async function api(path, options = {}) {
  let r = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try { r = await fetch(API + path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } }); } catch { r = null; }
    if (r && !TRANSIENT.has(r.status)) break;
    if (options.signal?.aborted || attempt === 10) break;
    window.dispatchEvent(new CustomEvent("kleza:reconnecting", { detail: { attempt } }));
    await pause(2500);
  }
  if (!r || TRANSIENT.has(r.status)) throw new Error(SERVER_DOWN);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.auth) window.dispatchEvent(new Event("kleza:auth"));
  if (!r.ok) throw new Error(data.error || `Something went wrong (code ${r.status}). Please try again.`);
  return data;
}
export const postJson = (path, body, method = "POST") =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    el.remove();
  }
}

export function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const safeName = (title) => (title || "kleza-content").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-").slice(0, 60) || "kleza-content";

export async function downloadDocx(text, title) {
  const r = await fetch(API + "/download/docx", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ text, title }),
  });
  if (!r.ok) throw new Error("Could not create the Word file.");
  downloadBlob(await r.blob(), `${safeName(title)}.docx`);
}

export const titleFrom = (text) => text.trim().split(/\s+/).slice(0, 7).join(" ").replace(/[.,;:!?]+$/, "") || "Untitled";
