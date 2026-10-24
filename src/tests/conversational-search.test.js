'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const semantic=require('../linkedin/conversationalSearch');
const {initializeSearchWithFilters,changeSearchQuery}=require('../linkedin/searchScope');
const {runPipeline}=require('../pipeline/pipeline');
const {combineSummaries}=require('../pipeline/combineSummaries');
const {buildRunOutcomeNotification}=require('../notifications/runOutcome');
const {createJobService}=require('../services/jobService');
function html(mode,query,custom=false){
 const radios=['Past month','Past week','Past 24 hours'].map((text,i)=>custom?`<div role="radio" aria-checked="false" tabindex="0" onclick="document.querySelectorAll('[role=radio]').forEach(x=>x.setAttribute('aria-checked','false'));this.setAttribute('aria-checked','true')">${text}</div>`:`<label><input type="radio" name="date" id="${mode==='classic'?['advanced-filter-timePostedRange-r2592000','advanced-filter-timePostedRange-r604800','advanced-filter-timePostedRange-r86400'][i]:'generated-date-'+i}">${text}</label>`).join('');
 const types=['Part-time','Contract','Internship','Full-time','Volunteer'].map((text,i)=>custom?`<div role="checkbox" aria-checked="false" tabindex="0" onclick="this.setAttribute('aria-checked',this.getAttribute('aria-checked')==='true'?'false':'true')">${text}</div>`:`<label><input type="checkbox" id="${mode==='classic'&&text==='Full-time'?'advanced-filter-jobType-F':'generated-type-'+i}">${text}</label>`).join('');
 return `<input ${mode==='semantic'?'data-testid="typeahead-input" componentkey="semanticSearchBox"':'aria-label="Search by title, skill, or company"'} value="${query}">
 ${mode==='classic'?'<input aria-label="City, state, or zip code">':''}
 <button onclick="document.querySelector('[role=dialog]').hidden=false">All filters</button>
 <div role="dialog" hidden>${radios}${types}<button onclick="apply()">Show results</button><button onclick="this.parentNode.hidden=true">Close</button></div>
 <ul><li data-occludable-job-id="100"><a href="/jobs/view/100">Initial results</a></li></ul>
 <script>
 const mode=${JSON.stringify(mode)};
 if(mode==='semantic')history.replaceState({},'', '/jobs/search-results/?keywords='+encodeURIComponent(${JSON.stringify(query)}));
 function resetFilters(){document.querySelectorAll('input[type=radio],input[type=checkbox]').forEach(x=>x.checked=false);document.querySelectorAll('[aria-checked]').forEach(x=>x.setAttribute('aria-checked','false'));}
 document.querySelector('input').addEventListener('keydown',e=>{if(e.key!=='Enter')return;const q=e.target.value;
  if(!window.noURLChange)history.pushState({},'',(mode==='semantic'?'/jobs/search-results/':'/jobs/search/')+'?keywords='+encodeURIComponent(window.lowercaseURL?q.toLowerCase():q));
  resetFilters();if(!window.noCardChange)setTimeout(()=>{document.querySelector('ul').innerHTML='<li data-occludable-job-id="'+(++window.counter)+'"><a href="/jobs/view/'+window.counter+'">'+q+'</a></li>';},60);
 });window.counter=100;
 const locationInput=document.querySelector('[aria-label="City, state, or zip code"]');if(locationInput)locationInput.addEventListener('keydown',e=>{if(e.key==='Enter'){const u=new URL(location.href);u.searchParams.set('geoId','123');history.replaceState({},'',u);}});
 function apply(){if(mode==='classic'){const u=new URL(location.href);if(document.getElementById('advanced-filter-timePostedRange-r604800').checked)u.searchParams.set('f_TPR','r604800');if(document.getElementById('advanced-filter-jobType-F').checked)u.searchParams.set('f_JT','F');history.replaceState({},'',u);}document.querySelector('[role=dialog]').hidden=true;}
 </script>`;
}
async function fixture(t,{mode='semantic',custom=false}={}){
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(1000);
 await page.route('**/*',r=>{const u=new URL(r.request().url());if(u.hostname!=='www.linkedin.com')return r.abort();return r.fulfill({contentType:'text/html',body:html(mode,u.searchParams.get('keywords')||'Head of Operations',custom)});});
 await page.goto('https://www.linkedin.com/jobs/search/?keywords=Head%20of%20Operations');return page;
}
const filters={location:'Barcelona',datePosted:'Past week',employmentType:'Full-time'};
test('inicialización detecta redirección y flujo conversacional sin control de ubicación',async t=>{
 const page=await fixture(t);const r=await initializeSearchWithFilters(page,'Head of Operations',filters,{queryTimeout:1000});
 assert.equal(r.filtersActive.locationMode,'conversational_query');assert.equal(r.filtersActive.locationActive,false);assert.equal(r.filtersActive.locationStrict,false);assert.equal(r.filtersActive.locationMentioned,true);assert.equal(r.filtersActive.datePostedActive,true);assert.equal(r.filtersActive.employmentTypeActive,true);assert.equal(r.filtersActive.effectiveQuery,'Head of Operations in Barcelona');
});
test('cambio de consulta conserva ubicación y reaplica fecha/jornada reiniciadas por la UI',async t=>{
 const page=await fixture(t);await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});assert(await changeSearchQuery(page,'Delivery Lead',{queryTimeout:1000}));
 const r=await semantic.verifyFilters(page,filters);assert.equal(r.effectiveQuery,'Delivery Lead in Barcelona');assert(r.datePostedActive&&r.employmentTypeActive);assert.equal(r.locationStrict,false);
});
test('controles con roles/aria-checked y sin IDs heredados',async t=>{
 const page=await fixture(t,{custom:true});await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});assert((await semantic.verifyFilters(page,filters)).employmentTypeActive);
});
test('URL nueva con resultados viejos: falla y un reintento no promueve falsamente la consulta',async t=>{
 const page=await fixture(t);await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});await page.evaluate(()=>window.noCardChange=true);
 assert.equal(await semantic.changeQuery(page,'Product Operations',{queryTimeout:150}),false);assert.equal(await semantic.changeQuery(page,'Product Operations',{queryTimeout:150}),false);
});
test('resultados nuevos sin keyword confirmado en URL no bastan',async t=>{
 const page=await fixture(t);await page.evaluate(()=>window.noURLChange=true);assert.equal(await semantic.submitQuery(page,'New query',{semantic:true,timeout:150}),false);
});
test('filtro de jornada perdido no se presenta como aplicado',async t=>{
 const page=await fixture(t);await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});await page.getByRole('button',{name:'All filters',exact:true}).click();await page.getByRole('checkbox',{name:'Full-time',exact:true}).uncheck();await page.getByRole('button',{name:'Close',exact:true}).click();await assert.rejects(semantic.verifyFilters(page,filters),/no quedaron activas/);
});
test('más de una jornada activa se detecta como ensanchamiento del filtro',async t=>{
 const page=await fixture(t);await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});await page.getByRole('button',{name:'All filters',exact:true}).click();await page.getByRole('checkbox',{name:'Part-time',exact:true}).check();await page.getByRole('button',{name:'Close',exact:true}).click();await assert.rejects(semantic.verifyFilters(page,filters),/no quedaron activas/);
});
test('filtro solicitado ausente o ambiguo falla explícitamente',async t=>{
 const page=await fixture(t);await page.getByRole('radio',{name:'Past week',exact:true,includeHidden:true}).evaluate(el=>el.parentElement.remove());await assert.rejects(semantic.applyFilters(page,filters),/no disponible o ambiguo/);
});
test('flujo clásico conserva ubicación estricta por geoId y filtros por URL',async t=>{
 const page=await fixture(t,{mode:'classic'});const r=await initializeSearchWithFilters(page,'Head of Operations',filters);assert.equal(r.filtersActive.locationActive,true);assert.equal(r.filtersActive.datePostedActive,true);assert.equal(r.filtersActive.employmentTypeActive,true);assert(!r.filtersActive.locationMode);assert(await changeSearchQuery(page,'Operations Lead',{queryTimeout:1000}));
});
test('ubicaciones con caracteres especiales se componen sin regex ni pérdida de texto',()=>{assert.equal(semantic.composeQuery('Operations','A Coruña (España)'),'Operations in A Coruña (España)');});
test('warning geográfico llega del pipeline al mensaje ntfy, sin notificación real',async()=>{
 const repo={items:new Map(),get(id){return this.items.get(id)||null;},has(id){return this.items.has(id);},getAll(){return [...this.items.values()];},save(j){this.items.set(j.jobId,j);return j;}};
 const summary=await runPipeline({jobService:createJobService(repo),discover:async()=>({jobs:[],discovery:{queriesExecuted:1,locationMode:'conversational_query'}}),analyze:null,analyzeLimit:0});
 const combined=combineSummaries([{source:'linkedin',summary}],{});const message=buildRunOutcomeNotification({outcome:'completed',summary:combined});assert(message.body.includes('ubicación orientativa'));assert(message.body.includes('sin filtro geográfico estricto'));
});

test('radios de fecha contradictorios no se aceptan como filtro comprobado',async t=>{
 const page=await fixture(t,{custom:true});await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});
 await page.getByRole('button',{name:'All filters',exact:true}).click();await page.getByRole('radio',{name:'Past month',exact:true}).evaluate(el=>el.setAttribute('aria-checked','true'));await page.getByRole('button',{name:'Close',exact:true}).click();
 await assert.rejects(semantic.verifyFilters(page,filters),/no quedaron activas/);
});
test('el aviso conversacional no altera las notificaciones de InfoJobs/clásico',()=>{
 const result=buildRunOutcomeNotification({outcome:'completed',summary:{sources:{infojobs:{label:'InfoJobs',status:'completed',discovery:{uniqueResults:3,newJobs:1},analysis:{analyzed:1}}}}});
 assert(!result.body.includes('orientativa'));assert(result.body.includes('InfoJobs'));
});

test('acciones accesibles con role button y contador de resultados',async t=>{
 const page=await fixture(t);await page.getByRole('button',{name:'All filters',exact:true}).evaluate(el=>{const replacement=document.createElement('div');replacement.setAttribute('role','button');replacement.tabIndex=0;replacement.textContent='All filters';replacement.onclick=()=>document.querySelector('[role=dialog]').hidden=false;el.replaceWith(replacement);});
 await page.getByRole('button',{name:'Show results',exact:true,includeHidden:true}).evaluate(el=>{const replacement=document.createElement('div');replacement.setAttribute('role','button');replacement.tabIndex=0;replacement.textContent='Show 2,000+ results';replacement.onclick=()=>el.parentNode;replacement.addEventListener('click',()=>document.querySelector('[role=dialog]').hidden=true);el.replaceWith(replacement);});
 await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});assert((await semantic.verifyFilters(page,filters)).datePostedActive);
});

test('panel real aside con controles ARIA y enlace Show results',async t=>{
 const page=await fixture(t,{custom:true});
 await page.evaluate(()=>{
  const old=document.querySelector('[role=dialog]'),panel=document.createElement('aside');
  panel.setAttribute('aria-hidden','true');panel.tabIndex=-1;panel.hidden=true;
  panel.innerHTML='<h2>Jobs filters</h2>'+old.innerHTML;old.replaceWith(panel);
  document.querySelectorAll('[role=radio],[role=checkbox]').forEach(el=>el.setAttribute('aria-label',el.textContent));
  document.querySelector('button').onclick=()=>{panel.hidden=false;panel.setAttribute('aria-hidden','false');};
  const close=panel.querySelectorAll('button')[1];close.setAttribute('aria-label','Close');
  close.onclick=()=>{panel.hidden=true;panel.setAttribute('aria-hidden','true');};
  const show=panel.querySelector('button'),link=document.createElement('a');link.href='/jobs/search-results/';link.textContent='Show results';link.setAttribute('aria-disabled','false');
  link.onclick=e=>{e.preventDefault();panel.hidden=true;panel.setAttribute('aria-hidden','true');};show.replaceWith(link);
  const unrelated=document.createElement('aside');unrelated.setAttribute('aria-hidden','false');unrelated.innerHTML='<h2>Other panel</h2>';document.body.append(unrelated);
 });
 assert.equal(await page.locator('[role="dialog"], dialog[open], .artdeco-modal').count(),0);
 await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});
 const result=await semantic.verifyFilters(page,filters);assert(result.datePostedActive&&result.employmentTypeActive);
 assert.equal(await page.locator('aside[aria-hidden="false"]:has(h2:text-is("Jobs filters"))').count(),0);
});

const {classifyEmployment,readEmploymentEvidence}=require('../linkedin/employmentEvidence');
test('jornada ausente en filtros permite discovery pero queda pendiente de ficha',async t=>{
 const page=await fixture(t);
 await page.getByRole('checkbox',{name:'Full-time',exact:true,includeHidden:true}).evaluate(el=>el.parentElement.remove());
 const result=await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});
 assert.equal(result.filtersActive.employmentTypeActive,null);assert.equal(result.filtersActive.employmentTypeMode,'detail');
});
test('jornada exacta, ausente, parcial, contradictoria y de otra oferta',()=>{
 const e=(values,jobId='100')=>({jobId,source:'detail_chip',values});
 assert(classifyEmployment(e(['Full-time']),'Full-time','100').eligible);
 assert(classifyEmployment(e(['Jornada completa']),'Full-time','100').eligible);
 for(const values of [[],['Part-time'],['Contract'],['Full-time','Part-time'],['not Full-time']])assert(!classifyEmployment(e(values),'Full-time','100').eligible);
 assert(!classifyEmployment(e(['Full-time'],'200'),'Full-time','100').eligible);
 assert(!classifyEmployment({jobId:'100',source:'description',values:['Full-time']},'Full-time','100').eligible);
});
test('evidencia de ficha toma chip propio, no prosa ni enlaces a otras ofertas',async t=>{
 const page=await fixture(t);await page.goto('https://www.linkedin.com/jobs/view/100/');
 await page.setContent('<main><p>Not Full-time, only Part-time.</p><a href="/jobs/view/200/">Full-time</a></main>');
 await page.evaluate(()=>history.replaceState({},'', '/jobs/view/100/'));
 assert.deepEqual((await readEmploymentEvidence(page,'100')).values,[]);
 await page.locator('main').evaluate(el=>el.insertAdjacentHTML('beforeend','<a href="/jobs/view/100/">Full-time</a>'));
 assert.deepEqual((await readEmploymentEvidence(page,'100')).values,['Full-time']);
 assert.deepEqual((await readEmploymentEvidence(page,'200')).values,[]);
});
test('pipeline omite analyzer y notificaciones ante jornada incompatible o desconocida',async()=>{
 const repo={items:new Map(),get(id){return this.items.get(id)||null;},has(id){return this.items.has(id);},getAll(){return [...this.items.values()];},save(j){this.items.set(j.jobId,j);return j;}};
 let calls=0,notifications=0;
 const summary=await runPipeline({jobService:createJobService(repo),discover:async()=>({jobs:[{jobId:'1'},{jobId:'2'},{jobId:'3'}]}),
 fetchDetails:async j=>({...j,description:'Responsabilidades profesionales concretas para gestionar operaciones y coordinar procesos. '.repeat(12)}),
 checkEligibility:async j=>({eligible:j.jobId==='3',reason:j.jobId==='1'?'employment_mismatch':'employment_not_documented'}),
 analyze:async()=>{calls++;return {analysis:{decision:'YES',overallMatchScore:90}};},notify:async()=>{notifications++;return {status:'sent'};}});
 assert.equal(calls,1);assert.equal(notifications,1);assert.equal(summary.analysis.skipped,2);
 assert.deepEqual(summary.analysis.eligibilitySkips,{employment_mismatch:1,employment_not_documented:1});
 const combined=combineSummaries([{source:'linkedin',summary}],{});
 const notice=buildRunOutcomeNotification({outcome:'completed',summary:combined});
 assert(notice.body.includes('1 omitidas por jornada incompatible'));assert(notice.body.includes('1 pendientes por jornada no confirmada'));
 assert.equal(repo.get('1').analysisStatus,'pending');assert.equal(repo.get('2').analysisStatus,'pending');
});

test('ntfy comunica jornadas omitidas y pendientes sin envío real',()=>{
 const n=buildRunOutcomeNotification({outcome:'completed',summary:{sources:{linkedin:{label:'LinkedIn',status:'completed',analysis:{analyzed:1,eligibilitySkips:{employment_mismatch:2,employment_not_documented:3,employment_ambiguous:1}}}}}});
 assert(n.body.includes('2 omitidas por jornada incompatible'));assert(n.body.includes('4 pendientes por jornada no confirmada'));
});

const {collectCurrentPageJobs}=require('../linkedin/jobsCollector');
const {collectCurrentSearch}=require('../linkedin/searchScope');
async function semanticCards(page){
 await page.locator('ul').evaluate(el=>{
  if(!el.closest('main')){const main=document.createElement('main');el.replaceWith(main);main.append(el);}
  el.innerHTML='<div role="button" tabindex="0" componentkey="job-card-component-ref-4479850600"><div componentkey="job-card-component-ref-4479850600"><p><span>Selected, Managing Director (Operations)</span><span aria-hidden="true">Managing Director (Operations)</span></p><div><p>NextGen Ventures</p></div><p>Barcelona</p><button aria-label="Dismiss Managing Director (Operations) job">X</button><p>Easy Apply</p></div></div><div role="button" componentkey="job-card-component-ref-4476521888"><p><span>Head of Business Operations</span><span aria-hidden="true">Head of Business Operations</span></p><div><p>Platform Engineering</p></div><p>Barcelona (Remote)</p></div>';
 });
}
test('extrae tarjetas SDUI sin li ni links, evita duplicados y texto accesible repetido',async t=>{
 const page=await fixture(t);await semanticCards(page);
 assert.equal(await page.locator('li[data-occludable-job-id]').count(),0);
 const r=await collectCurrentPageJobs(page);
 assert.equal(r.jobs.length,2);assert.deepEqual(r.jobs[0],{jobId:'4479850600',title:'Managing Director (Operations)',company:'NextGen Ventures',location:'Barcelona',url:'https://www.linkedin.com/jobs/view/4479850600/',easyApply:true});
 assert.equal(r.jobs[1].title,'Head of Business Operations');assert.equal(r.jobs[1].company,'Platform Engineering');
 const before=await semantic.resultSignature(page);await page.locator('[role="button"][componentkey="job-card-component-ref-4476521888"]').evaluate(el=>el.setAttribute('componentkey','job-card-component-ref-2000000000'));assert.notEqual(await semantic.resultSignature(page),before);
});
test('recorrido conversacional pagina dos veces con atributos SDUI y conserva filtros',async t=>{
 const page=await fixture(t),f={...filters,location:''};await semantic.initialize(page,'Head of Operations',f,{queryTimeout:1000});await semanticCards(page);
 await page.evaluate(()=>{
  const current=document.createElement('button');current.textContent='1';current.setAttribute('aria-current','true');current.setAttribute('data-testid','pagination-indicator-0');document.body.append(current);
  const next=document.createElement('button');next.textContent='Next';next.setAttribute('data-testid','pagination-controls-next-button-visible');
  next.onclick=()=>{document.querySelector('ul').innerHTML='<div role="button" componentkey="job-card-component-ref-2000000000"><p>Operations Lead</p><p>ACME</p><p>Madrid</p></div>';current.textContent='2';current.setAttribute('data-testid','pagination-indicator-1');next.disabled=true;};document.body.append(next);
 });
 const r=await collectCurrentSearch(page,'Head of Operations',f,{maxPages:2});
 assert.equal(r.jobs.length,3);assert.equal(r.metadata.pagesVisited,2);assert.equal(r.jobs[2].title,'Operations Lead');assert.equal(r.jobs[2].jobId,'2000000000');
});
test('tarjetas incompletas o resultados anunciados sin tarjetas no son éxito vacío',async t=>{
 const page=await fixture(t);await page.setContent('<main><p>99+ results</p></main>');
 await assert.rejects(collectCurrentPageJobs(page),/no reconoce tarjetas/);
 await page.setContent('<main><div role="button" componentkey="job-card-component-ref-1234567890"><p>Role</p></div></main>');
 await assert.rejects(collectCurrentPageJobs(page),/incompleta/);
 await page.setContent('<main><p>0 results</p></main>');assert.equal((await collectCurrentPageJobs(page)).jobs.length,0);
});


test('Oracle: LinkedIn guarda keywords en minúsculas y conserva la consulta y resultados nuevos',async t=>{const page=await fixture(t);await page.evaluate(()=>window.lowercaseURL=true);const result=await semantic.initialize(page,'Head of Operations',filters,{queryTimeout:1000});assert.equal(new URL(page.url()).searchParams.get('keywords'),'head of operations in barcelona');assert.equal(result.filtersActive.locationMentioned,true);assert(await semantic.changeQuery(page,'Delivery Lead',{queryTimeout:1000}));});
test('keywords en minúsculas sin renovación de tarjetas siguen rechazados',async t=>{const page=await fixture(t);await page.evaluate(()=>{window.lowercaseURL=true;window.noCardChange=true;});assert.equal(await semantic.submitQuery(page,'Head of Operations in Barcelona',{semantic:true,timeout:150}),false);});
test('normalización conserva palabras, ubicación y acentos; admite solo forma y espacios',()=>{assert.equal(semantic.normalizeQuery('  Head  of Operations in Barcelona '),semantic.normalizeQuery('head of operations in barcelona'));assert.notEqual(semantic.normalizeQuery('Operations in Barcelona'),semantic.normalizeQuery('Operations in Madrid'));assert.notEqual(semantic.normalizeQuery('Operations in Barcelona'),semantic.normalizeQuery('Operations'));assert.notEqual(semantic.normalizeQuery('A Coruña'),semantic.normalizeQuery('A Coruna'));assert.equal(semantic.normalizeQuery(null),null);});
