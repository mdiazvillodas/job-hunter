'use strict';

// MD6 — vocabulario de mercado y portafolio de queries propuesto.
// Transformacion pura: sin LinkedIn, sin Chromium, sin OpenAI, sin red.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildQueryPortfolio, normalizeCurrentQueries, CURRENT_QUERY_STATUS } = require('../marketDiscovery/queryPortfolio');
const { VOCABULARY_STATES, QUERY_TEST_STATES, QUERY_USE, PORTFOLIO, POLICY_VERSION } = require('../marketDiscovery/vocabularyPolicy');
const runtime = require('../runtime');

const roots = [];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md6-')); roots.push(dir); return dir; }

// --- Constructores de ledger sintetico (sin datos ni identidad reales).
const P = (key, classification, company, familyIds, searchIds) => ({
  postingKey: key, postingId: key, classification, company,
  familyIds, searchIds, firstSearchId: searchIds[0], depth: searchIds[0].startsWith('d1') ? 1 : 0, evaluated: true,
});
const O = (expression, type, postingKey, company, familyIds, searchIds, depth = 0) => ({
  type, expression, normalized: expression.toLowerCase(), sourceField: 'title',
  promotable: true, eligibility: 'ELIGIBLE', postingKey, company, familyIds, searchIds, depth,
});
const S = (searchId, query, resultKeys, newPostingKeys, depth = 0, status = 'COMPLETED') => ({
  searchId, query, depth, status, stopReason: 'no_next_page', familyId: null,
  origin: depth === 0 ? 'SEED' : 'EXPANSION', resultKeys, newPostingKeys, overlapRatio: 0, newCompatible: 0,
});
const L = (parts = {}) => ({
  schemaVersion: 1, operationId: 'md_run_1', status: 'COMPLETED', partial: false, stopReason: 'COMPLETED',
  seedPlan: { familiesConsidered: 0, familiesSelected: 0, truncated: false, omittedFamilies: [], priority: [] },
  families: [], searches: [], postings: [], overlaps: [], evaluations: [], observations: [],
  expansion: { depth: 1, candidates: [], selected: [] }, failures: { source: [], semantic: [] },
  budget: { limits: {}, policy: {}, consumed: {}, remaining: {} }, ...parts,
});
const build = (ledger, extra = {}) => buildQueryPortfolio({ exploration: ledger, ...extra });
const termOf = (proposal, normalized) => proposal.vocabulary.find((term) => term.normalized === normalized);

(async () => {
  try {
    // --------------------------------------------- 1-9. agregacion y promocion
    test('1+2+7. three postings across two companies promote; two stay WATCH, never REJECTED', () => {
      const proposal = build(L({
        postings: [P('a', 'COMPATIBLE', 'C1', ['f1'], ['d0_1']), P('b', 'COMPATIBLE', 'C2', ['f1'], ['d0_1']), P('c', 'COMPATIBLE', 'C1', ['f1'], ['d0_1']), P('d', 'COMPATIBLE', 'C3', ['f1'], ['d0_1'])],
        observations: [
          O('Gestor de obra', 'ROLE_TITLE', 'a', 'C1', ['f1'], ['d0_1']),
          O('Gestor de obra', 'ROLE_TITLE', 'b', 'C2', ['f1'], ['d0_1']),
          O('Gestor de obra', 'ROLE_TITLE', 'c', 'C1', ['f1'], ['d0_1']),
          O('Jefe de obra', 'ROLE_TITLE', 'a', 'C1', ['f1'], ['d0_1']),
          O('Jefe de obra', 'ROLE_TITLE', 'd', 'C3', ['f1'], ['d0_1']),
        ],
      }));
      const promoted = termOf(proposal, 'gestor de obra');
      assert.equal(promoted.state, VOCABULARY_STATES.PROMOTED);
      assert.equal(promoted.distinctPostings, 3);
      assert.equal(promoted.distinctCompanies, 2);
      const watch = termOf(proposal, 'jefe de obra');
      assert.equal(watch.state, VOCABULARY_STATES.WATCH);
      assert.notEqual(watch.state, VOCABULARY_STATES.REJECTED, 'evidencia escasa es WATCH, no REJECTED');
      assert(/2 of 3 required/.test(watch.stateReason));
    });
    test('3+4+5. duplicates and repeated mentions cannot promote; company is never invented', () => {
      const proposal = build(L({
        // La MISMA oferta vista por tres busquedas, mencionando el termino tres veces.
        postings: [P('dup', 'COMPATIBLE', null, ['f1', 'f2'], ['d0_1', 'd0_2', 'd0_3'])],
        observations: [
          O('Obra retail', 'ROLE_TITLE', 'dup', null, ['f1', 'f2'], ['d0_1', 'd0_2', 'd0_3']),
          O('Obra retail', 'ROLE_TITLE', 'dup', null, ['f1', 'f2'], ['d0_1', 'd0_2', 'd0_3']),
          O('Obra retail', 'ROLE_TITLE', 'dup', null, ['f1', 'f2'], ['d0_1', 'd0_2', 'd0_3']),
        ],
      }));
      const term = termOf(proposal, 'obra retail');
      assert.equal(term.distinctPostings, 1, 'una oferta cuenta una vez');
      assert.equal(term.observations, 3, 'las menciones se registran pero no suman soporte');
      assert.equal(term.state, VOCABULARY_STATES.WATCH);
      assert.equal(term.distinctCompanies, 0);
      assert.deepEqual(term.companies, [], 'no se inventa empresa');
      assert.equal(term.postingsWithCompany, 0);
    });
    test('6. an explicit profile exclusion rejects the term and its query use', () => {
      const proposal = build(L({
        postings: ['a', 'b', 'c'].map((key, i) => P(key, 'COMPATIBLE', `C${i}`, ['f1'], ['d0_1'])),
        observations: ['a', 'b', 'c'].map((key, i) => O('Commercial sales', 'ROLE_TITLE', key, `C${i}`, ['f1'], ['d0_1'])),
      }), { profile: { exclusions: [{ text: 'Exclusively commercial sales positions' }] } });
      const term = termOf(proposal, 'commercial sales');
      assert.equal(term.state, VOCABULARY_STATES.REJECTED);
      assert.equal(term.stateReason, 'matches an explicit profile exclusion');
      const candidate = proposal.queryCandidates.find((c) => c.normalized === 'commercial sales');
      if (candidate) assert.equal(candidate.queryUse, QUERY_USE.INELIGIBLE);
      assert(!proposal.selectedQueries.some((q) => q.normalized === 'commercial sales'));
    });
    test('8+9. OUT_OF_SCOPE and UNCERTAIN evidence never supports vocabulary', () => {
      const proposal = build(L({
        postings: [P('a', 'OUT_OF_SCOPE', 'C1', ['f1'], ['d0_1']), P('b', 'UNCERTAIN', 'C2', ['f1'], ['d0_1']), P('c', 'COMPATIBLE', 'C3', ['f1'], ['d0_1'])],
        observations: [
          O('Noisy term', 'ROLE_TITLE', 'a', 'C1', ['f1'], ['d0_1']),
          O('Noisy term', 'ROLE_TITLE', 'b', 'C2', ['f1'], ['d0_1']),
          O('Noisy term', 'ROLE_TITLE', 'c', 'C3', ['f1'], ['d0_1']),
          // Una observacion no promocionable tampoco cuenta.
          { ...O('Noisy term', 'ROLE_TITLE', 'c', 'C3', ['f1'], ['d0_1']), promotable: false },
        ],
      }));
      const term = termOf(proposal, 'noisy term');
      assert.equal(term.distinctPostings, 1, 'solo la oferta COMPATIBLE aporta');
      assert.equal(term.state, VOCABULARY_STATES.WATCH);
    });

    // ------------------------------------------ 10-13. variantes y procedencia
    test('10-13. variants, types and initial/expansion provenance are preserved', () => {
      const proposal = build(L({
        postings: [P('a', 'COMPATIBLE', 'C1', ['f1'], ['d0_1']), P('b', 'COMPATIBLE', 'C2', ['f1'], ['d0_1']), P('c', 'COMPATIBLE', 'C3', [], ['d1_1'])],
        observations: [
          O('Gestor de Obra', 'ROLE_TITLE', 'a', 'C1', ['f1'], ['d0_1']),
          { ...O('gestor de obra', 'ROLE_TITLE', 'b', 'C2', ['f1'], ['d0_1']), expression: 'GESTOR DE OBRA' },
          { ...O('gestor de obra', 'DISCRIMINATOR', 'c', 'C3', [], ['d1_1'], 1), expression: 'Gestor de obra' },
        ],
      }));
      const term = termOf(proposal, 'gestor de obra');
      assert.deepEqual(term.variants, ['Gestor de Obra', 'GESTOR DE OBRA', 'Gestor de obra'], 'se conservan los originales');
      assert.deepEqual([...term.types].sort(), ['DISCRIMINATOR', 'ROLE_TITLE']);
      assert.equal(term.initialEvidence, 2);
      assert.equal(term.expansionEvidence, 1);
      assert.deepEqual(term.sourceFields, ['title']);
      assert.deepEqual(term.postingKeys, ['a', 'b', 'c']);
    });

    // ------------------------------------------- 14-20. prueba de query
    function testedLedger(query, classifications, { firstSearch = 'd1_1' } = {}) {
      const keys = classifications.map((_, i) => `${query.replace(/\W/g, '')}_${i}`);
      return L({
        postings: keys.map((key, i) => ({ ...P(key, classifications[i], `C${i}`, [], [firstSearch]), firstSearchId: firstSearch })),
        searches: [S(firstSearch, query, keys, keys, 1)],
        observations: keys.filter((_, i) => classifications[i] === 'COMPATIBLE').map((key, i) => O(query, 'ROLE_TITLE', key, `C${i}`, [], [firstSearch], 1)),
      });
    }
    test('14-18. the query test policy validates only real, sufficient, incremental evidence', () => {
      const positive = build(testedLedger('Site Manager', ['COMPATIBLE', 'COMPATIBLE', 'COMPATIBLE', 'COMPATIBLE', 'OUT_OF_SCOPE']));
      const positiveCandidate = positive.queryCandidates.find((c) => c.normalized === 'site manager');
      assert.equal(positiveCandidate.status, QUERY_TEST_STATES.TESTED_POSITIVE);
      assert(/5 postings, 80% compatible, 4 incremental/.test(positiveCandidate.statusReason));
      // Muestra insuficiente.
      const small = build(testedLedger('Small Sample', ['COMPATIBLE', 'COMPATIBLE', 'COMPATIBLE', 'COMPATIBLE']));
      assert.equal(small.queryCandidates.find((c) => c.normalized === 'small sample').status, QUERY_TEST_STATES.TESTED_NEGATIVE);
      // Ratio bajo -> ruidosa -> inelegible como query, pero sigue siendo vocabulario.
      const noisy = build(testedLedger('Commercial Manager', ['COMPATIBLE', 'OUT_OF_SCOPE', 'OUT_OF_SCOPE', 'OUT_OF_SCOPE', 'OUT_OF_SCOPE', 'OUT_OF_SCOPE']));
      const noisyCandidate = noisy.queryCandidates.find((c) => c.normalized === 'commercial manager');
      assert.equal(noisyCandidate.status, QUERY_TEST_STATES.TESTED_NEGATIVE);
      assert.equal(noisyCandidate.queryUse, QUERY_USE.INELIGIBLE);
      assert(/tested and noisy/.test(noisyCandidate.queryUseReason));
      assert(termOf(noisy, 'commercial manager'), 'el termino sigue existiendo como vocabulario');
      assert(!noisy.selectedQueries.some((q) => q.normalized === 'commercial manager'));
    });
    test('17+19+20. low incremental value is negative; untested terms are marked UNTESTED', () => {
      // Cinco compatibles pero solo una incremental: el resto ya se conocia.
      const keys = ['k0', 'k1', 'k2', 'k3', 'k4'];
      const ledger = L({
        postings: keys.map((key, i) => ({ ...P(key, 'COMPATIBLE', `C${i}`, [], ['d1_1']), firstSearchId: i === 0 ? 'd1_1' : 'd0_1' })),
        searches: [S('d1_1', 'Redundant Term', keys, ['k0'], 1)],
        observations: keys.map((key, i) => O('Redundant Term', 'ROLE_TITLE', key, `C${i}`, [], ['d1_1'], 1)),
      });
      const proposal = build(ledger);
      const candidate = proposal.queryCandidates.find((c) => c.normalized === 'redundant term');
      assert.equal(candidate.status, QUERY_TEST_STATES.TESTED_NEGATIVE);
      assert(/1 incremental compatible postings, below 2/.test(candidate.statusReason));
      // Vocabulario valido (5 ofertas, 5 empresas) aunque la query sea floja.
      assert.equal(termOf(proposal, 'redundant term').state, VOCABULARY_STATES.PROMOTED);
      // Un termino nunca ejecutado es UNTESTED, no fabricado.
      const untested = build(L({
        postings: ['a', 'b', 'c'].map((key, i) => P(key, 'COMPATIBLE', `C${i}`, ['f1'], ['d0_1'])),
        observations: ['a', 'b', 'c'].map((key, i) => O('Never searched', 'ROLE_TITLE', key, `C${i}`, ['f1'], ['d0_1'])),
      }));
      assert.equal(untested.queryCandidates.find((c) => c.normalized === 'never searched').status, QUERY_TEST_STATES.UNTESTED);
    });

    // ------------------------------------------- 21-23. genericos y combinaciones
    test('21+22+23. generic words never stand alone; only observed combinations are generated', () => {
      const postings = ['a', 'b', 'c', 'd'].map((key, i) => P(key, 'COMPATIBLE', `C${i}`, ['f1'], ['d0_1']));
      const proposal = build(L({
        postings,
        observations: [
          ...['a', 'b', 'c'].map((key, i) => O('Gestor de obra', 'ROLE_TITLE', key, `C${i}`, ['f1'], ['d0_1'])),
          ...['a', 'b', 'c'].map((key, i) => O('locales comerciales', 'DISCRIMINATOR', key, `C${i}`, ['f1'], ['d0_1'])),
          ...['a', 'b', 'c', 'd'].map((key, i) => O('Manager', 'ROLE_TITLE', key, `C${i}`, ['f1'], ['d0_1'])),
          ...['a', 'b', 'd'].map((key, i) => O('aperturas', 'DISCRIMINATOR', key, `C${i}`, ['f1'], ['d0_1'])),
        ],
      }));
      const generic = termOf(proposal, 'manager');
      assert.equal(generic.state, VOCABULARY_STATES.PROMOTED, 'sigue siendo vocabulario');
      assert.equal(generic.generic, true);
      const genericCandidate = proposal.queryCandidates.find((c) => c.normalized === 'manager');
      assert.equal(genericCandidate.queryUse, QUERY_USE.INELIGIBLE);
      assert(/too generic to stand alone/.test(genericCandidate.queryUseReason));
      assert(!proposal.selectedQueries.some((q) => q.normalized === 'manager'));
      // Combinacion observada en las MISMAS ofertas compatibles: permitida.
      const combination = proposal.queryCandidates.find((c) => c.normalized === 'gestor de obra locales comerciales');
      assert(combination, 'la combinacion co-observada existe');
      assert.deepEqual(combination.components, ['gestor de obra', 'locales comerciales']);
      assert.equal(combination.status, QUERY_TEST_STATES.UNTESTED);
      // "aperturas" solo comparte 2 ofertas con el rol: no se combina.
      assert(!proposal.queryCandidates.some((c) => c.normalized === 'gestor de obra aperturas'));
      // Nunca se inventa una combinacion con un termino no observado.
      assert(!proposal.queryCandidates.some((c) => /fit out|remoto|senior/.test(c.normalized)));
    });

    // ------------------------------------------- 24-26. duplicados e idiomas
    test('24+25+26. exact duplicates merge; language variants never do and are never inferred', () => {
      const proposal = build(L({
        families: [{ familyId: 'f1', expression: 'Gestor de obra', rank: 1 }],
        postings: ['a', 'b', 'c'].map((key, i) => P(key, 'COMPATIBLE', `C${i}`, ['f1'], ['d0_1'])),
        observations: [
          ...['a', 'b', 'c'].map((key, i) => O('Gestor de obra', 'ROLE_TITLE', key, `C${i}`, ['f1'], ['d0_1'])),
          ...['a', 'b', 'c'].map((key, i) => O('Site Manager', 'ROLE_TITLE', key, `C${i}`, ['f1'], ['d0_1'])),
        ],
      }));
      // La familia semilla y el ROLE_TITLE promovido son la MISMA query normalizada.
      const duplicates = proposal.queryCandidates.filter((c) => c.normalized === 'gestor de obra');
      assert.equal(duplicates.length, 1, 'un solo candidato');
      assert.deepEqual([...duplicates[0].provenance].sort(), ['PROMOTED_ROLE_TITLE', 'SEED_EXPRESSION'], 'conserva ambas procedencias');
      // Variantes en distinto idioma NO se fusionan.
      assert(termOf(proposal, 'gestor de obra') && termOf(proposal, 'site manager'));
      // El idioma nunca se infiere de la oferta ni de la query.
      for (const term of proposal.vocabulary) {
        assert.equal(term.language, null);
        assert.equal(term.languageEvidence, 'not evidenced by the sample');
      }
    });

    // ================= FIXTURE REALISTA DE PORTAFOLIO =================
    // Familia 1: muchas variantes solapadas. Familia 2: menos ofertas pero
    // realmente incrementales. Terminos en español y en ingles. Un termino
    // generico. Una expansion probada util y otra ruidosa. Duplicados entre
    // busquedas. Sin datos ni identidad reales.
    function realisticLedger() {
      const postings = [
        P('p1', 'COMPATIBLE', 'Alfa SA', ['f1', 'f3'], ['d0_1', 'd0_3']),
        P('p2', 'COMPATIBLE', 'Beta SA', ['f1'], ['d0_1']),
        P('p3', 'COMPATIBLE', 'Gamma SA', ['f1'], ['d0_1']),
        P('p7', 'COMPATIBLE', 'Delta SA', ['f2'], ['d0_2']),
        P('p8', 'COMPATIBLE', 'Epsilon SA', ['f2'], ['d0_2']),
        P('p9', 'COMPATIBLE', 'Zeta SA', ['f2'], ['d0_2']),
        P('p30', 'OUT_OF_SCOPE', 'Eta SA', ['f3'], ['d0_3']),
        P('p4', 'COMPATIBLE', 'Theta SA', [], ['d1_1']),
        P('p5', 'COMPATIBLE', 'Iota SA', [], ['d1_1']),
        P('p6', 'COMPATIBLE', 'Kappa SA', [], ['d1_1']),
        P('p10', 'COMPATIBLE', 'Lambda SA', [], ['d1_1']),
        P('p11', 'OUT_OF_SCOPE', 'Mu SA', [], ['d1_1']),
        ...['p15', 'p16', 'p17', 'p18', 'p19', 'p20'].map((key, i) => P(key, i === 0 ? 'COMPATIBLE' : 'OUT_OF_SCOPE', `Noisy ${i} SA`, [], ['d1_2'])),
      ];
      return L({
        families: [
          { familyId: 'f1', expression: 'Gestor de obra retail', rank: 1 },
          { familyId: 'f2', expression: 'Delineante obra', rank: 2 },
          { familyId: 'f3', expression: 'Obra civil', rank: 3 },
        ],
        postings,
        searches: [
          S('d0_1', 'Gestor de obra retail', ['p1', 'p2', 'p3'], ['p1', 'p2', 'p3']),
          S('d0_2', 'Delineante obra', ['p7', 'p8', 'p9'], ['p7', 'p8', 'p9']),
          S('d0_3', 'Obra civil', ['p1', 'p30'], ['p30']),
          S('d1_1', 'Site Manager', ['p4', 'p5', 'p6', 'p10', 'p11'], ['p4', 'p5', 'p6', 'p10', 'p11'], 1),
          S('d1_2', 'Commercial Manager', ['p15', 'p16', 'p17', 'p18', 'p19', 'p20'], ['p15', 'p16', 'p17', 'p18', 'p19', 'p20'], 1),
        ],
        observations: [
          ...['p1', 'p2', 'p3'].map((key) => O('Gestor de obra', 'ROLE_TITLE', key, null, key === 'p1' ? ['f1', 'f3'] : ['f1'], ['d0_1'])),
          ...['p1', 'p2', 'p3'].map((key) => O('locales comerciales', 'DISCRIMINATOR', key, null, key === 'p1' ? ['f1', 'f3'] : ['f1'], ['d0_1'])),
          ...['p1', 'p2', 'p3', 'p4'].map((key) => O('Manager', 'ROLE_TITLE', key, null, key === 'p1' ? ['f1', 'f3'] : ['f1'], ['d0_1'])),
          ...['p7', 'p8', 'p9'].map((key) => O('Delineante de obra', 'ROLE_TITLE', key, null, ['f2'], ['d0_2'])),
          ...['p4', 'p5', 'p6', 'p10'].map((key) => O('Site Manager', 'ROLE_TITLE', key, null, [], ['d1_1'], 1)),
          O('Commercial Manager', 'ROLE_TITLE', 'p15', null, [], ['d1_2'], 1),
        ].map((observation) => ({ ...observation, company: (postings.find((p) => p.postingKey === observation.postingKey) || {}).company || null })),
      });
    }
    test('REALISTIC PORTFOLIO FIXTURE: incremental coverage beats variant stacking', () => {
      const proposal = build(realisticLedger());
      const chosen = proposal.selectedQueries.map((entry) => entry.normalized);

      // No se elige toda variante de la familia mas grande.
      const f1Candidates = proposal.queryCandidates.filter((c) => /gestor de obra/.test(c.normalized));
      assert(f1Candidates.length >= 3, 'la familia grande ofrece varias variantes');
      assert.equal(chosen.filter((n) => /gestor de obra/.test(n)).length, 1, 'solo una de ellas entra');
      // La segunda familia, con menos ofertas pero incrementales, aparece.
      assert(chosen.includes('delineante de obra') || chosen.includes('delineante obra'), 'la familia 2 recibe cobertura');
      // La expansion probada positiva se favorece; la ruidosa no.
      assert(chosen.includes('site manager'));
      const site = proposal.selectedQueries.find((entry) => entry.normalized === 'site manager');
      assert.equal(site.status, QUERY_TEST_STATES.TESTED_POSITIVE);
      assert.equal(site.incrementalCoverageAtSelection, 4);
      assert(!chosen.includes('commercial manager'));
      const noisy = proposal.unselectedCandidates.find((c) => c.normalized === 'commercial manager');
      assert(/tested and noisy/.test(noisy.reason));
      // Ambos idiomas sobreviven porque cada uno aporta evidencia distinta.
      assert(chosen.some((n) => /gestor|delineante/.test(n)) && chosen.includes('site manager'));
      // El duplicado p1 no infla el soporte.
      assert.equal(termOf(proposal, 'gestor de obra').distinctPostings, 3);
      assert.equal(termOf(proposal, 'gestor de obra').searchIds.length, 1);
      // El generico no entra como query suelta.
      assert(!chosen.includes('manager'));
      // Cobertura auditable y explicable.
      assert.equal(proposal.evidenceCoverage.compatiblePostings, 11);
      assert.equal(proposal.evidenceCoverage.coveredByPortfolio, 10, 'p15 solo lo cubre una query ruidosa');
      assert.deepEqual(proposal.evidenceCoverage.uncoveredCompatiblePostings, ['p15']);
      for (const entry of proposal.selectedQueries) assert(entry.whySelected && entry.whySelected.length > 10);
      for (const entry of proposal.unselectedCandidates) assert(entry.reason && entry.reason.length > 5);
    });

    // ------------------------------------------- 27-34. seleccion y tamaño
    test('27+28+29+30. marginal coverage, redundancy and family diversity', () => {
      const proposal = build(realisticLedger());
      // Cada seleccion aporta cobertura nueva; ninguna entra con cero marginal.
      for (const entry of proposal.selectedQueries) assert(entry.incrementalCoverageAtSelection > 0);
      // Un candidato redundante pierde y declara con quien solapa.
      const redundant = proposal.unselectedCandidates.find((c) => c.remainingIncrementalCoverage === 0 && c.queryUse === QUERY_USE.ELIGIBLE);
      assert(redundant, 'hay al menos un candidato redundante');
      assert(/already covered by a selected query/.test(redundant.reason));
      assert(redundant.redundantWith && redundant.redundantWith.overlap > 0);
      // La familia 2 obtiene su oportunidad pese a que la familia 1 tenia mas variantes.
      const families = proposal.selectedQueries.flatMap((entry) => entry.families.map((f) => f.familyId));
      assert(families.includes('f1') && families.includes('f2'));
      assert(proposal.selectedQueries.some((entry) => entry.introducedNewFamily));
      // Sin cuotas artificiales: f3 no aporta cobertura nueva (su unica oferta
      // compatible es p1, ya cubierta) y NO recibe una query propia por existir.
      const chosen = proposal.selectedQueries.map((entry) => entry.normalized);
      assert(!chosen.includes('obra civil'), 'no hay cuota fija por familia');
      // f3 solo aparece porque p1 fue hallada tambien por su busqueda, no por cuota.
      assert(proposal.unselectedCandidates.some((c) => c.normalized === 'obra civil' && c.remainingIncrementalCoverage === 0));
    });
    test('31+32+33+34. portfolio targets are respected and selection is deterministic', () => {
      assert.deepEqual(PORTFOLIO, { targetMin: 8, targetMax: 12, hardMax: 15 });
      const proposal = build(realisticLedger());
      assert(proposal.selectedQueries.length <= PORTFOLIO.hardMax);
      assert(proposal.selectedQueries.length < PORTFOLIO.targetMin);
      assert(proposal.warnings.some((w) => /does not support the target of 8/.test(w)), 'menos de 8 es valido y se explica');
      // Con evidencia abundante se alcanza la banda objetivo y nunca se pasa del maximo.
      // 20 terminos promovidos, cada uno con 3 ofertas compatibles DISJUNTAS: aqui
      // ninguna query cubre lo de otra, asi que la banda objetivo se alcanza.
      const wide = L({
        postings: Array.from({ length: 60 }, (_, i) => P(`w${i}`, 'COMPATIBLE', `Co ${i}`, [`f${i % 6}`], [`d0_${(i % 6) + 1}`])),
        observations: Array.from({ length: 60 }, (_, i) => O(`Role ${i % 20}`, 'ROLE_TITLE', `w${i}`, `Co ${i}`, [`f${i % 6}`], [`d0_${(i % 6) + 1}`])),
      });
      const big = build(wide);
      assert(big.selectedQueries.length >= PORTFOLIO.targetMin && big.selectedQueries.length <= PORTFOLIO.targetMax);
      assert(big.selectedQueries.length <= PORTFOLIO.hardMax);
      // Determinismo: misma entrada, misma propuesta.
      assert.deepEqual(build(realisticLedger()), proposal);
      assert.equal(build(realisticLedger()).proposalId, proposal.proposalId);
    });

    // ------------------------------------------- 38-40. queries actuales
    test('38+39+40. current queries are compared factually and never mutated', () => {
      const current = { queryGroups: [{ family: 'user', queries: [{ query: 'Site Manager', enabled: true }, { query: 'Something never searched', enabled: true }, { query: 'Commercial Manager', enabled: false }] }] };
      const snapshot = structuredClone(current);
      const proposal = build(realisticLedger(), { currentQueries: current });
      assert.deepEqual(current, snapshot, 'la entrada no se muta');
      const byNormalized = Object.fromEntries(proposal.currentQueryComparison.map((entry) => [entry.normalized, entry]));
      assert.equal(byNormalized['site manager'].status, CURRENT_QUERY_STATUS.KEEP);
      assert.equal(byNormalized['site manager'].testState, QUERY_TEST_STATES.TESTED_POSITIVE);
      assert.equal(byNormalized['site manager'].alsoProposed, true);
      // Ausente de la muestra != mala.
      const absent = byNormalized['something never searched'];
      assert.equal(absent.status, CURRENT_QUERY_STATUS.NOT_SUPPORTED_BY_THIS_SAMPLE);
      assert(/says nothing about it/.test(absent.note));
      assert(!/bad|fail|poor|remove/i.test(absent.note));
      assert.equal(absent.test, null);
      // Una query actual realmente probada reporta su evidencia real.
      const tested = byNormalized['commercial manager'];
      assert.equal(tested.status, CURRENT_QUERY_STATUS.REVIEW);
      assert.equal(tested.test.sample, 6);
      assert.equal(tested.test.compatible, 1);
      assert.equal(tested.enabled, false);
      assert.equal(normalizeCurrentQueries(null), null);
      assert.equal(normalizeCurrentQueries(['a', 'A', ' a ']).length, 1, 'duplicados normalizados colapsan');
    });

    // ------------------------------------------- 41-44. identidad e inmutabilidad
    test('41+42+43+44. identity is deterministic and everything is immutable', () => {
      const ledger = realisticLedger();
      const snapshot = structuredClone(ledger);
      const profile = { exclusions: [{ text: 'Exclusively commercial sales positions' }] };
      const profileSnapshot = structuredClone(profile);
      const proposal = build(ledger, { profile });
      assert.deepEqual(ledger, snapshot, 'el ledger no se muta');
      assert.deepEqual(profile, profileSnapshot, 'el perfil no se muta');
      assert(/^[a-f0-9]{64}$/.test(proposal.proposalId));
      assert(/^[a-f0-9]{64}$/.test(proposal.sourceExploration.hash));
      assert.equal(proposal.policy.version, POLICY_VERSION);
      assert.equal(proposal.applied, false, 'MD6 nunca aplica nada');
      // Cambiar el ledger cambia la identidad de la propuesta.
      const changed = realisticLedger();
      changed.postings.push(P('extra', 'COMPATIBLE', 'Omega SA', ['f2'], ['d0_2']));
      assert.notEqual(build(changed, { profile }).proposalId, proposal.proposalId);
      // Inmutabilidad profunda.
      assert(Object.isFrozen(proposal) && Object.isFrozen(proposal.vocabulary) && Object.isFrozen(proposal.selectedQueries));
      assert.throws(() => proposal.selectedQueries.push({}));
      assert.throws(() => { proposal.applied = true; });
    });

    // ------------------------------------------- 45-51. aislamiento
    test('45-51. MD6 is a pure transformation with no reach into Hunter or the outside', () => {
      const files = ['src/marketDiscovery/queryPortfolio.js', 'src/marketDiscovery/vocabularyPolicy.js'];
      const source = files.map((file) => fs.readFileSync(path.join(runtime.PROJECT_ROOT, file), 'utf8')).join('\n');
      for (const token of [
        'jobAnalyzer', 'analyzeJob', 'runPipeline', 'huntRunManager', 'jobRepository', 'jobService',
        'learnedPreferences', 'runOutcome', 'notifications/ntfy', 'telegram', 'userConfig', 'searchSettings',
        'scheduleStore', 'acquireLock', 'releaseLock', 'huntLock', 'operationOwner', 'launchLinkedInBrowser',
        'chromium', 'fetch(', 'writeFileSync', 'mkdirSync', 'appendFileSync', 'saveUserConfig', 'applyTo',
      ]) {
        assert(!source.includes(token), `MD6 no debe referenciar ${token}`);
      }
      for (const loaded of Object.keys(require.cache)) {
        for (const forbidden of ['jobAnalyzer', 'huntRunManager', 'linkedinMarketSource', 'semanticEvaluator']) {
          assert(!loaded.includes(forbidden), `${forbidden} no debe cargarse`);
        }
      }
      // Ninguna escritura en disco durante una construccion completa.
      const dataDir = temp();
      const before = fs.readdirSync(dataDir);
      const proposal = build(realisticLedger());
      assert.deepEqual(fs.readdirSync(dataDir), before);
      const text = JSON.stringify(proposal);
      for (const token of ['decision', 'overallMatchScore', 'YES', 'MAYBE', 'queryGroups', 'user.json']) {
        assert(!text.includes(token), `la propuesta no debe incluir ${token}`);
      }
    });

    console.log('Market Portfolio (MD6): ' + passed + ' tests passed');
  } finally {
    for (const dir of roots.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
