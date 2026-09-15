'use strict';

const { createLocalRepository } = require('./data/jobRepository');
const { createJobService } = require('./services/jobService');
const { parseReanalysisArgs, reanalyzeRepaired } = require('./repair/repairedAnalysis');

async function main(args = process.argv.slice(2)) {
  const options = parseReanalysisArgs(args);
  const { acquireLock, releaseLock } = require('./domain/huntLock');
  let lock;
  try {
    if (!options.dryRun) lock = acquireLock();
    const summary = await reanalyzeRepaired({
      options, jobService: createJobService(createLocalRepository()),
      analyze: async job => {
        const { analyzeJob } = require('./ai/jobAnalyzer');
        const { getMarianoMatchingProfile } = require('./ai/marianoProfile');
        return analyzeJob(getMarianoMatchingProfile(), job);
      },
    });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failed) process.exitCode = 1;
    return summary;
  } finally { if (lock) releaseLock(lock.lockPath); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
