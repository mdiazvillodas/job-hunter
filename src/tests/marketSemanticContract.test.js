'use strict';

// MD4 — endurecimiento del CONTRATO semantico.
//
// Regresion de lo observado en la tercera corrida real (mdrun_c83d6e0c38798da5):
// 9 evaluaciones, 6 aceptadas y 3 rechazadas por el contrato; el run murio al
// tercer fallo y el ledger solo habia guardado `name: SemanticContractError`,
// asi que la causa no se podia recuperar de los artefactos.
//
// Este archivo fija tres cosas:
//   1. que los limites del validador esten comunicados AGUAS ARRIBA (el modelo
//      conoce el contrato antes de responder);
//   2. que cada regla que puede rechazar una respuesta bien formada tenga un
//      CODIGO estable y persistible;
//   3. que las compuertas semanticas NO se hayan relajado.
//
// Determinista: sin OpenAI real, sin LinkedIn, sin Chromium, sin red.

const assert = require('assert/strict');

const { deriveProfile } = require('../marketDiscovery/profileMap');
const { createSemanticEvaluator, buildSystemPrompt } = require('../marketDiscovery/semanticEvaluator');
const {
  SEMANTIC_SCHEMA, SEMANTIC_RULES, SemanticContractError, toSafeSemanticDiagnostic,
  boundedDiagnosticMessage, MAX_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_EVIDENCE_ITEMS, MAX_TERMINOLOGY_ITEMS, MAX_REASON_ITEMS, DIMENSIONS, BLOCKING_DIMENSIONS, NON_BLOCKING_DIMENSIONS,
} = require('../marketDiscovery/semanticContract');
const { createExplorationEngine } = require('../marketDiscovery/explorationEngine');
const { DEFAULT_BUDGET, STOP_REASONS } = require('../marketDiscovery/explorationBudget');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed += 1; console.log('[PASS] ' + name); }

const PROFILE = deriveProfile({
  profile: {
    meta: { person: 'Example Person' },
    capabilities: [{ statement: 'Coordinate retail construction works', evidence: ['Delivered store fit-out programmes'] }],
    targetResponsibilities: [{ statement: 'Retail store delivery', evidence: ['Ran store openings'], language: 'en' }],
    industries: [{ statement: 'Retail construction', evidence: ['Delivered retail projects'] }],
    seniority: { assessedLevel: 'Senior', evidence: ['Led technical teams'] },
    unknowns: ['No evidence recorded for offshore work'],
  },
  matchingProfile: { roleTypesToAvoid: ['Exclusively commercial sales positions'] },
  config: { identity: { name: 'Example Person', email: 'person@example.invalid' }, search: { locations: ['Example region'], modalities: ['hybrid'] } },
});

const SECRET_DESCRIPTION = 'Buscamos un Gestor de obra para la implantacion de locales comerciales. '
  + 'Responsable de aperturas y reformas, coordinando el proyecto ejecutivo con contratistas.';

const posting = (extra = {}) => ({
  postingId: '4012345678',
  url: 'https://www.linkedin.com/jobs/view/4012345678/',
  title: 'Gestor de obra - locales comerciales',
  company: 'Example Retail SA',
  location: 'Example region',
  description: SECRET_DESCRIPTION,
  provenance: { searchId: 'search_1', familyId: 'family-0123456789abcdef', query: 'store development manager' },
  ...extra,
});

const allDimensions = (state = 'UNKNOWN', overrides = {}) => {
  const dimensions = {};
  for (const dimension of DIMENSIONS) dimensions[dimension] = state;
  return { ...dimensions, ...overrides };
};

const modelPayload = (extra = {}) => ({
  postingId: '4012345678',
  classification: 'COMPATIBLE',
  dimensions: allDimensions('NEUTRAL', { capabilities: 'SUPPORTS', responsibilities: 'SUPPORTS' }),
  rationale: 'Site management for retail fit-out overlaps the profile.',
  uncertaintyReasons: [],
  evidence: [{ dimension: 'responsibilities', sourceField: 'description', snippet: 'implantacion de locales comerciales' }],
  terminology: [{ type: 'ROLE_TITLE', expression: 'Gestor de obra', sourceField: 'title' }],
  ...extra,
});

function evaluate(payload, request = {}) {
  const transport = async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] });
  return createSemanticEvaluator({ transport, apiKey: 'test-key' })
    .evaluatePosting({ profile: PROFILE, posting: posting(), ...request });
}

// Captura el error de contrato para poder mirar su codigo, no solo su clase.
async function contractError(payload, request = {}) {
  try {
    await evaluate(payload, request);
  } catch (error) {
    return error;
  }
  throw new Error('expected a SemanticContractError');
}

// Repite un item valido n veces, manteniendo el anclaje literal.
const evidenceItems = (n) => Array.from({ length: n }, () => ({ dimension: 'responsibilities', sourceField: 'description', snippet: 'locales comerciales' }));
const terminologyItems = (n) => Array.from({ length: n }, (_, i) => ({ type: 'ROLE_TITLE', expression: i % 2 ? 'Gestor de obra' : 'locales comerciales', sourceField: i % 2 ? 'title' : 'description' }));
const reasonItems = (n) => Array.from({ length: n }, (_, i) => 'reason ' + i);

(async () => {
  console.log('\n### A. limites del validador comunicados aguas arriba');

  test('A1. el schema declara maxItems y coincide EXACTAMENTE con la constante del validador', () => {
    // El proveedor aplica el techo al generar; el validador lo sigue
    // comprobando como defensa en profundidad. Los dos numeros salen de la
    // misma constante, asi que no pueden separarse.
    const { evidence, terminology, uncertaintyReasons } = SEMANTIC_SCHEMA.properties;
    assert.equal(evidence.maxItems, MAX_EVIDENCE_ITEMS);
    assert.equal(terminology.maxItems, MAX_TERMINOLOGY_ITEMS);
    assert.equal(uncertaintyReasons.maxItems, MAX_REASON_ITEMS);
  });

  test('A1b. todo arreglo acotado por el validador declara su maxItems (ninguno se olvida)', () => {
    const bounded = { evidence: MAX_EVIDENCE_ITEMS, terminology: MAX_TERMINOLOGY_ITEMS, uncertaintyReasons: MAX_REASON_ITEMS };
    for (const [name, property] of Object.entries(SEMANTIC_SCHEMA.properties)) {
      if (property.type !== 'array') continue;
      assert.ok(name in bounded, 'arreglo sin cota conocida: ' + name);
      assert.equal(property.maxItems, bounded[name], name + '.maxItems');
    }
  });

  test('A2. cada arreglo acotado comunica SU limite real en el schema', () => {
    const { evidence, terminology, uncertaintyReasons } = SEMANTIC_SCHEMA.properties;
    assert.ok(evidence.description.includes(String(MAX_EVIDENCE_ITEMS)), 'evidence declara su maximo');
    assert.ok(terminology.description.includes(String(MAX_TERMINOLOGY_ITEMS)), 'terminology declara su maximo');
    assert.ok(uncertaintyReasons.description.includes(String(MAX_REASON_ITEMS)), 'uncertaintyReasons declara su maximo');
  });

  test('A3. el prompt comunica los mismos maximos, como limites y no como objetivos', () => {
    const prompt = buildSystemPrompt(PROFILE);
    assert.ok(prompt.includes(`at most ${MAX_EVIDENCE_ITEMS} items`));
    assert.ok(prompt.includes(`at most ${MAX_TERMINOLOGY_ITEMS} items`));
    assert.ok(prompt.includes(`at most ${MAX_REASON_ITEMS} items`));
    assert.ok(/maxima, never targets/.test(prompt), 'se enuncian como techo');
    assert.ok(/Never pad an array to reach its limit/.test(prompt), 'no se invita a rellenar');
  });

  test('A4. schema, prompt y validador leen la MISMA constante (no pueden derivar)', () => {
    const prompt = buildSystemPrompt(PROFILE);
    for (const cap of [MAX_EVIDENCE_ITEMS, MAX_TERMINOLOGY_ITEMS, MAX_REASON_ITEMS]) {
      assert.equal(typeof cap, 'number');
      assert.ok(prompt.includes(String(cap)));
    }
  });

  console.log('\n### B-G. cotas de arreglo: en el limite se acepta, pasado el limite se rechaza');

  await testAsync('B. evidencia en el maximo exacto se acepta', async () => {
    const result = await evaluate(modelPayload({ evidence: evidenceItems(MAX_EVIDENCE_ITEMS) }));
    assert.equal(result.classification, 'COMPATIBLE');
    assert.ok(result.evidence.length >= 1);
  });

  await testAsync('C. evidencia en maximo+1 se rechaza con codigo estable', async () => {
    const error = await contractError(modelPayload({ evidence: evidenceItems(MAX_EVIDENCE_ITEMS + 1) }));
    assert.ok(error instanceof SemanticContractError);
    assert.equal(error.code, SEMANTIC_RULES.EVIDENCE_LIMIT_EXCEEDED);
  });

  await testAsync('D. terminologia en el maximo exacto se acepta', async () => {
    const result = await evaluate(modelPayload({ terminology: terminologyItems(MAX_TERMINOLOGY_ITEMS) }));
    assert.equal(result.classification, 'COMPATIBLE');
  });

  await testAsync('E. terminologia en maximo+1 se rechaza con codigo estable', async () => {
    const error = await contractError(modelPayload({ terminology: terminologyItems(MAX_TERMINOLOGY_ITEMS + 1) }));
    assert.equal(error.code, SEMANTIC_RULES.TERMINOLOGY_LIMIT_EXCEEDED);
  });

  await testAsync('F. motivos en el maximo exacto se aceptan', async () => {
    const result = await evaluate(modelPayload({ classification: 'UNCERTAIN', uncertaintyReasons: reasonItems(MAX_REASON_ITEMS) }));
    assert.equal(result.classification, 'UNCERTAIN');
    assert.equal(result.uncertaintyReasons.length, MAX_REASON_ITEMS);
  });

  await testAsync('G. motivos en maximo+1 se rechazan con codigo estable', async () => {
    const error = await contractError(modelPayload({ classification: 'UNCERTAIN', uncertaintyReasons: reasonItems(MAX_REASON_ITEMS + 1) }));
    assert.equal(error.code, SEMANTIC_RULES.REASON_LIMIT_EXCEEDED);
  });

  console.log('\n### H-I. identidad de la oferta');

  await testAsync('H. postingId identico se acepta', async () => {
    const result = await evaluate(modelPayload({ postingId: '4012345678' }));
    assert.equal(result.postingId, '4012345678');
  });

  await testAsync('I. postingId distinto produce un codigo estable, sin normalizar nada', async () => {
    for (const wrong of ['4012345679', ' 4012345678', '4012345678 ', '', 'job:4012345678']) {
      const error = await contractError(modelPayload({ postingId: wrong }));
      assert.equal(error.code, SEMANTIC_RULES.POSTING_ID_MISMATCH, 'postingId=' + JSON.stringify(wrong));
    }
  });

  test('I2. el prompt exige el eco exacto del postingId', () => {
    assert.ok(/character-for-character identical/.test(buildSystemPrompt(PROFILE)));
  });

  console.log('\n### J-L. compuertas semanticas: siguen cerradas');

  await testAsync('J. COMPATIBLE sin evidencia anclada sigue rechazado', async () => {
    // Todos los fragmentos son inventados: el anclaje los descarta y COMPATIBLE
    // se queda sin ninguno.
    const error = await contractError(modelPayload({
      evidence: [{ dimension: 'responsibilities', sourceField: 'description', snippet: 'esto no aparece en la oferta' }],
    }));
    assert.equal(error.code, SEMANTIC_RULES.COMPATIBLE_NOT_GROUNDED);
    const empty = await contractError(modelPayload({ evidence: [] }));
    assert.equal(empty.code, SEMANTIC_RULES.COMPATIBLE_NOT_GROUNDED);
  });

  await testAsync('J2. COMPATIBLE sin capabilities ni responsibilities SUPPORTS sigue rechazado', async () => {
    const error = await contractError(modelPayload({ dimensions: allDimensions('NEUTRAL', { domain: 'SUPPORTS' }) }));
    assert.equal(error.code, SEMANTIC_RULES.COMPATIBLE_WITHOUT_SUPPORT);
  });

  await testAsync('K0. MODALIDAD en CONFLICTS ya NO invalida un COMPATIBLE fundado', async () => {
    // Decision de producto: Market Discovery responde si la oferta pertenece al
    // mercado profesional, no si el usuario deberia inscribirse. Una oferta
    // presencial con preferencia hibrida sigue ensenando vocabulario de mercado.
    const result = await evaluate(modelPayload({
      dimensions: allDimensions('NEUTRAL', { capabilities: 'SUPPORTS', responsibilities: 'SUPPORTS', modality: 'CONFLICTS' }),
    }));
    assert.equal(result.classification, 'COMPATIBLE');
    // El conflicto NO se borra: se registra con honestidad.
    assert.equal(result.dimensions.modality, 'CONFLICTS');
    assert.equal(result.terminology[0].promotable, true, 'su terminologia si alimenta el vocabulario');
  });

  test('K0b. el conjunto bloqueante es exactamente el profesional + geografia', () => {
    assert.deepEqual([...BLOCKING_DIMENSIONS].sort(),
      ['capabilities', 'direction', 'domain', 'exclusions', 'geography', 'responsibilities', 'seniority']);
    assert.deepEqual([...NON_BLOCKING_DIMENSIONS], ['modality']);
    assert.equal(DIMENSIONS.length, 8, 'modality sigue evaluandose y registrandose');
    assert.ok(DIMENSIONS.includes('modality'));
  });

  await testAsync('K1. GEOGRAFIA en CONFLICTS sigue rechazando COMPATIBLE', async () => {
    const error = await contractError(modelPayload({
      dimensions: allDimensions('NEUTRAL', { capabilities: 'SUPPORTS', geography: 'CONFLICTS' }),
    }));
    assert.equal(error.code, SEMANTIC_RULES.COMPATIBLE_WITH_CONFLICT);
    assert.ok(/cannot conflict on geography/.test(error.message));
  });

  await testAsync('K2. el prompt declara el conjunto bloqueante y la excepcion', async () => {
    const prompt = buildSystemPrompt(PROFILE);
    for (const dimension of BLOCKING_DIMENSIONS) assert.ok(prompt.includes(dimension), 'prompt names ' + dimension);
    assert.ok(/Exception: modality may be CONFLICTS and still be COMPATIBLE/.test(prompt));
    assert.ok(/Record it honestly/.test(prompt), 'modality se sigue registrando');
  });
  await testAsync('K. COMPATIBLE con cualquier dimension en CONFLICTS sigue rechazado', async () => {
    for (const dimension of BLOCKING_DIMENSIONS) {
      if (dimension === 'exclusions') continue; // tiene su propia regla, mas estricta
      // Se sostienen AMBAS dimensiones de apoyo para que la regla que falle sea
      // la del conflicto, tambien cuando la que conflictua es una de ellas.
      const error = await contractError(modelPayload({
        dimensions: allDimensions('NEUTRAL', { capabilities: 'SUPPORTS', responsibilities: 'SUPPORTS', [dimension]: 'CONFLICTS' }),
      }));
      assert.equal(error.code, SEMANTIC_RULES.COMPATIBLE_WITH_CONFLICT, 'dimension=' + dimension);
    }
  });

  await testAsync('L. una exclusion en CONFLICTS obliga a OUT_OF_SCOPE', async () => {
    for (const classification of ['COMPATIBLE', 'UNCERTAIN']) {
      const error = await contractError(modelPayload({
        classification,
        dimensions: allDimensions('NEUTRAL', { capabilities: 'SUPPORTS', exclusions: 'CONFLICTS' }),
      }));
      assert.equal(error.code, SEMANTIC_RULES.EXCLUSION_CONFLICT_NOT_OUT_OF_SCOPE);
    }
    const allowed = await evaluate(modelPayload({
      classification: 'OUT_OF_SCOPE',
      dimensions: allDimensions('NEUTRAL', { exclusions: 'CONFLICTS' }),
    }));
    assert.equal(allowed.classification, 'OUT_OF_SCOPE');
  });

  test('L2. el prompt enuncia cada regla que puede invalidar una respuesta bien formada', () => {
    const prompt = buildSystemPrompt(PROFILE);
    assert.ok(/If exclusions=CONFLICTS then classification MUST be OUT_OF_SCOPE/.test(prompt));
    assert.ok(/at least one of capabilities or responsibilities MUST be SUPPORTS/.test(prompt));
    // El prompt ya no dice "ninguna dimension": nombra EXACTAMENTE las que
    // bloquean, que es una afirmacion mas fuerte, no mas debil.
    assert.ok(/NONE of these may be CONFLICTS/.test(prompt));
    for (const dimension of BLOCKING_DIMENSIONS) assert.ok(prompt.includes(dimension), 'prompt names ' + dimension);
    assert.ok(/at least one evidence snippet that is found VERBATIM/.test(prompt));
  });

  console.log('\n### M-Q. diagnostico persistido: util y pobre a la vez');

  const engineWith = (evaluatorFn, postings = 3) => {
    const cards = Array.from({ length: postings }, (_, i) => ({
      jobId: String(2100 + i), url: 'https://www.linkedin.com/jobs/view/' + (2100 + i) + '/',
      title: 'Role ' + i, company: 'Co ' + i, location: 'Example region', easyApply: false,
    }));
    const source = {
      search: async (request) => ({
        status: 'COMPLETED', stopReason: 'no_next_page',
        observedScope: { location: 'VERIFIED' }, requestedScope: { location: 'Example region' },
        metrics: { rawCards: cards.length, uniqueResults: cards.length, pagesVisited: 1, limitReached: false },
        results: cards.map((c, i) => ({ ...c, searchId: request.search.searchId, position: i + 1 })),
      }),
    };
    return createExplorationEngine({ source, evaluator: { evaluatePosting: evaluatorFn } });
  };

  const OWNER = createOwner(OPERATION_TYPES.MARKET_DISCOVERY, 'md_contract1');
  const SEED_PLAN = {
    seeds: [{ familyId: 'family-1111111111111111', expression: 'Retail Architect', language: 'und', rank: 1 }],
    familiesConsidered: 1, familiesSelected: 1, truncated: false, omittedFamilies: [], priority: [],
  };
  const explore = (engine) => engine.explore({
    owner: OWNER, page: {}, profile: PROFILE, filters: { location: 'Example region' }, seedPlan: SEED_PLAN,
  });

  // Un fallo de contrato REAL, construido por el contrato mismo.
  const realContractError = () => {
    try {
      // evidencia por encima del limite -> EVIDENCE_LIMIT_EXCEEDED
      const { validateModelOutput } = require('../marketDiscovery/semanticContract');
      validateModelOutput(
        { ...modelPayload({ evidence: evidenceItems(MAX_EVIDENCE_ITEMS + 1) }) },
        { postingId: '4012345678' },
        { title: 'Gestor de obra', description: SECRET_DESCRIPTION }
      );
    } catch (error) { return error; }
    throw new Error('expected contract error');
  };

  let ledger = null;
  await testAsync('M. el ledger persiste el codigo de regla, no solo el nombre del error', async () => {
    ledger = await explore(engineWith(async () => { throw realContractError(); }));
    assert.equal(ledger.stopReason, STOP_REASONS.SEMANTIC_FAILED);
    const failure = ledger.failures.semantic[0];
    assert.equal(failure.name, 'SemanticContractError');
    assert.equal(failure.code, SEMANTIC_RULES.EVIDENCE_LIMIT_EXCEEDED);
    assert.equal(failure.rule, SEMANTIC_RULES.EVIDENCE_LIMIT_EXCEEDED, 'el codigo es uno conocido');
    assert.ok(failure.postingKey && failure.searchId, 'sigue diciendo que oferta y que busqueda');
  });

  test('N. el mensaje persistido esta acotado y saneado', () => {
    for (const failure of ledger.failures.semantic) {
      assert.equal(typeof failure.message, 'string');
      assert.ok(failure.message.length <= MAX_DIAGNOSTIC_MESSAGE_CHARS, 'mensaje acotado');
      assert.ok(!/[\u0000-\u001f]/.test(failure.message), 'sin caracteres de control');
    }
    const long = boundedDiagnosticMessage('x'.repeat(5000));
    assert.equal(long.length, MAX_DIAGNOSTIC_MESSAGE_CHARS);
    assert.equal(boundedDiagnosticMessage('  a\n\n  b  '), 'a b');
    assert.equal(boundedDiagnosticMessage(null), null);
  });

  test('O+P+Q. el diagnostico no arrastra oferta, respuesta del modelo, prompt ni credenciales', () => {
    const serialized = JSON.stringify(ledger.failures.semantic);
    assert.ok(!serialized.includes('implantacion de locales comerciales'), 'nada de la descripcion');
    assert.ok(!serialized.includes(SECRET_DESCRIPTION.slice(0, 40)), 'nada de la descripcion');
    assert.ok(!serialized.includes('Gestor de obra'), 'nada del contenido de la oferta');
    assert.ok(!serialized.includes('rationale') && !serialized.includes('Site management'), 'nada de la respuesta del modelo');
    assert.ok(!serialized.includes('ANTI-DRIFT') && !serialized.includes('You classify ONE job posting'), 'nada del prompt');
    assert.ok(!serialized.includes('test-key') && !/Bearer/i.test(serialized), 'nada de credenciales');
    assert.ok(!serialized.includes('api.openai.com'), 'nada del payload de la API');
  });

  test('O2. un error AJENO no puede colar su texto en el ledger', () => {
    const foreign = new Error('descripcion completa de la oferta con datos sensibles');
    foreign.name = 'WeirdError';
    const safe = toSafeSemanticDiagnostic(foreign);
    assert.equal(safe.name, 'WeirdError');
    assert.equal(safe.message, null, 'sin safeMessage propio no se persiste prosa');
    assert.equal(safe.rule, null, 'un codigo desconocido no se presenta como regla');
    assert.equal(safe.code, 'UNKNOWN');
  });

  test('O3. un valor venido del modelo se acota antes de entrar en el mensaje', () => {
    const error = (() => {
      try {
        const { validateModelOutput } = require('../marketDiscovery/semanticContract');
        validateModelOutput({ ...modelPayload(), extraneous: 'z'.repeat(4000) }, { postingId: '4012345678' }, { title: 't', description: 'd' });
      } catch (e) { return e; }
      throw new Error('expected contract error');
    })();
    assert.equal(error.code, SEMANTIC_RULES.UNEXPECTED_FIELD);
    assert.ok(error.safeMessage.length <= MAX_DIAGNOSTIC_MESSAGE_CHARS);
  });

  console.log('\n### R-U. lo que NO cambia');

  test('R. el umbral de fallos semanticos sigue siendo exactamente 3', () => {
    assert.equal(DEFAULT_BUDGET.maxSemanticFailures, 3);
    assert.equal(DEFAULT_BUDGET.maxEvaluations, 60);
  });

  await testAsync('R2. un fallo aislado NO corta el run; el tercero si', async () => {
    let calls = 0;
    const flaky = engineWith(async () => {
      calls += 1;
      if (calls === 1) throw realContractError();
      return { classification: 'UNCERTAIN', dimensions: {}, evidence: [], terminology: [], uncertaintyReasons: [] };
    });
    const isolated = await explore(flaky);
    assert.equal(isolated.failures.semantic.length, 1);
    assert.notEqual(isolated.stopReason, STOP_REASONS.SEMANTIC_FAILED, 'la exploracion continua');
    assert.ok(isolated.evaluations.length >= 1, 'las siguientes ofertas si se evaluan');
    assert.equal(ledger.failures.semantic.length, 3, 'al tercero se para');
  });

  await testAsync('S. una evaluacion valida sigue devolviendo lo mismo', async () => {
    const result = await evaluate(modelPayload());
    assert.equal(result.classification, 'COMPATIBLE');
    assert.equal(result.modelUsed, true);
    assert.equal(result.evidence[0].snippet, 'implantacion de locales comerciales');
    assert.equal(result.terminology[0].expression, 'Gestor de obra');
    assert.equal(result.terminology[0].promotable, true, 'la compuerta de terminologia no cambio');
  });

  await testAsync('T. OUT_OF_SCOPE no cambia y sigue sin producir terminologia', async () => {
    const result = await evaluate(modelPayload({
      classification: 'OUT_OF_SCOPE',
      dimensions: allDimensions('NEUTRAL', { domain: 'CONFLICTS' }),
    }));
    assert.equal(result.classification, 'OUT_OF_SCOPE');
    assert.deepEqual(result.terminology, [], 'OUT_OF_SCOPE nunca alimenta vocabulario');
  });

  await testAsync('U. UNCERTAIN no cambia y su terminologia sigue siendo no promocionable', async () => {
    const result = await evaluate(modelPayload({ classification: 'UNCERTAIN', uncertaintyReasons: ['thin description'] }));
    assert.equal(result.classification, 'UNCERTAIN');
    assert.equal(result.terminology[0].eligibility, 'REVIEW_ONLY');
    assert.equal(result.terminology[0].promotable, false);
  });

  await testAsync('U2. una oferta sin contenido sigue siendo UNCERTAIN sin llamar al modelo', async () => {
    let called = 0;
    const transport = async () => { called += 1; return { choices: [{ message: { content: '{}' } }] }; };
    const result = await createSemanticEvaluator({ transport, apiKey: 'test-key' })
      .evaluatePosting({ profile: PROFILE, posting: posting({ title: null, description: null }) });
    assert.equal(result.classification, 'UNCERTAIN');
    assert.equal(result.modelUsed, false);
    assert.equal(called, 0);
  });

  console.log(`\nMD4 Semantic Contract: ${passed} tests passed`);
})().catch((error) => {
  console.error('\n[FAIL]', error && error.stack ? error.stack : error);
  process.exit(1);
});
