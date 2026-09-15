const { detectSecurityChallenge } = require('./session');
const { readJobDescription } = require('./descriptionExtractor');

function canonicalJobUrl(url, jobId) {
  if (jobId) return `https://www.linkedin.com/jobs/view/${jobId}/`;
  const match = url && url.match(/\/jobs\/view\/(\d+)|currentJobId=(\d+)/);
  const id = match && (match[1] || match[2]);
  return id ? `https://www.linkedin.com/jobs/view/${id}/` : url;
}

async function extractJobDetail(page, listingJob, descriptionResult) {
  return page.evaluate(
    ({ listingJob, descriptionResult }) => {
      const normalizeText = (value) => {
        if (!value) return null;
        const normalized = value.replace(/\s+/g, ' ').trim();
        return normalized || null;
      };

      const firstText = (selectors) => {
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          const text = normalizeText(element && (element.innerText || element.textContent));
          if (text) return text;
        }
        return null;
      };

      const jobId =
        listingJob.jobId ||
        (location.href.match(/\/jobs\/view\/(\d+)|currentJobId=(\d+)/) || [])[1] ||
        (location.href.match(/\/jobs\/view\/(\d+)|currentJobId=(\d+)/) || [])[2] ||
        null;

      const pageTitle = normalizeText(document.title);
      const titleFromDocument = pageTitle && pageTitle.includes(' | ') ? pageTitle.split(' | ')[0] : null;
      const companyFromDocument = pageTitle && pageTitle.includes(' | ') ? pageTitle.split(' | ')[1] : null;

      const mainText = normalizeText(document.querySelector('main')?.innerText || '') || '';
      const topTokens = mainText.split(/\s+(?=Use AI to assess|People you can reach|About the job|Acerca del empleo|Sobre el empleo)/i)[0] || '';
      const topParts = topTokens.split(/\s+\u00b7\s+/).map(normalizeText).filter(Boolean);
      const locationFromTop = topParts[0] && topParts[0].replace(/^.*?\s(?=[A-Z][^,]+,\s|Spain\b|European\b|Greater\b)/, '');

      const company =
        firstText(['main a[href*="/company/"]', 'main a[href*="/school/"]']) ||
        listingJob.company ||
        companyFromDocument;

      const title = listingJob.title || titleFromDocument;
      const locationValue = listingJob.location || locationFromTop || null;

      const findCandidate = (text, candidates) => {
        const haystack = normalizeText(text || '')?.toLowerCase() || '';
        return candidates.find((candidate) => haystack.includes(candidate.toLowerCase())) || null;
      };

      const workplaceCandidates = ['Remote', 'Hybrid', 'On-site', 'Remoto', 'Hibrido', 'H\u00edbrido', 'Presencial'];
      const employmentCandidates = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Volunteer', 'Jornada completa', 'Media jornada', 'Contrato', 'Temporal', 'Pr\u00e1cticas'];
      const seniorityPattern = /(Internship|Entry level|Associate|Mid-Senior level|Director|Executive|Pr\u00e1cticas|Sin experiencia|Algo de experiencia|Intermedio|Director|Ejecutivo)/i;

      const workplaceType = findCandidate(topTokens, workplaceCandidates) || findCandidate(locationValue, workplaceCandidates);
      const employmentType = findCandidate(topTokens, employmentCandidates) || findCandidate(mainText.slice(0, 800), employmentCandidates);

      const criteriaText = Array.from(document.querySelectorAll('main li, main div, main span'))
        .map((element) => normalizeText(element.innerText || element.textContent))
        .filter(Boolean)
        .find((text) => /seniority level|nivel de antig/i.test(text));
      const seniority = criteriaText ? normalizeText(criteriaText.replace(/seniority level|nivel de antig[uü]edad/gi, '')) : (mainText.match(seniorityPattern) || [])[1] || null;

      const description = descriptionResult.description;

      const easyApply = /Easy Apply|Solicitud sencilla|Candidatura sencilla/i.test(topTokens || mainText);
      const missingFields = ['title', 'company', 'location', 'description'].filter((field) => {
        const values = { title, company, location: locationValue, description };
        return !values[field];
      });

      return {
        detail: {
          ...listingJob,
          jobId,
          url: jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : listingJob.url || location.href,
          title,
          company,
          location: locationValue,
          employmentType,
          workplaceType,
          seniority,
          easyApply,
          description,
          descriptionLength: description ? description.length : 0,
          listing: listingJob,
          detailExtraction: descriptionResult.diagnostics,
        },
        diagnostics: { ...descriptionResult.diagnostics, missingFields },
      };
    },
    { listingJob, descriptionResult }
  );
}

async function collectJobDetail(page, listingJob, options = {}) {
  const url = options.directUrl ? listingJob.url : canonicalJobUrl(listingJob.url, listingJob.jobId);
  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      if (error.name === 'TimeoutError') {
        error.detailDiagnostics = { status: 'detail_load_timeout', jobId: listingJob.jobId, url, fetchedAt: new Date().toISOString(), error: error.message };
      }
      // No extraer contenido potencialmente viejo tras una navegacion fallida.
      throw error;
    }
    const descriptionResult = await readJobDescription(page, listingJob.jobId, options);
    const extracted = await extractJobDetail(page, listingJob, descriptionResult);
    return {
      detail: extracted.detail,
      diagnostics: [{ event: 'extracted_job_detail', ...extracted.diagnostics }],
    };
  } catch (error) {
    if (!error.detailDiagnostics) {
      error.detailDiagnostics = {
        status: ['AuthenticationError', 'SecurityChallengeError'].includes(error.name) ? 'auth_or_challenge' : 'detail_fetch_error',
        jobId: listingJob.jobId, url, fetchedAt: new Date().toISOString(), error: error.message,
      };
    }
    throw error;
  }
}

async function collectJobDetails(page, listingJobs, options = {}) {
  const details = [];
  const diagnostics = [];
  const jobsToProcess = listingJobs.slice(0, options.limit);

  for (const job of jobsToProcess) {
    try {
      const result = await collectJobDetail(page, job, options);
      details.push(result.detail);
      diagnostics.push(...result.diagnostics);

      if (options.searchResultsUrl) {
        await page.goto(options.searchResultsUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await detectSecurityChallenge(page);
      }
    } catch (error) {
      diagnostics.push({
        event: 'job_detail_error',
        jobId: job.jobId,
        url: job.url,
        error: error.message || String(error),
      });
      throw error;
    }
  }

  return {
    details,
    diagnostics,
  };
}

module.exports = {
  collectJobDetails,
  collectJobDetail,
};
