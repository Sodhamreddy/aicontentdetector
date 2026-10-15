import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';

const testDb=fileURLToPath(new URL('./smoke.db',import.meta.url));
const testModel=fileURLToPath(new URL('./detector-model.json',import.meta.url));
for(const f of [testDb,testDb+'-wal',testDb+'-shm',testModel]) if(fs.existsSync(f)) fs.rmSync(f);
process.env.KLEZA_DB_PATH=testDb;
process.env.PORT='0';
process.env.KLEZA_NEURAL='off'; // never download or run the language model in tests (tests/neural.test.mjs covers it)
process.env.RATE_LIMIT_PER_MIN='0'; // the smoke test makes many rapid calls
process.env.KLEZA_ALLOW_PRIVATE_URLS='true'; // its URL-import fixture runs on 127.0.0.1; blocked by default
const {server,db}=await import('../server.mjs');
const fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><head><title>Fixture Article</title><meta name="description" content="Import test"></head><body><nav>Skip</nav><article><h1>A useful guide</h1><p>This is a complete public article fixture with enough practical content to validate the URL import workflow from beginning to end.</p><p>The second paragraph confirms that multiple content blocks are extracted while unrelated navigation is removed.</p></article></body></html>')});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));

const base=`http://127.0.0.1:${server.address().port}/api`;
const ok=async(path,options)=>{const r=await fetch(base+path,options);const body=await r.json();if(!r.ok)throw new Error(`${path}: ${body.error}`);return body};
const post=(path,body)=>ok(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const sample="In today's fast-paced world, it is important to note that home care matters. Furthermore, many families need practical help. Additionally, a clear routine can significantly improve daily life. In conclusion, it is crucial to choose carefully.";

await new Promise(r=>setTimeout(r,500));
const health=await ok('/health');
const analysis=await post('/analyze',{title:'Smoke Test',text:sample});
if(!analysis.id||!analysis.issues.length)throw new Error('Analysis did not produce persisted findings.');
// Trained detector: calibrated document probability plus per-sentence probabilities.
if(typeof analysis.detection?.probability!=='number'||!analysis.detection.verdict||!analysis.detection.confidence)throw new Error('AI-likelihood detection missing from analysis.');
if(!analysis.sentenceSignals.every(s=>typeof s.aiProbability==='number'&&s.aiConfidence))throw new Error('Sentence-level AI probabilities missing.');
const humanSample="Went to the hardware store twice today because I bought the wrong size screws, then the right screws but no anchors. The shelf is up now. It's a little crooked. My partner says it's fine; I say it's a design choice. Cost me $23 and a whole Saturday afternoon, but hey, it holds the plants.";
const humanAnalysis=await post('/analyze',{title:'Human sample',text:humanSample});
if(!(analysis.detection.probability>humanAnalysis.detection.probability))throw new Error(`Detector did not rank the formulaic sample above the casual one (${analysis.detection.probability} vs ${humanAnalysis.detection.probability}).`);
if(analysis.language!=='English'||analysis.readabilityFormula!=='Flesch Reading Ease')throw new Error('English-only analysis metadata missing.');
// Longer input: above the old 50,000-character cap but within the 50,000-word limit.
const longText=Array.from({length:800},(_,i)=>`Paragraph ${i+1} explains a practical step for planning weekly meals.`).join(' ');
if(longText.length<=50000)throw new Error('Long-input fixture is too short.');
const longAnalysis=await post('/analyze',{title:'Long',text:longText});if(longAnalysis.words<5000)throw new Error('Long text was not fully analyzed.');
const tooLong=await fetch(base+'/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'word '.repeat(50001)})});if(tooLong.status!==400)throw new Error('50,000-word limit not enforced.');
const atLimit=await post('/analyze',{title:'At the limit',text:'The quick brown fox jumps over the lazy dog near the river. '.repeat(4166)});if(atLimit.words!==49992)throw new Error('A text just under the 50,000-word limit was not fully analyzed.');
// Detector model card, benchmark, evaluation on labeled data, retraining, and reset.
const model=await ok('/detector');if(!model.benchmark?.overall?.auroc||!model.training.languages.English||!model.caveat)throw new Error('Detector model card incomplete.');
const labeled=[{text:sample+' '+sample,label:'ai'},{text:humanSample,label:'human'}].map(x=>JSON.stringify(x)).join('\n');
const evaluation=await post('/detector/evaluate',{data:labeled});if(evaluation.samples!==2||evaluation.confusion.truePositive+evaluation.confusion.falseNegative!==1)throw new Error('Detector evaluation failed.');
const csvEval=await post('/detector/evaluate',{data:`text,label\n"${humanSample.replace(/"/g,'""')}",human\n"${sample}",ai`,format:'csv'});if(csvEval.samples!==2)throw new Error('CSV evaluation failed.');
const retrained=await post('/detector/train',{data:labeled});if(retrained.added!==2||retrained.workspaceSamples!==2||retrained.training.samples!==model.training.samples+2)throw new Error('Detector retraining failed.');
const reset=await post('/detector/reset',{});if(reset.workspaceSamples!==0||reset.training.samples!==model.training.samples)throw new Error('Detector reset failed.');
const shortEval=await fetch(base+'/detector/evaluate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:'{"text":"too short","label":"ai"}\n{"text":"also short","label":"human"}'})});if(shortEval.status!==400)throw new Error('Evaluation with no usable samples should be rejected.');
const pretty=await post('/detector/evaluate',{data:JSON.stringify([{text:humanSample,label:'human'},{text:sample+' '+sample,label:'ai'}],null,2)});if(pretty.samples!==2)throw new Error('Pretty-printed JSON array was not accepted.');
const single=await post('/rewrite',{text:sample,original:sample,analysisId:analysis.id,issue:analysis.issues[0],options:{level:'Natural',required:['home care']}});
if(single.text===sample)throw new Error('Issue-level fix did not change the selected passage.');
const revision=await post('/rewrite',{text:sample,original:sample,analysisId:analysis.id,options:{level:'Natural',required:['home care']}});
if(!revision.text||revision.checks.length<4)throw new Error('Rewrite or quality checks failed.');
const saved=await post('/content',{title:'Smoke Test',body:revision.text});
const library=await ok('/content');
if(!library.some(x=>x.id===saved.id))throw new Error('Saved content missing from library.');
const reports=await ok('/reports');
if(!reports.some(x=>x.id===analysis.id&&x.revised))throw new Error('Revised report missing.');
const form=new FormData();form.append('file',new Blob(['Uploaded text for extraction and editing.']), 'upload-test.txt');
const upload=await ok('/upload',{method:'POST',body:form});
if(!upload.text.includes('Uploaded text'))throw new Error('TXT extraction failed.');
const imported=await post('/url',{url:`http://127.0.0.1:${fixture.address().port}/article`});
if(imported.title!=='Fixture Article'||!imported.text.includes('second paragraph'))throw new Error('URL extraction failed.');
const docx=await fetch(base+'/download/docx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Smoke',text:revision.text})});
const docxBytes=await docx.arrayBuffer();
if(!docx.ok||docxBytes.byteLength<500)throw new Error('DOCX export failed.');
const docxForm=new FormData();docxForm.append('file',new Blob([docxBytes],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),'roundtrip.docx');
const docxUpload=await ok('/upload',{method:'POST',body:docxForm});
if(!docxUpload.text.toLowerCase().includes('home care'))throw new Error('DOCX extraction failed.');
const canvas=createCanvas(1100,250);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1100,250);ctx.fillStyle='black';ctx.font='bold 52px Arial';ctx.fillText('Scanned invoice number 4827',45,115);ctx.font='32px Arial';ctx.fillText('Payment is due on Friday.',45,175);
const imagePdf=await PDFDocument.create(),page=imagePdf.addPage([550,125]),png=await imagePdf.embedPng(canvas.toBuffer('image/png'));page.drawImage(png,{x:0,y:0,width:550,height:125});
const ocrForm=new FormData();ocrForm.append('file',new Blob([await imagePdf.save()],{type:'application/pdf'}),'scan.pdf');const ocrUpload=await ok('/upload',{method:'POST',body:ocrForm});
if(!ocrUpload.ocr||!ocrUpload.text.includes('4827'))throw new Error(`Image-only PDF OCR failed: ${ocrUpload.text}`);
console.log(JSON.stringify({health,analysis:{score:analysis.score,issues:analysis.issues.length,aiLikelihood:analysis.detection.percent,humanSampleAiLikelihood:humanAnalysis.detection.percent,longWords:longAnalysis.words},detector:{samples:model.training.samples,cvAuroc:model.benchmark.overall.auroc,evaluatedAccuracy:evaluation.accuracy},singleFix:'ok',rewrite:{provider:revision.provider,checks:revision.checks.map(x=>x.status)},saved:saved.id,existingContentSelection:library.length,upload:[upload.title,docxUpload.title],ocr:{title:ocrUpload.title,recognized:ocrUpload.text},urlImport:imported.title,reports:reports.length,docx:'ok'},null,2));
fs.writeFileSync('tests/.last-smoke.json',JSON.stringify({passed:true,at:new Date().toISOString()},null,2));
await new Promise(resolve=>server.close(resolve));
await new Promise(resolve=>fixture.close(resolve));
db.close();
for(const f of [testDb,testDb+'-wal',testDb+'-shm',testModel]) if(fs.existsSync(f)) fs.rmSync(f);
