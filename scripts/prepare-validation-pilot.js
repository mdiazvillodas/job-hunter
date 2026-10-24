'use strict';
// Preparation only: no fetch, HTTP clients, browsers, hunts or process spawning.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),original='C:/Users/maria/job-hunter';
const out=path.join(root,'private-baseline/validation-pilot');
fs.mkdirSync(out,{recursive:true});
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'docs/validation-pilot/fixtures.json'),'utf8'));
const local=require('../src/ai/jobAnalyzer');
const originalAnalyzer=require(path.join(original,'src/ai/jobAnalyzer'));
const simple=require('../src/ai/simpleProfile');
const packagedSimple=require('../dist/Job-Hunter-0.2-simple-diagnostico/src/ai/simpleProfile');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const selection=[
 ['M1','4455895513','Buen encaje ejercido: Product Operations'],
 ['M2','4457672044','Transferencia: Senior Deployment Manager'],
 ['M3','4467709377','Frontera MAYBE que resultó útil: Director of Operations'],
 ['M4','4430277391','Interés documentado: Business Integration'],
 ['M5','4355787565','Oferta descartada pese a score alto: Product Manager'],
 ['M6','4457600069','Descarte profesional: People Operations']
];
const profileBytes=fs.readFileSync(path.join(root,'private-baseline/marianoMatchingProfile.json'));
const activeBytes=fs.readFileSync(path.join(original,'src/ai/marianoMatchingProfile.json'));
assert.equal(hash(profileBytes),hash(activeBytes),'La referencia de Mariano cambió: detener, no mezclar perfiles');
const profile=JSON.parse(profileBytes);
const records=selection.map(([id,jobId,purpose])=>{
 const bytes=fs.readFileSync(path.join(root,'private-baseline/jobs',jobId+'.json'));
 const job=JSON.parse(bytes);assert(job.description?.length>=300);assert(job.aiAnalysis);
 assert.equal(local.buildSystemPrompt(profile),originalAnalyzer.buildSystemPrompt(profile));
 assert.equal(local.buildUserPrompt(job),originalAnalyzer.buildUserPrompt(job));
 return {id,purpose,job,history:{analysis:job.aiAnalysis,userState:job.userState,feedback:job.feedback,feedbackEvents:job.feedbackEvents},sha256:hash(bytes)};
});
const pairs=records.map(r=>({id:r.id,jobId:r.job.jobId,title:r.job.title,purpose:r.purpose,decision:r.job.aiAnalysis.decision,score:r.job.aiAnalysis.overallMatchScore,status:r.job.userState?.status,sha256:r.sha256}));
fs.writeFileSync(path.join(out,'frozen-cases.json'),JSON.stringify({profile,records,fixtures},null,2),{mode:0o600});
for(const file of ['src/ai/jobAnalyzer.js','src/domain/descriptionQuality.js','src/domain/sources.js']){
 const target=path.join(out,'original-code',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(original,file),target);
}
fs.writeFileSync(path.join(out,'case-index.json'),JSON.stringify(pairs,null,2),{mode:0o600});
const diagnostics=Object.fromEntries(Object.entries(fixtures.profiles).map(([key,text])=>[key,simple.diagnose(text)]));
for(const [key,text]of Object.entries(fixtures.profiles))assert.deepEqual(packagedSimple.diagnose(text),diagnostics[key],'Diagnóstico del instalable distinto: '+key);
for(const [key,job]of Object.entries(fixtures.jobs))assert(job.description.length>=300,key);
// Conservative input bound: serialized request bytes plus 2048 tokens for framing.
const sizes=records.map(r=>({id:r.id,inputBytes:Buffer.byteLength(JSON.stringify({messages:[{role:'system',content:local.buildSystemPrompt(profile)},{role:'user',content:local.buildUserPrompt(r.job)}],response_format:{type:'json_schema',json_schema:{name:'job_analysis',strict:true,schema:local.JOB_ANALYSIS_SCHEMA}}}))}));
assert(sizes.every(s=>s.inputBytes+2048<=65536),'Supera el techo de entrada: no truncar, revisar protocolo');
const zip=path.join(root,'dist/Job-Hunter-0.2-simple-Diagnostico-Windows.zip');
const report={preparedAt:'2026-10-18',baseCandidateCommit:'193426a',candidateRevision:'diagnostico-contenido-v1',diagnosisSHA256:hash(fs.readFileSync(path.join(root,'src/ai/profileDiagnosis.js'))),status:'PREPARED_NOT_AUTHORIZED',apiCallsExecuted:0,scrapesExecuted:0,plannedCalls:{marianoPaired:12,architecture:8,freshJobs:2,maximum:22,retries:0},budget:{currency:'USD',inputPerMillion:0.4,outputPerMillion:1.6,maxInputTokensPerCall:65536,maxOutputTokensPerCall:32768,upperEstimate:22*(65536*0.4+32768*1.6)/1e6,authorizationCeiling:2,excludes:'Impuestos y cambio de divisa; sin descuentos por cache'},historicalCases:6,architectureCases:8,profileSHA256:hash(profileBytes),packageSHA256:hash(fs.readFileSync(zip)),maxHistoricalRequestBytes:Math.max(...sizes.map(s=>s.inputBytes)),diagnostics,localDiagnosisRegression:'A8 rechazado como suficiente; junior aceptado; 13 regresiones locales aprobadas',knownBlockers:[],privateCaseIndex:'private-baseline/validation-pilot/case-index.json',paidSemanticEvaluation:'NOT_RUN',liveScraping:'NOT_RUN'};
if(diagnostics.superficial.status==='Perfil suficientemente documentado')report.knownBlockers.push('A8: el diagnóstico acepta un perfil superficial con todos los encabezados; no aprueba todavía la comunicación de carencias. No se modificó el producto.');
if(!fs.readFileSync(path.join(root,'instances/mariana/src/ai/candidate.md'),'utf8').trim())report.knownBlockers.push('Mariana no tiene todavía un perfil real cargado: no se puede aprobar su calidad personalizada con fixtures.');
fs.writeFileSync(path.join(root,'docs/validation-pilot/preflight.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({historicalCases:6,architectureCases:8,apiCallsExecuted:0,scrapesExecuted:0,upperEstimate:report.budget.upperEstimate,knownBlockers:report.knownBlockers},null,2));
