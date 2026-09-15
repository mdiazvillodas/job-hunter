'use strict';

const { isDescriptionUsable } = require('../domain/descriptionQuality');
const { markAnalysisStale } = require('../domain/jobRecord');

function parseRepairArgs(args) {
  const options = { dryRun: false, limit: null, jobIds: [], analyzedOnly: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--analyzed-only') options.analyzedOnly = true;
    else if (arg === '--limit') {
      const raw = args[++i];
      if (!/^[1-9]\d*$/.test(raw || '') || !Number.isSafeInteger(Number(raw))) throw new Error('--limit requiere un entero positivo.');
      options.limit = Number(raw);
    } else if (arg === '--job-id') {
      const id = args[++i];
      if (!/^\d+$/.test(id || '')) throw new Error('--job-id requiere un ID numerico.');
      options.jobIds.push(id);
    } else throw new Error(`Opcion desconocida: ${arg}`);
  }
  // Sin seleccion explicita, solo inventario: nunca reparar todo por accidente.
  if (options.limit === null && !options.jobIds.length) options.dryRun = true;
  return options;
}

function selectRepairJobs(jobs, options) {
  const ids = new Set(options.jobIds || []);
  const eligible = jobs.filter(job => !isDescriptionUsable(job.description)
    && (!options.analyzedOnly || !!job.aiAnalysis)
    && (!ids.size || ids.has(job.jobId)))
    .sort((a, b) => a.jobId.localeCompare(b.jobId));
  return { eligibleCount: eligible.length, jobs: eligible.slice(0, options.limit ?? eligible.length) };
}

function validDirectJobUrl(job) {
  try {
    const url = new URL(job.url);
    return url.protocol === 'https:' && !url.username && !url.password
      && /(^|\.)linkedin\.com$/i.test(url.hostname)
      && url.pathname.match(/^\/jobs\/view\/(\d+)\/?$/)?.[1] === job.jobId;
  } catch { return false; }
}

async function repairDescriptions({ repository, fetchDetail, options, log = () => {} }) {
  const selected = selectRepairJobs(repository.getAll(), options);
  const summary = {
    dryRun: options.dryRun, eligibleCount: selected.eligibleCount, selected: selected.jobs.length,
    attempted: 0, recovered: 0, withoutUsableDescription: 0, stoppedByChallenge: false,
    jobs: [],
  };
  for (const candidate of selected.jobs) {
    const base = { jobId: candidate.jobId, url: candidate.url, previousLength: (candidate.description || '').length, hasAnalysis: !!candidate.aiAnalysis };
    if (options.dryRun) { summary.jobs.push({ ...base, validUrl: validDirectJobUrl(candidate) }); continue; }
    let diagnostics;
    let description;
    let stop = false;
    if (!validDirectJobUrl(candidate)) {
      diagnostics = { status: 'invalid_job_url', jobId: candidate.jobId, url: candidate.url };
    } else {
      summary.attempted++;
      try {
        // El caller usa collectJobDetail con directUrl:true. Sin discovery/analyzer.
        const result = await fetchDetail(candidate);
        description = result.detail.description;
        diagnostics = result.detail.detailExtraction || {
          status: isDescriptionUsable(description) ? 'description_extracted' : description ? 'description_too_short' : 'description_not_found',
        };
      } catch (error) {
        stop = ['AuthenticationError', 'SecurityChallengeError'].includes(error.name);
        diagnostics = error.detailDiagnostics || { status: stop ? 'auth_or_challenge' : 'detail_fetch_error', error: error.message };
      }
    }
    // Releer antes de guardar; conservar aiAnalysis y marcar su obsolescencia.
    const job = repository.get(candidate.jobId);
    const recovered = isDescriptionUsable(description);
    if (recovered) {
      if (!isDescriptionUsable(job.description)) markAnalysisStale(job);
      job.description = description;
      job.descriptionLength = description.length;
      job.detailExtraction = diagnostics;
      summary.recovered++;
    } else summary.withoutUsableDescription++;
    const attempt = {
      attemptedAt: new Date().toISOString(), url: candidate.url, recovered,
      previousLength: base.previousLength, extractedLength: (description || '').length,
      diagnostics,
    };
    job.descriptionRepair = { attempts: [...(job.descriptionRepair?.attempts || []), attempt] };
    repository.save(job);
    const outcome = { ...base, recovered, descriptionLength: (job.description || '').length, diagnostics };
    summary.jobs.push(outcome);
    log(outcome);
    if (stop) { summary.stoppedByChallenge = true; break; }
  }
  return summary;
}

module.exports = { parseRepairArgs, selectRepairJobs, validDirectJobUrl, repairDescriptions };
