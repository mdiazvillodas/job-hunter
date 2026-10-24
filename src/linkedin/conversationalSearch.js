'use strict';
const { firstVisible, getSearchInput } = require('./searchControls');
const { detectSecurityChallenge } = require('./session');
const SEMANTIC_INPUT = 'input[componentkey="semanticSearchBox"][data-testid="typeahead-input"]';
const contexts = new WeakMap();
const confirmedQueries = new WeakMap();
const DATE_LABELS = {'past month':'Past month','past week':'Past week','ultima semana':'Past week','past 24 hours':'Past 24 hours','any time':'Any time'};
const TYPE_LABELS = {'full-time':'Full-time','jornada completa':'Full-time','part-time':'Part-time',contract:'Contract',internship:'Internship',volunteer:'Volunteer'};
async function isConversational(page) {
  if (await firstVisible(page, SEMANTIC_INPUT).count()) return true;
  if (/\/jobs\/search-results\//.test(new URL(page.url()).pathname)) {
    await firstVisible(page, SEMANTIC_INPUT).waitFor({state:'visible',timeout:15000});
    return true;
  }
  return false;
}
// LinkedIn normalizes URL keywords (observed: lowercase). Keep every term and accent.
function normalizeQuery(value) { return typeof value==='string' ? value.normalize('NFC').trim().replace(/\s+/gu,' ').toLowerCase() : null; }
function composeQuery(query, location) { return location && location.trim() ? `${query.trim()} in ${location.trim()}` : query; }
async function resultSignature(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('main [role="button"][componentkey^="job-card-component-ref-"], li[data-occludable-job-id], li.jobs-search-results__list-item, [data-job-id], .job-card-container, a[href*="/jobs/view/"]'))
    .filter(el => el.getClientRects().length)
    .map(el => [el.getAttribute('componentkey') || el.getAttribute('data-occludable-job-id') || el.getAttribute('data-job-id') || el.getAttribute('href') || '', el.textContent.trim().replace(/\s+/g,' ')].join(':')).join('|'));
}
async function submitQuery(page, query, {semantic=false, allowExisting=false, timeout=20000}={}) {
  const input = semantic ? firstVisible(page, SEMANTIC_INPUT) : await getSearchInput(page,'Search by title, skill, or company');
  const currentKeyword = () => {try{return new URL(page.url()).searchParams.get('keywords');}catch{return null;}};
  if ((allowExisting || confirmedQueries.get(page)===query) && normalizeQuery(currentKeyword())===normalizeQuery(query) && normalizeQuery(await input.inputValue())===normalizeQuery(query)) {
    confirmedQueries.set(page,query);return true;
  }
  const previous = await resultSignature(page);
  await input.fill(query);await input.press('Enter');
  try {
    await page.waitForFunction(({normalizedQuery,previous}) => {
      const keyword=new URL(location.href).searchParams.get('keywords');
      if(typeof keyword!=='string'||keyword.normalize('NFC').trim().replace(/\s+/gu,' ').toLowerCase()!==normalizedQuery)return false;
      const signature=Array.from(document.querySelectorAll('main [role="button"][componentkey^="job-card-component-ref-"], li[data-occludable-job-id], li.jobs-search-results__list-item, [data-job-id], .job-card-container, a[href*="/jobs/view/"]'))
        .filter(el=>el.getClientRects().length).map(el=>[el.getAttribute('componentkey') || el.getAttribute('data-occludable-job-id')||el.getAttribute('data-job-id')||el.getAttribute('href')||'',el.textContent.trim().replace(/\s+/g,' ')].join(':')).join('|');
      return !!signature && signature!==previous;
    },{normalizedQuery:normalizeQuery(query),previous},{timeout});
    await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
    await detectSecurityChallenge(page);confirmedQueries.set(page,query);return true;
  } catch(error) {
    if(error.name!=='TimeoutError')throw error;
    await detectSecurityChallenge(page);return false;
  }
}
async function modalFor(page) {
  const trigger=page.getByRole('button',{name:/^(All filters|Show all filters\.)/i}).filter({visible:true});
  if(await trigger.count()!==1)throw Error('LinkedIn conversacional: boton All filters no disponible o ambiguo');
  await trigger.click();
  // LinkedIn video players also expose role=dialog. Never let a dynamic .first()
  // move from the filters panel to an unrelated dialog after closing filters.
  const modal=page.locator('aside[aria-hidden="false"]:has(h2:text-is("Jobs filters")), :is([role="dialog"], dialog[open], .artdeco-modal):has(:is([role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]))').filter({visible:true});
  await modal.waitFor({state:'visible',timeout:15000});return modal;
}
async function option(modal,role,name) {
  const found=modal.getByRole(role,{name,exact:true}).filter({visible:true});
  // The panel can be visible before its asynchronous controls have mounted.
  // Wait for the requested control, never substitute another date or pick a duplicate.
  try { await found.waitFor({state:'visible',timeout:10000}); }
  catch(cause) {
    throw Error(`LinkedIn conversacional: filtro no disponible o ambiguo: ${name} (coincidencias visibles: ${await found.count()})`,{cause});
  }
  if(await found.count()!==1)throw Error(`LinkedIn conversacional: filtro no disponible o ambiguo: ${name} (coincidencias visibles: ${await found.count()})`);
  return found;
}
async function checked(control) {
  const aria=await control.getAttribute('aria-checked');
  return aria===null?control.isChecked():aria==='true';
}
async function setChecked(control,value) {
  if(await checked(control)!==value){
    const native=await control.evaluate(el=>el instanceof HTMLInputElement);
    if(native)await control.setChecked(value);else await control.click();
  }
  if(await checked(control)!==value)throw Error('LinkedIn conversacional: no se pudo confirmar el estado del filtro');
}
function requestedLabels(filters) {
  const date=filters.datePosted?DATE_LABELS[String(filters.datePosted).toLowerCase()]:null;
  const type=filters.employmentType?TYPE_LABELS[String(filters.employmentType).toLowerCase()]:null;
  if(filters.datePosted&&!date)throw Error('LinkedIn conversacional: fecha no soportada: '+filters.datePosted);
  if(filters.employmentType&&!type)throw Error('LinkedIn conversacional: jornada no soportada: '+filters.employmentType);
  return {date,type};
}
async function applyFilters(page,filters) {
  const {date,type}=requestedLabels(filters),modal=await modalFor(page);
  if(date)await setChecked(await option(modal,'radio',date),true);
  if(type){
    for(const label of Object.values(TYPE_LABELS).filter((x,i,a)=>a.indexOf(x)===i)) {
      const control=modal.getByRole('checkbox',{name:label,exact:true}).filter({visible:true});
      if(label===type && await control.count()>0)await setChecked(await option(modal,'checkbox',label),true);
      else if(await control.count()===1)await setChecked(control,false);
    }
  }
  const name=/^Show(?:\s+[\d,.+]+)?\s+results$/i;
  const show=modal.getByRole('button',{name}).or(modal.getByRole('link',{name})).filter({visible:true});
  if(await show.count()!==1)throw Error('LinkedIn conversacional: accion Show results no disponible o ambigua');
  await show.click();
  await modal.waitFor({state:'hidden',timeout:15000});
  await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});await detectSecurityChallenge(page);
}
async function verifyFilters(page,filters) {
  const {date,type}=requestedLabels(filters),modal=await modalFor(page);let dateOK=null,typeOK=null;
  try{
    if(date){
      dateOK=await checked(await option(modal,'radio',date));
      for(const label of [...new Set(Object.values(DATE_LABELS))].filter(x=>x!==date)){
        const control=modal.getByRole('radio',{name:label,exact:true}).filter({visible:true});
        if(await control.count()===1&&await checked(control))dateOK=false;
      }
    }
    if(type){
      const requested=modal.getByRole('checkbox',{name:type,exact:true}).filter({visible:true});
      typeOK=await requested.count()===0?null:await checked(await option(modal,'checkbox',type));
      for(const label of [...new Set(Object.values(TYPE_LABELS))].filter(x=>x!==type)){
        const control=modal.getByRole('checkbox',{name:label,exact:true}).filter({visible:true});
        if(await control.count()===1&&await checked(control))typeOK=false;
      }
    }
  }finally{
    const close=modal.getByRole('button',{name:/^(Close|Dismiss)$/i}).filter({visible:true});
    if(await close.count()===1)await close.click();else await page.keyboard.press('Escape');
    await modal.waitFor({state:'hidden',timeout:15000});
  }
  if(dateOK===false||typeOK===false)throw Error('LinkedIn conversacional: fecha o jornada solicitadas no quedaron activas; no se recolectan resultados sin esos filtros');
  const state=contexts.get(page),effectiveQuery=await firstVisible(page,SEMANTIC_INPUT).inputValue();
  const locationMentioned=filters.location?!!state&&effectiveQuery===composeQuery(state.query,filters.location):null;
  if(filters.location&&!locationMentioned)throw Error('LinkedIn conversacional: ubicacion solicitada no confirmada en la consulta');
  return {url:page.url(),datePostedActive:dateOK,employmentTypeActive:typeOK,locationActive:filters.location?false:null,
    employmentTypeMode:type&&typeOK===null?'detail':'filter',locationStrict:false,locationMode:'conversational_query',locationMentioned,effectiveQuery,searchMode:'conversational'};
}
async function initialize(page,query,filters,options={}) {
  contexts.set(page,{query,filters});
  if(!await submitQuery(page,composeQuery(query,filters.location),{semantic:true,allowExisting:true,timeout:options.queryTimeout}))throw Error('LinkedIn conversacional: no se confirmo el cambio de consulta/resultados');
  await applyFilters(page,filters);
  if(filters.location)console.error('[LinkedIn] Ubicacion solicitada en consulta conversacional; no es un filtro geografico estricto: '+filters.location);
  return {filtersActive:await verifyFilters(page,filters)};
}
async function changeQuery(page,query,options={}) {
  const state=contexts.get(page);if(!state)throw Error('LinkedIn conversacional: falta inicializar los filtros');
  const changed=await submitQuery(page,composeQuery(query,state.filters.location),{semantic:true,timeout:options.queryTimeout});
  if(changed){contexts.set(page,{...state,query});await applyFilters(page,state.filters);await verifyFilters(page,state.filters);}
  return changed;
}
module.exports={normalizeQuery,SEMANTIC_INPUT,isConversational,composeQuery,resultSignature,submitQuery,initialize,changeQuery,verifyFilters,applyFilters};
