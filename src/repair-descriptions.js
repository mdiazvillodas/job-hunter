'use strict';

const { createLocalRepository } = require('./data/jobRepository');
const { parseRepairArgs, repairDescriptions } = require('./repair/descriptionRepair');

async function main(args = process.argv.slice(2)) {
  const options = parseRepairArgs(args);
  const repository = createLocalRepository();
  let context;
  let page;
  let lock;
  const { acquireLock, releaseLock } = require('./domain/huntLock');
  try {
    if (!options.dryRun) lock = acquireLock();
    const summary = await repairDescriptions({ repository, options,
      fetchDetail: async job => {
        if (!context) {
          const { launchLinkedInBrowser } = require('./linkedin/browser');
          const { BROWSER_PROFILE_DIR } = require('./config');
          context = await launchLinkedInBrowser(BROWSER_PROFILE_DIR);
          page = await context.newPage();
        }
        const { collectJobDetail } = require('./linkedin/detailCollector');
        return collectJobDetail(page, job, { directUrl: true });
      },
      log: result => console.error(`[repair] ${result.jobId}: ${result.diagnostics.status}, length=${result.descriptionLength}`),
    });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.stoppedByChallenge) process.exitCode = 1;
    return summary;
  } finally {
    try { if (context) await context.close(); }
    finally { if (lock) releaseLock(lock.lockPath); }
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
