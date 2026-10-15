# Kleza AI Content Detector & Humanizer

Kleza is a full-stack editorial tool that identifies observable writing patterns and helps refine them. Each analysis reports two separate signals:

- **AI likelihood**: a calibrated probability from a trained statistical classifier, with a confidence level, the features that pushed the score up or down, and a per-sentence heatmap.
- **Writing Pattern Score**: a heuristic editorial indicator that explains specific passages.

Neither signal is proof of AI authorship.

## Interface

One page with a tab bar. The two main tools share one text box (up to **50,000 words**), which you can fill by pasting, uploading TXT, DOC, DOCX or PDF (scanned PDFs are OCR'd), importing a URL, picking saved content, or trying a sample. Auto-detect language can be overridden.

- **AI Detector:** score gauge, verdict, confidence, what moved the score, sentence-by-sentence highlights, writing-pattern issues with readability, and a **Fix this** button per issue (with Undo).
- **Humanizer:** four styles (Light, Natural, Professional, Brand Voice), plus audience, tone, primary and secondary keywords, terms to keep unchanged and a brand voice, which you can save as defaults. The result shows the before/after AI score, is editable, and can be copied, saved, downloaded as .txt or .docx, compared with the original, or re-checked in one click.
- **Plagiarism:** free, with no key or account. It finds passages of your text that also appear elsewhere (see "Plagiarism checker" below). It marks the matches in the text and lists the sources with the matching passages.
- **My Content:** search, reuse, copy and delete saved text.
- **Reports:** the history of every check and every humanizer run (kept in the local database). Search it, open an entry to see the original and rewritten text, scores, quality checks and versions, reopen a text in the detector or humanizer, and export everything to a CSV that opens in Excel (`GET /api/reports/export.csv`).

It follows the system light or dark theme and works on phones. The code is in `src/` (`App.jsx`, `pages/`, `app.css`).

**Long texts:** analysis of a ~46,000-word document takes about 2 seconds, and the built-in rewrite about 5. The rewrite runs entirely on this machine; no text is sent to an AI service.

## Detection model

The detector combines three kinds of evidence, the same general approach used by commercial tools such as QuillBot, Scribbr, NoteGPT and GPTZero (a trained classifier plus statistical text signals, scored per sentence):

1. **Writing style** (`detector.mjs`): an L2-regularized logistic-regression classifier over 24 stylometric features plus the usage rates of the ~100 most common words. It looks at sentence-length burstiness, vocabulary variety, stock phrases and AI-associated vocabulary, contractions (possessives excluded), first- and second-person voice, named entities, hedged generalisations, passive voice and punctuation.
2. **A trained classifier** (`neural.mjs`): a RoBERTa model ([onnx-community/tmr-ai-text-detector-ONNX](https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX)) trained directly to tell AI from human text on the [RAID benchmark](https://raid-bench.xyz/), which covers many different AI generators and domains. This is the same kind of model commercial detectors run, rather than a hand-built statistic.
3. **Word predictability** (`neural.mjs`): GPT-2 runs locally and scores how surprising each word is. Text written by a language model tends to be more predictable than human writing ("perplexity", in the terms these tools use). Ten summary statistics (average surprise, how much it varies, how often the model's top pick was chosen, and so on) are combined with the style score, plus a few "register" features so that formal and technical writing is judged fairly, by a second logistic-regression stage. Probabilities are calibrated with Platt scaling fitted on out-of-fold scores.

The final English score averages two models in logit space: the full stack above, and a second stack with the word-predictability (GPT-2) features removed. The GPT-2 features were learned mostly from older ChatGPT-era text and weaken on newer models, so this keeps them from overruling the classifier. It costs about one point of held-out accuracy, and on one real modern-style article it moved the score from 18% to 54%. That is a single example, not a measurement. Each sentence is scored in context for the highlight view: the classifier scores the sentence with its neighbours (up to 80 sentences; later ones use the style estimate), combined with the document score and a style estimate by a small model fitted on human and AI documents stitched together from the training corpus (sentence-level AUROC 0.90 on stitched holdout documents, this adds roughly a quarter of a second per sentence). Sentences of a document judged clearly human are never highlighted. Short passages are pulled toward "undecided", and every result shows which signals moved the score. English only.

**Both neural models (about 250 MB total) are plain files in `data/models`, loaded into memory at start and run offline on WebAssembly (no native binaries).** The app has no download code; keep the folder with the project. The page tells you while they load; until ready, or if unavailable, scores fall back to the style-only model. Set `KLEZA_NEURAL=off` to disable them, or pre-fetch them by starting the server once. Long texts are scored from up to six 240-word windows, so scoring a very long document takes a few seconds; the GPT-2 pass yields to the event loop every 16 words so the server stays responsive to other requests while it runs.

- The detector trains at server start from `detector/corpus.seed.jsonl` (plus labeled samples added on the **Model** page). `detector/neural-cache.json` holds pre-computed neural signals for the bundled corpus so training does not need to run either model. Samples you add yourself train the style model; the combined stage is trained from the bundled corpus.
- The **Model** tab shows the model card and the cross-validated benchmark of both stages, and lets you evaluate or retrain on your own labeled JSONL or CSV.
- Command line: `npm run detector:benchmark`, `npm run detector:benchmark -- --data labeled.jsonl`, `npm run detector:train -- --data labeled.csv`.

### Training data

`detector/corpus.seed.jsonl` (about 1,680 samples, English only) ships as a plain local file and is read into memory at start; the app never fetches training data over the network. It is mostly real text:

- Real human answers paired with ChatGPT answers (Reddit ELI5, finance, medicine, Wikipedia CS).
- Student-style human essays and AI essays.
- Human and AI essays and posts.
- Human and AI scientific abstracts.
- About 90 human-written scientific-paper and Wikipedia-based Q&A samples from **[MAGE](https://huggingface.co/datasets/yaful/MAGE)** (Apache 2.0; an ACL 2024 academic benchmark), added to strengthen scientific and technical writing — a persistent weak spot (see below). Apache 2.0 is the license MAGE's authors put on their own compiled file; the underlying text (arXiv papers, Wikipedia) carries whatever terms the original source has, which the tag doesn't settle by itself.
- Wikipedia and pre-2020 Hacker News comments as human text (only about 40 Hacker News comments are used, for statistics).
- About 130 samples written for this project. These are the weakest part of the corpus.

**What didn't make the cut:** MAGE also ships AI-generated text (about a dozen generators including GPT-3.5, GPT-J, GLM-130B, BLOOM and OPT/Flan-T5 variants) across nine more domains (Reddit opinion and Q&A threads, Yelp reviews, BBC/XSum news, TLDR summaries, WritingPrompts/ROCStories fiction, HellaSwag commonsense). Adding any of that AI-side text measurably hurt every benchmark below — accuracy on the ChatGPT holdout dropped as much as 5 points and human text got wrongly flagged noticeably more often, most likely because several of those generators are old and weak enough that their output overlaps awkwardly with plain human writing in the style features this detector uses. Adding the *human* side of those nine domains alone helped the ChatGPT holdout but measurably hurt AI recall on the mixed holdout and failed the leave-one-generator-out check, so it was left out too. Only the two human-only additions that measured as a clear, consistent improvement (scientific writing and Wikipedia Q&A) were kept. This is worth knowing if you extend the corpus yourself: more data is not automatically better data, and it needs to be measured, not assumed.

If you plan to redistribute or sell the corpus, have someone check the license of each underlying source first; several rows trace back to openly licensed but share-alike or attribution-required datasets, and one previously included source was removed for having no clear license.

### How accurate is it?

Measured on held-out files that are never trained on (duplicates against the corpus are removed and checked by `npm run test:detector`):

| | Style only | **Combined (English)** |
| --- | --- | --- |
| **ChatGPT-style answers** (`holdout.en.jsonl`, 670): accuracy | 83.6% | **93.9%** |
| AI text caught (recall) | 85.1% | **97.6%** |
| Human text wrongly flagged at the 50% line | 17.9% | **9.9%** |
| AUROC | 0.918 | **0.991** |
| **Mixed generators and domains** (`holdout.mixed.jsonl`, 201: essays, abstracts, other generators): accuracy | 69.7% | **88.6%** |
| AI text caught (recall) | 53.5% | **85.1%** |
| Human text wrongly flagged at the 50% line | 14.0% | **8.0%** |
| AUROC | 0.796 | **0.955** |
| **"Likely AI-generated" (score of 80% or more)**: precision, ChatGPT / mixed | 94% / 92% | **98.4% / 95.2%** |

Re-run with `npm run detector:benchmark -- --data detector/holdout.mixed.jsonl`, or run the regression checks with `npm run test:detector`.

On AI text from a **generator the model never saw in training at all** (trained with that source held out, then tested on it): (measured before the silentone rows were removed and not re-run since) the combined model caught 99% of ChatGPT-style text (style only: 50%), 96% of Claude-written text (style only: 80%), 94% of a third-party essay generator (75%) and 69% of an older GPT-2/3-style generator (30%). It still caught only 11% of unseen scientific-abstract AI text (style only: 37%) — adding the trained classifier barely moved that number, so dense technical writing remains a real, specific weak spot rather than something more training data alone will fix.

Known limits, so you do not over-trust a score:

- **Prefer the 80% "Likely AI-generated" verdict over the raw 50% line.** At 50% the detector still wrongly flags roughly 8 to 10% of human text; at 80% it is about 1.6 to 5%.
- **Scientific abstracts and other very formal writing** are the weakest genre (roughly 60-79% correct in the mixed holdout, and the specific weak spot above).
- **AI models newer than roughly mid-2024**, or any generator not represented in training at all, are the least reliably covered. Verified, clean labeled text specifically from GPT-4o/5, Claude 3+ or Gemini was searched for and not found in a usable form (see the rejected-dataset note above) — the `silentone0725` dataset claimed coverage of GPT-4/5 but was removed (see above), so that coverage is gone. Other tools, lightly edited AI text and humanized text can also score much lower. The tool cannot tell you what any other detector (QuillBot, Scribbr, NoteGPT, GPTZero, Turnitin, ZeroGPT) would say — each uses its own proprietary model, so scores will differ.
- Under about 80 words there is too little signal; the model reports low confidence.
- English only. Text in other languages is not detected reliably.
- The cross-validation figures (`npm run detector:benchmark`, and `GET /api/detector`) run higher than the held-out results because folds share sources. Trust the held-out numbers.
- For your own content, add labeled samples of the kind of writing you check and re-run the benchmark.

## Humanizer

- **Optional AI rewriting (off by default).** Set `LLM_PROVIDER` (`groq`, `openrouter`, `gemini` or `ollama`) and `LLM_API_KEY` in `.env` (see `.env.example`) and rewrites go to that OpenAI-compatible service instead (`llm.mjs`). The prompt asks for varied sentence length and plain wording and forbids changing facts; every attempt is scored by the detector, retried with its feedback up to `HUMANIZE_MAX_ATTEMPTS` times, and the best attempt that kept every number, quotation and required term is returned. Long texts are rewritten in chunks of about 1,200 words, one at a time (free tiers are rate-limited). **The text is sent to the service you choose.** If it fails (bad key, rate limit, outage), the built-in editor below does the rewrite and the result says so. A rewrite that loses a fifth or more of the words counts as unfaithful (the model dropped content), and markdown marks and non-breaking hyphens some models add are cleaned out. `npm run test:llm` checks all this against a mock service. One real run was made with Groq's `openai/gpt-oss-120b` on a 750-word text: the combined detector's score went from 70% to 4% in about a minute (3 to 4 attempts) with the number, quotation and keyword checks passing, and one earlier attempt had cut the text to 474 words (what the length rule now catches). That is one text, scored by this project's own detector, so it says nothing about third-party detectors.
- **Built-in editor (the default, and the fallback).** Rewrites run in two steps on this machine. (1) `humanizer.mjs` applies deterministic edits: stock phrases, buzzwords, formal transitions, contractions, and sentence rhythm. (2) `lexical.mjs` swaps adjectives, adverbs, nouns and verbs for close synonyms. WordNet (the `wordnet-db` package) proposes them, GPT-2 (the same local model the detector uses) rejects any word that does not fit its sentence, is rare, or makes the following words unlikely, and the detector's own score decides how many swaps to keep (the fewest that reach a score under 30%). Quotations, numbers, names, keywords and required terms are never touched, and the second step is skipped at the Light level or when the neural models are not loaded.
- **What it achieves, honestly:** step 1 alone barely moves the combined score (40 ChatGPT answers: 99% to 98%). Step 2 helps more but is limited: on a 750-word text only about 4 to 5 swaps pass the quality checks, which moved the combined score by roughly 4 to 22 points (for example 69.6% to 47.8%, and 41.7% to 37.7%) on the three versions tried, and it takes about a minute. The trained classifier's own score does not move: tests of many local edit types, and even real expert human edits (the Beemo dataset), changed it by less than 0.4 on its logit scale, against the roughly 4 needed to reach the 50% line. The score it lowers is this project's own combined detector, not any other tool's. A strongly AI-patterned text can still score high; for a bigger change, rewrite the highlighted sentences in your own words.
- **Tests:** `npm run test:humanizer` (rewrite rules, span edits and the guided search). It runs as part of `npm test`.

Input limits are 50,000 words and 400,000 characters per analysis. Use 80 or more words for a meaningful AI-likelihood estimate.

## Run locally

Requirements: Node.js 20+.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:3001` and creates its SQLite database at `data/kleza.db`.

For a production build:

```bash
npm run build
set NODE_ENV=production
npm start
```

Then open `http://localhost:3001`.

## Environment variables

Copy `.env.example` to `.env` and add your credentials. The `npm run dev` and `npm start` commands automatically load that file when present. For other launch methods, use your deployment platform, shell, or process manager to inject the variables.

- `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` — optional AI rewriting through an OpenAI-compatible service (see Humanizer). `HUMANIZE_TARGET` (default `0.15`) and `HUMANIZE_MAX_ATTEMPTS` (default `4`) set how hard it tries.
- `SEARCH_PROVIDER` (`searxng`, `brave` or `google`), `SEARCH_BASE_URL` (your SearXNG address), `SEARCH_API_KEY`, `SEARCH_CX` (Google only): optional web search for the plagiarism check; off until set. `SEARCH_MIN_INTERVAL_MS` changes the spacing between searches (default 1100 for Brave). `WIKI_API` and `SEARCH_BASE_URL` override the service addresses (the tests use them).
- `PORT` — optional API/production port; defaults to `3001`.
- `KLEZA_NEURAL` — set to `off` to skip the neural models (RAID classifier and GPT-2 word predictability, about 250 MB in `data/models`). Scores then use the style-only model.
- The detector makes **no network request for its data**: training data is read from `detector/*.jsonl` and the models from `data/models`, both into memory, and checking a text uses only what is in memory. There is no download code. Without the model files the app still works, on the style-only model.
- Other network use is only what you trigger: URL import (and the optional LLM rewrite). OCR language data ships with the app.
- `KLEZA_ACCESS_TOKEN` — optional. When set, every `/api` call (except health) needs this token, and the page asks for it once per browser session. Set it before exposing the app beyond your own machine.
- `RATE_LIMIT_PER_MIN` (default 300) and `RATE_LIMIT_HEAVY_PER_MIN` (default 60, for analyze, rewrite, upload and URL import) — per-client request limits; `0` disables limiting. Set `TRUST_PROXY` (`true` or a hop count) when running behind a reverse proxy so clients are told apart.
- `CORS_ORIGIN` — optional comma-separated list of origins allowed to call the API from another site. By default no CORS headers are sent; the bundled page is same-origin.
- `KLEZA_ALLOW_PRIVATE_URLS` — set to `true` only if you deliberately want URL import and source comparison to reach private or local addresses (for example an intranet). By default they are blocked.

API keys are used only by the server and are never exposed to browser code.

## OCR and credential-dependent features

- Rewrites use the built-in local pattern engine; there is no AI-service rewrite.
- **From URL** (`extract.mjs`) finds the article on a page and leaves out menus, sidebars, comments, related links, cookie notices, reference lists and footers. It works on pages with no `<article>` tag and on old table-layout pages, keeps headings and paragraphs in order, cleans the site name off the title, and reads the author, date and site name. A link to a plain-text file is used as it is, and pages that declare their encoding only in `<meta charset>` are decoded correctly. You can type an address without `https://`. After an import the app shows where the text came from and warns when little text was found (a JavaScript-built page, a login or a paywall) or when the page is mostly links, such as a topic listing. Pages over 50,000 words are cut to the limit with a warning, and a PDF link tells you to use Upload file. It is a heuristic: it can still include a stray caption or miss a section on an unusual page, so check the imported text. `npm run test:extract` covers it.
- Importing a URL requires that the public website allow server-side access. Paywalls, bot protection, and login-only pages return an actionable error. Fetches are guarded against server-side request forgery: private, loopback and cloud-metadata addresses are refused (checked again at every redirect and at connection time), and only HTML or text pages up to 5 MB are accepted.
- Rewrites run as background jobs (`POST /api/rewrite/jobs`, then poll `GET /api/rewrite/jobs/:id`, cancel with `DELETE`), so a long rewrite reports progress and can be cancelled. `POST /api/rewrite` still works for short, direct calls.
- Image-only PDFs are rendered and processed locally with Tesseract OCR (English), up to 15 pages per upload, and return an actionable error for encrypted or unreadable PDFs.

## Plagiarism checker

The **Plagiarism** tab (`plagiarism.mjs`, `POST /api/plagiarism`) looks for passages of your text that also appear in other sources, and shows the share of the text matched, the matched passages marked in the text, and each source with the passages it contains.

- **How it matches:** a run of **8 or more words that is exactly the same**, ignoring case, punctuation and spacing. A run made mostly of common words ("it is one of the…") is ignored. Passages inside quotation marks are reported separately and are not counted, since they are cited. Results are rounded to a tenth of a percent.
- **Sources (each can be switched off):** (1) **Wikipedia**, searched with your most distinctive sentences (5, more for longer texts, up to 10) as exact phrases, no key needed; (2) **scientific papers**, free with no key: Europe PMC searches the full text of open-access medical and science papers for the same sentences, and the paper text (not its reference list) is compared (it covers science and medicine only, not blogs or news); (3) **the web**, optional: the same sentences are searched with Brave Search (or Google) and the top results are read, only once you set a free key (see below); (4) **pages you list**, up to five, fetched with the same safe fetcher as From URL (private addresses are refused) and reduced to their article text; (5) **your own saved texts and history**, skipping any entry that is the same text as the one you are checking. Without a search key there is no web search, and the result says so; you can still list a page's address. Web search is paced (about one search a second on Brave's free plan, retried once if it says "too many requests") and the check stops after about 90 seconds and says so. Search engines can take days to index a new post, so when the results point at the same site twice or more, the checker also reads that site's most recently changed posts from its sitemap (up to 6 per site, 2 sites). Each sentence is searched as written (hyphens and capitals kept); if that finds nothing, the end of the sentence is tried, and only then a loose search (top two results). The result's **What was searched** list shows every search and how many results it returned, so a 0% can be explained. If your text is published on your own site, put that site under "Ignore my own site" so the page does not match itself.
- **A 0% is not a clean bill of health:** if no source could be read (for example only Wikipedia was selected and it has no page with your sentences), the result says **"Nothing was compared"** and shows "—" instead of a percentage, and tells you what was and was not searched. Only a score with "Compared with N sources" means those sources had nothing matching.
- **Free web search with SearXNG (no key):** [SearXNG](https://docs.searxng.org/) is an open-source meta-search engine you run yourself; it asks public search engines for results, so it costs nothing, but it is not a complete web index and the engines behind it may sometimes refuse or throttle it, so results vary. With Docker: `docker run -d --name searxng -p 127.0.0.1:8080:8080 -v "%cd%/searxng:/etc/searxng" searxng/searxng`, then in `searxng/settings.yml` make sure `search: formats:` lists `json` as well as `html` and restart it. Then put `SEARCH_PROVIDER=searxng` and `SEARCH_BASE_URL=http://localhost:8080` in `.env` and restart. It only finds candidate addresses; the pages are then fetched by this server (private addresses refused) and compared word for word. Keep the instance private to your machine.
- **Setting up web search with a key:** create an account at [brave.com/search/api](https://brave.com/search/api/), pick the free plan (about 2,000 searches a month; a card may be asked for identity only) and copy the key. Put `SEARCH_PROVIDER=brave` and `SEARCH_API_KEY=your-key` in `.env` and restart. Google Programmable Search works too (`SEARCH_PROVIDER=google`, `SEARCH_API_KEY`, `SEARCH_CX`; about 100 free searches a day). Each check uses 5 searches, plus one more for every 150 words of text, up to 10, so the free plan covers roughly 200 to 400 checks a month. Never paste the key into a chat or commit it.
- **Privacy:** the whole text is never sent anywhere. Only short phrases (up to 14 words each, 5 to 10 of them) go to Wikipedia, Europe PMC and, if you set it up, your search provider, and pages you list are fetched by the server. The sentence model runs on this machine.
- **Reworded text ("Possible rewording"):** a second step looks, in the sentences the exact step did not flag, for sentences that say the same thing in other words. TF-IDF with cosine similarity (word overlap, with rare words weighted more) shortlists up to five source sentences per sentence; then a sentence-embedding model (`all-MiniLM-L6-v2`, a Sentence-BERT model, run locally by `embed.mjs`) judges whether they mean the same, and a pair is reported at a cosine of 0.65 or more. These are listed separately and do not change the exact-match percent. The threshold was measured on a small sample (a real 7,000-word Wikipedia article: hand-written rewordings scored 0.60 to 0.88, same-topic sentences saying something different at most 0.50, and 60 unrelated sentences at most 0.58, so 0.65 caught 7 of 8 rewordings with no false alarms), so treat it as a rough setting. Facts that are simply true will match, so read each pair. Without the model files it falls back to word overlap alone (cosine 0.6), labelled "similar wording", which finds only close rewordings. Turn it off with the "Also look for reworded text" box.
- **What it cannot do, so do not over-trust a clean result:** it finds copied and lightly edited text, and rewording only when the source sentence was read and the meaning stays close; it does not find translation, text behind a login or paywall, printed books, or any source it never reads. A high match is something to review (it may be a properly cited passage or a common phrase), not a verdict. There is no built-in database of the whole web.
- Every check is saved to **Reports** with its match share and sources, and appears in the CSV export. `npm run test:plagiarism` covers the matching rules, the rewording step (with a stand-in for the model, and with the real model when its files are present) and the full flow with mock Wikipedia, search and web pages.
## Validation

```bash
npm test                # rewrite rules, the offline check and the end-to-end smoke test
npm run test:security   # URL-fetch guard, rate limits, access token, CORS
npm run test:detector   # accuracy on the held-out benchmark files (style-only and combined)
npm run test:neural     # the real word-predictability model, end to end (skips until data/models has it)
npm run test:offline    # proves the detector makes no network request (fetch is stubbed to fail)
npm run test:ui         # builds, then drives the real app in Chrome or Edge (skips if none is installed)
```

The smoke test covers analysis, AI-likelihood detection with sentence probabilities, the 50,000-word limit (and a text just under it), detector evaluation, retraining and reset, rewriting, quality checks, SQLite persistence, saved-content selection, TXT and DOCX extraction, a generated image-only PDF OCR pass, URL import, reports, and DOCX export.

## Credits and licenses

The detector and the humanizer use the third-party models and data below. Everything listed here is free to use, including commercially, if the notices stay with it. This is a summary of what each project's own page says, not legal advice: check the linked license texts, and get a legal review before shipping this in a paid product.

**Models loaded from `data/models`** (the files are ONNX conversions, quantized, of the original models and carry the same licenses):

| Model | Used for | License |
|---|---|---|
| [`onnx-community/tmr-ai-text-detector-ONNX`](https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX), converted from [`Oxidane/tmr-ai-text-detector`](https://huggingface.co/Oxidane/tmr-ai-text-detector) ("TMR", a RoBERTa-base classifier trained on the RAID benchmark) | The trained AI-text classifier | MIT |
| [`FacebookAI/roberta-base`](https://huggingface.co/FacebookAI/roberta-base) | The base model the classifier was fine-tuned from | MIT |
| [`Xenova/gpt2`](https://huggingface.co/Xenova/gpt2), converted from [`openai-community/gpt2`](https://huggingface.co/openai-community/gpt2) | GPT-2 word-predictability signals | MIT (OpenAI's original; the conversion page states no license of its own) |

**Other components**

| Component | Used for | License |
|---|---|---|
| [WordNet 3.0](https://wordnet.princeton.edu/) data, read from the [`wordnet-db`](https://www.npmjs.com/package/wordnet-db) package | Synonyms for the word-swap step | Princeton University's WordNet license: free for any purpose without fee, provided its copyright notice and disclaimer appear on all copies (the file is `node_modules/wordnet-db/LICENSE`; keep it if you redistribute the data) |
| [`openai/gpt-oss-120b`](https://huggingface.co/openai/gpt-oss-120b) through Groq (optional, only when `LLM_PROVIDER` is set) | The optional AI rewrite | Apache-2.0 for the model; Groq's own terms and rate limits apply to the service, and the text is sent to it |
| [`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2), converted from [`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) (22 MB, quantized) | Sentence embeddings for the plagiarism checker's rewording step | Apache-2.0 (keep the license notice; the files go in `data/models/Xenova__all-MiniLM-L6-v2/`: `tokenizer.json`, `tokenizer_config.json` and `onnx/model_quantized.onnx`) |
| [RAID](https://raid-bench.xyz/) benchmark | What the classifier was trained on, and part of the bundled corpus | See the data sources under "Detection model" above |

**What to do when you ship this:** keep these credits (or an equivalent notice) somewhere users can see them, such as an About page; keep the `LICENSE` files that come with the models and with WordNet if you redistribute them; and check the license of each dataset in `detector/` before you redistribute or sell the training corpus, as noted under "Detection model". The npm packages in `package.json` have their own licenses, which you can list with `npx license-checker --summary`.

Credit where it is due: the TMR classifier (Oxidane), RoBERTa (Meta AI / Facebook), GPT-2 (OpenAI), MiniLM and Sentence-BERT (Microsoft Research, the Sentence-Transformers authors), the ONNX conversions (Xenova and the ONNX Community on Hugging Face), WordNet (Princeton University) and the RAID benchmark (Dugan et al.).
## Deploying

The app is one Node server that also serves the built UI. It needs a host that can run a long-lived Node process with about 1 GB of RAM (the two neural models are about 250 MB on disk and load into memory); serverless platforms are not a good fit.

**Docker (recommended)**

```bash
docker build -t kleza .
docker run -p 3001:3001 -v kleza-data:/app/data -e TRUST_PROXY=1 -e KLEZA_ACCESS_TOKEN=choose-a-secret kleza
```

The `data/models` folder must be present when you build (it is not in git). On first start the models are copied into the mounted `/app/data` volume, which also holds the database. A health check hits `/api/health`; the page shows the models as loading for the first minute.

**Without Docker**

```bash
npm ci
npm run build
set NODE_ENV=production
set TRUST_PROXY=1
npm start
```

Checklist before going public:

- Put the app behind HTTPS (the platform or a reverse proxy) and set `TRUST_PROXY` so rate limits use the real client address.
- Set `KLEZA_ACCESS_TOKEN` unless you want anyone to be able to use it. Note that "My Content" and "Reports" are shared by everyone who can reach the app: there are no user accounts.
- Keep `.env` out of git (it is already ignored). If you use an AI rewrite service, the key lives only in the host's environment.
- Back up `data/kleza.db`.
- The server sends security headers (a strict Content-Security-Policy, no framing) and shuts down cleanly on SIGTERM.
# aicontentdetector
