const { detectSecurityChallenge } = require('./session');

function canonicalJobUrl(url, jobId) {
  if (jobId) return `https://www.linkedin.com/jobs/view/${jobId}/`;
  const match = url && url.match(/\/jobs\/view\/(\d+)|currentJobId=(\d+)/);
  const id = match && (match[1] || match[2]);
  return id ? `https://www.linkedin.com/jobs/view/${id}/` : url;
}

async function waitForJobDetail(page, jobId) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await detectSecurityChallenge(page);

  const detailRoot = page.locator(
    [
      `#JobDetails_AboutTheJob_${jobId}`,
      '[data-sdui-component*="aboutTheJob"]',
      '[data-testid="expandable-text-box"]',
      'main',
    ].join(', ')
  );

  await detailRoot.first().waitFor({ state: 'visible', timeout: 30000 });
}

async function expandDescriptionIfNeeded(page) {
  const result = await page.evaluate(() => {
    const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const expansionPattern = /^(see more|show more|ver m[aá]s|mostrar m[aá]s|\u2026\s*more|\.\.\.\s*more)$/i;
    const aboutRoot =
      document.querySelector('[id^="JobDetails_AboutTheJob_"]') ||
      document.querySelector('[data-sdui-component*="aboutTheJob"]');

    const candidates = Array.from((aboutRoot || document).querySelectorAll('button, a')).filter((element) => {
      const label = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label'));
      return expansionPattern.test(label);
    });

    const button = candidates[0] || null;
    if (!button) {
      return { found: false, clicked: false, text: null };
    }

    button.scrollIntoView({ block: 'center' });
    button.click();
    return {
      found: true,
      clicked: true,
      text: normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label')),
    };
  });

  if (result.clicked) {
    await page.waitForTimeout(1000);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }

  return result;
}

async function extractJobDetail(page, listingJob, expandInfo) {
  return page.evaluate(
    ({ listingJob, expandInfo }) => {
      const normalizeText = (value) => {
        if (!value) return null;
        const normalized = value.replace(/\s+/g, ' ').trim();
        return normalized || null;
      };

      const removeHeading = (text) => {
        const normalized = normalizeText(text);
        if (!normalized) return null;
        return normalized.replace(/^About the job\s*/i, '').replace(/^Acerca del empleo\s*/i, '').replace(/^Sobre el empleo\s*/i, '').trim();
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

      const aboutRoot =
        document.querySelector(`[id="JobDetails_AboutTheJob_${jobId}"]`) ||
        document.querySelector('[id^="JobDetails_AboutTheJob_"]') ||
        document.querySelector('[data-sdui-component*="aboutTheJob"]');
      const descriptionBox = aboutRoot && (aboutRoot.querySelector('[data-testid="expandable-text-box"]') || aboutRoot);
      const description = removeHeading(descriptionBox && (descriptionBox.innerText || descriptionBox.textContent));

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
        },
        diagnostics: {
          jobId,
          url: listingJob.url || location.href,
          expansionButtonFound: Boolean(expandInfo && expandInfo.found),
          expansionClicked: Boolean(expandInfo && expandInfo.clicked),
          expansionButtonText: expandInfo ? expandInfo.text : null,
          descriptionLength: description ? description.length : 0,
          missingFields,
          errors: description ? [] : ['description_not_found'],
        },
      };
    },
    { listingJob, expandInfo }
  );
}

async function collectJobDetail(page, listingJob, options = {}) {
  const url = canonicalJobUrl(listingJob.url, listingJob.jobId);
  const debugEvents = [];

  if (options.debug) {
    debugEvents.push({
      event: 'opening_job_detail',
      jobId: listingJob.jobId,
      url,
    });
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForJobDetail(page, listingJob.jobId);

  const expandInfo = await expandDescriptionIfNeeded(page);
  await detectSecurityChallenge(page);
  const extracted = await extractJobDetail(page, listingJob, expandInfo);

  if (options.debug) {
    debugEvents.push({
      event: 'extracted_job_detail',
      ...extracted.diagnostics,
    });
  }

  return {
    detail: extracted.detail,
    diagnostics: debugEvents,
  };
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
};
