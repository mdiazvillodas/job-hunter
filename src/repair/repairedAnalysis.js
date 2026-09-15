'use strict';

const { isDescriptionUsable } = require('../domain/descriptionQuality');
const { markAnalysisStale } = require('../domain/jobRecord');
const { parseRepairArgs } = require('./descriptionRepair');

function parseReanalysisArgs(args) {
  if (args.includes('--analyzed-only')) throw new Error('reanalyze:repaired solo acepta --dry-run, --limit y --job-id.');
  return parseRepairArgs(args);
}

function isRepairedStale(job) {
  return !!job && job.analysisStatus === 'stale'
    && job.analysisStaleReason === 'description_repaired'
    && isDescriptionUsable(job.description);
}

function selectRepairedJobs(jobs, options) {
  const ids = new Set(options.jobIds || []);
  const eligible = jobs.filter(j => isRepairedStale(j) && (!ids.size || ids.has(j.jobId)))
    .sort((a, b) => a.jobId.localeCompare(b.jobId));
  return { eligibleCount: eligible.length, jobs: eligible.slice(0, options.limit ?? eligible.length) };
}

async function reanalyzeRepaired({ jobService, analyze, options }) {
  const selected = selectRepairedJobs(jobService.getAllJobs(), options);
  const summary = { dryRun: options.dryRun, eligibleCount: selected.eligibleCount, selected: selected.jobs.length, analyzed: 0, failed: 0, jobs: [] };
  for (const candidate of selected.jobs) {
    const item = { jobId: candidate.jobId, title: candidate.title, descriptionLength: candidate.description.trim().length, analysisStatus: candidate.analysisStatus };
    if (options.dryRun) { summary.jobs.push(item); continue; }
    // Revalidar el dato persistido inmediatamente antes del analyzer (P0).
    const job = jobService.getJob(candidate.jobId);
    if (!isRepairedStale(job)) { summary.jobs.push({ ...item, skipped: 'no_longer_eligible' }); continue; }
    jobService.applyAnalysisProcessing(job.jobId);
    try {
      const result = await analyze(job);
      jobService.applyAnalysisResult(job.jobId, result.analysis);
      summary.analyzed++;
      summary.jobs.push({ ...item, analysisStatus: 'completed' });
    } catch (error) {
      // Conserva aiAnalysis anterior y stale para un reintento posterior.
      jobService.applyAnalysisFailure(job.jobId, error.message || String(error));
      summary.failed++;
      summary.jobs.push({ ...item, error: error.message || String(error) });
    }
  }
  return summary;
}

// Migracion acotada al informe explicito. Prevalidar TODO antes de escribir.
function migrateRepairedSample(repository, report, options = {}) {
  const rows = report.jobs;
  if (!Array.isArray(rows) || !rows.length || report.recovered !== rows.length
      || new Set(rows.map(r => r.jobId)).size !== rows.length) throw new Error('Informe de muestra invalido.');
  const jobs = rows.map(row => {
    const job = repository.get(row.jobId);
    const repair = job?.descriptionRepair?.attempts?.find(a => a.recovered && a.previousLength < 300 && a.extractedLength >= 300);
    if (!job?.aiAnalysis || !isDescriptionUsable(job.description) || !repair
        || row.diagnostics?.status !== 'description_extracted') throw new Error(`Repair no verificable: ${row.jobId}`);
    if (job.analysisCompletedAt && job.analysisCompletedAt > repair.attemptedAt) throw new Error(`El job ya tiene un analisis posterior al repair: ${row.jobId}`);
    return job;
  });
  let migrated = 0;
  for (const job of jobs) {
    if (job.analysisStatus === 'stale' && job.analysisStaleReason === 'description_repaired') continue;
    markAnalysisStale(job, options);
    repository.save(job);
    migrated++;
  }
  return { selected: jobs.length, migrated, jobIds: jobs.map(j => j.jobId) };
}

module.exports = { parseReanalysisArgs, isRepairedStale, selectRepairedJobs, reanalyzeRepaired, migrateRepairedSample };
