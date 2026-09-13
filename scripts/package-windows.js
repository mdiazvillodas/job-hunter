'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_ROOT = path.join(PROJECT_ROOT, 'dist');
const ROOT_FILES = ['package.json', 'package-lock.json', '.env.example', 'start-job-hunter.cmd'];

function packagingError(code, message, relativePath) {
  const error = new Error(message);
  error.code = code;
  if (relativePath) error.relativePath = relativePath;
  return error;
}

function assertSafePackageTarget(target, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const distRoot = path.resolve(options.distRoot || path.join(projectRoot, 'dist'));
  const resolved = path.resolve(target);
  const relative = path.relative(distRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || resolved === projectRoot) {
    throw packagingError('UNSAFE_PACKAGE_TARGET', 'El destino del package debe estar dentro de dist.');
  }
  for (const forbidden of [options.dataDir, options.runtimeDir].filter(Boolean).map((entry) => path.resolve(entry))) {
    if (resolved === forbidden || forbidden.startsWith(resolved + path.sep) || resolved.startsWith(forbidden + path.sep)) throw packagingError('UNSAFE_PACKAGE_TARGET', 'El destino se superpone con datos o runtime reales.');
  }
  return resolved;
}

function parseNodeMajor(version) {
  const match = String(version || '').trim().match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

function validateNodeSource(nodeSource, options = {}) {
  const fileSystem = options.fs || fs;
  const source = path.resolve(String(nodeSource || ''));
  const executable = path.join(source, 'node.exe');
  if (!nodeSource || !fileSystem.existsSync(executable)) throw packagingError('NODE_SOURCE_MISSING', 'La fuente de Node portable no contiene node.exe.');
  const run = options.run || ((command, args) => spawnSync(command, args, { encoding: 'utf8', windowsHide: true }));
  const result = run(executable, ['--version']);
  const version = result && result.status === 0 ? String(result.stdout || '').trim() : '';
  if (parseNodeMajor(version) !== 22) throw packagingError('NODE_SOURCE_INCOMPATIBLE', 'La fuente portable debe usar Node 22.');
  return { source, executable, version };
}

function copyProductFiles(sourceRoot, targetRoot, options = {}) {
  const fileSystem = options.fs || fs;
  for (const name of ROOT_FILES) {
    const source = path.join(sourceRoot, name);
    if (fileSystem.existsSync(source)) fileSystem.cpSync(source, path.join(targetRoot, name), { recursive: true });
  }
  fileSystem.copyFileSync(path.join(sourceRoot, 'README-DISTRIBUTION.md'), path.join(targetRoot, 'README.md'));
  fileSystem.mkdirSync(path.join(targetRoot, 'scripts'), { recursive: true });
  fileSystem.copyFileSync(path.join(sourceRoot, 'scripts', 'bootstrap.js'), path.join(targetRoot, 'scripts', 'bootstrap.js'));
  fileSystem.cpSync(path.join(sourceRoot, 'src'), path.join(targetRoot, 'src'), {
    recursive: true,
    filter: (source) => path.relative(path.join(sourceRoot, 'src'), source).split(path.sep)[0] !== 'tests',
  });
}

function findForbiddenFile(packageRoot, options = {}) {
  const fileSystem = options.fs || fs;
  const forbiddenRoots = new Set(['runtime-data', 'n8n', '.git', 'coverage']);
  const stack = [packageRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fileSystem.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(packageRoot, absolute).replace(/\\/g, '/');
      const first = relative.split('/')[0];
      if (entry.name === '.env' || forbiddenRoots.has(first) || relative === 'src/tests' || relative.startsWith('src/tests/') || relative.split('/').includes('browser-profile')) return relative;
      if (entry.isDirectory()) stack.push(absolute);
    }
  }
  return null;
}

function validatePackage(packageRoot, options = {}) {
  const fileSystem = options.fs || fs;
  const required = ['start-job-hunter.cmd', 'scripts/bootstrap.js', 'package.json', 'runtime-managed/node/node.exe', 'runtime-managed/playwright-browsers'];
  for (const relative of required) if (!fileSystem.existsSync(path.join(packageRoot, relative))) throw packagingError('PACKAGE_INVALID', `Falta ${relative}.`, relative);
  const forbidden = findForbiddenFile(packageRoot, { fs: fileSystem });
  if (forbidden) throw packagingError('PACKAGE_CONTAINS_FORBIDDEN_FILE', `El package contiene un archivo no permitido: ${forbidden}`, forbidden);
  const node = validateNodeSource(path.join(packageRoot, 'runtime-managed', 'node'), { fs: fileSystem, run: options.run });
  const resolveModule = options.resolveModule || ((name) => require.resolve(name, { paths: [packageRoot] }));
  try { resolveModule('playwright'); } catch (_) { throw packagingError('PACKAGE_PLAYWRIGHT_MISSING', 'Playwright no es resoluble desde el package.'); }
  if (fileSystem.readdirSync(path.join(packageRoot, 'runtime-managed', 'playwright-browsers')).length) throw packagingError('PACKAGE_BROWSER_DIR_NOT_EMPTY', 'El directorio administrado de browsers debe estar vacío.');
  return { app: 'job-hunter', version: require(path.join(packageRoot, 'package.json')).version, nodeVersion: node.version, dependencies: Object.keys(require(path.join(packageRoot, 'package.json')).dependencies || {}).length };
}

function defaultDependencyInstaller(packageRoot, nodeSource, options = {}) {
  const node = path.join(nodeSource, 'node.exe');
  const npmCli = path.join(nodeSource, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw packagingError('NPM_SOURCE_MISSING', 'La fuente portable no contiene npm-cli.js.');
  const run = options.run || spawnSync;
  const result = run(node, [npmCli, 'ci', '--omit=dev'], {
    cwd: packageRoot,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PLAYWRIGHT_BROWSERS_PATH: path.join(packageRoot, 'runtime-managed', 'playwright-browsers') },
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (!result || result.status !== 0) throw packagingError('DEPENDENCY_INSTALL_FAILED', 'No se pudieron preparar las dependencias de producción.');
}

function buildWindowsPackage(options = {}) {
  const fileSystem = options.fs || fs;
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const manifest = JSON.parse(fileSystem.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const packageName = options.packageName || `job-hunter-v${manifest.version}`;
  const distRoot = path.resolve(options.distRoot || path.join(projectRoot, 'dist'));
  const target = assertSafePackageTarget(path.join(distRoot, packageName), { projectRoot, distRoot, dataDir: options.dataDir, runtimeDir: options.runtimeDir });
  const staging = assertSafePackageTarget(path.join(distRoot, `.${packageName}.staging-${process.pid}`), { projectRoot, distRoot, dataDir: options.dataDir, runtimeDir: options.runtimeDir });
  const node = validateNodeSource(options.nodeSource || process.env.JOB_HUNTER_NODE_SOURCE, { fs: fileSystem, run: options.nodeVersionRunner });
  fileSystem.mkdirSync(distRoot, { recursive: true });
  for (const disposable of [staging, target]) if (fileSystem.existsSync(disposable)) fileSystem.rmSync(disposable, { recursive: true, force: true });
  try {
    fileSystem.mkdirSync(staging, { recursive: true });
    copyProductFiles(projectRoot, staging, { fs: fileSystem });
    fileSystem.mkdirSync(path.join(staging, 'runtime-managed'), { recursive: true });
    fileSystem.cpSync(node.source, path.join(staging, 'runtime-managed', 'node'), { recursive: true });
    fileSystem.mkdirSync(path.join(staging, 'runtime-managed', 'playwright-browsers'), { recursive: true });
    const installDependencies = options.installDependencies || ((root) => defaultDependencyInstaller(root, node.source));
    installDependencies(staging);
    fileSystem.writeFileSync(path.join(staging, 'package-manifest.json'), JSON.stringify({ app: 'job-hunter', version: manifest.version, nodeVersion: node.version, platform: 'win32', arch: 'x64' }, null, 2) + '\n');
    const summary = validatePackage(staging, { fs: fileSystem, run: options.nodeVersionRunner, resolveModule: options.resolveModule && ((name) => options.resolveModule(name, staging)) });
    fileSystem.renameSync(staging, target);
    return { target, ...summary };
  } catch (error) {
    if (fileSystem.existsSync(staging)) fileSystem.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const index = argv.indexOf('--node-source');
  return { nodeSource: index >= 0 ? argv[index + 1] : undefined };
}

function main() {
  try {
    const result = buildWindowsPackage(parseArgs(process.argv.slice(2)));
    console.log(`Package listo: ${path.relative(PROJECT_ROOT, result.target)} · Node ${result.nodeVersion} · ${result.dependencies} dependencias productivas`);
  } catch (error) {
    console.error(`[package-windows] ${error.code || 'PACKAGE_FAILED'}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { PROJECT_ROOT, DIST_ROOT, ROOT_FILES, assertSafePackageTarget, parseNodeMajor, validateNodeSource, copyProductFiles, findForbiddenFile, validatePackage, defaultDependencyInstaller, buildWindowsPackage, parseArgs, packagingError };
