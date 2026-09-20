'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fixture = require('./fixtures/marketDiscovery');
const { deriveProfile } = require('../marketDiscovery/profileMap');
const { generateSeeds, generateSeedPlan } = require('../marketDiscovery/seedGenerator');
const { createRepository } = require('../marketDiscovery/repository');
const { validateProfile } = require('../marketDiscovery/domain');
const { copyProductFiles, findForbiddenFile } = require('../../scripts/package-windows');
const roots = [];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-checkpoint1-')); roots.push(dir); return dir; }
const originalFetch = global.fetch;
global.fetch = () => { throw new Error('External activity forbidden in MD1/MD2'); };
try {
  const input = fixture(), untouched = structuredClone(input), profile = deriveProfile(input), seeds = generateSeeds(profile);
  test('only evidenced capabilities, never legacy taxonomy', () => {
    assert.equal(profile.demonstratedCapabilities.length, 1);
    assert.equal(profile.demonstratedCapabilities[0].text, 'Coordinate technical teams');
    assert(!JSON.stringify(profile).includes('arbitraryTaxonomyBucket'));
  });
  test('explicit exclusions retain their category and sources', () => {
    assert.equal(profile.exclusions.length, 1); assert.equal(profile.exclusions[0].category, 'explicit-exclusion');
    assert(profile.exclusions[0].sources.length);
  });
  test('missing experience and weak CAN SELL do not become exclusions', () => {
    assert(!JSON.stringify(profile.exclusions).includes('offshore'));
    assert(!JSON.stringify(profile).includes('Presentation evidence'));
    assert(!JSON.stringify(profile).includes('silently promote'));
  });
  test('no identity/contact/notification/telegram values in projection', () => {
    const text = JSON.stringify(profile);
    for (const value of ['Example Person', 'person@example.invalid', 'https://example.invalid', 'PRIVATE_NOTIFICATION_VALUE', 'PRIVATE_TELEGRAM_VALUE']) assert(!text.includes(value));
  });
  test('inputs unchanged and snapshots deeply immutable', () => {
    assert.deepEqual(input, untouched); assert(Object.isFrozen(profile.demonstratedCapabilities[0].evidence));
    assert.throws(() => profile.market.locations.push('elsewhere'));
  });
  test('near-synonym titles collapse; materially distinct responsibilities survive', () => {
    assert.equal(seeds.length, 4);
    // Three level/word-order variants of one concept share a single family and one slot.
    const variants = seeds.find(s => s.expression === 'Retail Architect');
    assert.equal(variants.support, 3);
    // "Project Architect Retail" is a materially different concept, not a level variant of it.
    assert.equal(seeds.filter(s => /architect/i.test(s.expression)).length, 2);
    assert(seeds.some(s => s.expression === 'Project Architect Retail'));
    assert.equal(new Set(seeds.map(s => s.familyId)).size, 4);
    assert(seeds.some(s => s.expression === 'Water quality monitoring'));
    assert(seeds.some(s => s.expression === 'Environmental permit coordination'));
  });
  test('six is a maximum, never a quota', () => {
    const empty = deriveProfile({}); assert.equal(generateSeeds(empty).length, 0);
    const many = fixture(); many.profile.targetResponsibilities = Array.from({ length: 12 }, (_, i) => ({ statement: 'Distinct responsibility ' + i, evidence: ['Explicit target ' + i] }));
    assert.equal(generateSeeds(deriveProfile(many)).length, 6);
  });
  test('language explicit or undetermined, never inferred from location', () => {
    assert.equal(seeds.find(s => s.expression === 'Water quality monitoring').language, 'en');
    assert.equal(seeds.find(s => /architect/i.test(s.expression)).language, 'und');
  });
  test('active queries are not copied as seeds', () => assert(!JSON.stringify(seeds).includes('Unrelated query')));
  test('deterministic profile and seed generation', () => {
    assert.deepEqual(deriveProfile(fixture()), profile); assert.deepEqual(generateSeeds(deriveProfile(fixture())), seeds);
  });
  test('family identity stable across input ordering and seniority modifiers', () => {
    const reordered = fixture(); reordered.matchingProfile.targetRoles.primary[0].roles.reverse();
    assert.deepEqual(generateSeeds(deriveProfile(reordered)).map(s => s.familyId), seeds.map(s => s.familyId));
    const only = fixture(); only.matchingProfile.targetRoles.primary[0].roles = ['Senior Architect Retail'];
    assert.equal(generateSeeds(deriveProfile(only)).find(s => /architect/i.test(s.expression)).familyId, seeds.find(s => /architect/i.test(s.expression)).familyId);
    assert.equal(new Set(seeds.map(s => s.familyId)).size, seeds.length);
  });
  test('every seed has a reason, provenance and hypothesis status', () => {
    for (const s of seeds) { assert(s.reason && s.sources.length && s.evidence.length); assert.equal(s.status, 'HYPOTHESIS'); }
    for (const s of seeds) { assert(Number.isInteger(s.support) && s.support >= 1); }
    assert.deepEqual(seeds.map(s => s.rank), seeds.map((_, i) => i + 1));
  });
  const targetsOf = list => generateSeeds(deriveProfile({ profile: {
    targetResponsibilities: list.map(statement => ({ statement, evidence: ['Explicit target evidence'] })) } }));
  test('ISSUE 1: role-defining words are not stripped as level modifiers', () => {
    assert.deepEqual(targetsOf(['Project Manager', 'Manager']).map(s => s.expression), ['Project Manager', 'Manager']);
    assert.deepEqual(targetsOf(['Technical Lead', 'Lead']).map(s => s.expression), ['Technical Lead', 'Lead']);
    assert.deepEqual(targetsOf(['Head of Design', 'Design']).map(s => s.expression), ['Head of Design', 'Design']);
    // Genuine level modifiers still collapse, in any word order, into one slot.
    assert.deepEqual(targetsOf(['Senior Retail Architect', 'Retail Architect', 'Senior Architect Retail']).map(s => s.expression), ['Retail Architect']);
  });
  test('ISSUE 2: explicit targets never vanish when normalization strips every token', () => {
    assert.deepEqual(targetsOf(['Technical Lead', 'Project Lead', 'Water quality monitoring']).map(s => s.expression),
      ['Technical Lead', 'Project Lead', 'Water quality monitoring']);
    // A title built only from level words keeps a conservative family of its own.
    const levelOnly = targetsOf(['Senior Principal', 'Water quality monitoring']);
    assert.deepEqual(levelOnly.map(s => s.expression), ['Senior Principal', 'Water quality monitoring']);
    assert.equal(new Set(levelOnly.map(s => s.familyId)).size, 2);
    // That conservative family is still order-insensitive, not one family per spelling.
    assert.equal(targetsOf(['Senior Principal', 'Principal Senior']).length, 1);
  });
  test('ISSUE 3: a bridging expression never merges two distinct concepts', () => {
    const bridged = targetsOf(['Architect', 'Retail Architect Manager', 'Manager']);
    assert.deepEqual(bridged.map(s => s.expression), ['Architect', 'Retail Architect Manager', 'Manager']);
    assert.equal(new Set(bridged.map(s => s.familyId)).size, 3);
    // Both endpoints keep exactly the identity they have when the bridge is absent.
    for (const seed of targetsOf(['Architect', 'Manager'])) {
      assert(bridged.some(b => b.familyId === seed.familyId && b.expression === seed.expression));
    }
  });
  test('ISSUE 4: the six-family cap follows documented priority, not family-id order', () => {
    const names = ['Alpha concept', 'Bravo concept', 'Charlie concept', 'Delta concept', 'Echo concept', 'Foxtrot concept', 'Golf concept', 'Hotel concept'];
    const plan = generateSeedPlan(deriveProfile({ profile: { targetResponsibilities:
      names.map((statement, i) => ({ statement, evidence: i === 1 ? ['first', 'second'] : ['first'] })) } }));
    // Stronger evidence first, then profile order; never the family hash.
    assert.deepEqual(plan.seeds.map(s => s.expression),
      ['Bravo concept', 'Alpha concept', 'Charlie concept', 'Delta concept', 'Echo concept', 'Foxtrot concept']);
    assert.deepEqual(plan.seeds.map(s => s.rank), [1, 2, 3, 4, 5, 6]);
    assert.equal(plan.familiesConsidered, 8); assert.equal(plan.familiesSelected, 6); assert.equal(plan.truncated, true);
    assert.deepEqual(plan.omittedFamilies.map(f => f.expression), ['Golf concept', 'Hotel concept']);
    assert.deepEqual(plan.omittedFamilies.map(f => f.rank), [7, 8]);
    for (const omitted of plan.omittedFamilies) assert(/^family-[a-f0-9]{16}$/.test(omitted.familyId) && omitted.reason);
    // Family-id ordering would have selected a different six, including the last-ranked family.
    const every = [...plan.seeds.map(s => ({ familyId: s.familyId, expression: s.expression })), ...plan.omittedFamilies];
    const byFamilyId = every.slice().sort((a, b) => a.familyId.localeCompare(b.familyId)).slice(0, 6).map(f => f.expression);
    assert.notDeepEqual(byFamilyId, plan.seeds.map(s => s.expression));
    assert(byFamilyId.includes('Hotel concept'));
    // Explicit targets outrank demonstrated capabilities as the source of hypotheses.
    for (const s of seeds) assert.equal(s.evidenceCategory, 'explicit-target');
    const untruncated = generateSeedPlan(profile);
    assert.equal(untruncated.truncated, false); assert.deepEqual(untruncated.omittedFamilies, []);
    assert.equal(untruncated.familiesConsidered, untruncated.familiesSelected);
  });
  test('ISSUE 5: every meaningful component of a known full name is redacted', () => {
    const derived = deriveProfile({ profile: { targetResponsibilities: [{ statement: 'Work led by Given on maritime permits',
      evidence: ['Given Middle Family signed off', 'Reviewed with Family'] }] }, config: { identity: { name: 'Given Middle Family' } } });
    const fact = derived.targetResponsibilities[0];
    assert.equal(fact.text, 'Work led by [person] on maritime permits');
    assert.deepEqual(fact.evidence, ['[person] signed off', 'Reviewed with [person]']);
    const text = JSON.stringify(derived);
    for (const part of ['Given', 'Middle', 'Family']) assert(!text.includes(part));
    // Vocabulary that merely shares a prefix with a name component survives intact.
    assert(fact.text.includes('maritime'));
  });
  test('ISSUE 6: short names use word boundaries and never corrupt vocabulary', () => {
    const derived = deriveProfile({ profile: { targetResponsibilities: [{ statement: 'Alignment and Alarm handling',
      evidence: ['Algorithm work', 'Al reviewed it'] }] }, config: { identity: { name: 'Al' } } });
    const fact = derived.targetResponsibilities[0];
    assert.equal(fact.text, 'Alignment and Alarm handling');
    assert.deepEqual(fact.evidence, ['Algorithm work', '[person] reviewed it']);
    // Particles and sub-minimum fragments of a longer name are not redacted on their own.
    const particles = deriveProfile({ profile: { targetResponsibilities: [{ statement: 'Van fleet and de-icing scheduling', evidence: ['e'] }] },
      config: { identity: { name: 'Sample van de Example' } } });
    assert.equal(particles.targetResponsibilities[0].text, 'Van fleet and de-icing scheduling');
  });
  test('MINOR: projected arrays are independent immutable values', () => {
    const derived = deriveProfile({ matchingProfile: { targetRoles: { primary: [{ roleFamily: 'Built environment',
      roles: ['Retail Architect'], evidence: ['Explicitly supplied target roles'] }] } } });
    assert.equal(derived.targetResponsibilities.length, 1); assert.equal(derived.desiredDirection.length, 1);
    assert.notEqual(derived.targetResponsibilities[0], derived.desiredDirection[0]);
    assert.notEqual(derived.targetResponsibilities[0].evidence, derived.desiredDirection[0].evidence);
    assert.notEqual(derived.targetResponsibilities[0].sources, derived.desiredDirection[0].sources);
    assert.deepEqual(derived.targetResponsibilities[0], derived.desiredDirection[0]);
    assert(Object.isFrozen(derived.targetResponsibilities[0]) && Object.isFrozen(derived.desiredDirection[0]));
  });
  test('unknowns preserved and desired domains are not demonstrated facts', () => {
    assert(profile.unknowns.includes('No evidence recorded for offshore work'));
    assert.equal(profile.domains[0].category, 'demonstrated-domain');
  });
  const data = temp(), repo = createRepository({ dataDir: data });
  test('repository import/read has no write side effect', () => { assert.equal(repo.get('missing'), null); assert.deepEqual(fs.readdirSync(data), []); });
  test('persistence lives exclusively under market-discovery', () => {
    repo.save('fixture-run', profile, seeds);
    assert.deepEqual(fs.readdirSync(data), ['market-discovery']);
    assert.deepEqual(fs.readdirSync(path.join(data, 'market-discovery')), ['fixture-run.json']);
    assert.deepEqual(repo.get('fixture-run').profile, profile);
    for (const dir of ['jobs', 'runs', 'feedback', 'profile', 'config']) assert(!fs.existsSync(path.join(data, dir)));
  });
  test('snapshot publication is create-only', () => {
    const file = path.join(data, 'market-discovery/fixture-run.json'), before = fs.readFileSync(file);
    assert.throws(() => repo.save('fixture-run', profile, seeds), { code: 'EEXIST' });
    assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
  });
  test('reject traversal and invalid schema before writing', () => {
    assert.throws(() => repo.save('../jobs/escape', profile, seeds));
    assert.throws(() => repo.save('bad', { ...profile, schemaVersion: 2 }, seeds));
    assert.throws(() => validateProfile({ ...profile, demonstratedCapabilities: [{ ...profile.demonstratedCapabilities[0], evidence: [] }] }));
    assert.throws(() => repo.save('identity', { ...profile, identity: { name: 'Should not persist' } }, seeds));
    assert.throws(() => repo.save('foreign', profile, [{ ...seeds[0], sources: ['outside/profile'] }]));
  });
  test('fallback targets, provenance merging and explicit role language', () => {
    const f = fixture(); f.careerContext.targetRoles = f.matchingProfile.targetRoles;
    f.matchingProfile.targetRoles = { primary: [] }; f.careerContext.targetRoles.primary[0].language = 'es';
    const p = deriveProfile(f);
    assert(p.targetResponsibilities[0].sources[0].startsWith('careerContext/'));
    assert.equal(generateSeeds(p).find(s => /architect/i.test(s.expression)).language, 'es');
    assert.equal(profile.exclusions[0].sources.length, 2);
  });
  test('capability-only input remains supported without inventing targets', () => {
    const p = deriveProfile({ profile: { capabilities: fixture().profile.capabilities } });
    assert.equal(p.targetResponsibilities.length, 0);
    assert.equal(generateSeeds(p).length, 1);
    assert.equal(generateSeeds(p)[0].evidenceCategory, 'demonstrated');
  });
  test('reject corrupt snapshots', () => {
    const file = path.join(data, 'market-discovery/fixture-run.json'); const obj = JSON.parse(fs.readFileSync(file));
    obj.profile.market.locations.push('tampered'); fs.writeFileSync(file, JSON.stringify(obj));
    assert.throws(() => repo.get('fixture-run'));
  });
  test('reject linked persistence roots', () => {
    const other = temp(), linkedData = temp(); fs.symlinkSync(other, path.join(linkedData, 'market-discovery'), 'junction');
    assert.throws(() => createRepository({ dataDir: linkedData }).save('unsafe', profile, seeds));
    assert.deepEqual(fs.readdirSync(other), []);
  });
  test('packaging still excludes exploration data and fixture tests', () => {
    const source = temp(), target = temp(); fs.mkdirSync(path.join(source, 'scripts')); fs.mkdirSync(path.join(source, 'src/tests'), { recursive: true });
    fs.mkdirSync(path.join(source, 'runtime-data/market-discovery'), { recursive: true });
    fs.writeFileSync(path.join(source, 'runtime-data/market-discovery/private.json'), 'private');
    fs.writeFileSync(path.join(source, 'src/tests/private-fixture.js'), 'fixture');
    fs.writeFileSync(path.join(source, 'src/module.js'), 'module'); fs.writeFileSync(path.join(source, 'scripts/bootstrap.js'), 'bootstrap');
    fs.writeFileSync(path.join(source, 'README-DISTRIBUTION.md'), 'readme');
    copyProductFiles(source, target); assert.equal(findForbiddenFile(target), null);
    assert(!fs.existsSync(path.join(target, 'runtime-data'))); assert(!fs.existsSync(path.join(target, 'src/tests')));
  });
  console.log('Market Discovery: ' + passed + ' tests passed');
} finally {
  global.fetch = originalFetch;
  for (const dir of roots.reverse()) fs.rmSync(dir, { recursive: true, force: true });
}
