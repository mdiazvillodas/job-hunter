'use strict';

// URLs de InfoJobs. Modulo PURO (sin Playwright): se testea sin red.
//
// Ofertas: https://www.infojobs.net/<ciudad>/<slug-del-puesto>/of-i<id hex>
//   El id es el segmento "of-<id>". Es estable aunque cambie el slug.
// Busqueda: https://www.infojobs.net/jobsearch/search-results/list.xhtml?keyword=...
//   Los filtros (provincia, fecha) son parametros de la propia web: es lo mismo que
//   marcarlos en la UI, y despues se verifica en la URL final que siguen activos.

const { INFOJOBS_JOB_ID_PREFIX } = require('../domain/sources');

const BASE_URL = 'https://www.infojobs.net';
const SEARCH_PATH = '/jobsearch/search-results/list.xhtml';
const OFFER_PATH_RE = /\/of-([a-z0-9]{10,})(?:[/?#]|$)/i;

// Etiquetas del config (las mismas de LinkedIn) -> valor de sinceDate de InfoJobs.
const SINCE_DATE = {
  'past 24 hours': '_24_HOURS',
  'past week': '_7_DAYS',
  'ultima semana': '_7_DAYS',
  'past 15 days': '_15_DAYS',
  'past month': '_15_DAYS', // InfoJobs no ofrece un mes: el rango mas amplio disponible.
  'any time': 'ANY',
};

function sinceDateOf(datePosted) {
  return SINCE_DATE[String(datePosted || '').trim().toLowerCase()] || null;
}

function isInfoJobsHost(hostname) {
  return /(^|\.)infojobs\.net$/i.test(String(hostname || ''));
}

// Id de la oferta a partir de cualquier URL de oferta de InfoJobs. null si no lo es.
function parseOfferId(href) {
  if (!href) return null;
  try {
    const url = new URL(href, BASE_URL);
    if (!isInfoJobsHost(url.hostname)) return null;
    const m = url.pathname.match(OFFER_PATH_RE);
    return m ? m[1].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

// URL canonica: https, host www.infojobs.net, sin query ni fragmento.
function canonicalOfferUrl(href) {
  if (!parseOfferId(href)) return null;
  const url = new URL(href, BASE_URL);
  return `${BASE_URL}${url.pathname}`;
}

function toJobId(offerId) {
  return offerId ? INFOJOBS_JOB_ID_PREFIX + String(offerId).toLowerCase() : null;
}

function buildSearchUrl(query, filters = {}, pageNumber = 1) {
  const url = new URL(SEARCH_PATH, BASE_URL);
  url.searchParams.set('keyword', query);
  if (filters.provinceId) url.searchParams.set('provinceIds', String(filters.provinceId));
  const since = sinceDateOf(filters.datePosted);
  if (since) url.searchParams.set('sinceDate', since);
  if (pageNumber > 1) url.searchParams.set('page', String(pageNumber));
  return url.toString();
}

// Verifica en la URL REAL (despues de redirecciones) que los filtros siguen activos,
// igual que se hace con LinkedIn.
function verifyFiltersInUrl(currentUrl, filters = {}) {
  let params;
  try {
    params = new URL(currentUrl).searchParams;
  } catch (_) {
    return { url: currentUrl, locationActive: false, datePostedActive: false };
  }
  const since = sinceDateOf(filters.datePosted);
  const provinces = params.getAll('provinceIds').join(',').split(',');
  return {
    url: currentUrl,
    locationActive: filters.provinceId ? provinces.includes(String(filters.provinceId)) : null,
    datePostedActive: since ? params.get('sinceDate') === since : null,
  };
}

module.exports = {
  BASE_URL,
  SEARCH_PATH,
  sinceDateOf,
  isInfoJobsHost,
  parseOfferId,
  canonicalOfferUrl,
  toJobId,
  buildSearchUrl,
  verifyFiltersInUrl,
};
