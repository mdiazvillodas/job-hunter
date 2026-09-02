const path = require('path');
const { BROWSER_PROFILE_DIR } = require('./runtime');

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

// Busquedas agrupadas por familia. Primera version experimental.
// Estructura pensada para poder, mas adelante:
//  - activar/desactivar familias (family.enabled);
//  - activar/desactivar queries individuales (query.enabled);
//  - asignar prioridades (family.priority; menor = antes).
const SEARCH_QUERIES = [
  {
    family: 'operations',
    label: 'Operations',
    enabled: true,
    priority: 1,
    queries: [
      { query: 'Head of Operations', enabled: true },
      { query: 'Operations Lead', enabled: true },
      { query: 'Business Operations', enabled: true },
      { query: 'Business Operations Lead', enabled: true },
      { query: 'Operations Manager', enabled: true },
    ],
  },
  {
    family: 'delivery',
    label: 'Delivery',
    enabled: true,
    priority: 2,
    queries: [
      { query: 'Head of Delivery', enabled: true },
      { query: 'Delivery Lead', enabled: true },
      { query: 'Delivery Manager', enabled: true },
    ],
  },
  {
    family: 'strategy',
    label: 'Strategy / Transformation',
    enabled: true,
    priority: 3,
    queries: [
      { query: 'Strategy & Operations', enabled: true },
      { query: 'Business Transformation', enabled: true },
      { query: 'Digital Transformation', enabled: true },
    ],
  },
  {
    family: 'product',
    label: 'Product / Hybrid',
    enabled: true,
    priority: 4,
    queries: [
      { query: 'Head of Product Operations', enabled: true },
      { query: 'Product Operations', enabled: true },
      { query: 'Product Operations Manager', enabled: true },
    ],
  },
];

// Aplana SEARCH_QUERIES a una lista ordenada por prioridad de familia,
// respetando los flags enabled de familia y de query.
// Devuelve: [{ query, family, familyLabel, priority }]
function getActiveSearchQueries(groups = SEARCH_QUERIES) {
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

module.exports = {
  LINKEDIN_SEARCH_QUERY: 'Head of Operations',

  // Filtros de la busqueda de prueba. Se aplican por UI (no por parametros de URL asumidos).
  LINKEDIN_FILTERS: {
    location: 'Barcelona',
    employmentType: 'Full-time',
    datePosted: 'Past week',
  },

  SEARCH_QUERIES,
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
