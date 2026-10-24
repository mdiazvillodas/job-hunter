const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'), dest=path.join(root,'dist',process.argv[2] || 'Job-Hunter-0.2-simple');
if(fs.existsSync(dest))throw Error('El paquete existe: conservarlo y elegir otro destino');
fs.mkdirSync(dest,{recursive:true});
// Keep the archive's own hash in the external preflight, avoiding a recursive manifest.
for(const d of ['src','docs','scripts']) fs.cpSync(path.join(root,d),path.join(dest,d),{recursive:true,filter:p=>!/(candidate\.md|mariano(?:MatchingProfile|CareerContext|Profile)\.json)$/.test(p)&&!p.includes(path.join('data','jobs')+path.sep)&&!p.endsWith(path.join('validation-pilot','preflight.json'))});
for(const f of ['package.json','package-lock.json','LEEME.md'])fs.copyFileSync(path.join(root,f),path.join(dest,f));
fs.mkdirSync(path.join(dest,'runtime'));fs.copyFileSync(process.execPath,path.join(dest,'runtime/node.exe'));
fs.cpSync(path.join(root,'node_modules'),path.join(dest,'node_modules'),{recursive:true});
const browserSpecs=JSON.parse(fs.readFileSync(path.join(root,'node_modules/playwright-core/browsers.json'))).browsers;
fs.mkdirSync(path.join(dest,'browsers'));
for(const name of ['chromium','chromium-headless-shell','ffmpeg','winldd']){
 const b=browserSpecs.find(b=>b.name===name);if(!b)continue;
 const dir=name.replaceAll('-','_')+'-'+b.revision;
 const cache=process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(require('os').homedir(),'AppData/Local/ms-playwright');
 const source=path.join(cache,dir);
 if(!fs.existsSync(source))throw Error('Falta navegador '+dir);
 fs.cpSync(source,path.join(dest,'browsers',dir),{recursive:true});
}
fs.writeFileSync(path.join(dest,'Instalar.cmd'),'@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" scripts/install.js\r\npause\r\n');
console.log(dest);
