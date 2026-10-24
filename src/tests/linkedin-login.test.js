const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{EventEmitter}=require('events');
const {connectLinkedIn}=require('../connect-linkedin');
const {acquireLock,releaseLock}=require('../domain/huntLock');
test('conexión manual visible permanece abierta, usa perfil propio y excluye búsquedas',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hunter-login-')),lockPath=path.join(dir,'hunt.lock'),profileDir=path.join(dir,'browser-profile');
 const context=new EventEmitter();let navigated=false,done=false;
 context.pages=()=>[{goto:async url=>{assert.equal(url,'https://www.linkedin.com/login/');navigated=true;}}];
 const pending=connectLinkedIn({profileDir,lockPath,log:()=>{},launch:async(p,o)=>{assert.equal(p,profileDir);assert.equal(o.headless,false);return context;}}).then(()=>{done=true;});
 await new Promise(r=>setImmediate(r));assert(navigated);assert(!done);assert.throws(()=>acquireLock(lockPath),{code:'LOCK_HELD'});
 // A second instance remains independent.
 const second=path.join(dir,'other.lock');acquireLock(second);releaseLock(second);
 context.emit('close');await pending;assert(!fs.existsSync(lockPath));fs.rmSync(dir,{recursive:true});
});
test('fallo de navegación conserva ventana; fallo de lanzamiento libera bloqueo',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hunter-login-')),lockPath=path.join(dir,'hunt.lock');
 const context=new EventEmitter();context.pages=()=>[{goto:async()=>{throw Error('offline');}}];let done=false;
 const pending=connectLinkedIn({lockPath,log:()=>{},launch:async()=>context}).then(()=>done=true);
 await new Promise(r=>setImmediate(r));assert(!done);context.emit('close');await pending;
 await assert.rejects(connectLinkedIn({lockPath,launch:async()=>{throw Error('launch');}}),/launch/);assert(!fs.existsSync(lockPath));fs.rmSync(dir,{recursive:true});
});
