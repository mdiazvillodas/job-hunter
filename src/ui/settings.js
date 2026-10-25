'use strict';
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../..');
function read(){
 let settings={};const p=path.join(root,'candidate-settings.json');if(fs.existsSync(p))settings=JSON.parse(fs.readFileSync(p,'utf8'));
 const schedule=path.join(root,'schedule.json');const envPath=path.join(root,'.env');
 const saved=fs.existsSync(envPath)?require('node:util').parseEnv(fs.readFileSync(envPath,'utf8')):{};
 const configured=saved.ANALYZE_LIMIT??process.env.ANALYZE_LIMIT??require('../config').ANALYZE_LIMIT;
 const limit=Number(configured);
 return {settings,limit:Number.isInteger(limit)&&limit>=0?limit:50,minutes:fs.existsSync(schedule)?JSON.parse(fs.readFileSync(schedule,'utf8')).minutes:0,hasApiKey:!!(saved.OPENAI_API_KEY||process.env.OPENAI_API_KEY),preservedProfile:fs.existsSync(path.join(root,'src/ai/marianoProfile.json')),manualOnly:process.platform!=='win32'};
}
function save(d){
 if(typeof d.apiKey!=='string'||/[\r\n]/.test(d.apiKey))throw Error('Clave inválida');
 if(!Number.isInteger(d.limit)||d.limit<0||d.limit>100)throw Error('Límite entre 0 y 100');
 if(!Number.isInteger(d.minutes)||!(d.minutes===0||d.minutes>=15&&d.minutes<=10080))throw Error('Programación: 0 o entre 15 y 10080 minutos');
 if(fs.existsSync(path.join(root,'candidate-settings.json'))&&(!d.query?.trim()||typeof d.location!=='string'))throw Error('Completá puesto y ubicación');
 const p=path.join(root,'.env');let env=fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
 const values={ANALYZE_LIMIT:String(d.limit),INFOJOBS_ANALYZE_LIMIT:String(d.limit),HEADLESS:'false'};
 if(d.apiKey)values.OPENAI_API_KEY=d.apiKey;
 for(const [k,v]of Object.entries(values)){env=env.replace(new RegExp('^'+k+'=.*(?:\\r?\\n|$)','gm'),'');env+=k+'='+JSON.stringify(v)+'\n';}
 fs.writeFileSync(p+'.tmp',env,{mode:0o600});fs.renameSync(p+'.tmp',p);
 fs.writeFileSync(path.join(root,'schedule.json'),JSON.stringify({minutes:d.minutes}));
 if(fs.existsSync(path.join(root,'candidate-settings.json'))){
  if(typeof d.query!=='string'||!d.query.trim()||typeof d.location!=='string')throw Error('Completá puesto y ubicación');
  const current=JSON.parse(fs.readFileSync(path.join(root,'candidate-settings.json'),'utf8'));
  fs.writeFileSync(path.join(root,'candidate-settings.json'),JSON.stringify({...current,query:d.query.trim(),location:d.location.trim()},null,2));
 }
 return {message:'Configuración guardada. Las próximas búsquedas usarán estos valores. La clave no se muestra.'};
}
module.exports={read,save};
