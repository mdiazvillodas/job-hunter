'use strict';

// Tests de InfoJobs como segunda fuente opcional.
// No abren navegador, no tocan la red y no llaman a OpenAI: el navegador, el
// collector y el detalle se inyectan.
// Ejecutar: node src/tests/infojobs.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const urls = require('../infojobs/urls');
const { evaluateInfoJobsChallenge } = require('../infojobs/challenge');
const { PROVINCES, provinceForLocation, resolveInfoJobsProvince } = require('../infojobs/provinces');
const { sourceOf, sourceLabel } = require('../domain/sources');
const { createJobRecord } = require('../domain/jobRecord');
const { validateUserConfig, getInfoJobsSettings } = require('../config/userConfig');
const { toEditableInfoJobs, applyInfoJobsSettings, applySearchSettings, toEditableSearch } = require('../config/searchSettings');
const { combineSummaries } = require('../pipeline/combineSummaries');
const { safeSummary } = require('../run/huntRunManager');
const { buildRunOutcomeNotification } = require('../notifications/runOutcome');
const { runInfoJobsHunt, createProgressTracker, getExecutionConfig } = require('../hunt');
const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');
const { SecurityChallengeError } = require('../linkedin/errors');
const L = require('../ui/jobListLogic');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }
function tmpSvc() { return createJobService(createLocalRepository({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jh-ij-')) })); }

const OFFER = 'https://www.infojobs.net/barcelona/director-operaciones/of-i3f9a1c2b4d5e6f7a8b9c0d1e2f3a4b5c';

function baseConfig(extra = {}) {
  return {
    identity: { name: 'Example User', linkedinUrl: 'https://www.linkedin.com/in/example-user/' },
    search: {
      targetAnalyzedJobs: 20,
      locations: ['Barcelona, Cataluña, España'],
      modalities: ['hybrid'],
      queryGroups: [{ family: 'operations', label: 'Operations', enabled: true, priority: 1, queries: [{ query: 'Operations Manager', enabled: true }] }],
    },
    ...extra,
  };
}

function summary(over = {}) {
  return {
    runId: 'run_x', startedAt: 'a', finishedAt: 'b', stoppedByChallenge: false, challenge: null,
    discovery: { queriesExecuted: 2, rawResults: 10, uniqueResults: 8, duplicatesRemoved: 2, newJobs: 5, existingJobs: 3, perQuery: [{ query: 'Ops', status: 'completed' }] },
    analysis: { requiringAnalysis: 5, alreadyAnalyzed: 3, processed: 4, analyzed: 4, failed: 0, skipped: 1, detailsFetched: 4, analysisEnabled: true, target: 20, stopReason: 'candidates_exhausted' },
    persistence: { created: 5, updated: 1, unchanged: 2 },
    notifications: { eligible: 1, sent: 1, alreadyNotified: 0, failed: 0 },
    usageTotals: { promptTokens: 100, completionTokens: 50, cachedTokens: 0, totalTokens: 150, model: 'm' },
    durations: { discoveryMs: 10, detailsMs: 10, analysisMs: 10, totalMs: 30 },
    jobs: [{ jobId: '1' }],
    ...over,
  };
}

const LONG_DESCRIPTION = 'Descripción de la oferta. '.repeat(30);

function infojobsDeps(over = {}) {
  const closed = { value: false };
  const deps = {
    options: {},
    infojobs: { enabled: true, profileDir: '/tmp/ij', filters: { provinceId: '9', datePosted: 'Past week', employmentType: 'Full-time' } },
    activeQueries: [{ query: 'Operations Manager', family: 'operations' }],
    analyze: async () => ({ analysis: { decision: 'MAYBE', overallMatchScore: 70 }, model: 'test' }),
    jobService: tmpSvc(),
    notify: async () => ({ status: 'below_threshold' }),
    stage: () => {},
    reportProgress: () => {},
    ANALYZE_LIMIT: 50,
    TARGET_ANALYZED_JOBS: 20,
    MAX_PAGES_PER_SEARCH: 2,
    MAX_RESULTS_PER_SEARCH: 25,
    browser: {
      launchInfoJobsBrowser: async () => ({ close: async () => { closed.value = true; } }),
      getInitialPage: async () => ({}),
    },
    collector: {
      collectInfoJobsSearches: async () => ({
        metadata: { searches: { total: 1, completed: 1 }, results: { rawResults: 1, uniqueResults: 1, duplicatesRemoved: 0 } },
        perQuery: [{ query: 'Operations Manager', status: 'completed' }],
        jobs: [{ jobId: 'ij_iabcdef123456', source: 'infojobs', title: 'Director de Operaciones', company: 'ACME', location: 'Barcelona', url: OFFER, matchedQueries: ['Operations Manager'], matchedFamilies: ['operations'] }],
      }),
    },
    detail: {
      fetchInfoJobsDetail: async (_page, job) => ({ jobId: job.jobId, description: LONG_DESCRIPTION, salary: '40.000 - 50.000 EUR / año' }),
    },
    ...over,
  };
  return { deps, closed };
}

async function run() {
  section('URLs y fuente');
  ok('id de oferta y url canonica', urls.parseOfferId(OFFER + '?page=1') === 'i3f9a1c2b4d5e6f7a8b9c0d1e2f3a4b5c'
    && urls.canonicalOfferUrl(OFFER + '?x=1#y') === OFFER);
  ok('jobId con prefijo ij_', urls.toJobId('IABC123') === 'ij_iabc123');
  ok('una url ajena no es oferta', urls.parseOfferId('https://evil.example/of-i3f9a1c2b4d5e6f7') === null);
  const search = new URL(urls.buildSearchUrl('Director de Operaciones', { provinceId: '9', datePosted: 'Past week' }, 2));
  ok('busqueda con provincia, fecha y pagina', search.searchParams.get('provinceIds') === '9'
    && search.searchParams.get('sinceDate') === '_7_DAYS' && search.searchParams.get('page') === '2');
  ok('sin provincia no se filtra', new URL(urls.buildSearchUrl('x', { provinceId: null })).searchParams.get('provinceIds') === null);
  ok('source: ausente = linkedin, prefijo ij_ = infojobs', sourceOf({ jobId: '123' }) === 'linkedin' && sourceOf({ jobId: 'ij_x' }) === 'infojobs');
  ok('etiqueta legible', sourceLabel('infojobs') === 'InfoJobs');
  const record = createJobRecord({ jobId: 'ij_x', salary: '30k', contractType: 'Indefinido' });
  ok('el registro guarda fuente y datos propios de InfoJobs', record.source === 'infojobs' && record.salary === '30k' && record.contractType === 'Indefinido');
  ok('un registro de LinkedIn sigue siendo linkedin', createJobRecord({ jobId: '42' }).source === 'linkedin');
  ok('la lista muestra la fuente', L.listItemView(createJobRecord({ jobId: 'ij_x' })).source === 'infojobs' && L.listItemView(createJobRecord({ jobId: '9' })).source === 'linkedin');

  section('Provincias');
  ok('Barcelona es la 9 (verificada en el recon)', PROVINCES.find((p) => p.name === 'Barcelona').id === '9');
  ok('ids unicos', new Set(PROVINCES.map((p) => p.id)).size === PROVINCES.length);
  ok('la ubicacion principal se traduce', provinceForLocation('Barcelona, Cataluña, España').id === '9' && provinceForLocation('Madrid').id === '33');
  ok('una ubicacion desconocida no inventa provincia', provinceForLocation('Example City') === null);
  ok('auto usa la ubicacion principal', resolveInfoJobsProvince(null, ['Madrid', 'Barcelona']).provinceId === '33');
  ok('all busca en toda España', resolveInfoJobsProvince('all', ['Madrid']).provinceId === null);
  ok('manual usa la elegida', resolveInfoJobsProvince('51', ['Madrid']).name === 'Vizcaya/Bizkaia');
  ok('un id no verificado no se usa a ciegas', resolveInfoJobsProvince('999', ['Madrid']).provinceId === null);

  section('Challenge');
  ok('CAPTCHA por url', evaluateInfoJobsChallenge({ url: 'https://geo.captcha-delivery.com/captcha/?x=1' }).signal === 'url:captcha');
  ok('pantalla de humano o robot', evaluateInfoJobsChallenge({ url: OFFER, text: '¿Eres humano o un robot?' }).signal === 'text:human_or_robot');
  ok('el texto normal de una oferta no es challenge', evaluateInfoJobsChallenge({ url: OFFER, text: 'Buscamos Director de Operaciones con experiencia en verificación de procesos.' }) === null);

  section('Configuracion');
  ok('un user.json sin bloque sources sigue validando y queda apagado', getInfoJobsSettings(validateUserConfig(baseConfig())).enabled === false);
  let threw = false;
  try { validateUserConfig(baseConfig({ sources: { infojobs: { enabled: 'yes' } } })); } catch (_) { threw = true; }
  ok('enabled tiene que ser booleano', threw);
  threw = false;
  try { validateUserConfig(baseConfig({ sources: { infojobs: { enabled: true, provinceId: 'Barcelona' } } })); } catch (_) { threw = true; }
  ok('provinceId invalido se rechaza', threw);

  const editable = toEditableInfoJobs(baseConfig());
  ok('vista editable: apagado, auto y provincia efectiva', editable.enabled === false && editable.provinceId === 'auto' && editable.effectiveProvince === 'Barcelona');
  const on = applyInfoJobsSettings(baseConfig(), { enabled: true, provinceId: 'auto' });
  ok('activar guarda enabled y provincia automatica', on.sources.infojobs.enabled === true && on.sources.infojobs.provinceId === null);
  const manual = applyInfoJobsSettings(on, { enabled: true, provinceId: '33' });
  ok('elegir provincia la guarda', manual.sources.infojobs.provinceId === '33' && toEditableInfoJobs(manual).effectiveProvince === 'Madrid');
  threw = false;
  try { applyInfoJobsSettings(on, { enabled: true, provinceId: '999' }); } catch (e) { threw = e.code === 'INVALID_SEARCH_SETTINGS'; }
  ok('una provincia desconocida se rechaza con error de settings', threw);
  const resaved = applySearchSettings(manual, toEditableSearch(manual));
  ok('guardar la busqueda no borra la configuracion de InfoJobs', resaved.sources.infojobs.enabled === true && resaved.sources.infojobs.provinceId === '33');
  const off = applyInfoJobsSettings(manual, { enabled: false, provinceId: '33' });
  ok('desactivar conserva la provincia elegida', off.sources.infojobs.enabled === false && off.sources.infojobs.provinceId === '33');

  section('Summary combinado');
  const li = summary();
  ok('sin InfoJobs el summary es exactamente el de LinkedIn', combineSummaries(li, null) === li);
  const both = combineSummaries(li, { summary: summary({ jobs: [{ jobId: 'ij_a' }] }) });
  ok('los contadores se suman', both.discovery.uniqueResults === 16 && both.analysis.analyzed === 8 && both.persistence.created === 10 && both.notifications.sent === 2);
  ok('las queries llevan su plataforma', both.discovery.perQuery.length === 2 && both.discovery.perQuery[1].source === 'infojobs');
  ok('las ofertas de ambas plataformas se conservan', both.jobs.length === 2);
  ok('desenlace por plataforma', both.sources.linkedin.status === 'completed' && both.sources.infojobs.status === 'completed');
  const ijChallenged = combineSummaries(li, { challenge: { source: 'text', signal: 'text:human_or_robot' }, error: 'InfoJobs presentó un CAPTCHA o bloqueo.' });
  ok('un CAPTCHA de InfoJobs no marca el hunt como detenido', ijChallenged.stoppedByChallenge === false && ijChallenged.sources.infojobs.status === 'stopped_by_challenge');
  ok('y los contadores de LinkedIn quedan intactos', ijChallenged.discovery.uniqueResults === 8);
  const safe = safeSummary(ijChallenged);
  ok('la API expone el desenlace saneado', safe.sources.infojobs.status === 'stopped_by_challenge' && safe.sources.infojobs.challenge.signal === 'text:human_or_robot');
  ok('sin InfoJobs la API no gana campos', safeSummary(li).sources === undefined);
  const notice = buildRunOutcomeNotification({ outcome: 'completed', summary: ijChallenged });
  ok('la notificacion de cierre avisa del CAPTCHA de InfoJobs', /InfoJobs: detenido por un CAPTCHA/.test(notice.body));

  section('Progreso acumulado');
  const seen = [];
  const tracker = createProgressTracker((p) => seen.push(p), 40);
  tracker.report({ phase: 'analysis', analysisCompleted: 7, uniqueJobsDiscovered: 12, analysisTarget: 20 });
  tracker.advance();
  tracker.report({ phase: 'analysis', analysisCompleted: 2, uniqueJobsDiscovered: 3, analysisTarget: 20 });
  const last = seen[seen.length - 1];
  ok('InfoJobs suma sobre lo hecho por LinkedIn', last.analysisCompleted === 9 && last.uniqueJobsDiscovered === 15);
  ok('el objetivo es el de ambas plataformas', last.analysisTarget === 40);

  section('Pipeline de InfoJobs (navegador simulado)');
  {
    const { deps, closed } = infojobsDeps();
    const result = await runInfoJobsHunt(deps);
    const saved = deps.jobService.getJob('ij_iabcdef123456');
    ok('corre discovery + detalle + analisis', result.summary && result.summary.analysis.analyzed === 1);
    ok('persiste la oferta como InfoJobs con salario', saved && saved.source === 'infojobs' && saved.salary === '40.000 - 50.000 EUR / año');
    ok('cierra su navegador', closed.value === true);
  }
  {
    const challenge = new SecurityChallengeError('captcha');
    challenge.challengeDiagnostic = { source: 'text', signal: 'text:human_or_robot', stage: 'discovery' };
    const { deps, closed } = infojobsDeps({ collector: { collectInfoJobsSearches: async () => { throw challenge; } } });
    const result = await runInfoJobsHunt(deps);
    ok('un CAPTCHA en discovery no lanza: se informa', !result.summary && result.challenge.signal === 'text:human_or_robot');
    ok('y el navegador se cierra igual', closed.value === true);
  }
  {
    const { deps } = infojobsDeps({ browser: { launchInfoJobsBrowser: async () => { throw new Error('no chromium'); }, getInitialPage: async () => ({}) } });
    const result = await runInfoJobsHunt(deps);
    ok('un error de InfoJobs no tumba el hunt', !result.summary && result.challenge === null && /InfoJobs/.test(result.error));
  }
  {
    const controller = new AbortController();
    const { deps } = infojobsDeps({
      options: { signal: controller.signal },
      collector: { collectInfoJobsSearches: async () => { controller.abort(); const e = new Error('Hunt cancelled.'); e.name = 'HuntCancelledError'; throw e; } },
    });
    let name = null;
    try { await runInfoJobsHunt(deps); } catch (e) { name = e.name; }
    ok('la cancelacion del usuario si se propaga', name === 'HuntCancelledError');
  }

  section('Hunt');
  {
    const huntSource = fs.readFileSync(path.join(__dirname, '..', 'hunt.js'), 'utf8');
    ok('InfoJobs solo corre si esta activado', /if \(!infojobs\) return linkedinSummary;/.test(huntSource));
    const cfg = getExecutionConfig.toString();
    ok('la configuracion de ejecucion lee el interruptor', /INFOJOBS_ENABLED/.test(cfg));
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run();
