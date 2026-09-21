'use strict';

// Ordenamiento DETERMINISTA de candidatos antes de gastar detalle + analisis.
//
// Problema que resuelve: un run analiza como maximo `targetAnalyzedJobs` ofertas
// (20 por defecto) y hasta ahora las tomaba en ORDEN DE DESCUBRIMIENTO. Una
// busqueda como "Retail Architect" tambien devuelve "Solution Architect": esas
// colisiones semanticas consumian el presupuesto antes de llegar a las ofertas
// del dominio real del usuario.
//
// Que hace y que NO hace:
//  - SOLO ORDENA. No descarta, no filtra y no puntua fit: la lista de salida
//    contiene exactamente los mismos jobs que la de entrada.
//  - No decide nada sobre la oferta. La decision de fit sigue siendo del
//    analyzer; esto solo elige a quien se le pregunta primero.
//  - Es puro y determinista: mismas entradas -> mismo orden, sin reloj, sin azar.
//
// La senal POSITIVA se deriva de las queries configuradas por el usuario, no de
// una lista global: cada usuario prioriza segun su propio dominio. Sin queries
// el modulo es un no-op y el orden de descubrimiento se conserva.

// Conectores sin valor de dominio. No aportan senal en ningun idioma soportado.
const STOP_WORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'en', 'para',
  'con', 'por', 'a', 'al', 'the', 'of', 'for', 'and', 'or', 'in', 'to', 'at',
]);

// Terminos que SI estan en las queries del usuario pero que, por si solos, NO
// distinguen su dominio: "Architect" y "Project Manager" existen igual en
// software, en IA y en construccion. NO PUNTUAN. Solo dejan de restar cuando
// vienen acompanados de una senal fuerte del dominio (retail, obras, tiendas...).
const AMBIGUOUS_TERMS = new Set([
  'architect', 'architecture', 'arquitecto', 'arquitecta', 'arquitectura', 'arquitecte',
  'project', 'projects', 'proyecto', 'proyectos', 'projecte', 'projectes',
  'manager', 'management', 'senior', 'junior', 'lead', 'jefe', 'responsable',
  'technical', 'tecnico', 'tecnica', 'development', 'developer', 'engineer',
  'ingeniero', 'ingeniera', 'product', 'producto',
]);

// Sentido SOFTWARE/IT de "architect": un calificador tecnico pegado a la palabra.
const SOFTWARE_ARCHITECT_QUALIFIERS = [
  'solution', 'solutions', 'software', 'data', 'cloud', 'enterprise',
  'systems', 'system', 'security', 'integration', 'platform', 'network',
  'application', 'applications', 'infrastructure', 'devops',
  'sap', 'aws', 'azure', 'salesforce', 'java', 'ai', 'genai', 'ml',
];
const SOFTWARE_ARCHITECT_NOUNS_ES = [
  'soluciones', 'software', 'datos', 'sistemas', 'seguridad', 'red', 'redes',
  'nube', 'aplicaciones', 'infraestructura', 'integracion',
];

// Marcadores de dominio SOFTWARE / IT / IA que no dependen del sustantivo:
// "AI Engineer", "Machine Learning Engineer", "AI Product Manager", "IT PM".
// Conjunto acotado y explicito: desambigua dominio, no juzga la oferta.
const TECH_DOMAIN_MARKERS = [
  // IA / ML / GenAI
  'ai', 'genai', 'gen ai', 'generative ai', 'artificial intelligence',
  'inteligencia artificial', 'ia generativa', 'machine learning', 'deep learning',
  'aprendizaje automatico', 'ml', 'mlops', 'llm', 'nlp', 'data science',
  'data scientist', 'data engineer', 'data platform', 'big data',
  // Software / IT
  'it', 'software', 'devops', 'cloud', 'saas', 'sap', 'erp', 'crm',
  'aws', 'azure', 'gcp', 'salesforce', 'cybersecurity', 'ciberseguridad',
  'backend', 'frontend', 'fullstack', 'full stack', 'scrum', 'agile',
  'ciberseguretat', 'informatica', 'informatico',
];

// Sin senal fuerte suficiente, una colision tecnica cae por debajo de cualquier
// candidato que no colisione. No la elimina: la manda al final de la cola.
const COLLISION_PENALTY = 100;

// "Otra senal fuerte" que anula la penalizacion: el titulo debe ser
// sustancialmente del dominio del usuario, no mencionarlo de refilon. Una sola
// palabra ("IT Project Manager (Retail-SAP)") no alcanza.
const COLLISION_OVERRIDE_STRONG_HITS = 2;

// Minusculas + sin acentos + separadores unificados. "Arquitecto/a Técnico"
// y "arquitecto tecnico" deben producir los mismos tokens.
function normalize(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(value) {
  const normalized = normalize(value);
  if (!normalized) return [];
  return normalized.split(' ').filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

/**
 * Deriva el vocabulario del dominio a partir de las queries configuradas.
 * @param {string[]} queries
 * @returns {{all:Set<string>, strong:Set<string>, phrases:string[]}}
 */
function buildDomainTerms(queries = []) {
  const all = new Set();
  const strong = new Set();
  const phrases = [];
  for (const raw of queries) {
    const normalized = normalize(raw);
    if (!normalized) continue;
    phrases.push(normalized);
    for (const token of tokenize(raw)) {
      all.add(token);
      if (!AMBIGUOUS_TERMS.has(token)) strong.add(token);
    }
  }
  return { all, strong, phrases };
}

// "Solution Architect", "Arquitecto de soluciones", "Arquitecto Senior .NET".
// El calificador tecnico puede ir antes (ingles) o despues (castellano) de la
// palabra, asi que basta con que ambos esten en el mismo titulo.
function isSoftwareArchitectCollision(title) {
  // ".NET" pierde el punto al normalizar y "net" solo es demasiado generico
  // (existe "Net Zero Architect"), asi que se busca sobre el titulo crudo.
  if (/\.net\b/i.test(String(title == null ? '' : title))) return true;
  const normalized = normalize(title);
  if (!normalized) return false;
  if (!/\b(architect|architecture|arquitect[oa]s?|arquitectes?|arquitectura)\b/.test(normalized)) return false;
  const qualifiers = SOFTWARE_ARCHITECT_QUALIFIERS.join('|');
  if (new RegExp(`\\b(${qualifiers})\\b`).test(normalized)) return true;
  const nouns = SOFTWARE_ARCHITECT_NOUNS_ES.join('|');
  return new RegExp(`\\b(${nouns})\\b`).test(normalized);
}

// Marcador de dominio tecnico en cualquier posicion del titulo: cubre los casos
// que no giran alrededor de "architect" ("Machine Learning Engineer",
// "AI Product Manager", "IT Project Manager", "Data Scientist").
function hasTechDomainMarker(title) {
  const normalized = normalize(title);
  if (!normalized) return false;
  const padded = ' ' + normalized + ' ';
  return TECH_DOMAIN_MARKERS.some((marker) => padded.includes(' ' + marker + ' '));
}

// Colision = la oferta pertenece al dominio software/IT/IA, no al del usuario.
function isTechnicalCollision(title) {
  return isSoftwareArchitectCollision(title) || hasTechDomainMarker(title);
}

/**
 * Puntua UN candidato. Solo mira titulo y las queries que ya lo encontraron:
 * no abre la oferta, no usa la descripcion y no llama a nadie.
 * @param {object} job
 * @param {{all:Set<string>, strong:Set<string>, phrases:string[]}} terms
 */
function scoreCandidate(job, terms) {
  const title = (job && job.title) || '';
  const titleTokens = new Set(tokenize(title));
  let strongHits = 0;
  let ambiguousHits = 0;
  for (const token of titleTokens) {
    if (!terms.all.has(token)) continue;
    // Solo los terminos que distinguen el dominio suman. "Architect" y
    // "Project Manager" por si solos no son evidencia de nada.
    if (terms.strong.has(token)) strongHits += 1;
    else ambiguousHits += 1;
  }
  // Una query completa dentro del titulo es mas que la suma de sus palabras.
  const normalizedTitle = ' ' + normalize(title) + ' ';
  const phraseHit = terms.phrases.some((phrase) => phrase && normalizedTitle.includes(' ' + phrase + ' '));

  const collision = strongHits < COLLISION_OVERRIDE_STRONG_HITS && isTechnicalCollision(title);
  const score = strongHits + (phraseHit ? 2 : 0) - (collision ? COLLISION_PENALTY : 0);
  const matchedQueries = Array.isArray(job && job.matchedQueries) ? job.matchedQueries.length : 0;
  return { score, strongHits, ambiguousHits, phraseHit, collision, matchedQueries };
}

/**
 * Reordena candidatos por evidencia de dominio. Devuelve un ARRAY NUEVO con
 * exactamente los mismos elementos (ninguno se agrega ni se pierde).
 * @param {object[]} jobs
 * @param {{queries?:string[]}} [options]
 * @returns {object[]}
 */
function prioritizeCandidates(jobs, options = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const queries = Array.isArray(options.queries) ? options.queries : [];
  // Sin vocabulario no hay criterio: se respeta el orden de descubrimiento.
  const terms = buildDomainTerms(queries);
  if (!terms.all.size) return list.slice();

  return list
    .map((job, index) => ({ job, index, ...scoreCandidate(job, terms) }))
    .sort((a, b) =>
      b.score - a.score ||
      b.strongHits - a.strongHits ||
      b.matchedQueries - a.matchedQueries ||
      a.index - b.index // desempate estable: el orden de descubrimiento manda
    )
    .map((entry) => entry.job);
}

module.exports = {
  prioritizeCandidates,
  scoreCandidate,
  buildDomainTerms,
  isSoftwareArchitectCollision,
  hasTechDomainMarker,
  isTechnicalCollision,
  normalize,
  tokenize,
  STOP_WORDS,
  AMBIGUOUS_TERMS,
  SOFTWARE_ARCHITECT_QUALIFIERS,
  TECH_DOMAIN_MARKERS,
  COLLISION_PENALTY,
  COLLISION_OVERRIDE_STRONG_HITS,
};
