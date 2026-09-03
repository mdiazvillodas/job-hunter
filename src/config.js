const { BROWSER_PROFILE_DIR } = require('./runtime');
const { getUserConfig } = require('./config/userConfig');

function readPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Acepta 0 como valor valido (0 = sin limite). Un valor ausente o invalido usa el fallback.
function readNonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function configuredSearch() {
  return getUserConfig().search;
}

// Aplana SEARCH_QUERIES a una lista ordenada por prioridad de familia,
// respetando los flags enabled de familia y de query.
// Devuelve: [{ query, family, familyLabel, priority }]
function getActiveSearchQueries(groups = configuredSearch().queryGroups) {
  return groups
    .filter((g) => g.enabled)
    .slice()
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .flatMap((g) =>
      g.queries
        .filter((q) => q.enabled)
        .map((q) => ({
          query: q.query,
          family: g.family,
          familyLabel: g.label,
          priority: g.priority || 0,
        }))
    );
}

const config = {
  getActiveSearchQueries,

  // Limite de JOBS UNICOS por busqueda individual. 0 => sin limite. (Milestone 4)
  MAX_RESULTS_PER_SEARCH: readNonNegativeIntegerEnv('MAX_RESULTS_PER_SEARCH', 25),
  // Safety limit de paginas por busqueda individual. 0 => sin limite. (Milestone 4)
  MAX_PAGES_PER_SEARCH: readNonNegativeIntegerEnv('MAX_PAGES_PER_SEARCH', 2),

  // Limites del flujo de busqueda unica (milestone anterior). Se mantienen por compatibilidad.
  MAX_RESULTS: readNonNegativeIntegerEnv('MAX_RESULTS', 100),
  MAX_PAGES: readNonNegativeIntegerEnv('MAX_PAGES', 0),

  // Milestone de detalle individual (queda disponible pero desactivado por defecto).
  DETAIL_LIMIT: readPositiveIntegerEnv('DETAIL_LIMIT', 3),

  // --- OpenAI Job Analyzer (Milestone 6B) ---
  // La API key NO se expone aqui: se lee directamente de process.env.OPENAI_API_KEY en el analyzer.
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  // Maximo de jobs NUEVOS que un run envia a OpenAI. Semantica (gate de costo):
  //   0  => NO analizar (solo discovery/persistencia).
  //   N>0 => como maximo N.
  // (Distinto de MAX_*_PER_SEARCH, donde 0 = sin limite: aqui 0 = ninguno, por seguridad de gasto.)
  ANALYZE_LIMIT: readNonNegativeIntegerEnv('ANALYZE_LIMIT', 50),

  BROWSER_PROFILE_DIR,
};

Object.defineProperties(config, {
  CANDIDATE_NAME: { enumerable: true, get: () => getUserConfig().identity.name },
  USER_LINKEDIN_URL: { enumerable: true, get: () => getUserConfig().identity.linkedinUrl },
  SEARCH_QUERIES: { enumerable: true, get: () => configuredSearch().queryGroups },
  LINKEDIN_SEARCH_QUERY: { enumerable: true, get: () => getActiveSearchQueries()[0].query },
  // El collector actual consume una sola ubicacion: la primera es la primaria.
  LINKEDIN_FILTERS: {
    enumerable: true,
    get: () => ({
      location: configuredSearch().locations[0],
      employmentType: 'Full-time',
      datePosted: 'Past week',
    }),
  },
});

module.exports = config;
