'use strict';
const labels={'full-time':'full-time','jornada completa':'full-time','part-time':'part-time','media jornada':'part-time',contract:'contract',contrato:'contract',temporary:'temporary',temporal:'temporary',internship:'internship','prácticas':'internship',volunteer:'volunteer'};
function classifyEmployment(evidence,requested,jobId){
 if(!requested)return {eligible:true};
 const expected=labels[String(requested).trim().toLowerCase()];
 const actual=evidence&&evidence.jobId===String(jobId)&&['detail_chip','detail_criteria'].includes(evidence.source)?evidence.values:[];
 const types=[...new Set((actual||[]).map(x=>labels[String(x).trim().toLowerCase()]).filter(Boolean))];
 return {eligible:!!expected&&types.length===1&&types[0]===expected,reason:types.length===0?'employment_not_documented':types.length>1?'employment_ambiguous':types[0]!==expected?'employment_mismatch':null};
}
async function readEmploymentEvidence(page,jobId){
 return page.evaluate(({jobId,labels})=>{
  const norm=x=>(x||'').replace(/\s+/g,' ').trim();
  const current=(location.pathname.match(/\/jobs\/view\/(\d+)/)||[])[1]||new URL(location.href).searchParams.get('currentJobId');
  if(current!==String(jobId))return {jobId:String(jobId),source:'unverified_page',values:[]};
  const values=[];
  for(const a of document.querySelectorAll('main a[href]')){
   const text=norm(a.textContent);if(!labels[text.toLowerCase()]||!a.getClientRects().length)continue;
   const u=new URL(a.getAttribute('href'),location.href);
   if(u.origin===location.origin&&u.pathname===location.pathname&&u.searchParams.get('currentJobId')===new URL(location.href).searchParams.get('currentJobId'))values.push(text);
  }
  if(values.length)return {jobId:String(jobId),source:'detail_chip',values:[...new Set(values)]};
  for(const item of document.querySelectorAll('.description__job-criteria-item')){
   const heading=norm(item.querySelector('h3')?.textContent);
   if(!/^(Employment type|Tipo de empleo)$/i.test(heading))continue;
   const value=norm(item.querySelector('.description__job-criteria-text')?.textContent);if(labels[value.toLowerCase()])values.push(value);
  }
  return {jobId:String(jobId),source:'detail_criteria',values:[...new Set(values)]};
 },{jobId,labels});
}
module.exports={classifyEmployment,readEmploymentEvidence};
