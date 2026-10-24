'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {createLinkedinConnection}=require('../ui/linkedinConnection');
test('conexión propia: GET no abre navegador ni entrega clave; POST protege origen, excluye búsqueda y no duplica ventanas',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'linkedin-connection-'));fs.writeFileSync(path.join(root,'.vnc-password.txt'),'fixture-viewer-only');let busy=false,launches=0;const children=[];
 const handle=createLinkedinConnection({projectRoot:root,available:true,inspectLock:()=>({busy}),spawnConnection:()=>{launches++;const child=new EventEmitter();children.push(child);return child;}});
 const server=http.createServer((req,res)=>handle(req,res,new URL(req.url,'http://localhost')));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});const origin='http://127.0.0.1:'+server.address().port,url=origin+'/api/linkedin-connection';
 let r=await fetch(url);assert.equal(r.status,200);assert.equal(launches,0);assert(!JSON.stringify(await r.json()).includes('fixture-viewer-only'));
 r=await fetch(url,{method:'POST',headers:{Origin:'https://foreign.example'}});assert.equal(r.status,403);assert.equal(launches,0);
 busy=true;r=await fetch(url,{method:'POST',headers:{Origin:origin}});assert.equal(r.status,409);assert.equal(launches,0);
 busy=false;r=await fetch(url,{method:'POST',headers:{Origin:origin}});assert.equal(r.status,202);assert.equal((await r.json()).viewerPassword,'fixture-viewer-only');assert.equal(launches,1);
 r=await fetch(url,{method:'POST',headers:{Origin:origin}});assert.equal(r.status,202);assert.equal(launches,1);children[0].emit('close',0);assert.equal((await(await fetch(url)).json()).open,false);
 await fetch(url,{method:'POST',headers:{Origin:origin}});children[1].emit('error',Error('fixture-error'));assert((await(await fetch(url)).json()).error);assert.equal(launches,2);
});
test('instalación sin visor: no inicia proceso',()=>{let status;const handle=createLinkedinConnection({available:false,inspectLock:()=>({busy:false}),spawnConnection:()=>{throw Error('Must not run');}});const res={writeHead:s=>status=s,end:()=>{}};handle({method:'POST',headers:{origin:'http://localhost',host:'localhost'}},res,{pathname:'/api/linkedin-connection'});assert.equal(status,409);});
