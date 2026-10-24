const test=require('node:test'),assert=require('node:assert/strict');
const {buildSystemPrompt,buildUserPrompt}=require('../ai/jobAnalyzer');
const legacy='If no evidence supports equivalence, classify as real_gap or critical_requirement_unmet by how critical it is.';
test('M3: oferta separada de hechos y transferencia entre cargos conservada',()=>{
 const p={experience:[{title:'Coordinador',responsibilities:['Coordiné entregas entre clientes y equipos técnicos.']}]};
 const before=JSON.stringify(p),system=buildSystemPrompt(p),user=buildUserPrompt({title:'Director',description:'Interim functional leadership'});
 assert(system.includes('Job requirements and examples present ONLY in the posting are never evidence'));
 assert(system.includes('Recognize underlying capabilities across titles, sectors and professions'));
 assert(system.includes(p.experience[0].responsibilities[0]));assert(!system.includes('Interim functional leadership'));assert(user.includes('Interim functional leadership'));assert.equal(JSON.stringify(p),before);
});
test('M4: regla heredada normalizada sin mutar hechos ni otras reglas',()=>{
 const p={experience:['Delivery'],transferability:{principle:'Never invent equivalence.',rules:[legacy,'Keep preferred distinct from required.']}};
 const before=JSON.stringify(p),prompt=buildSystemPrompt(p);
 assert(!prompt.includes(legacy));assert(prompt.includes('If evidence is missing, classify as NOT_EVIDENCED.'));
 assert(prompt.includes('Missing evidence alone is NOT_EVIDENCED'));assert(prompt.includes('ABSENT requires concrete evidence of absence'));
 assert(prompt.includes('Keep preferred distinct from required.'));assert.equal(JSON.stringify(p),before);
});
test('A8: Markdown superficial no presupone framework ni herramientas específicas',()=>{
 const p={candidateDocument:'Arquitecta edilicia. Trabajo en proyectos. Uso herramientas del sector.'};
 const prompt=buildSystemPrompt(p);assert(prompt.includes('does not imply a complete evaluation framework'));assert(!prompt.includes('ALREADY CONTAINS'));
 assert(prompt.includes('do not evidence any specific tool'));assert(prompt.includes('without blocking the search'));assert(prompt.includes(JSON.stringify(p)));
});
test('transferencia fundada junior sin métricas ni coincidencia literal',()=>{
 const p={candidateDocument:'En prácticas preparé planos de viviendas con AutoCAD bajo supervisión y registré mediciones en visitas de obra.'};
 const prompt=buildSystemPrompt(p);assert(prompt.includes(p.candidateDocument));assert(prompt.includes('responsibilities, tasks, methods or experiences'));assert(prompt.includes('never require management experience for junior roles')||prompt.includes('never reward verbosity')||prompt.includes('Never reward verbosity'));
});
