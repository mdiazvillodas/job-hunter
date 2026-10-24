const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),pkg=path.join(root,'dist',process.argv[2] || 'Job-Hunter-0.2-simple-diagnostico');
async function run(){
 for(const f of ['src/ai/marianoProfile.json','src/ai/marianoMatchingProfile.json','src/ai/marianoCareerContext.json','.env','private-baseline'])assert(!fs.existsSync(path.join(pkg,f)),f+' debe estar excluido');
 assert(fs.existsSync(path.join(pkg,'runtime/node.exe')));
 const dest=require(path.join(pkg,'scripts/install')).createInstance('package-smoke',45873,false,{query:'Arquitectura edilicia',location:'Barcelona'});
 assert.equal(fs.readdirSync(path.join(dest,'src/data/jobs')).length,0);
 const profiles=require('../docs/validation-pilot/fixtures.json').profiles;
 const diagnosis=require(path.join(dest,'src/ai/simpleProfile')).diagnose;
 assert.notEqual(diagnosis(profiles.superficial).status,'Perfil suficientemente documentado');
 assert.equal(diagnosis(profiles.junior_synthetic).status,'Perfil suficientemente documentado');
 assert(fs.readFileSync(path.join(dest,'Buscar.cmd'),'utf8').includes('PLAYWRIGHT_BROWSERS_PATH'));
 const launcher=fs.readFileSync(path.join(dest,'Conectar LinkedIn.cmd'),'utf8');
 assert(launcher.includes('PLAYWRIGHT_BROWSERS_PATH')&&launcher.includes('src/connect-linkedin.js'));
 assert(fs.readFileSync(path.join(dest,'src/ui/public/settings.html'),'utf8').includes('Conectar LinkedIn.cmd'));
 assert.equal(fs.readFileSync(path.join(pkg,'src/ai/jobAnalyzer.js'),'utf8'),fs.readFileSync(path.join(root,'src/ai/jobAnalyzer.js'),'utf8'));

 process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(pkg,'browsers');
 for(const f of ['src/ui/manualSearch.js','src/ui/public/manualSearch.js','src/infojobs/browser.js','src/linkedin/conversationalSearch.js','src/linkedin/employmentEvidence.js','src/linkedin/searchScope.js','src/linkedin/jobsCollector.js','src/linkedin/detailCollector.js','src/linkedin/multiSearch.js','src/hunt.js','src/pipeline/pipeline.js','src/pipeline/combineSummaries.js','src/notifications/runOutcome.js'])assert.equal(fs.readFileSync(path.join(pkg,f),'utf8'),fs.readFileSync(path.join(root,f),'utf8'),'Paquete desactualizado: '+f);
 const verification=require('child_process').spawnSync(path.join(pkg,'runtime/node.exe'),['--test','--test-name-pattern=flujo clásico|tarjetas SDUI|recorrido conversacional|tarjetas incompletas|jornada ausente|pipeline omite analyzer',path.join(pkg,'src/tests/conversational-search.test.js')],{cwd:pkg,encoding:'utf8',env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:path.join(pkg,'browsers')},timeout:120000});
 assert.equal(verification.status,0,verification.stdout+'\n'+verification.stderr);
 console.log(verification.stdout);
 const {chromium}=require(path.join(pkg,'node_modules/playwright'));
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.setContent('<title>Job Hunter offline</title><h1>Paquete listo</h1>');assert.equal(await page.title(),'Job Hunter offline');}finally{await browser.close();}
 // Actual bundled browser + packaged login helper, all navigation intercepted locally.
 const {connectLinkedIn}=require(path.join(dest,'src/connect-linkedin'));
 const ownProfile=path.join(dest,'browser-profile'), lockPath=path.join(dest,'src/data/hunt.lock');
 let ctx,readyResolve;const ready=new Promise(r=>readyResolve=r);let completed=false;
 const pending=connectLinkedIn({profileDir:ownProfile,lockPath,log:()=>{},launch:async(profile,options)=>{
   assert.equal(options.headless,false);
   ctx=await chromium.launchPersistentContext(profile,{headless:false,channel:'chromium'});
   await ctx.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<title>Autenticación simulada offline</title><p>Sin conexión externa</p>'}));
   ctx.pages()[0].once('domcontentloaded',()=>readyResolve());return ctx;
 }}).then(()=>completed=true);
 await ready;assert(!completed);assert(fs.existsSync(lockPath));
 await ctx.addCookies([{name:'synthetic_session',value:'own-instance-only',domain:'offline.example',path:'/',expires:Math.floor(Date.now()/1000)+3600}]);
 await ctx.close();await pending;assert(!fs.existsSync(lockPath));
 const reopened=await chromium.launchPersistentContext(ownProfile,{headless:true,channel:'chromium'});
 try{assert((await reopened.cookies('https://offline.example')).some(c=>c.name==='synthetic_session'));}finally{await reopened.close();}
 const separate=await chromium.launchPersistentContext(path.join(dest,'separate-browser-profile'),{headless:true,channel:'chromium'});
 try{assert.equal((await separate.cookies('https://offline.example')).length,0);}finally{await separate.close();}
 fs.renameSync(dest,path.join(root,'private-baseline/package-smoke-instance-'+Date.now()));
 console.log('PASS: paquete sin perfiles ni secretos, instalación independiente y Chromium incluido arrancan offline');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
