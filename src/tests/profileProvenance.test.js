const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),os=require('os');
const {profileUnits,attachProfileProvenance}=require('../ai/profileProvenance');
const {present}=require('../ui/public/profilePresentation');
const fixtures=require('../../docs/validation-pilot/fixtures.json');
const p={capabilities:{operations:[{point:'Rutinas operativas',evidence:'Diseñé rutinas operativas y coordiné entregas.',restriction:'No trabajé con OKR.'}]},education:[{statement:'Estudios incompletos.',degreeAwarded:false}]};
const row=(classification,reference,requirement='Cadencias OKR')=>({requirement,classification,profileReference:reference,note:'Experiencia parcial en OKR inventada.'});
const analysis=rows=>({requirementAssessments:rows,summary:'Inventó AutoCAD.',transferableExperience:['Inventó experiencia parcial OKR.'],gaps:['No tiene experiencia M&A.'],reasoning:'Texto no verificado.',decision:'MAYBE',overallMatchScore:65,professionalFitScore:60,interestFitScore:70,cvFitScore:60,confidence:75});
test('unidad completa: conserva evidencia, negación y condición sin permitir referencias internas',()=>{
 const units=profileUnits(p);assert.equal(units[0].reference,'/capabilities/operations/0');assert.deepEqual(units[0].content,p.capabilities.operations[0]);
 const a=attachProfileProvenance(analysis([row('DIRECT_MATCH','/capabilities/operations/0/evidence')]),p);assert.equal(present(a)[0].source,null);
 const b=present(attachProfileProvenance(analysis([row('DIRECT_MATCH','/education/0')]),p))[0];assert.equal(b.source.content.degreeAwarded,false);
});
test('M3: cita real conserva la negación y no acredita OKR; equivalencia es inferencia',()=>{
 const view=present(attachProfileProvenance(analysis([row('TRANSFERABLE_MATCH','/capabilities/operations/0')]),p))[0];
 assert.equal(view.category,'inference');assert(view.message.includes('no acredita experiencia previa'));assert.equal(view.source.content.restriction,'No trabajé con OKR.');assert(!JSON.stringify(view).includes('parcial'));
});
test('M4: NOT_EVIDENCED no se publica como ausencia confirmada',()=>{
 const view=present(attachProfileProvenance(analysis([row('NOT_EVIDENCED',null,'M&A')]),p))[0];assert.equal(view.category,'unknown');assert(view.message.includes('No documentado'));assert(view.message.includes('No implica'));assert(!JSON.stringify(view).includes('No tiene experiencia'));
});
test('A8: frase genérica conservada literalmente, sin convertirla en manejo de AutoCAD',()=>{
 const profile={candidateDocument:fixtures.profiles.superficial};const view=present(attachProfileProvenance(analysis([row('NOT_EVIDENCED','/capabilities','AutoCAD')]),profile))[0];
 assert.equal(view.source.content,'Uso herramientas del sector.');assert.equal(view.category,'unknown');assert(!JSON.stringify(view).includes('manejo básico'));assert(view.sourceMessage.includes('no está comprobada'));
});
test('Markdown: sección completa conserva negaciones en párrafos separados y no confía en campos derivados alterados',()=>{
 const profile={candidateDocument:'## Capacidades y herramientas\nAutoCAD.\n\nNo tengo experiencia profesional.\n\n## Objetivos\nAprender Revit.',capabilities:'Domina AutoCAD'};
 const unit=profileUnits(profile).find(x=>x.reference==='/capabilities');assert.equal(unit.content,'AutoCAD.\n\nNo tengo experiencia profesional.');assert(!unit.content.includes('Domina'));assert(!profileUnits(profile).some(x=>x.reference==='/targetRoles'));
});
test('referencias inexistentes, oferta, índices inválidos y metas no publican citas',()=>{
 const profile={...p,targetRoles:{title:'Dominar AutoCAD'}};
 for(const ref of ['/job/description','/capabilities/operations/99','/targetRoles','__proto__','/capabilities/operations/0/evidence',null,3])assert.equal(present(attachProfileProvenance(analysis([row('DIRECT_MATCH',ref)]),profile))[0].source,null);
});
test('transferencia entre cargos se mantiene visible sin convertirla en antecedente directo',()=>{
 const profile={experience:[{role:'Coordinador',responsibilities:['Coordiné clientes y equipos técnicos.']}]};const view=present(attachProfileProvenance(analysis([row('TRANSFERABLE_MATCH','/experience/0','Deployment')]),profile))[0];assert.equal(view.source.content.role,'Coordinador');assert.equal(view.category,'inference');assert(view.message.includes('posible transferencia'));
});
test('brechas propuestas y DIRECT_MATCH siguen siendo opiniones, no hechos acreditados',()=>{
 for(const cls of ['DIRECT_MATCH','CLEAR_GAP','CRITICAL_GAP','SCALE_STRETCH']){const view=present(attachProfileProvenance(analysis([row(cls,'/capabilities/operations/0')]),p))[0];assert.equal(view.category,'inference');assert(!view.message.includes('no tenés'));}
});
test('respuesta original, scores y decisión intactos; fuente persiste tras editar perfil y reiniciar repositorio',()=>{
 const profile=JSON.parse(JSON.stringify(p)),input=analysis([row('TRANSFERABLE_MATCH','/capabilities/operations/0')]),before=JSON.stringify(input);const enriched=attachProfileProvenance(input,profile);
 assert.equal(JSON.stringify(input),before);const {profileProvenance,...unchanged}=enriched;assert.deepEqual(unchanged,input);
 profile.capabilities.operations[0].evidence='Perfil cambiado';assert.equal(profileProvenance.requirements[0].source.content.evidence,p.capabilities.operations[0].evidence);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hunter-provenance-'));const {createLocalRepository}=require('../data/jobRepository');const {createJobService}=require('../services/jobService');const repo=createLocalRepository({dir}),svc=createJobService(repo);svc.createJob({jobId:'offline',title:'Prueba'});svc.applyAnalysisResult('offline',enriched);assert.deepEqual(createLocalRepository({dir}).get('offline').aiAnalysis,enriched);fs.rmSync(dir,{recursive:true});
});
test('análisis histórico sin referencia no acredita antecedentes ni expone prosa libre',()=>{
 const view=present(analysis([row('DIRECT_MATCH',null)]))[0];assert.equal(view.source,null);assert(view.sourceMessage.includes('Sin referencia'));assert.equal(view.category,'inference');
});
test('UI usa plantillas y escapa fuentes; no publica resumen, notas o transferencias libres',()=>{
 const code=fs.readFileSync(path.join(__dirname,'../ui/public/app.js'),'utf8');const start=code.indexOf('function sourceHtml('),end=code.indexOf('\nfunction renderDetail(',start);
 const context=vm.createContext({window:{ProfilePresentation:{present}},esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('>','&gt;')});vm.runInContext(code.slice(start,end),context);
 context.a=attachProfileProvenance(analysis([row('TRANSFERABLE_MATCH','/experience/0','Deployment')]),{experience:[{role:'<script>malicioso</script>',responsibilities:['Coordiné entregas.']}]});const html=vm.runInContext('diagnosisHtml(a)',context);
 assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('INFORMACIÓN DOCUMENTADA'));assert(html.includes('INFERENCIA'));assert(!html.includes('Inventó'));assert(!html.includes('parcial'));assert(!code.includes('${a.summary ?'));assert(!code.includes("listSection('EXPERIENCIA TRANSFERIBLE'"));
});
test('una sola llamada simulada, raw íntegro y procedencia construida localmente',async()=>{
 const {analyzeJob,JOB_ANALYSIS_SCHEMA}=require('../ai/jobAnalyzer');const reply=Object.fromEntries(Object.entries(JOB_ANALYSIS_SCHEMA.properties).map(([k,s])=>[k,s.enum?s.enum[0]:s.type==='array'?[]:s.type==='integer'?65:'Simulado']));Object.assign(reply,analysis([row('TRANSFERABLE_MATCH','/capabilities/operations/0')]));reply.coreCapabilityCoverage=[];reply.recommendedCV='current_cv';let calls=0;const raw=JSON.stringify(reply);
 const result=await analyzeJob(p,fixtures.jobs.building,{transport:async()=>{calls++;return {choices:[{message:{content:raw}}]};}});assert.equal(calls,1);assert.equal(result.raw,raw);assert.equal(result.analysis.overallMatchScore,65);assert.equal(result.analysis.decision,'MAYBE');assert.equal(present(result.analysis)[0].source.content.evidence,p.capabilities.operations[0].evidence);
});
