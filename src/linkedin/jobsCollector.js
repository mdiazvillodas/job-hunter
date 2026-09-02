const { detectSecurityChallenge } = require('./session');

function buildJobsSearchUrl(query) {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  url.searchParams.set('keywords', query);
  return url.toString();
}

async function openJobsSearch(page, query) {
  await page.goto('https://www.linkedin.com/jobs/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await detectSecurityChallenge(page);

  await page.goto(buildJobsSearchUrl(query), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await detectSecurityChallenge(page);
}

async function waitForJobResults(page) {
  const cards = page.locator(
    [
      'li.jobs-search-results__list-item',
      'li[data-occludable-job-id]',
      '[data-job-id]',
      '.job-card-container',
      'a[href*="/jobs/view/"]',
    ].join(', ')
  );

  await cards.first().waitFor({ state: 'visible', timeout: 30000 });
}

async function extractVisibleJobs(page, options = {}) {
  return page.evaluate(() => {
    const normalizeText = (value) => {
      if (!value) return null;
      const normalized = value.replace(/\s+/g, ' ').trim();
      return normalized || null;
    };

    const cleanTitle = (value) => {
      const text = normalizeText(value);
      if (!text) return null;
      return text.replace(/\s+with verification$/i, '').trim();
    };

    const pickText = (root, candidateSelectors, transform = normalizeText) => {
      for (const selector of candidateSelectors) {
        const element = root.querySelector(selector);
        const text = element && transform(element.textContent || element.getAttribute('aria-label'));
        if (text) return text;
      }
      return null;
    };

    const extractJobId = (card, url) => {
      const attrs = ['data-job-id', 'data-occludable-job-id', 'data-entity-urn'];
      for (const attr of attrs) {
        const value = card.getAttribute(attr) || card.querySelector(`[${attr}]`)?.getAttribute(attr);
        const match = value && value.match(/(\d{6,})/);
        if (match) return match[1];
      }

      const fromUrl = url && url.match(/\/jobs\/view\/(\d+)|currentJobId=(\d+)/);
      return fromUrl ? fromUrl[1] || fromUrl[2] : null;
    };

    const canonicalJobUrl = (href, jobId) => {
      if (jobId) return `https://www.linkedin.com/jobs/view/${jobId}/`;
      if (!href) return null;
      const url = new URL(href, window.location.origin);
      const match = url.pathname.match(/\/jobs\/view\/(\d+)/) || url.search.match(/currentJobId=(\d+)/);
      return match ? `https://www.linkedin.com/jobs/view/${match[1]}/` : url.origin + url.pathname;
    };

    const cards = Array.from(document.querySelectorAll('li[data-occludable-job-id]'));
    const seen = new Set();
    const diagnostics = [];

    const jobs = cards
      .map((card) => {
        const jobContainer = card.querySelector('.job-card-container[data-job-id], .job-card-container');
        const link = card.querySelector('a.job-card-list__title--link[href*="/jobs/view/"], a[href*="/jobs/view/"]');
        const rawHref = link && link.getAttribute('href');
        const jobId = extractJobId(card, rawHref);
        const url = canonicalJobUrl(rawHref, jobId);
        const dedupeKey = jobId || url;

        if (!dedupeKey || seen.has(dedupeKey)) return null;
        seen.add(dedupeKey);

        const text = normalizeText(card.innerText || card.textContent) || '';
        const reasons = [];

        if (!jobContainer || !link || !text) {
          reasons.push('card_not_hydrated_in_current_viewport');
        }

        const title =
          (link && pickText(link, ['strong'], cleanTitle)) ||
          (link && cleanTitle(link.getAttribute('aria-label'))) ||
          pickText(card, ['.artdeco-entity-lockup__title strong'], cleanTitle) ||
          (link && cleanTitle(link.innerText || link.textContent));

        const company = pickText(card, [
          '.job-card-container__company-name',
          '.job-card-list__company-name',
          '.artdeco-entity-lockup__subtitle span[aria-hidden="true"]',
          '.artdeco-entity-lockup__subtitle',
        ]);

        const location = pickText(card, [
          '.job-card-container__metadata-item',
          '.artdeco-entity-lockup__caption span[aria-hidden="true"]',
          '.artdeco-entity-lockup__caption',
        ]);

        if (!title) reasons.push('missing_title');
        if (!company) reasons.push('missing_company');
        if (!location) reasons.push('missing_location');
        if (!url) reasons.push('missing_url');
        if (!jobId) reasons.push('missing_job_id');

        if (reasons.length) {
          diagnostics.push({
            jobId,
            reasons,
            textPreview: text.slice(0, 240),
            hasLink: Boolean(link),
            hasJobContainer: Boolean(jobContainer),
            cardClassName: card.className,
          });
        }

        return {
          title,
          company,
          location,
          url,
          jobId,
          easyApply: /easy apply|solicitud sencilla|candidatura sencilla/i.test(text),
        };
      })
      .filter((job) => job && (job.title || job.company || job.url || job.jobId));

    return {
      jobs,
      diagnostics,
    };
  });
}

async function getResultsScrollContainerHandle(page) {
  return page.evaluateHandle(() => {
    return (
      document.querySelector('.jobs-search-results-list') ||
      document.querySelector('.scaffold-layout__list') ||
      document.querySelector('[aria-label*="Jobs search results"]') ||
      document.querySelector('[aria-label*="resultados"]') ||
      document.scrollingElement
    );
  });
}

async function collectHydratedJobsWhileScrolling(page, options = {}) {
  const collected = new Map();
  const diagnostics = [];

  const mergeExtraction = async () => {
    const snapshot = await extractVisibleJobs(page, options);
    for (const job of snapshot.jobs) {
      const key = job.jobId || job.url;
      if (!key) continue;
      const previous = collected.get(key) || {};
      collected.set(key, { ...previous, ...job });
    }
    diagnostics.push(...snapshot.diagnostics);
  };

  await mergeExtraction();

  const jobIds = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li[data-occludable-job-id]'))
      .map((card) => card.getAttribute('data-occludable-job-id'))
      .filter(Boolean);
  });

  for (const jobId of jobIds) {
    await page.locator(`li[data-occludable-job-id="${jobId}"]`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(450);
    await mergeExtraction();
  }

  const container = await getResultsScrollContainerHandle(page);
  await container.evaluate((element) => {
    element.scrollTop = 0;
  }).catch(() => {});

  const latestDiagnosticsByJob = new Map();
  const uniqueDiagnostics = new Map();
  for (const item of diagnostics) {
    if (item.jobId && item.textPreview) latestDiagnosticsByJob.set(item.jobId, item);
    if (item.jobId && collected.has(item.jobId)) continue;

    const key = `${item.jobId || 'unknown'}:${item.reasons.join(',')}`;
    if (!uniqueDiagnostics.has(key)) uniqueDiagnostics.set(key, item);
  }

  for (const job of collected.values()) {
    const missingFields = ['title', 'company', 'location', 'url', 'jobId'].filter((field) => !job[field]);
    if (!missingFields.length) continue;

    const key = `${job.jobId || job.url || 'unknown'}:final_missing_fields`;
    const latestDiagnostic = job.jobId && latestDiagnosticsByJob.get(job.jobId);
    uniqueDiagnostics.set(key, {
      jobId: job.jobId,
      reasons: missingFields.map((field) => `missing_${field}`),
      textPreview: latestDiagnostic ? latestDiagnostic.textPreview : null,
      hasLink: Boolean(job.url),
      hasJobContainer: true,
      cardClassName: null,
    });
  }

  return {
    jobs: Array.from(collected.values()),
    diagnostics: Array.from(uniqueDiagnostics.values()),
  };
}

async function collectFirstPageJobs(page, query, options = {}) {
  await openJobsSearch(page, query);
  await waitForJobResults(page);
  const result = await collectHydratedJobsWhileScrolling(page, options);
  await detectSecurityChallenge(page);
  return result;
}

// Recolecta todas las tarjetas de la pagina de resultados actual (hidratando por scroll).
// Reutilizable para cualquier pagina durante la paginacion.
async function collectCurrentPageJobs(page, options = {}) {
  return collectHydratedJobsWhileScrolling(page, options);
}

module.exports = {
  buildJobsSearchUrl,
  collectFirstPageJobs,
  collectCurrentPageJobs,
  openJobsSearch,
  waitForJobResults,
};
