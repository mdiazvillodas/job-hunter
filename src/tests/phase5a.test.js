'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROJECT_ROOT,
  assertSafePackageTarget,
  validateNodeSource,
  validatePackage,
  buildWindowsPackage,
} = require('../../scripts/package-windows');

let passed = 0; let failed = 0;
function ok(name, value) { if (value) { passed++; console.log(`  [PASS] ${name}`); } else { failed++; console.log(`  [FAIL] ${name}`); } }
function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `jh-5a-${name}-`)); }
function errorCode(fn) { try { fn(); } catch (error) { return error.code; } return null; }
const node22 = () => ({ status: 0, stdout: 'v22.22.3\n' });

function fakeNodeSource(root, withNpm = true) {
  const source = path.join(root, 'Node Source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'node.exe'), 'test-node');
  if (withNpm) { const npmDir = path.join(source, 'node_modules', 'npm', 'bin'); fs.mkdirSync(npmDir, { recursive: true }); fs.writeFileSync(path.join(npmDir, 'npm-cli.js'), ''); }
  fs.writeFileSync(path.join(source, 'LICENSE'), 'Node fixture');
  return source;
}

function installFixtureDependencies(packageRoot) {
  for (const name of ['playwright', 'playwright-core']) {
    const dir = path.join(packageRoot, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.62.1', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
  }
}

function packageSkeleton(root) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime-managed', 'node'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime-managed', 'playwright-browsers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'start-job-hunter.cmd'), '');
  fs.writeFileSync(path.join(root, 'scripts', 'bootstrap.js'), '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0-dev', dependencies: { playwright: '1.62.1' } }));
  fs.writeFileSync(path.join(root, 'runtime-managed', 'node', 'node.exe'), 'fixture');
  installFixtureDependencies(root);
}

function run() {
  console.log('\n### Packaging safety and Node source');
  const safeRoot = temp('safe'); const dist = path.join(safeRoot, 'dist');
  ok('1. target hijo de dist aceptado', assertSafePackageTarget(path.join(dist, 'job-hunter'), { projectRoot: safeRoot, distRoot: dist }) === path.join(dist, 'job-hunter'));
  ok('2. dist root rechazado', errorCode(() => assertSafePackageTarget(dist, { projectRoot: safeRoot, distRoot: dist })) === 'UNSAFE_PACKAGE_TARGET');
  ok('3. traversal fuera de dist rechazado', errorCode(() => assertSafePackageTarget(path.join(dist, '..', 'outside'), { projectRoot: safeRoot, distRoot: dist })) === 'UNSAFE_PACKAGE_TARGET');
  ok('4. superposición con data rechazada', errorCode(() => assertSafePackageTarget(path.join(dist, 'pkg'), { projectRoot: safeRoot, distRoot: dist, dataDir: path.join(dist, 'pkg', 'runtime-data') })) === 'UNSAFE_PACKAGE_TARGET');
  ok('5. Node source missing controlado', errorCode(() => validateNodeSource(path.join(safeRoot, 'missing'))) === 'NODE_SOURCE_MISSING');
  const nodeSource = fakeNodeSource(safeRoot); ok('6. Node 22 aceptado', validateNodeSource(nodeSource, { run: node22 }).version === 'v22.22.3');
  ok('7. Node incompatible rechazado', errorCode(() => validateNodeSource(nodeSource, { run: () => ({ status: 0, stdout: 'v20.1.0' }) })) === 'NODE_SOURCE_INCOMPATIBLE');

  console.log('\n### Reproducible allowlist package');
  const outputRoot = path.join(PROJECT_ROOT, 'dist', '.phase5a-tests');
  if (fs.existsSync(outputRoot)) fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  const sourceDataMarker = path.join(PROJECT_ROOT, 'runtime-data', 'phase5a-source-marker-must-not-exist');
  if (fs.existsSync(sourceDataMarker)) throw new Error('fixture marker inesperado');
  let result;
  try {
    result = buildWindowsPackage({
      projectRoot: PROJECT_ROOT,
      distRoot: outputRoot,
      packageName: 'Job Hunter Test',
      nodeSource,
      nodeVersionRunner: node22,
      installDependencies: installFixtureDependencies,
      resolveModule: () => path.join('node_modules', 'playwright', 'index.js'),
      dataDir: path.join(PROJECT_ROOT, 'runtime-data'),
      runtimeDir: path.join(PROJECT_ROOT, 'runtime-managed'),
    });
    ok('8. package funciona en path con espacios', result.target.endsWith('Job Hunter Test') && fs.existsSync(path.join(result.target, 'runtime-managed', 'node', 'node.exe')));
    ok('9. allowlist copia launcher/bootstrap/src', fs.existsSync(path.join(result.target, 'start-job-hunter.cmd')) && fs.existsSync(path.join(result.target, 'scripts', 'bootstrap.js')) && fs.existsSync(path.join(result.target, 'src', 'ui', 'server.js')));
    ok('10. tests excluidos', !fs.existsSync(path.join(result.target, 'src', 'tests')));
    ok('11. n8n excluido', !fs.existsSync(path.join(result.target, 'n8n')));
    ok('12. runtime-data y env real excluidos', !fs.existsSync(path.join(result.target, 'runtime-data')) && !fs.existsSync(path.join(result.target, '.env')));
    ok('13. node_modules productivo incluido', fs.existsSync(path.join(result.target, 'node_modules', 'playwright', 'package.json')) && fs.existsSync(path.join(result.target, 'node_modules', 'playwright-core', 'package.json')));
    ok('14. browsers administrados inicialmente vacíos', fs.readdirSync(path.join(result.target, 'runtime-managed', 'playwright-browsers')).length === 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.target, 'package-manifest.json'), 'utf8')); ok('15. manifest seguro y reproducible', manifest.nodeVersion === 'v22.22.3' && !JSON.stringify(manifest).includes(PROJECT_ROOT) && !('createdAt' in manifest));
    ok('16. source data no mutado', !fs.existsSync(sourceDataMarker));
  } finally {
    if (fs.existsSync(outputRoot)) fs.rmSync(outputRoot, { recursive: true, force: true });
  }

  console.log('\n### Package validation');
  const skeleton = temp('validation'); packageSkeleton(skeleton);
  const valid = validatePackage(skeleton, { run: node22, resolveModule: () => 'playwright' }); ok('17. package válido reconocido', valid.nodeVersion === 'v22.22.3' && valid.dependencies === 1);
  fs.unlinkSync(path.join(skeleton, 'runtime-managed', 'node', 'node.exe')); ok('18. missing node detectado', errorCode(() => validatePackage(skeleton, { run: node22, resolveModule: () => 'playwright' })) === 'PACKAGE_INVALID'); fs.writeFileSync(path.join(skeleton, 'runtime-managed', 'node', 'node.exe'), 'fixture');
  ok('19. missing Playwright detectado', errorCode(() => validatePackage(skeleton, { run: node22, resolveModule: () => { throw new Error(); } })) === 'PACKAGE_PLAYWRIGHT_MISSING');
  fs.writeFileSync(path.join(skeleton, '.env'), 'SECRET=not-read'); ok('20. .env prohibido detectado sin contenido', errorCode(() => validatePackage(skeleton, { run: node22, resolveModule: () => 'playwright' })) === 'PACKAGE_CONTAINS_FORBIDDEN_FILE'); fs.unlinkSync(path.join(skeleton, '.env'));
  fs.mkdirSync(path.join(skeleton, 'runtime-data')); ok('21. runtime-data prohibido detectado', errorCode(() => validatePackage(skeleton, { run: node22, resolveModule: () => 'playwright' })) === 'PACKAGE_CONTAINS_FORBIDDEN_FILE');

  const packageSource = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'package-windows.js'), 'utf8'); ok('22. install productivo usa npm portable y omite browsers', packageSource.includes("'ci', '--omit=dev'") && packageSource.includes("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'") && packageSource.includes("'npm-cli.js'") && packageSource.includes("path.join(nodeSource, 'node.exe')"));
  ok('23. empaquetador no descarga Node ni usa node_modules source', !/https?:\/\//.test(packageSource) && !packageSource.includes("path.join(projectRoot, 'node_modules')"));
  const lock = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package-lock.json'), 'utf8')); ok('24. lockfile clasifica Playwright como producción', lock.packages['node_modules/playwright'].dev !== true && lock.packages['node_modules/playwright-core'].dev !== true);
  console.log(`\nPhase 5A: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
}

try { run(); } catch (error) { console.error(error); process.exitCode = 1; }
