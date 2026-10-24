// Offline browser acceptance. Historical replies are replayed, never requested again.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const root=path.resolve(__dirname,'..'),pkg=process.argv[2]?path.resolve(process.argv[2]):root;
const {attachProfileProvenance}=require(path.join(pkg,'src/ai/profileProvenance'));
async function run(){
 const output=path.join(root,'private-baseline','extractive-ui-'+Date.now());fs.mkdirSync(output,{recursive:true});
 const port=await new Promise((resolve,reject)=>{const probe=require('net').createServer();probe.on('error',reject);probe.listen(0,'127.0.0.1',()=>{const n=probe.address().port;probe.close(()=>resolve(n));});});
 const dest=require(path.join(pkg,'scripts/install')).createInstance('extractive-smoke-'+Date.now(),port,false,{query:'Arquitectura edilicia',location:'Barcelona'});
 const svc=require(path.join(dest,'src/services/jobService')).createJobService(require(path.join(dest,'src/data/jobRepository')).createLocalRepository());
 const history=path.join(root,'private-baseline/validacion-final-dirigida-20261018');
 const cases=JSON.parse(fs.readFileSync(path.join(history,'cases.json'))), examples=[];
 for(const c of cases){
  const analyzer=require(path.join(pkg,'src/ai/jobAnalyzer'));
  const sent=JSON.parse(fs.readFileSync(path.join(history,'requests',c.id+'.json')));
  assert.equal(analyzer.buildSystemPrompt(c.profile),sent.messages[0].content,'Matching instructions unchanged');
  const user=Object.hasOwn(c.profile,'candidateDocument')?analyzer.buildUserPrompt(c.job).replaceAll('Mariano','the candidate'):analyzer.buildUserPrompt(c.job);
  assert.equal(user,sent.messages[1].content,'Job input unchanged');
  const raw=JSON.parse(fs.readFileSync(path.join(history,'responses',c.id+'.json'))).analysis;
  const id='replay-'+c.id;
  svc.createJob({...c.job,jobId:id});svc.applyAnalysisResult(id,raw); // No new references fabricated for old replies.
  assert.deepEqual(svc.getJob(id).aiAnalysis,raw);
 }
 // Explicit fixture: the original positive reply plus one manually selected valid reference.
 // This tests extraction/UI, not the model's ability to return a reference in a future call.
 const positive=cases.find(c=>c.id==='T-positive');
 const raw=JSON.parse(fs.readFileSync(path.join(history,'responses/T-positive.json'))).analysis;
 const fixture=JSON.parse(JSON.stringify(raw));fixture.requirementAssessments[10].profileReference='/capabilities/operations/4';
 svc.createJob({...positive.job,jobId:'reference-fixture'});svc.applyAnalysisResult('reference-fixture',attachProfileProvenance(fixture,positive.profile));
 const runtime=fs.existsSync(path.join(pkg,'runtime/node.exe'))?path.join(pkg,'runtime/node.exe'):process.execPath;
 const child=spawn(runtime,['src/ui/server.js'],{cwd:dest,env:{...process.env,UI_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 let browser;
 try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('UI did not start')),15000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(Error('UI exit '+code+' '+stderr));});});
 if(fs.existsSync(path.join(pkg,'browsers')))process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(pkg,'browsers');
 const {chromium}=require(path.join(pkg,'node_modules/playwright'));browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.goto('http://127.0.0.1:'+port);await page.locator('.job-item').first().waitFor();
 await page.locator('#filtersBtn').click();await page.selectOption('#scoreFilter','0');await page.locator('#closeFiltersBtn').click();
 for(const c of cases){
 await page.locator('.job-item[data-id="replay-'+c.id+'"]').click();await page.locator('#detailContent h1').filter({hasText:c.job.title}).waitFor();await page.locator('#detailContent .profile-basis').first().waitFor();
 const detail=await page.locator('#detailContent').innerText();
 assert(detail.includes('Recomendación orientativa de IA'));assert(detail.includes(String(raw.overallMatchScore))||c.id!=='T-positive');
 assert(!detail.includes('partial OKR cadence experience'));assert(!detail.includes('No direct M&A or post-acquisition integration leadership experience.'));assert(!detail.includes('puede transferirse al manejo básico de AutoCAD'));
 if(c.id==='M4'||c.id==='A8')assert(detail.includes('COMPETENCIA O EXPERIENCIA NO DOCUMENTADA'));
 if(c.id==='T-positive'||c.id==='M3')assert(detail.includes('INFERENCIA'));
 examples.push({id:c.id,mode:'Historical response unchanged; no references retroactively inferred',presentation:detail});
 await page.screenshot({path:path.join(output,c.id+'.png')});
 }
 await page.locator('.job-item[data-id="reference-fixture"]').click();const source=page.locator('.profile-basis').filter({has:page.locator('details')});await source.waitFor();await source.locator('summary').click();
 const sourceText=await source.innerText();assert(sourceText.includes('Designed scalable operating routines'));assert(sourceText.includes('no está comprobada'));assert(sourceText.includes('INFERENCIA'));
 await source.screenshot({path:path.join(output,'source-reference-fixture.png')});
 assert.equal(errors.length,0,JSON.stringify(errors));
 fs.writeFileSync(path.join(output,'examples.json'),JSON.stringify({historicalExamples:examples,sourceReferenceFixture:sourceText,paidCalls:0,realScraping:0,package:pkg},null,2));
 console.log('PASS: 4 respuestas históricas, recomendación, ocultación de prosa y referencia contextual completa en UI real; '+output);
 }finally{if(browser)await browser.close();const stopped=new Promise(resolve=>child.once('close',resolve));child.kill();await stopped;}
 const target=path.resolve(output,'instance');assert(path.resolve(dest).startsWith(path.resolve(pkg,'instances')+path.sep));assert(target.startsWith(path.resolve(root,'private-baseline')+path.sep));
 fs.renameSync(dest,target);
}
run().catch(e=>{console.error(e);process.exitCode=1;});
