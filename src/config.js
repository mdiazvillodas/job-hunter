const path = require('path');
const { parseSources } = require('./domain/sources');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function readBooleanEnv(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

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
//  - asignar prioridades (family.priority; menor = antes);
//  - limitar una query a ciertas plataformas (query.sources). Sin `sources` la
//    query corre en TODAS. Las queries en castellano solo tienen sentido en
//    InfoJobs, donde la mayoria de ofertas estan redactadas en castellano.
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
      { query: 'Director de Operaciones', enabled: true, sources: ['infojobs'] },
      { query: 'Responsable de Operaciones', enabled: true, sources: ['infojobs'] },
      { query: 'Jefe de Operaciones', enabled: true, sources: ['infojobs'] },
      { query: 'Gerente de Operaciones', enabled: true, sources: ['infojobs'] },
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
      { query: 'Director de Proyectos', enabled: true, sources: ['infojobs'] },
      { query: 'Responsable de Proyectos', enabled: true, sources: ['infojobs'] },
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
      { query: 'Transformación Digital', enabled: true, sources: ['infojobs'] },
      { query: 'Estrategia y Operaciones', enabled: true, sources: ['infojobs'] },
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
// Con `source`, ademas descarta las queries restringidas a otras plataformas.
// Sin `source` (compatibilidad) solo devuelve las queries sin restriccion, que
// son exactamente las de LinkedIn de siempre.
// Devuelve: [{ query, family, familyLabel, priority }]
function getActiveSearchQueries(groups = SEARCH_QUERIES, source = null) {
  const runsOn = (q) => (Array.isArray(q.sources) ? !!source && q.sources.includes(source) : true);
  return groups
    .filter((g) => g.enabled)
    .slice()
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .flatMap((g) =>
      g.queries
        .filter((q) => q.enabled && runsOn(q))
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

  // Mismos filtros que LinkedIn, expresados como los entiende InfoJobs. Se aplican
  // por parametros de la URL de busqueda de la propia web (ver src/infojobs/urls.js).
  // provinceId 9 = Barcelona en el filtro de provincias de InfoJobs.
  INFOJOBS_FILTERS: {
    location: 'Barcelona',
    provinceId: process.env.INFOJOBS_PROVINCE_ID || '9',
    employmentType: 'Full-time',
    datePosted: 'Past week',
  },

  SEARCH_QUERIES,
  getActiveSearchQueries,

  // Plataformas que recorre `npm run hunt`, en orden. Ausente = todas.
  // Ej.: SOURCES=linkedin  (solo LinkedIn)  |  SOURCES=infojobs  (solo InfoJobs).
  SOURCES: parseSources(process.env.SOURCES),

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
  // Mismo gate de costo, para InfoJobs. Cada plataforma tiene su propio cupo por run,
  // asi una no le quita analisis a la otra. Ausente = mismo valor que ANALYZE_LIMIT.
  INFOJOBS_ANALYZE_LIMIT: readNonNegativeIntegerEnv('INFOJOBS_ANALYZE_LIMIT', readNonNegativeIntegerEnv('ANALYZE_LIMIT', 50)),

  // --- Notificaciones push (ntfy) ---
  // Side effect informativo. Si NTFY_ENABLED no es 'true' el hunt corre igual,
  // simplemente sin enviar nada. El umbral de high match NO es configurable por
  // entorno: es una constante de dominio en src/notifications/ntfy.js.
  NTFY_ENABLED: readBooleanEnv('NTFY_ENABLED', false),
  NTFY_BASE_URL: process.env.NTFY_BASE_URL || 'https://ntfy.sh',
  NTFY_TOPIC: process.env.NTFY_TOPIC || null,

  // Headless por defecto: solo HEADLESS="false" explicito abre el navegador visible.
  // Ausente o valor inesperado => headless (true).
  HEADLESS: readBooleanEnv('HEADLESS', true),
  BROWSER_PROFILE_DIR: path.join(PROJECT_ROOT, 'browser-profile'),
  // InfoJobs usa su propio perfil: no comparte cookies ni sesion con LinkedIn.
  INFOJOBS_BROWSER_PROFILE_DIR: path.join(PROJECT_ROOT, 'browser-profile-infojobs'),
};
