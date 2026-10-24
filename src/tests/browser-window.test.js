'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../linkedin/browser.js'),'utf8');
test('ventana Oracle ocupa 1440x900 sin cambiar Windows ni instalaciones sin display',async()=>{
 for(const [platform,display,expected]of [['linux',':1',true],['linux',undefined,false],['win32',':1',false]]){
  let options;const sandbox={module:{exports:{}},process:{platform,env:{DISPLAY:display}},require:name=>name==='playwright'?{chromium:{launchPersistentContext:async(dir,o)=>{assert.equal(dir,'fixture-profile');options=o;return {};}}}:{HEADLESS:false}};
  vm.runInNewContext(source,sandbox);await sandbox.module.exports.launchLinkedInBrowser('fixture-profile');assert.equal(options.viewport,null);assert.equal(options.headless,false);assert.equal(options.channel,'chromium');assert.equal(JSON.stringify(options.args),expected?JSON.stringify(['--window-size=1440,900']):undefined);
 }
});
