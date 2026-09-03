const config = require('./config');
const { collectJobDetails } = require('./linkedin/detailCollector');
const { SecurityChallengeError } = require('./linkedin/errors');
const { collectMultipleSearches } = require('./linkedin/multiSearch');
const { assertAuthenticatedSession } = require('./linkedin/session');

function parseCliArgs(argv) {
  return {
    debug: argv.includes('--debug'),
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const BROWSER_PROFILE_DIR = config.BROWSER_PROFILE_DIR;
  const DETAIL_LIMIT = config.DETAIL_LIMIT;
  const LINKEDIN_FILTERS = config.LINKEDIN_FILTERS;
  const MAX_PAGES_PER_SEARCH = config.MAX_PAGES_PER_SEARCH;
  const MAX_RESULTS_PER_SEARCH = config.MAX_RESULTS_PER_SEARCH;
  const activeQueries = config.getActiveSearchQueries();
  const { getInitialPage, launchLinkedInBrowser, waitForBrowserClose } = require('./linkedin/browser');
  const context = await launchLinkedInBrowser(BROWSER_PROFILE_DIR);
  const page = await getInitialPage(context);

  try {
    await assertAuthenticatedSession(context, page);

    const result = await collectMultipleSearches(page, activeQueries, LINKEDIN_FILTERS, {
      ...options,
      maxResultsPerSearch: MAX_RESULTS_PER_SEARCH,
      maxPagesPerSearch: MAX_PAGES_PER_SEARCH,
    });

    const output = {
      ...result.metadata,
      perQuery: result.perQuery,
      jobs: result.jobs,
    };

    // Extraccion de detalle: pertenece a otro milestone y NO se ejecuta sobre todos
    // los resultados. Se mantiene disponible pero desactivada por defecto
    // (COLLECT_DETAILS=1 para activarla puntualmente sobre las primeras DETAIL_LIMIT).
    if (process.env.COLLECT_DETAILS === '1') {
      const detailResult = await collectJobDetails(page, result.jobs, {
        ...options,
        limit: DETAIL_LIMIT,
        searchResultsUrl: page.url(),
      });
      output.jobDetails = detailResult.details;
    }

    console.log(JSON.stringify(output, null, 2));

    console.error('Navegador abierto para inspeccion. Cerralo manualmente cuando termines.');
    await waitForBrowserClose(context);
  } catch (error) {
    if (error instanceof SecurityChallengeError) {
      console.error(error.message);
      console.error('Navegador abierto para que puedas inspeccionar el estado manualmente.');
      await waitForBrowserClose(context);
      return;
    }

    console.error(error.message || error);
    console.error('Navegador abierto para inspeccion. No se cerrara automaticamente.');
    process.exitCode = 1;
    await waitForBrowserClose(context);
  }
}

if (require.main === module) main();

module.exports = { main };
