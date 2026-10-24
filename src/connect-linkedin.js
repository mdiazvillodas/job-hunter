const { launchLinkedInBrowser, getInitialPage, waitForBrowserClose } = require('./linkedin/browser');
const { BROWSER_PROFILE_DIR } = require('./config');
const { acquireLock, releaseLock, DEFAULT_LOCK_PATH } = require('./domain/huntLock');

// Login only: no scraper, analyzer, cookie inspection, timeout or automated login.
async function connectLinkedIn({ launch = launchLinkedInBrowser, profileDir = BROWSER_PROFILE_DIR,
  lockPath = DEFAULT_LOCK_PATH, log = console.log } = {}) {
  acquireLock(lockPath);
  try {
    const context = await launch(profileDir, { headless: false });
    // Subscribe before navigation so even closing the window during navigation releases the lock.
    const closed = waitForBrowserClose(context);
    log('Iniciá sesión manualmente en esta ventana. Cerrala al terminar para habilitar las búsquedas. La sesión pertenece solamente a esta instancia.');
    try {
      const page = await getInitialPage(context);
      await page.goto('https://www.linkedin.com/login/', { waitUntil: 'domcontentloaded' });
    } catch (error) {
      log('No se pudo completar la navegación: ' + error.message + '. Podés continuar manualmente o cerrar la ventana.');
    }
    await closed;
  } finally {
    releaseLock(lockPath);
  }
}
if (require.main === module) {
  require('./env').loadProjectEnv();
  connectLinkedIn().catch(error => { console.error(error.code === 'LOCK_HELD'
    ? 'La instancia está ocupada. Cerrá la búsqueda o conexión existente y volvé a abrir Conectar LinkedIn.cmd.' : error.message); process.exitCode = 1; });
}
module.exports = { connectLinkedIn };
