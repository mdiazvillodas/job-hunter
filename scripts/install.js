'use strict';
const fs=require('fs'), path=require('path'), http=require('http'), {spawn}=require('child_process');
const root=path.resolve(__dirname,'..');
function createInstance(name, port, original=false, settings={}) {
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw Error('Nombre: letras minúsculas, números y guiones');
  if(!Number.isInteger(port)||port<1024||port>65534)throw Error('Puerto inválido');
  if(!original&&(!settings.query?.trim()||typeof settings.location!=='string'))throw Error('Completá puesto y ubicación');
  const instances=path.join(root,'instances');
  if(fs.existsSync(instances))for(const folder of fs.readdirSync(instances)){
    const envFile=path.join(instances,folder,'.env');if(!fs.existsSync(envFile))continue;
    const text=fs.readFileSync(envFile,'utf8');
    const ports=[...text.matchAll(/^(?:UI_PORT|HUNT_TRIGGER_PORT)=(\d+)/gm)].map(x=>Number(x[1]));
    if(ports.includes(port)||ports.includes(port+1))throw Error('Ese puerto ya pertenece a otra instancia');
  }
  const dest=path.join(root,'instances',name);
  if(fs.existsSync(dest))throw Error('La instancia ya existe; no se sobrescribe');
  if(original&&!fs.existsSync(path.join(root,'private-baseline/marianoProfile.json')))throw Error('Referencia privada no disponible');
  fs.mkdirSync(dest,{recursive:true});
  fs.writeFileSync(path.join(dest,'.instance'),name);
  for(const dir of ['src','docs']) fs.cpSync(path.join(root,dir),path.join(dest,dir),{recursive:true,filter:p=>!/(?:^|[\\/])(?:resultados-reales-[^\\/]+|diagnostico-tecnico-cuatro-problemas\.md|validacion-final-dirigida-[^\\/]+|cierre-simple-[^\\/]+)$/.test(p)&&!/(candidate\.md|mariano(?:MatchingProfile|CareerContext|Profile)\.json)$/.test(p)&&!p.includes(path.join('data','jobs')+path.sep)});
  fs.mkdirSync(path.join(dest,'src/data/jobs'),{recursive:true});
  fs.copyFileSync(path.join(root,'package.json'),path.join(dest,'package.json'));
  if(original){
    for(const f of ['marianoProfile.json','marianoMatchingProfile.json','marianoCareerContext.json'])fs.copyFileSync(path.join(root,'private-baseline',f),path.join(dest,'src/ai',f));
    if(fs.existsSync(path.join(root,'private-baseline/jobs')))fs.cpSync(path.join(root,'private-baseline/jobs'),path.join(dest,'src/data/jobs'),{recursive:true});
  } else {
    fs.writeFileSync(path.join(dest,'src/ai/candidate.md'),'');
    fs.writeFileSync(path.join(dest,'candidate-settings.json'),JSON.stringify(settings,null,2));
  }
  let env=original&&fs.existsSync(path.join(root,'private-baseline/original.env'))?fs.readFileSync(path.join(root,'private-baseline/original.env'),'utf8'):'';
  env=env.replace(/^(UI_PORT|HUNT_TRIGGER_PORT)=.*(?:\r?\n|$)/gm,'');
  env+=`\nUI_PORT=${port}\nHUNT_TRIGGER_PORT=${port+1}\n`;
  if(!original)env+='ANALYZE_LIMIT=0\nINFOJOBS_ANALYZE_LIMIT=0\nHEADLESS=false\n';
  fs.writeFileSync(path.join(dest,'.env'),env,{mode:0o600});
  const node=fs.existsSync(path.join(root,'runtime/node.exe'))?'%~dp0..\\..\\runtime\\node.exe':process.execPath;
  const browserEnv=fs.existsSync(path.join(root,'browsers'))?'set "PLAYWRIGHT_BROWSERS_PATH=%~dp0..\\..\\browsers"\r\n':'';
  fs.writeFileSync(path.join(dest,'Abrir.cmd'),`@echo off\r\ncd /d "%~dp0"\r\n${browserEnv}start "" http://127.0.0.1:${port}\r\n"${node}" src/start.js\r\npause\r\n`);
  fs.writeFileSync(path.join(dest,'Buscar.cmd'),`@echo off\r\ncd /d "%~dp0"\r\n${browserEnv}"${node}" src/hunt.js\r\npause\r\n`);
  fs.writeFileSync(path.join(dest,'Conectar LinkedIn.cmd'),`@echo off\r\ncd /d "%~dp0"\r\n${browserEnv}"${node}" src/connect-linkedin.js\r\npause\r\n`);
  return dest;
}
if(require.main===module){
 const server=http.createServer(async(req,res)=>{try{
  if(req.method==='POST'&&req.url==='/install'){
   if(req.headers.origin!=='http://'+req.headers.host)throw Error('Origen inválido');
   let raw='';for await(const c of req){raw+=c;if(raw.length>10000)throw Error('Solicitud demasiado grande');}
   const d=JSON.parse(raw);const dest=createInstance(d.name,Number(d.port),false,{query:d.query,location:d.location});
   res.end('Instalado en '+dest+'. Abrí Abrir.cmd en esa carpeta.');return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="es"><title>Instalar Job Hunter</title><h1>Una instalación por candidato</h1><p>Se crearán datos y sesiones independientes. No se inicia ninguna búsqueda.</p><form><p>Nombre corto <input name="name" required pattern="[a-z][a-z0-9-]{0,39}"></p><p>Puerto local <input name="port" type="number" value="4273" min="1024" max="65534"></p><p>Puesto a buscar <input name="query" required></p><p>Ciudad <input name="location" required></p><button>Instalar</button></form><pre></pre><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});document.querySelector('pre').textContent=await r.text();};</script></html>`);
 }catch(e){res.statusCode=400;res.end(e.message);}});
 server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port;console.log(url);spawn('cmd.exe',['/c','start','',url],{windowsHide:true});});
}
module.exports={createInstance};
