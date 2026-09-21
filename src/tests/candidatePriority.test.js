'use strict';

// Tests del ordenamiento de candidatos previo al analisis.
// No abren navegador, no llaman a OpenAI y no ejecutan hunts.
// Ejecutar: node src/tests/candidatePriority.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');
const { runPipeline } = require('../pipeline/pipeline');
const { prioritizeCandidates, scoreCandidate, buildDomainTerms, isSoftwareArchitectCollision, isTechnicalCollision } = require('../domain/candidatePriority');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }
function tmpSvc() { return createJobService(createLocalRepository({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jh-prio-')) })); }

// Queries reales de una configuracion de arquitectura retail. El vocabulario
// POSITIVO sale de aca, no de una lista global del producto.
const RETAIL_QUERIES = [
  'Arquitecto retail',
  'Arquitecto locales comerciales',
  'Retail Project Manager',
  'Gestor proyectos obras retail',
  'Retail Construction Manager',
  'Project Manager reformas comerciales',
  'Store Design Manager',
  'Project Manager aperturas tiendas',
  'Retail Rollout Project Manager',
  'Arquitecto proyecto ejecutivo retail',
  'Project Architect - Retail',
  'Senior Retail Architect',
  'Senior Architect - Retail',
  'Retail Architect',
];

function job(id, title, over) {
  return {
    jobId: String(id), title, company: 'Co ' + id, location: 'Barcelona',
    url: 'https://www.linkedin.com/jobs/view/' + id + '/', easyApply: true,
    matchedQueries: ['Retail Architect'], matchedFamilies: ['user'], ...over,
  };
}
const idsOf = (list) => list.map((j) => j.jobId);
const rankOf = (list, id) => idsOf(list).indexOf(String(id));

function analysisOf(id) {
  return { decision: 'YES', overallMatchScore: 75, professionalFitScore: 80, interestFitScore: 70, cvFitScore: 70,
    roleFamily: 'Architecture', summary: 's', whyItFits: ['a'], transferableExperience: ['b'], literalMatches: ['c'],
    gaps: ['d'], criticalRequirementsUnmet: [], redFlags: [], recommendedCV: 'current_cv', cvAdjustments: ['e'],
    confidence: 80, reasoning: 'r', requirementAssessments: [], coreCapabilityCoverage: [] };
}
const okDetail = (j) => Promise.resolve({ ...j, description: 'Descripcion completa de ' + j.jobId, descriptionLength: 30 });

async function run() {
  // ---------- 1. arquitectura de edificacion/retail por delante de Solution Architect ----------
  section('1. Retail/building architecture ranks ahead of Solution Architect');
  {
    // El job de software va PRIMERO en el orden de descubrimiento: si no se
    // reordenara, se llevaria el slot.
    const input = [
      job('sol', 'Solution Architect'),
      job('data', 'Data Architect'),
      job('sw', 'Software Solutions Architect'),
      job('cloud', 'Senior Cloud Architect'),
      job('ent', 'Enterprise Architect'),
      job('es', 'Arquitecto de soluciones'),
      job('arq', 'Arquitecto/a Retail — Proyecto Ejecutivo'),
    ];
    const out = prioritizeCandidates(input, { queries: RETAIL_QUERIES });
    ok('el candidato de arquitectura retail queda primero', out[0].jobId === 'arq', idsOf(out).join(','));
    for (const id of ['sol', 'data', 'sw', 'cloud', 'ent', 'es']) {
      ok(`"${input.find((j) => j.jobId === id).title}" queda detras`, rankOf(out, 'arq') < rankOf(out, id));
    }
    ok('las 5 colisiones nombradas se detectan', ['Solution Architect', 'Data Architect', 'Software Architect', 'Cloud Architect', 'Enterprise Architect'].every(isSoftwareArchitectCollision));
    ok('un arquitecto de edificacion NO se marca como colision', !isSoftwareArchitectCollision('Arquitecto/a Técnico de Obra'));
  }

  // ---------- 2. retail/obra por delante de un IT Project Manager ----------
  section('2. Retail/construction project role ranks ahead of unrelated IT Project Manager');
  {
    const input = [
      job('it1', 'IT Project Manager (Retail-SAP)'),
      job('it2', 'Project Manager IT – Precision Medicine & Genomics'),
      job('it3', 'AWS Project Manager / Senior Project Manager'),
      job('ret', 'Retail Project Manager'),
      job('obra', 'Gestor de proyectos y obras retail'),
    ];
    const out = prioritizeCandidates(input, { queries: RETAIL_QUERIES });
    for (const id of ['it1', 'it2', 'it3']) {
      ok(`"Retail Project Manager" por delante de "${input.find((j) => j.jobId === id).title}"`, rankOf(out, 'ret') < rankOf(out, id));
      ok(`"Gestor de proyectos y obras retail" por delante de "${input.find((j) => j.jobId === id).title}"`, rankOf(out, 'obra') < rankOf(out, id));
    }
    // "Retail-SAP" comparte la palabra retail: aun asi no debe superar a un
    // candidato con mas evidencia de dominio.
    ok('un titulo IT que menciona retail no gana por esa sola palabra', rankOf(out, 'obra') < rankOf(out, 'it1'));
  }

  // ---------- 3. reordena pero NO borra ----------
  section('3. Candidates are reordered, never deleted');
  {
    const input = [
      job('a', 'Solution Architect'), job('b', 'Arquitecto retail'), job('c', 'Key Account Manager Regional'),
      job('d', 'Scrum Master'), job('e', 'Store Design Manager'), job('f', 'Data Architect'),
    ];
    const out = prioritizeCandidates(input, { queries: RETAIL_QUERIES });
    ok('misma cantidad de elementos', out.length === input.length, `${input.length} -> ${out.length}`);
    ok('exactamente los mismos jobIds', idsOf(out).slice().sort().join(',') === idsOf(input).slice().sort().join(','));
    ok('son las MISMAS referencias (no copias ni jobs inventados)', out.every((j) => input.includes(j)));
    ok('no muta el array de entrada', idsOf(input).join(',') === 'a,b,c,d,e,f');
    ok('el orden efectivamente cambia', idsOf(out).join(',') !== idsOf(input).join(','));
    // Incluso lo irrelevante sigue presente: esto ordena, no filtra.
    ok('los candidatos sin ninguna senal siguen en la lista', ['c', 'd'].every((id) => idsOf(out).includes(id)));
  }

  // ---------- determinismo y no-op ----------
  section('Determinism and no-op behaviour');
  {
    const input = [job('1', 'Arquitecto retail'), job('2', 'Solution Architect'), job('3', 'Retail Project Manager')];
    const a = idsOf(prioritizeCandidates(input, { queries: RETAIL_QUERIES }));
    const b = idsOf(prioritizeCandidates(input, { queries: RETAIL_QUERIES }));
    ok('mismas entradas -> mismo orden', a.join(',') === b.join(','));
    ok('sin queries es un no-op (conserva descubrimiento)', idsOf(prioritizeCandidates(input, {})).join(',') === '1,2,3');
    ok('queries vacias es un no-op', idsOf(prioritizeCandidates(input, { queries: [] })).join(',') === '1,2,3');
    const tie = [job('x', 'Arquitecto retail'), job('y', 'Arquitecto retail')];
    ok('empate se resuelve por orden de descubrimiento', idsOf(prioritizeCandidates(tie, { queries: RETAIL_QUERIES })).join(',') === 'x,y');
    ok('titulo nulo no rompe', prioritizeCandidates([job('n', null)], { queries: RETAIL_QUERIES }).length === 1);
    ok('mas queries coincidentes desempata hacia arriba',
      idsOf(prioritizeCandidates(
        [job('few', 'Arquitecto retail', { matchedQueries: ['Retail Architect'] }),
         job('many', 'Arquitecto retail', { matchedQueries: ['Retail Architect', 'Senior Retail Architect', 'Arquitecto retail'] })],
        { queries: RETAIL_QUERIES }
      )).join(',') === 'many,few');
    ok('el vocabulario sale de las queries del usuario',
      buildDomainTerms(RETAIL_QUERIES).strong.has('retail') && !buildDomainTerms(['Head of Operations']).strong.has('retail'));
    ok('una colision con VARIAS senales fuertes no se penaliza',
      scoreCandidate(job('s', 'Retail Solution Architect Store Rollout'), buildDomainTerms(RETAIL_QUERIES)).collision === false);
  }

  // ---------- "Architect" / "Project Manager" no son senal positiva ----------
  section('"Architect" / "Project Manager" alone are not positive signals');
  {
    const terms = buildDomainTerms(RETAIL_QUERIES);
    for (const title of ['Architect', 'Arquitecto', 'Project Manager', 'Senior Project Manager', 'Technical Project Manager']) {
      const s = scoreCandidate(job('t', title), terms);
      ok(`"${title}" no suma score por si solo (score=${s.score})`, s.score === 0 && s.strongHits === 0);
      ok(`"${title}" si registra el termino ambiguo (diagnostico)`, s.ambiguousHits > 0);
    }
    // Solo la evidencia de dominio puntua.
    ok('"Retail Architect" si puntua (retail es senal fuerte)',
      scoreCandidate(job('t', 'Retail Architect'), terms).score > 0);
    ok('"Project Manager obras tiendas" si puntua',
      scoreCandidate(job('t', 'Project Manager obras tiendas'), terms).strongHits === 2);
  }

  // ---------- IA / ML / GenAI como ruido fuera de alcance ----------
  section('AI / ML / GenAI roles rank as unrelated technical noise');
  {
    const AI_NOISE = [
      'AI Architect', 'GenAI Architect', 'Machine Learning Engineer', 'AI Engineer',
      'Data & AI Lead', 'AI/ML Project Manager', 'Technical Project Manager for AI',
      'AI Product Manager', 'Sr AI & Technical Project Manager On Demand',
      'Data Scientist', 'IT Project Manager (Retail-SAP)', 'Arquitecto/a Sénior .NET',
    ];
    ok('todos los titulos de IA/IT se detectan como colision tecnica', AI_NOISE.every(isTechnicalCollision), AI_NOISE.filter((t) => !isTechnicalCollision(t)).join(' | '));

    // Ninguna oferta real del dominio de Mari debe marcarse como colision.
    const REAL_DOMAIN = [
      'Arquitecto/a técnico/a', 'ARQUITECTO Y/O ARQUITECTO TÉCNICO', 'Arquitecte tècnic',
      'Responsable de Construcción / Construction Manager', 'PROJECT MANAGER de OBRAS',
      'Encargado de obra', 'Arquitecto/a Técnico/a DEO: Arquitectura y Edificación',
      'Director/a de Obra — Arquitecto/a', 'Project manager de producción de stands',
      'Retail Project Manager', 'Store Design Manager', 'Arquitecto proyecto ejecutivo retail',
    ];
    ok('ninguna oferta real del dominio se marca como colision', REAL_DOMAIN.every((t) => !isTechnicalCollision(t)), REAL_DOMAIN.filter(isTechnicalCollision).join(' | '));

    const input = [
      ...AI_NOISE.map((t, i) => job('ai' + i, t)),
      job('real1', 'Arquitecto/a Retail — Proyecto Ejecutivo'),
      job('real2', 'Project Manager obras y reformas comerciales'),
      job('real3', 'Arquitecto/a técnico/a'),
    ];
    const out = prioritizeCandidates(input, { queries: RETAIL_QUERIES });
    const worstReal = Math.max(rankOf(out, 'real1'), rankOf(out, 'real2'), rankOf(out, 'real3'));
    const bestNoise = Math.min(...AI_NOISE.map((_, i) => rankOf(out, 'ai' + i)));
    ok('los 3 candidatos del dominio quedan por delante de TODO el ruido IA/IT', worstReal < bestNoise, idsOf(out).join(','));
    ok('el ruido sigue presente (ordenado, no borrado)', AI_NOISE.every((_, i) => idsOf(out).includes('ai' + i)));
    // "Retail-SAP" menciona retail una vez: no alcanza para anular la colision.
    ok('una sola mencion de dominio no rescata un titulo IT', rankOf(out, 'real3') < rankOf(out, 'ai10'));
  }

  // ---------- 4. dedup intacto ----------
  section('4. Deduplication behaviour unchanged');
  {
    // Escenario compartido: mismo jobId repetido dentro de UNA discovery.
    // Se corre con y sin targetQueries para comprobar que el ordenamiento no
    // altera en nada la deduplicacion; no para cambiar lo que el pipeline hace.
    const scenario = () => ({
      jobs: [
        job('dup', 'Arquitecto retail'),
        job('dup', 'Arquitecto retail', { matchedQueries: ['Senior Retail Architect'] }),
        job('other', 'Solution Architect'),
      ],
      discovery: { queriesExecuted: 2, rawResults: 5, uniqueResults: 3, duplicatesRemoved: 2 },
    });
    const runWith = async (targetQueries) => {
      const svc = tmpSvc();
      const calls = [];
      const summary = await runPipeline({
        jobService: svc, analyzeLimit: 50, analysisTarget: 10, targetQueries,
        discover: async () => scenario(),
        fetchDetails: okDetail,
        analyze: (j) => { calls.push(j.jobId); return Promise.resolve({ analysis: analysisOf(j.jobId), model: 'test' }); },
      });
      return { svc, calls, summary };
    };
    const withOrder = await runWith(RETAIL_QUERIES);
    const without = await runWith(undefined);

    ok('duplicatesRemoved del collector se reporta igual', withOrder.summary.discovery.duplicatesRemoved === 2);
    ok('el jobId repetido se PERSISTE una sola vez',
      withOrder.summary.discovery.newJobs === 2 && withOrder.summary.persistence.created === 2,
      JSON.stringify(withOrder.summary.discovery));
    ok('matchedQueries del duplicado se fusionan (union)',
      withOrder.svc.getJob('dup').matchedQueries.length === 2, JSON.stringify(withOrder.svc.getJob('dup').matchedQueries));
    // Invariante real de este cambio: ordenar no altera la deduplicacion.
    ok('el ordenamiento no cambia la deduplicacion (identico con y sin targetQueries)',
      withOrder.summary.persistence.created === without.summary.persistence.created &&
      withOrder.summary.discovery.newJobs === without.summary.discovery.newJobs &&
      withOrder.calls.slice().sort().join(',') === without.calls.slice().sort().join(','),
      `con=${withOrder.calls.join(',')} sin=${without.calls.join(',')}`);
    ok('el candidato prioritario se analizo primero', withOrder.calls[0] === 'dup', withOrder.calls.join(','));

    // La garantia de deduplicacion que el pipeline SI posee: idempotencia entre
    // runs via shouldAnalyzeJob. Una oferta ya analizada no se re-analiza.
    const svc = tmpSvc();
    const calls = [];
    const again = (targetQueries) => runPipeline({
      jobService: svc, analyzeLimit: 50, analysisTarget: 10, targetQueries,
      discover: async () => ({ jobs: [job('a', 'Arquitecto retail')], discovery: {} }),
      fetchDetails: okDetail,
      analyze: (j) => { calls.push(j.jobId); return Promise.resolve({ analysis: analysisOf(j.jobId), model: 'test' }); },
    });
    await again(RETAIL_QUERIES);
    const second = await again(RETAIL_QUERIES);
    ok('una oferta ya analizada no se re-analiza en el run siguiente', calls.length === 1, calls.join(','));
    ok('y se contabiliza como alreadyAnalyzed', second.analysis.alreadyAnalyzed === 1 && second.discovery.existingJobs === 1);
  }

  // ---------- 5. targetAnalyzedJobs sigue limitando las llamadas ----------
  section('5. targetAnalyzedJobs still caps analyzer calls');
  {
    const svc = tmpSvc();
    const calls = [];
    // 30 candidatos, presupuesto 20: el orden cambia QUIEN entra, nunca CUANTOS.
    const many = [];
    for (let i = 0; i < 15; i += 1) many.push(job('it' + i, 'Solution Architect ' + i));
    for (let i = 0; i < 15; i += 1) many.push(job('re' + i, 'Arquitecto retail obras ' + i));
    const s = await runPipeline({
      jobService: svc, analyzeLimit: 50, analysisTarget: 20, targetQueries: RETAIL_QUERIES,
      discover: async () => ({ jobs: many, discovery: { queriesExecuted: 1, rawResults: 30, duplicatesRemoved: 0 } }),
      fetchDetails: okDetail,
      analyze: (j) => { calls.push(j.jobId); return Promise.resolve({ analysis: analysisOf(j.jobId), model: 'test' }); },
    });
    ok('exactamente 20 llamadas al analyzer', calls.length === 20, String(calls.length));
    ok('analyzed = 20 y stopReason = target_reached', s.analysis.analyzed === 20 && s.analysis.stopReason === 'target_reached');
    ok('los 30 candidatos siguen persistidos (no se borro ninguno)', s.discovery.newJobs === 30 && s.jobs.length === 30);
    ok('los 15 relevantes entraron en el presupuesto', calls.filter((id) => id.startsWith('re')).length === 15, calls.join(','));
    ok('los 15 de software quedaron al final (solo 5 alcanzaron)', calls.filter((id) => id.startsWith('it')).length === 5);
    ok('los no analizados quedan pending, no eliminados', svc.getJob('it14').analysisStatus === 'pending' && !!svc.getJob('it14'));

    // Sin prioridad, el mismo input gasta el presupuesto en el ruido: esto es
    // exactamente la regresion que el ordenamiento corrige.
    const svc2 = tmpSvc();
    const calls2 = [];
    await runPipeline({
      jobService: svc2, analyzeLimit: 50, analysisTarget: 20,
      discover: async () => ({ jobs: many, discovery: {} }),
      fetchDetails: okDetail,
      analyze: (j) => { calls2.push(j.jobId); return Promise.resolve({ analysis: analysisOf(j.jobId), model: 'test' }); },
    });
    ok('sin targetQueries se conserva el comportamiento previo', calls2.length === 20 && calls2[0] === 'it0');
    ok('y ese comportamiento previo desperdicia el presupuesto', calls2.filter((id) => id.startsWith('re')).length === 5);
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run();
