import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Database from 'better-sqlite3';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import * as pdfjs from 'pdf-parse';
import { pdf as renderPdf } from 'pdf-to-img';
import { createWorker } from 'tesseract.js';
import { extractArticle, withScheme } from './extract.mjs';
import { checkPlagiarism, tokenize, wikipedia, europePmc, searchProvider } from './plagiarism.mjs';
import { initEmbedder, embedTexts, embedderStatus } from './embed.mjs';
import { Document, Packer, Paragraph } from 'docx';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { safeGet, rateLimiter, accessGate } from './security.mjs';
import { initNeural, neuralLocalLogits, neuralSettled, neuralSignals, neuralStatus, neuralWordFit } from './neural.mjs';
import { humanizeLexical } from './lexical.mjs';
import { loadSignalsCache } from './signals-cache.mjs';
import { fileURLToPath } from 'url';
import * as detector from './detector.mjs';
import { humanizeSpan, humanizeGuided, refineLong } from './humanizer.mjs';
import { llmConfig, llmChat } from './llm.mjs';
import { Worker } from 'worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const MAX_CHARS = 400000, MAX_WORDS = 50000;
const db = new Database(process.env.KLEZA_DB_PATH || path.join(__dirname, 'data', 'kleza.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS content (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT DEFAULT 'approved', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS analyses (id INTEGER PRIMARY KEY, title TEXT, original TEXT NOT NULL, revised TEXT, score INTEGER, issues TEXT, checks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY, analysis_id INTEGER, body TEXT NOT NULL, label TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS detector_samples (id INTEGER PRIMARY KEY, text TEXT NOT NULL, label INTEGER NOT NULL, language TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
// ai_after / provider / kind record humanizer runs in the history: kind is 'check' (a detector run) or 'rewrite'.
for (const [col, type] of [['ai_probability', 'REAL'], ['language', 'TEXT'], ['ai_after', 'REAL'], ['provider', 'TEXT'], ['kind', "TEXT DEFAULT 'check'"], ['plagiarism', 'REAL']]) {
  const cols = db.prepare('PRAGMA table_info(analyses)').all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE analyses ADD COLUMN ${col} ${type}`);
}

// Train the statistical detector on the seed corpus plus user-contributed labeled samples.
let detectorModel;
const modelFile = path.join(path.dirname(process.env.KLEZA_DB_PATH || path.join(__dirname, 'data', 'kleza.db')), 'detector-model.json');
function trainingSet() {
  const seed = detector.loadSeedCorpus(__dirname);
  const extra = db.prepare('SELECT text,label,language FROM detector_samples').all().map((r) => ({ text: r.text, label: r.label, language: r.language || undefined }));
  return { samples: [...seed, ...extra], source: extra.length ? `seed corpus + ${extra.length} workspace samples` : 'seed corpus' };
}
function useModel(model) { detectorModel = model; try { fs.writeFileSync(modelFile, JSON.stringify(model, null, 2)); } catch {} return model; }
// Word-predictability signals for the bundled corpus (see neural.mjs) let the detector train its combined model.
const signalsCache = loadSignalsCache(__dirname);
// Startup: reuse the saved model when it was trained on exactly this data; otherwise train before serving.
(() => {
  const { samples, source } = trainingSet();
  try { const cached = JSON.parse(fs.readFileSync(modelFile, 'utf8')); if (cached.cacheKey === detector.corpusKey(samples, signalsCache.salt)) { detectorModel = cached; return; } } catch {}
  useModel(detector.train(samples, { source, signalsFor: signalsCache.signalsFor, cacheSalt: signalsCache.salt }));
})();
// The neural models (a RAID-trained classifier and a GPT-2 word-predictability model, ~250 MB total) are read from
// data/models into memory in the background; nothing is fetched. Until ready, or if the files are absent, the detector uses
// its style-only model. KLEZA_NEURAL=off disables it.
const modelsDir = path.join(path.dirname(process.env.KLEZA_DB_PATH || path.join(__dirname, 'data', 'kleza.db')), 'models');
initNeural({ dir: modelsDir });
// Signals for a text about to be scored (null when the model is not ready).
// A check made while the models are still loading would silently use the weaker style-only score, so wait (up to 20 s) first.
const signalsFor = async (text) => { await neuralSettled(20000); return neuralSignals(text); };
// The classifier's verdict on each sentence (with its neighbours), used to highlight which sentences look most like AI.
// Bounded so a very long text stays quick: sentences past the cap fall back to the style-only local estimate.
const LOCAL_WINDOWS_MAX = 80;
async function localTmrFor(text) {
  const sents = sentencePatternSignals(text).map((s) => s.text);
  const windows = sents.slice(0, LOCAL_WINDOWS_MAX).map((s, i) => ((s.match(/\S+/g) || []).length < 4 ? null : sents.slice(Math.max(0, i - 1), i + 2).join(' ')));
  return neuralLocalLogits(windows);
}
// Runtime retraining runs in a worker thread; the current model keeps serving until the new one is ready.
let retraining = Promise.resolve();
function retrainDetector() {
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./detector-worker.mjs', import.meta.url), { workerData: { ...trainingSet(), dir: __dirname } });
    worker.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(useModel(m.model))));
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Training worker exited with code ${code}.`)); });
  });
  retraining = retraining.catch(() => {}).then(run); // serialize concurrent retrains
  return retraining;
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
// Baseline security headers for a public deployment (the UI is same-origin and loads nothing from other sites).
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  if (process.env.NODE_ENV === 'production' && req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});
// No CORS headers unless CORS_ORIGIN lists allowed origins (the bundled UI is same-origin, and the dev proxy keeps it so).
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : false }));
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
// RATE_LIMIT_PER_MIN (default 300) and RATE_LIMIT_HEAVY_PER_MIN (default 60: analyze, rewrite, upload, url). 0 disables.
app.use(rateLimiter({ max: Number(process.env.RATE_LIMIT_PER_MIN ?? 300), heavyMax: Number(process.env.RATE_LIMIT_HEAVY_PER_MIN ?? 60) }));
// KLEZA_ACCESS_TOKEN, when set, is required on every /api call except health and provider webhooks.
app.use(accessGate(process.env.KLEZA_ACCESS_TOKEN));
app.use(express.json({ limit: '10mb' }));

const patterns = [
  { type:'Generic opening', severity:'Medium', re:/\b(in today['’]?s|in the (?:modern|digital|ever-evolving)|in (?:a|an|this) (?:rapidly|ever)[- ](?:changing|evolving)|when it comes to|it is important to note)\b[^.!?]*[.!?]/gi, explanation:'This familiar opening delays the main point.', suggestion:'Open with a specific claim, observation, or benefit.' },
  { type:'Stock phrase', severity:'Medium', re:/\b(digital landscape|(?:rapidly|ever)[- ](?:changing|evolving)|fast-paced|cutting-edge|valuable insights|various industries|sustainable growth|informed decisions|unlock (?:new |their |your |its )?(?:opportunities|potential)|remain competitive|overall productivity|enhance customer experiences?|improve efficiency|shap(?:e|es|ing) the future|plays? an? (?:crucial|vital|pivotal|key|significant) role|seamless(?:ly)?|leverag(?:e|es|ing)|delv(?:e|es|ing) into|a testament to|navigat(?:e|ing) the (?:complexities|challenges)|harness(?:ing)? the power|in the realm of|a wide range of|a myriad of|foster(?:ing)? (?:a culture|innovation|growth)|drive (?:innovation|growth)|empower(?:s|ing)? (?:businesses|individuals|teams|users))\b/gi, explanation:'A stock phrase common in machine-generated and marketing copy; it says little the reader can picture.', suggestion:'Replace it with the concrete thing you mean: a number, a named example, or a specific outcome.' },
  { type:'Predictable transition', severity:'Low', re:/\b(furthermore|moreover|in conclusion|additionally|in summary)\b/gi, explanation:'Formulaic transitions can make the flow feel mechanical.', suggestion:'Connect the ideas directly or use a more specific transition.' },
  { type:'Vague claim', severity:'High', re:/\b(many (?:people|businesses|experts)|research shows|studies (?:show|suggest)|significantly|numerous benefits|game[- ]changer)\b/gi, explanation:'The claim is broad or lacks evidence the reader can verify.', suggestion:'Name the source, add a concrete example, or narrow the claim.' },
  { type:'Impersonal phrasing', severity:'Low', re:/\b(it is (?:essential|crucial|vital|important) to|one must|there are several)\b/gi, explanation:'Abstract phrasing creates distance from the reader.', suggestion:'Use a direct subject and an active verb.' }
];

function sentences(text){ return text.match(/[^.!?\n]+[.!?]?/g)?.map(s=>s.trim()).filter(Boolean) || []; }
function countSyllables(word){ word=word.toLowerCase().replace(/[^a-z]/g,''); if(word.length<=3)return 1; return Math.max(1,(word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/,'').match(/[aeiouy]{1,2}/g)||[]).length); }
function readability(text){ const s=Math.max(1,sentences(text).length), words=text.match(/[\p{L}\p{N}’'-]+/gu)||[], n=Math.max(1,words.length);
  const syl=words.reduce((t,w)=>t+countSyllables(w),0); return Math.max(0,Math.min(100,Math.round(206.835-1.015*(n/s)-84.6*(syl/n)))); }
function wordCount(text){ return (text.match(/[\p{L}\p{N}’'-]+/gu)||[]).length; }
function sentencePatternSignals(text){let cursor=0;return sentences(text).map((sentence,index)=>{const start=text.indexOf(sentence,cursor);cursor=Math.max(cursor,start+sentence.length);const wordCount=(sentence.match(/\b[\wáéíóúñü’'-]+\b/gi)||[]).length;let raw=8,reasons=[];for(const p of patterns){const re=new RegExp(p.re.source,p.re.flags.replace('g',''));if(re.test(sentence)){raw+=p.severity==='High'?35:p.severity==='Medium'?23:14;reasons.push(p.type)}}if(wordCount>32){raw+=18;reasons.push('Very long sentence')}if(wordCount>12&&/^(In |It is |There are|Furthermore|Moreover|Additionally)/i.test(sentence)){raw+=12;reasons.push('Predictable construction')}const score=Math.max(3,Math.min(96,Math.round(raw))),confidence=wordCount<8?'Low':reasons.length>1?'High':'Medium',label=score>=70?'Strongly patterned':score>=45?'Patterned':score>=25?'Mixed':'Natural';return{id:`s${index+1}`,index,start,end:start+sentence.length,text:sentence,score,confidence,label,reasons}})}
function analyzeText(text, opts={}){
  const issues=[];
  for(const p of patterns){ for(const m of text.matchAll(p.re)){ issues.push({ id:`i${issues.length+1}`, type:p.type, severity:p.severity, start:m.index, end:m.index+m[0].length, excerpt:m[0], explanation:p.explanation, suggestion:p.suggestion }); } }
  const ss=sentences(text), lengths=ss.map(s=>(s.match(/\b\w+\b/g)||[]).length);
  if(lengths.length>4){ const avg=lengths.reduce((a,b)=>a+b,0)/lengths.length; const variance=lengths.reduce((n,x)=>n+(x-avg)**2,0)/lengths.length; if(Math.sqrt(variance)<4) issues.push({id:`i${issues.length+1}`,type:'Uniform sentence rhythm',severity:'Medium',start:0,end:Math.min(text.length,180),excerpt:text.slice(0,180),explanation:'Sentence lengths vary very little, creating a repetitive cadence.',suggestion:'Mix short emphasis with longer explanatory sentences.'}); }
  const phrases=new Map();
  const words=text.toLowerCase().match(/\b[a-z]{4,}\b/g)||[];
  for(let i=0;i<words.length-2;i++){const p=words.slice(i,i+3).join(' ');phrases.set(p,(phrases.get(p)||0)+1)}
  const repeated=[...phrases].find(([,n])=>n>=3);
  if(repeated){const start=text.toLowerCase().indexOf(repeated[0]);issues.push({id:`i${issues.length+1}`,type:'Repeated phrase',severity:'Medium',start,end:start+repeated[0].length,excerpt:text.slice(start,start+repeated[0].length),explanation:`“${repeated[0]}” appears ${repeated[1]} times.`,suggestion:'Replace or remove repeated wording where it adds no meaning.'})}
  const weights={High:15,Medium:9,Low:5};
  const score=Math.min(96,Math.max(4,Math.round(18+issues.reduce((n,i)=>n+weights[i.severity],0)+(lengths.length>3?6:0))));
  const totalWords=wordCount(text),signalConfidence=totalWords<80?'Low':totalWords<250?'Medium':'High';
  const patternSignals=sentencePatternSignals(text);
  const detection=detector.detect(detectorModel,text,'English',patternSignals.map(s=>s.text),opts.signals,opts.localTmr);
  const sentenceSignals=patternSignals.map((s,i)=>{const d=detection.sentences[i];return d?{...s,aiProbability:Math.round(d.probability*100),aiConfidence:d.confidence}:s});
  const {sentences:_omit,...detectionSummary}=detection;
  const scoringMode=opts.signals&&detectorModel.stack?'combined':'style-only',classifierPercent=Number.isFinite(opts.signals?.tmr)?Math.round(100/(1+Math.exp(-opts.signals.tmr))):null;
  return { score, issues, sentenceSignals, signalConfidence, scoringMode, classifierPercent, language:'English', readability:readability(text), readabilityFormula:'Flesch Reading Ease', words:totalWords, detection:detectionSummary, disclaimer:'A heuristic writing-pattern indicator—not proof of AI authorship.' };
}

// Local fallback: the deterministic humanizer (see humanizer.mjs). With an issue, only that span is rewritten.
function localRewrite(text, level='Natural', issue=null){
  const options={level};
  if(issue)return humanizeSpan(text,issue.start,issue.end,options);
  // Whole-text rewrites keep only the sentence-boundary edits that lower the detector's score.
  return humanizeGuided(text,{...options,budgetMs:1500,score:(t)=>detector.predict(detectorModel,t).logit});
}
// AI-likelihood as a whole percent, or null when the text is too short to score. `signals` are the word-predictability signals, if available.
function aiPercent(text,signals=null){ const d=detector.detect(detectorModel,text,'English',undefined,signals); return d.probability==null?null:d.percent; }
// Rewrites run entirely on this machine (humanizer.mjs, then lexical.mjs); no external AI service is called.
// Step 1 is the phrase/rhythm editor. Step 2 swaps words for fitting synonyms (WordNet + GPT-2, kept only as far as the
// detector's score needs) and is skipped when the Light level is chosen or the neural models are not loaded.
// With an LLM configured (llm.mjs) the text is rewritten by it, scored by the detector after every attempt, and retried with
// the detector's feedback. If that service fails (rate limit, bad key, outage) the built-in engine below does the rewrite instead.
async function llmRewrite(cfg,text,options,hooks){
  // The rewrite must keep at least HUMANIZE_MIN_LENGTH of the words (default 90%), so a low score cannot come from cutting content.
  // Attempts are close to independent samples, so a stalled score does not mean the next one will not do better: stop after three.
  const minLength=Number(process.env.HUMANIZE_MIN_LENGTH)||0.9;
  // Chunks of about 600 words keep each request (prompt plus the output allowance it asks for) under a free tier's 8,000 tokens a minute.
  const run=(t)=>refineLong({text:t,options:{...options,minLength},minLength,stallLimit:3,concurrency:1,maxChunkWords:Number(process.env.LLM_CHUNK_WORDS)||600,onProgress:hooks.onProgress,signal:hooks.signal,
    maxAttempts:Number(process.env.HUMANIZE_MAX_ATTEMPTS)||5,target:Number(process.env.HUMANIZE_TARGET)||0.15,
    generate:(prompt,{signal}={})=>llmChat(cfg,prompt,{signal,maxTokens:Math.min(8192,Math.max(3000,wordCount(prompt)*3+2500))}),
    score:async(candidate)=>{const d=detector.detect(detectorModel,candidate,'English',undefined,await signalsFor(candidate));return {probability:d.probability,signals:(d.towardAI||[]).map((s)=>s.label)};}});
  return run(text);
}
async function rewriteText(text, options, issue, hooks={}){
  const cfg=llmConfig();
  if(cfg){
    try{
      if(issue){const r=await llmRewrite(cfg,text.slice(issue.start,issue.end),options,hooks);return {text:text.slice(0,issue.start)+r.text+text.slice(issue.end),provider:cfg.name,attempts:r.attempts}}
      const r=await llmRewrite(cfg,text,options,hooks);
      return {text:r.text,provider:cfg.name,attempts:r.attempts,note:r.faithful?undefined:'No attempt kept the full text and every fact, so the most complete one is shown. Check it against the original.'};
    }catch(e){if(hooks.signal?.aborted)throw e;hooks.fallback=`The ${cfg.name} rewrite failed (${e.message}), so the built-in editor was used instead.`}
  }
  hooks.onProgress?.({done:0,total:2});
  let out=localRewrite(text,options.level,issue),provider='Local pattern engine',note=hooks.fallback;
  hooks.onProgress?.({done:1,total:2});
  if(options.level!=='Light'&&neuralStatus().status==='ready'){
    const protect=[options.primary,...(options.secondary||[]),...(options.required||[])];
    const score=async(t)=>{const d=detector.detect(detectorModel,t,'English',undefined,await neuralSignals(t));return d.probability};
    try{
      const lex=await humanizeLexical(out,{fit:neuralWordFit,protect,signal:hooks.signal,...(issue?{minWords:5,share:1}:{score})});
      if(lex.changes){out=lex.text;provider='Local engine + word swaps';note=[note,`Swapped ${lex.changes} word${lex.changes===1?'':'s'} for close synonyms.`].filter(Boolean).join(' ')}
    }catch(e){if(hooks.signal?.aborted)throw e;note=[note,'The word-swap step was skipped ('+String(e.message).slice(0,80)+').'].filter(Boolean).join(' ')} // the phrase edits above still apply
  }
  hooks.onProgress?.({done:2,total:2});
  return {text:out,provider,note};
}
function checks(original,revised,required=[]){
  const nums=s=>s.match(/\b\d+(?:\.\d+)?%?\b/g)||[];
  const quotes=s=>s.match(/[“"][^”"]+[”"]/g)||[];
  const preserved=required.every(k=>revised.toLowerCase().includes(k.toLowerCase()));
  const factual=JSON.stringify(nums(original))===JSON.stringify(nums(revised)) && quotes(original).every(q=>revised.includes(q));
  const wordDelta=Math.abs(revised.length-original.length)/Math.max(1,original.length);
  return [
    {name:'Meaning preservation',status:wordDelta<.35?'Passed':'Needs Review',detail:wordDelta<.35?'Scope and length remain comparable.':'The revision changed substantially; review meaning.'},
    {name:'Factual consistency',status:factual?'Passed':'Needs Review',detail:factual?'Numbers and quotations were preserved.':'A number or quotation may have changed.'},
    {name:'Required keywords',status:preserved?'Passed':'Needs Review',detail:preserved?'All required terms remain present.':'At least one required term is missing.'},
    {name:'Grammar & readability',status:'Passed',detail:`Readability score ${readability(revised)}/100; pattern scan completed.`},
  ];
}


app.get('/api/health',(_,res)=>res.json({ok:true,llm:llmConfig()?.name||null,search:searchProvider()?.name||null,embedder:embedderStatus().status,neural:{...neuralStatus(),combined:!!detectorModel.stack}}));
app.post('/api/analyze',async(req,res)=>{try{const {text,title='Untitled'}=req.body;if(!text?.trim())return res.status(400).json({error:'Add text before analysis.'});if(text.length>MAX_CHARS)return res.status(400).json({error:`Text exceeds the ${MAX_CHARS.toLocaleString('en-US')}-character limit.`});if(wordCount(text)>MAX_WORDS)return res.status(400).json({error:`Text exceeds the ${MAX_WORDS.toLocaleString('en-US')}-word limit. Split it into parts and analyze each one.`});const signals=await signalsFor(text);const result=analyzeText(text,{signals,localTmr:signals?await localTmrFor(text):null});const info=db.prepare('INSERT INTO analyses(title,original,score,issues,ai_probability,language) VALUES(?,?,?,?,?,?)').run(title,text,result.score,JSON.stringify(result.issues),result.detection.probability,result.language);res.json({...result,id:Number(info.lastInsertRowid)});}catch(e){res.status(500).json({error:e.message})}});
class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
function assertRewriteInput(body){
  const text=body?.text;
  if(typeof text!=='string'||!text.trim())throw new HttpError(400,'Add text before rewriting.');
  if(text.length>MAX_CHARS)throw new HttpError(400,`Text exceeds the ${MAX_CHARS.toLocaleString('en-US')}-character limit.`);
  if(wordCount(text)>MAX_WORDS)throw new HttpError(400,`Text exceeds the ${MAX_WORDS.toLocaleString('en-US')}-word limit. Split it into parts.`);
}
// One implementation behind both the direct endpoint and background jobs.
async function runRewrite(body,hooks={}){
  assertRewriteInput(body);
  const {text,original=text,options={},issue,analysisId}=body;
  const result=await rewriteText(text,options,issue,hooks);
  const quality=checks(original,result.text,options.required||[]);
  const beforeSignals=await signalsFor(text),afterSignals=await signalsFor(result.text);
  const aiBefore=aiPercent(text,beforeSignals),aiAfter=aiPercent(result.text,afterSignals);
  // Every humanizer run is kept in the history (Reports): linked to the check it came from when the caller says which, otherwise as its
  // own entry. A single-passage "Fix this" without a linked check is not saved on its own: the re-check that follows it is.
  const prob=(p)=>p==null?null:p/100,label=`${issue?'Issue fix':'Full rewrite'} · ${result.provider}${aiBefore!=null&&aiAfter!=null?` · ${aiBefore}% → ${aiAfter}%`:''}`;
  let historyId=null;
  if(analysisId){
    db.prepare('UPDATE analyses SET revised=?,checks=?,ai_after=?,provider=? WHERE id=?').run(result.text,JSON.stringify(quality),prob(aiAfter),result.provider,analysisId);
    db.prepare('INSERT INTO versions(analysis_id,body,label) VALUES(?,?,?)').run(analysisId,result.text,label);historyId=Number(analysisId);
  }else if(!issue){
    const info=db.prepare("INSERT INTO analyses(title,original,revised,score,issues,checks,ai_probability,ai_after,provider,language,kind) VALUES(?,?,?,?,?,?,?,?,?,?,'rewrite')")
      .run(body.title||(original.trim().split(/\s+/).slice(0,7).join(' ').replace(/[.,;:!?]+$/,'')||'Untitled'),original,result.text,null,'[]',JSON.stringify(quality),prob(aiBefore),prob(aiAfter),result.provider,'English');
    historyId=Number(info.lastInsertRowid);
    db.prepare('INSERT INTO versions(analysis_id,body,label) VALUES(?,?,?)').run(historyId,result.text,label);
  }
  const note=[result.note,aiAfter!=null&&aiAfter>=50?'The built-in editor swaps phrases and words but cannot restructure a text, so a strongly AI-patterned one may still score high.':null].filter(Boolean).join(' ')||undefined;
  return {...result,checks:quality,aiBefore,aiAfter,note,historyId,analysis:analyzeText(result.text,{signals:afterSignals})};
}
const rewriteError=(e)=>e instanceof HttpError?{status:e.status,error:e.message}:{status:500,error:`Rewrite failed: ${e.message}`};
app.post('/api/rewrite',async(req,res)=>{try{res.json(await runRewrite(req.body))}catch(e){const {status,error}=rewriteError(e);res.status(status).json({error})}});

// Background rewrite jobs: a long text can take a while, so the UI starts a job, polls its progress, and can cancel it.
const jobs=new Map(),MAX_RUNNING_JOBS=3,JOB_TTL_MS=30*60*1000;
const runningJobs=()=>[...jobs.values()].filter((j)=>j.status==='running').length;
function pruneJobs(){const now=Date.now();for(const [id,j] of jobs)if(j.status!=='running'&&now-j.finishedAt>JOB_TTL_MS)jobs.delete(id)}
app.post('/api/rewrite/jobs',(req,res)=>{
  try{assertRewriteInput(req.body)}catch(e){return res.status(e.status||400).json({error:e.message})}
  pruneJobs();
  if(runningJobs()>=MAX_RUNNING_JOBS)return res.status(429).json({error:'Several rewrites are already running. Please wait for one to finish.'});
  const id=crypto.randomUUID(),controller=new AbortController(),job={status:'running',done:0,total:1,controller};
  jobs.set(id,job);
  runRewrite(req.body,{signal:controller.signal,onProgress:({done,total})=>{job.done=done;job.total=total}})
    .then((result)=>{if(job.status==='running'){job.status='done';job.result=result}})
    .catch((e)=>{if(job.status!=='running')return;if(controller.signal.aborted)job.status='cancelled';else{job.status='error';job.error=rewriteError(e).error}})
    .finally(()=>{job.finishedAt=Date.now()});
  res.status(202).json({id});
});
app.get('/api/rewrite/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'That rewrite was not found. It may have expired.'});res.json({status:j.status,done:j.done,total:j.total,...(j.status==='done'?{result:j.result}:{}),...(j.status==='error'?{error:j.error}:{})})});
app.delete('/api/rewrite/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'That rewrite was not found.'});if(j.status==='running'){j.status='cancelled';j.finishedAt=Date.now();j.controller.abort()}res.json({status:j.status})});

// Detection model: model card, benchmark, evaluation on user-labeled data, and retraining.
const detectorInfo=()=>({version:detectorModel.version,trainedAt:detectorModel.trainedAt,source:detectorModel.source,training:detectorModel.training,benchmark:detectorModel.benchmark,combined:detectorModel.stack?{trainedOn:detectorModel.stack.trainedOn,benchmark:detectorModel.stack.benchmark}:null,neural:neuralStatus(),features:detector.FEATURES.map(([key,label])=>({key,label})),workspaceSamples:db.prepare('SELECT COUNT(*) n FROM detector_samples').get().n,limits:{maxWords:MAX_WORDS,maxChars:MAX_CHARS,recommendedMinWords:80},caveat:'English only. Combines three signals: writing style, a RoBERTa classifier trained on the RAID benchmark (the same kind of trained classifier that commercial detectors use, covering many AI generators), and GPT-2 word predictability. Trained on about 2,050 samples: real human and ChatGPT answers (HC3), student-style essays, general essays and scientific abstracts from several AI generators, Wikipedia and Wikinews, Hacker News, human-written scientific and Wikipedia Q&A text added from the MAGE benchmark, AI texts generated with recent Gemini models, and some AI text written for this project. On held-out data the combined model scored about 94% accuracy on ChatGPT-style answers and about 89% on a mixed set of essays, abstracts and other generators. When it says "Likely AI-generated" it was right about 95 to 98% of the time, but at the plain 50% line it still wrongly flags roughly 8 to 10% of human text. It is weakest on scientific abstracts (a known gap even with the added classifier), formal writing, edited or humanized AI text and non-native writers. Text from AI models newer than about mid-2024, or from any AI generator not represented in training, is less reliably covered; a labeled dataset naming GPT-4o/Claude/Gemini specifically was tried and found to be corrupted (random watermark-like tokens spliced into both classes) and was excluded rather than used. Cross-validation figures are optimistic because folds share sources. Evaluate on your own labeled data before relying on it, and never treat a score as proof of authorship.'});
function labeledFromBody(body){ if(Array.isArray(body.samples)) return body.samples.map(s=>({text:String(s?.text||'').trim(),label:detector.normalizeLabel(s?.label),language:detector.normalizeLanguage(s?.language)})).filter(s=>s.text&&s.label!==null); return detector.parseLabeled(body.data,body.format); }
app.get('/api/detector',(_,res)=>res.json(detectorInfo()));
app.post('/api/detector/evaluate',(req,res)=>{try{const samples=labeledFromBody(req.body);if(samples.length<2)return res.status(400).json({error:'Provide at least two labeled samples (text + label of "ai" or "human").'});if(samples.length>5000)return res.status(400).json({error:'Evaluate up to 5,000 samples at a time.'});res.json({...detector.evaluate(detectorModel,samples),model:detector.modelSummary(detectorModel)});}catch(e){res.status(400).json({error:`Could not read the labeled data. ${e.message}`})}});
app.post('/api/detector/train',async(req,res)=>{let samples;try{samples=labeledFromBody(req.body).filter(s=>wordCount(s.text)>=20);}catch(e){return res.status(400).json({error:`Could not read the labeled data. ${e.message}`})}if(!samples.length)return res.status(400).json({error:'No usable samples. Each needs 20+ words and a label of "ai" or "human".'});if(samples.length>5000)return res.status(400).json({error:'Add up to 5,000 samples at a time.'});try{const ins=db.prepare('INSERT INTO detector_samples(text,label,language) VALUES(?,?,?)');db.transaction(()=>samples.forEach(s=>ins.run(s.text,s.label,'English')))();await retrainDetector();res.json({added:samples.length,...detectorInfo()});}catch(e){res.status(500).json({error:`Training failed. ${e.message}`})}});
app.post('/api/detector/reset',async(_,res)=>{try{db.prepare('DELETE FROM detector_samples').run();await retrainDetector();res.json(detectorInfo());}catch(e){res.status(500).json({error:`Reset failed. ${e.message}`})}});
app.get('/api/content',(req,res)=>{const q=`%${req.query.q||''}%`;res.json(db.prepare('SELECT * FROM content WHERE title LIKE ? OR body LIKE ? ORDER BY updated_at DESC').all(q,q))});
app.post('/api/content',(req,res)=>{const {title='Untitled',body}=req.body;if(!body?.trim())return res.status(400).json({error:'There is no content to save.'});const x=db.prepare('INSERT INTO content(title,body) VALUES(?,?)').run(title,body);res.json({id:Number(x.lastInsertRowid),success:true})});
app.delete('/api/content/:id',(req,res)=>{db.prepare('DELETE FROM content WHERE id=?').run(req.params.id);res.json({success:true})});
// History: every detector check and every humanizer run. The list leaves the texts out; the detail and the CSV include them.
const historyRow=(x)=>({...x,kind:x.kind||'check',issues:JSON.parse(x.issues||'[]'),checks:JSON.parse(x.checks||'[]'),revised:!!x.revised});
app.get('/api/reports',(_,res)=>res.json(db.prepare("SELECT id,title,score,issues,checks,ai_probability,ai_after,plagiarism,provider,kind,language,created_at,revised IS NOT NULL as revised,length(original) as chars FROM analyses ORDER BY created_at DESC,id DESC").all().map(historyRow)));
const csvCell=(v,guard=false)=>{let s=v==null?'':String(v);if(guard&&/^[=+\-@\t\r]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`}; // a leading = + - @ would run as a formula in Excel
app.get('/api/reports/export.csv',(_,res)=>{
  const rows=db.prepare("SELECT id,kind,title,created_at,language,ai_probability,ai_after,plagiarism,score,issues,provider,original,revised FROM analyses ORDER BY created_at DESC,id DESC").all();
  const pctOf=(p)=>p==null?'':`${Math.round(p*100)}%`,wc=(s)=>s?(s.match(/\S+/g)||[]).length:'';
  const head=['ID','Type','Title','Date (UTC)','Language','AI likelihood (before)','AI likelihood (after)','Plagiarism match','Pattern score','Issues','Edited with','Words (original)','Words (revised)','Original text','Revised text'];
  const body=rows.map((r)=>[r.id,r.kind==='rewrite'?'Rewrite':r.kind==='plagiarism'?'Plagiarism':'Check',csvCell(r.title,true),r.created_at,r.language||'',pctOf(r.ai_probability),pctOf(r.ai_after),pctOf(r.plagiarism),r.score??'',JSON.parse(r.issues||'[]').length,r.provider||'',wc(r.original),wc(r.revised),csvCell(r.original,true),csvCell(r.revised,true)]
    .map((c,i)=>(i===2||i>=13)?c:csvCell(c)));
  res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="kleza-history.csv"'});
  res.send('﻿'+[head.map((h)=>csvCell(h)),...body].map((r)=>r.join(',')).join('\r\n')+'\r\n'); // BOM so Excel reads UTF-8; CRLF rows
});
app.get('/api/reports/:id',(req,res)=>{
  const row=db.prepare('SELECT * FROM analyses WHERE id=?').get(req.params.id);
  if(!row)return res.status(404).json({error:'That history entry was not found.'});
  res.json({...historyRow(row),revised:row.revised,versions:db.prepare('SELECT id,body,label,created_at FROM versions WHERE analysis_id=? ORDER BY created_at DESC,id DESC').all(req.params.id)});
});
app.get('/api/settings',(_,res)=>res.json(Object.fromEntries(db.prepare('SELECT * FROM settings').all().map(x=>[x.key,JSON.parse(x.value)]))));
app.put('/api/settings',(req,res)=>{const up=db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');const tx=db.transaction(o=>Object.entries(o).forEach(([k,v])=>up.run(k,JSON.stringify(v))));tx(req.body);res.json({success:true})});


async function ocrPdf(buffer){
  const document=await renderPdf(`data:application/pdf;base64,${buffer.toString('base64')}`,{scale:2.2});
  if(document.length>15){document.destroy?.();throw new Error('OCR supports up to 15 pages per upload. Split this PDF and try again.');}
  // English OCR data ships with the app.
  let worker;try{worker=await createWorker('eng');}catch(e){document.destroy?.();throw new Error(`The OCR language data could not be loaded. ${e.message||e}`);}const pages=[];
  try{let page=0;for await(const image of document){page++;const {data}=await worker.recognize(image);if(data.text?.trim())pages.push(data.text.trim());}}
  finally{await worker.terminate();document.destroy?.();}
  return pages.join('\n\n');
}
app.post('/api/upload',upload.single('file'),async(req,res)=>{try{if(!req.file)return res.status(400).json({error:'Choose a file to upload.'});const ext=path.extname(req.file.originalname).toLowerCase();let text='',ocr=false;if(ext==='.txt')text=req.file.buffer.toString('utf8');else if(ext==='.docx')text=(await mammoth.extractRawText({buffer:req.file.buffer})).value;else if(ext==='.doc'){const doc=await new WordExtractor().extract(req.file.buffer);text=doc.getBody();}else if(ext==='.pdf'){let parser;try{parser=pdfjs.PDFParse?new pdfjs.PDFParse({data:req.file.buffer}):null;const data=parser?await parser.getText():await pdfjs.default(req.file.buffer);text=data.text;}catch(e){if(/password|encrypt/i.test(e.message))throw new Error('This PDF is encrypted. Remove the password and upload it again.');}finally{if(parser)await parser.destroy();}const meaningfulTokens=text?.match(/[A-Za-z0-9]{2,}/g)||[];if(meaningfulTokens.length<3){text=await ocrPdf(req.file.buffer);ocr=true;}if(!text?.trim())throw new Error('OCR completed but no readable text was found. Try a clearer scan.');}else return res.status(415).json({error:'Unsupported file. Upload TXT, DOC, DOCX, or PDF.'});res.json({title:path.basename(req.file.originalname,ext),text:text.trim(),ocr,message:ocr?'Text recovered from the scanned PDF with OCR.':'Text extracted successfully.'});}catch(e){res.status(422).json({error:`Could not read this file. ${e.message}`})}});
// Import a page: fetch it safely (security.mjs), then extract the readable article (extract.mjs). Plain-text links are used as they are.
const urlProblem=(status)=>status===401||status===403?'The site refused automated access (it may need a login or block bots), so the page could not be read.':status===404||status===410?'The page was not found. Check the address.':status===429?'The site is rate-limiting requests. Try again in a minute.':status>=500?`The site had a server problem (${status}). Try again later.`:`The page returned ${status}.`;
app.post('/api/url',async(req,res)=>{try{
  let address=String(req.body?.url||'').trim();if(!address)throw new Error('Enter a page address.');
  address=withScheme(address); // "example.com/page" works without the https://
  const response=await safeGet(address);if(response.status>=400)throw new Error(urlProblem(response.status));
  const page=response.type==='text/plain'
    ?{title:new URL(response.url).pathname.split('/').filter(Boolean).pop()||new URL(response.url).hostname,text:response.body.replace(/\r\n?/g,'\n').split(/\n\s*\n+/).map((p)=>p.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n\n'),metadata:{url:response.url,siteName:new URL(response.url).hostname,extractor:'plain-text'},warnings:[]}
    :extractArticle(response.body,response.url);
  if(page.text.length<100)throw new Error(page.warnings[0]||'No usable article text was found on this page.');
  let text=page.text;const warnings=[...page.warnings];
  if(wordCount(text)>MAX_WORDS){text=text.split(/(\s+)/).slice(0,MAX_WORDS*2).join('').trim();warnings.push(`The page is longer than the ${MAX_WORDS.toLocaleString('en-US')}-word limit, so only the first ${MAX_WORDS.toLocaleString('en-US')} words were imported.`)}
  res.json({title:page.title,text,metadata:{...page.metadata,words:wordCount(text),url:page.metadata.url||response.url},warnings});
}catch(e){res.status(422).json({error:`Could not import URL. ${e.message}`})}});
// Plagiarism check (plagiarism.mjs): exact matches of 8+ words, and reworded sentences, against Wikipedia, pages the user lists and the user's own
// saved texts and, when SEARCH_PROVIDER and a key are set (free tiers exist), the first web results for a few distinctive sentences.
// Each source is optional and the answer says what was read.
const wiki=wikipedia(process.env.WIKI_API||undefined);
const readPage=async(address)=>{const r=await safeGet(withScheme(address),{timeoutMs:9000});if(r.status>=400)throw new Error(urlProblem(r.status));if(r.type==='text/plain')return {title:r.url,text:r.body,url:r.url};const a=extractArticle(r.body,r.url);return {title:a.title,text:a.text,url:r.url}};
const sameText=(a,b)=>tokenize(a).map((t)=>t.w).join(' ')===tokenize(b).map((t)=>t.w).join(' ');
app.post('/api/plagiarism',async(req,res)=>{try{
  const {text,title,options={}}=req.body||{};
  if(typeof text!=='string'||wordCount(text)<30)return res.status(400).json({error:'Add at least 30 words to check for plagiarism.'});
  if(text.length>MAX_CHARS||wordCount(text)>MAX_WORDS)return res.status(400).json({error:'Text exceeds the '+MAX_WORDS.toLocaleString('en-US')+'-word limit. Split it into parts.'});
  const search=searchProvider();
  // The user's own saved texts and history, minus any entry that is this very text (it would match itself 100%).
  const library=()=>{const out=[];
    for(const c of db.prepare('SELECT id,title,body FROM content ORDER BY id DESC LIMIT 300').all())if(!sameText(c.body,text))out.push({id:'content:'+c.id,type:'My Content',title:c.title||'Saved text',text:c.body});
    for(const h of db.prepare('SELECT id,title,original,revised FROM analyses ORDER BY id DESC LIMIT 300').all()){for(const [k,t] of [['',h.original],[' (rewrite)',h.revised]])if(t&&!sameText(t,text))out.push({id:'history:'+h.id+k,type:'History',title:'#'+h.id+' '+(h.title||'Untitled')+k,text:t})}
    return out};
  const result=await checkPlagiarism(text,
    {urls:(Array.isArray(options.urls)?options.urls:String(options.urls||'').split(/[\s,]+/)).map(String).map((u)=>u.trim()).filter(Boolean),wikipedia:options.wikipedia!==false,scholar:options.scholar!==false,web:!!search&&options.web!==false,ignore:(Array.isArray(options.ignore)?options.ignore:String(options.ignore||'').split(/[\s,]+/)).map(String).map((h)=>h.trim()).filter(Boolean),library:!!options.library,paraphrase:options.paraphrase!==false},
    {fetchPage:readPage,wikiSearch:wiki.wikiSearch,wikiPage:wiki.wikiPage,...europePmc(process.env.EUROPEPMC_API||undefined),webSearch:search?.search,sitemap:async(u)=>{const r=await safeGet(u,{timeoutMs:9000,maxBytes:2*1024*1024,xml:true});if(r.status>=400)throw new Error(`sitemap returned ${r.status}`);return r.body},library,
     embed:async(texts)=>(await initEmbedder(modelsDir))?embedTexts(texts):null}, {});
  const name=title||tokenize(text).slice(0,7).map((t)=>t.w).join(' ')||'Untitled';
  const checksList=result.sources.map((s)=>({name:s.title,status:s.percent+'% matched',detail:(s.type+(s.url?' · '+s.url:''))}));
  // Sources that matched only in meaning or wording are listed after the exact ones.
  const onlySimilar=new Map();for(const s of result.similar||[])if(!result.sources.some((x)=>x.id===s.source.id)){const e=onlySimilar.get(s.source.id)||{name:s.source.title,n:0,detail:s.source.type+(s.source.url?' · '+s.source.url:'')};e.n++;onlySimilar.set(s.source.id,e)}
  for(const e of onlySimilar.values())checksList.push({name:e.name,status:e.n+' similar sentence'+(e.n===1?'':'s'),detail:e.detail});
  const info=db.prepare("INSERT INTO analyses(title,original,score,issues,checks,ai_probability,plagiarism,provider,language,kind) VALUES(?,?,?,?,?,?,?,?,?,'plagiarism')")
    .run(name,text,null,'[]',JSON.stringify(checksList),null,result.percent/100,'Plagiarism check','English');
  res.json({...result,historyId:Number(info.lastInsertRowid),search:search?.name||null,embedder:embedderStatus().status});
}catch(e){res.status(500).json({error:'Plagiarism check failed. '+e.message})}});

app.post('/api/download/docx',async(req,res)=>{const doc=new Document({sections:[{children:req.body.text.split(/\n+/).map(x=>new Paragraph(x))}]});const buf=await Packer.toBuffer(doc);res.set({'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':`attachment; filename="${(req.body.title||'kleza-content').replace(/[^a-z0-9-_]/gi,'-')}.docx"`}).send(buf)});

if(process.env.NODE_ENV==='production'){app.use(express.static(path.join(__dirname,'dist'),{setHeaders:(res,file)=>res.setHeader('Cache-Control',file.includes(`${path.sep}assets${path.sep}`)?'public, max-age=31536000, immutable':'no-cache')}));
  // Single-page-app fallback. A middleware rather than app.get('*'), which Express 5 rejects at startup.
  app.use((req,res,next)=>req.method==='GET'&&!req.path.startsWith('/api')?res.sendFile(path.join(__dirname,'dist','index.html')):next())}
const port=process.env.PORT||3001;const server=app.listen(port,()=>console.log(`Kleza API running on http://localhost:${port}`));
// Let the host (Docker, Render, Fly, systemd) stop the app cleanly: finish open requests, then close the database.
const shutdown = () => { server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); }); setTimeout(() => process.exit(0), 10000).unref(); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
export { app, server, db };
