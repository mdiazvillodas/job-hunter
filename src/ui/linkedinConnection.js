'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {inspectLock}=require('../domain/huntLock');
function createLinkedinConnection(options={}){
 const root=options.projectRoot||path.resolve(__dirname,'../..');
 const available=options.available??(process.platform==='linux'&&!!process.env.DISPLAY);
 const lock=options.inspectLock||(()=>inspectLock(path.join(root,'src/data/hunt.lock')));
 const launch=options.spawnConnection||(()=>{const fd=fs.openSync(path.join(root,'manual-linkedin.log'),'a',0o600);try{return spawn(process.execPath,[path.join(root,'src/connect-linkedin.js')],{cwd:root,env:process.env,shell:false,windowsHide:true,stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}});
 let child=null,error=null;
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 return function handle(req,res,url){
  if(url.pathname!=='/api/linkedin-connection')return false;
  if(req.method==='GET'){send(res,200,{available,open:!!child,busy:lock().busy,error});return true;}
  if(req.method!=='POST'){send(res,405,{error:'Método no permitido'});return true;}
  if(req.headers.origin!=='http://'+req.headers.host){send(res,403,{error:'Origen inválido'});return true;}
  if(!available){send(res,409,{error:'El visor remoto no está disponible en esta instalación.'});return true;}
  if(!child&&lock().busy){send(res,409,{error:'La instancia está ocupada. Esperá a que termine la búsqueda o cerrá la conexión anterior.'});return true;}
  try{
   const password=fs.readFileSync(path.join(root,'.vnc-password.txt'),'utf8').trim();
   if(!child){error=null;const started=launch();child=started;started.once('error',()=>{if(child===started){child=null;error='No se pudo abrir el navegador remoto.';}});started.once('close',code=>{if(child===started){child=null;if(code)error='El navegador no pudo abrirse o terminó con un error. Volvé a intentar la conexión.';}});}
   send(res,202,{open:true,viewer:'/desktop/vnc.html?path=desktop/websockify',viewerPassword:password});
  }catch(e){send(res,500,{error:'No se pudo preparar la conexión remota.'});}
  return true;
 };
}
module.exports={createLinkedinConnection};
