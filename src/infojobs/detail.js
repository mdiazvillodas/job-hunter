'use strict';

// Detalle de una oferta de InfoJobs: el equivalente de collectJobDetails de LinkedIn.
// Abre la oferta, comprueba challenge y extrae descripcion + datos extra
// (salario, experiencia minima) que el pipeline fusiona en el job persistido.

const { isDescriptionUsable } = require('../domain/descriptionQuality');
const { detectInfoJobsChallenge } = require('./challenge');
const { extractOfferDetailDom } = require('./extract');

async function fetchInfoJobsDetail(page, job, options = {}) {
  if (!job || !job.url) throw new Error('oferta de InfoJobs sin url');
  if (options.pauseMs) await page.waitForTimeout(options.pauseMs);

  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await detectInfoJobsChallenge(page, { stage: 'detail_collection', jobId: job.jobId });

  const d = await page.evaluate(extractOfferDetailDom);
  const usable = isDescriptionUsable(d.description);
  const detailExtraction = {
    jobId: job.jobId,
    source: 'infojobs',
    status: usable ? 'description_extracted' : (d.expired ? 'offer_expired' : 'description_missing'),
    method: d.method,
    descriptionLength: d.description ? d.description.length : 0,
  };

  // Solo se devuelven campos con dato: mergeDiscovery rellena faltantes, no pisa.
  const detailed = { jobId: job.jobId, detailExtraction };
  if (d.description) {
    detailed.description = d.description;
    detailed.descriptionLength = d.description.length;
  }
  for (const field of ['title', 'company', 'location', 'employmentType', 'workplaceType', 'contractType', 'salary', 'experienceMin']) {
    if (d[field]) detailed[field] = d[field];
  }
  return detailed;
}

module.exports = { fetchInfoJobsDetail };
