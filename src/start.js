'use strict';
require('./env').loadProjectEnv();
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const root=path.resolve(__dirname,'..');
const ui=spawn(process.execPath,[path.join(__dirname,'ui/server.js')],{cwd:root,env:process.env,stdio:'inherit',windowsHide:true});
let hunt=null,last=Date.now();
const timer=setInterval(()=>{
 try{
  const file=path.join(root,'schedule.json');if(!fs.existsSync(file))return;
  const {minutes}=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Number.isInteger(minutes)||minutes<15||hunt||Date.now()-last<minutes*60000)return;
  last=Date.now();
  // Child loads the instance .env anew, including edits made through settings.
  const env={...process.env};for(const k of ['OPENAI_API_KEY','ANALYZE_LIMIT','INFOJOBS_ANALYZE_LIMIT','HEADLESS'])delete env[k];
  hunt=spawn(process.execPath,[path.join(__dirname,'hunt.js')],{cwd:root,env,stdio:'inherit',windowsHide:true});
  hunt.on('error',e=>{console.error(e.message);hunt=null;});hunt.on('exit',()=>{hunt=null;});
 }catch(e){console.error('Programación:',e.message);}
},30000);
function stop(){clearInterval(timer);ui.kill();if(hunt)hunt.kill();}
process.on('SIGINT',()=>{stop();process.exit();});
process.on('SIGTERM',()=>{stop();process.exit();});
ui.on('exit',code=>{stop();process.exit(code||0);});
