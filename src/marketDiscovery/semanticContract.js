'use strict';

// MD4 — contrato semantico de Market Discovery: enums, schema, normalizacion de
// la oferta y validacion ANCLADA de lo que devuelve el modelo.
//
// Todo lo de este modulo es puro: sin IO, sin red, sin modelo. La salida del
// modelo se trata como NO CONFIABLE y se verifica contra el texto realmente
// enviado. Lo que no se puede verificar no se repara: se descarta o falla.
//
// Este contrato es deliberadamente AJENO al Job Analyzer de Hunter: aqui no hay
// decision YES/MAYBE/NO, ni scores, ni CAN SELL.

const { SCHEMA_VERSION, hash, freeze, normalize, assert } = require('./domain');

const CLASSIFICATIONS = Object.freeze(['COMPATIBLE', 'UNCERTAIN', 'OUT_OF_SCOPE']);
const DIMENSION_STATES = Object.freeze(['SUPPORTS', 'NEUTRAL', 'CONFLICTS', 'UNKNOWN']);
const DIMENSIONS = Object.freeze(['capabilities', 'responsibilities', 'domain', 'direction', 'seniority', 'exclusions', 'geography', 'modality']);
const SOURCE_FIELDS = Object.freeze(['title', 'description']);
const TERM_TYPES = Object.freeze(['ROLE_TITLE', 'DISCRIMINATOR']);
// Solo una oferta COMPATIBLE puede alimentar el vocabulario futuro.
const ELIGIBILITY = Object.freeze({ ELIGIBLE: 'ELIGIBLE', REVIEW_ONLY: 'REVIEW_ONLY' });

const CLASSIFIER_VERSION = 1;
const PROMPT_VERSION = 1;
const MAX_DESCRIPTION_CHARS = 12000;
const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 300;
const MAX_TERM_CHARS = 120;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_TERMINOLOGY_ITEMS = 12;
const MAX_RATIONALE_CHARS = 800;
const MAX_REASON_ITEMS = 8;

class SemanticContractError extends Error {
  constructor(message, code = 'MARKET_SEMANTIC_INVALID') {
    super(message);
    this.name = 'SemanticContractError';
    this.code = code;
  }
}
function fail(message) { throw new SemanticContractError(message); }

// --- JSON Schema (Structured Outputs strict): object/array/string/enum,
// additionalProperties:false y todas las propiedades en required.
const dimensionProperties = {};
for (const dimension of DIMENSIONS) dimensionProperties[dimension] = { type: 'string', enum: [...DIMENSION_STATES] };

const SEMANTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    postingId: { type: 'string', description: 'Debe repetir exactamente el postingId recibido.' },
    classification: { type: 'string', enum: [...CLASSIFICATIONS] },
    dimensions: { type: 'object', additionalProperties: false, properties: dimensionProperties, required: [...DIMENSIONS] },
    rationale: { type: 'string' },
    uncertaintyReasons: { type: 'array', items: { type: 'string' } },
    evidence: {
      type: 'array',
      description: 'Fragmentos LITERALES de la oferta que sostienen el juicio.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dimension: { type: 'string', enum: [...DIMENSIONS] },
          sourceField: { type: 'string', enum: [...SOURCE_FIELDS] },
          snippet: { type: 'string', description: 'Texto copiado LITERALMENTE de ese campo.' },
        },
        required: ['dimension', 'sourceField', 'snippet'],
      },
    },
    terminology: {
      type: 'array',
      description: 'Expresiones de mercado observadas LITERALMENTE en la oferta.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: [...TERM_TYPES] },
          expression: { type: 'string', description: 'Texto copiado LITERALMENTE del campo indicado.' },
          sourceField: { type: 'string', enum: [...SOURCE_FIELDS] },
        },
        required: ['type', 'expression', 'sourceField'],
      },
    },
  },
  required: ['postingId', 'classification', 'dimensions', 'rationale', 'uncertaintyReasons', 'evidence', 'terminology'],
};

// --- Oferta: contrato minimo. Lo que falta, falta explicitamente; no se inventa.
function sanitizeText(value, limit) {
  if (typeof value !== 'string') return null;
  // Se quitan controles y se colapsa el espacio UNA vez: el texto resultante es
  // exactamente el que se envia al modelo y contra el que se verifica el anclaje.
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned;
}

function normalizePosting(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'posting required');
  const postingId = typeof input.postingId === 'string' ? input.postingId.trim() : '';
  assert(postingId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(postingId), 'posting id required');
  const rawDescription = typeof input.description === 'string' ? input.description : null;
  const description = sanitizeText(rawDescription, MAX_DESCRIPTION_CHARS);
  const sanitizedFull = rawDescription === null ? null : sanitizeText(rawDescription, Number.MAX_SAFE_INTEGER);
  const provenance = input.provenance && typeof input.provenance === 'object' ? {
    searchId: typeof input.provenance.searchId === 'string' ? input.provenance.searchId : null,
    familyId: typeof input.provenance.familyId === 'string' ? input.provenance.familyId : null,
    // La query que encontro la oferta es PROCEDENCIA, no verdad: se conserva
    // aqui y NUNCA se envia al modelo.
    query: typeof input.provenance.query === 'string' ? input.provenance.query : null,
  } : null;
  const fields = {
    title: sanitizeText(input.title, MAX_TITLE_CHARS),
    description,
  };
  const posting = {
    postingId,
    url: sanitizeText(input.url, 500),
    title: fields.title,
    company: sanitizeText(input.company, 200),
    location: sanitizeText(input.location, 200),
    description,
    descriptionAvailable: description !== null,
    descriptionTruncated: sanitizedFull !== null && description !== null && sanitizedFull.length > description.length,
    provenance,
  };
  // Sin titulo y sin descripcion no hay nada que evaluar: no se llama al modelo.
  posting.assessable = Boolean(fields.title || fields.description);
  return { posting: freeze(posting), fields: freeze(fields) };
}

// Solo los campos que el modelo puede ver. La query/semilla queda fuera a proposito.
function postingPayload(posting) {
  return {
    postingId: posting.postingId,
    title: posting.title,
    company: posting.company,
    location: posting.location,
    description: posting.description,
    descriptionAvailable: posting.descriptionAvailable,
    descriptionTruncated: posting.descriptionTruncated,
  };
}

// --- Anclaje: una afirmacion del modelo vale si aparece LITERALMENTE en el campo
// que dice. Se compara sin distinguir mayusculas, y se conserva el texto REAL de
// la oferta, no la version del modelo.
function locateLiteral(haystack, needle) {
  if (typeof haystack !== 'string' || !haystack || typeof needle !== 'string') return null;
  const candidate = needle.replace(/\s+/g, ' ').trim();
  if (!candidate) return null;
  const offset = haystack.toLowerCase().indexOf(candidate.toLowerCase());
  if (offset < 0) return null;
  return { offset, length: candidate.length, text: haystack.slice(offset, offset + candidate.length) };
}

function validateModelOutput(raw, posting, fields) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('semantic output is not an object');
  for (const key of Object.keys(raw)) {
    if (!SEMANTIC_SCHEMA.required.includes(key)) fail(`unexpected semantic field: ${key}`);
  }
  for (const key of SEMANTIC_SCHEMA.required) {
    if (!(key in raw)) fail(`missing semantic field: ${key}`);
  }
  if (raw.postingId !== posting.postingId) fail('semantic output posting identity mismatch');
  if (!CLASSIFICATIONS.includes(raw.classification)) fail(`invalid classification: ${String(raw.classification)}`);
  if (!raw.dimensions || typeof raw.dimensions !== 'object' || Array.isArray(raw.dimensions)) fail('dimensions must be an object');
  for (const key of Object.keys(raw.dimensions)) {
    if (!DIMENSIONS.includes(key)) fail(`unexpected dimension: ${key}`);
  }
  const dimensions = {};
  for (const dimension of DIMENSIONS) {
    const state = raw.dimensions[dimension];
    if (!DIMENSION_STATES.includes(state)) fail(`invalid state for ${dimension}: ${String(state)}`);
    dimensions[dimension] = state;
  }
  if (typeof raw.rationale !== 'string') fail('rationale must be a string');
  if (!Array.isArray(raw.uncertaintyReasons) || raw.uncertaintyReasons.length > MAX_REASON_ITEMS) fail('invalid uncertaintyReasons');
  if (!Array.isArray(raw.evidence) || raw.evidence.length > MAX_EVIDENCE_ITEMS) fail('invalid evidence');
  if (!Array.isArray(raw.terminology) || raw.terminology.length > MAX_TERMINOLOGY_ITEMS) fail('invalid terminology');

  // Reglas deterministas ANTI-DERIVA. No dependen de que el modelo se porte bien.
  if (dimensions.exclusions === 'CONFLICTS' && raw.classification !== 'OUT_OF_SCOPE') {
    fail('an explicit exclusion conflict must be OUT_OF_SCOPE');
  }
  if (raw.classification === 'COMPATIBLE' && dimensions.capabilities !== 'SUPPORTS' && dimensions.responsibilities !== 'SUPPORTS') {
    // Compartir una palabra generica con la semilla no es compatibilidad.
    fail('COMPATIBLE requires supported capabilities or responsibilities');
  }
  if (raw.classification === 'COMPATIBLE') {
    for (const dimension of DIMENSIONS) {
      if (dimensions[dimension] === 'CONFLICTS') fail(`COMPATIBLE cannot conflict on ${dimension}`);
    }
  }

  let droppedEvidence = 0;
  const evidence = [];
  for (const item of raw.evidence) {
    if (!item || typeof item !== 'object') fail('evidence item must be an object');
    if (!DIMENSIONS.includes(item.dimension)) fail(`invalid evidence dimension: ${String(item.dimension)}`);
    if (!SOURCE_FIELDS.includes(item.sourceField)) fail(`invalid evidence sourceField: ${String(item.sourceField)}`);
    if (typeof item.snippet !== 'string') fail('evidence snippet must be a string');
    const located = locateLiteral(fields[item.sourceField], item.snippet.slice(0, MAX_SNIPPET_CHARS));
    // Un fragmento que no esta en la oferta no es evidencia: se descarta.
    if (!located) { droppedEvidence += 1; continue; }
    evidence.push({ dimension: item.dimension, sourceField: item.sourceField, snippet: located.text, offset: located.offset, length: located.length });
  }
  if (raw.classification === 'COMPATIBLE' && !evidence.length) fail('COMPATIBLE requires at least one grounded evidence snippet');

  let droppedTerminology = 0;
  const terminology = [];
  const seen = new Set();
  for (const item of raw.terminology) {
    if (!item || typeof item !== 'object') fail('terminology item must be an object');
    if (!TERM_TYPES.includes(item.type)) fail(`invalid terminology type: ${String(item.type)}`);
    if (!SOURCE_FIELDS.includes(item.sourceField)) fail(`invalid terminology sourceField: ${String(item.sourceField)}`);
    if (typeof item.expression !== 'string') fail('terminology expression must be a string');
    const located = locateLiteral(fields[item.sourceField], item.expression.slice(0, MAX_TERM_CHARS));
    // Termino inventado o parafraseado: se DESCARTA, nunca se repara.
    if (!located) { droppedTerminology += 1; continue; }
    const normalized = normalize(located.text);
    if (!normalized) { droppedTerminology += 1; continue; }
    const key = item.type + ':' + normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    terminology.push({
      type: item.type,
      expression: located.text,
      normalized,
      sourceField: item.sourceField,
      offset: located.offset,
      length: located.length,
    });
  }

  return {
    classification: raw.classification,
    dimensions,
    rationale: raw.rationale.slice(0, MAX_RATIONALE_CHARS),
    uncertaintyReasons: raw.uncertaintyReasons
      .filter((reason) => typeof reason === 'string' && reason.trim())
      .map((reason) => reason.slice(0, MAX_SNIPPET_CHARS)),
    evidence,
    terminology,
    droppedEvidence,
    droppedTerminology,
  };
}

// La compuerta: solo COMPATIBLE produce terminologia promocionable.
// OUT_OF_SCOPE no produce terminologia en absoluto.
function applyTerminologyGate(classification, terminology, posting) {
  if (classification === 'OUT_OF_SCOPE') return [];
  const eligibility = classification === 'COMPATIBLE' ? ELIGIBILITY.ELIGIBLE : ELIGIBILITY.REVIEW_ONLY;
  return terminology.map((term) => ({
    ...term,
    postingId: posting.postingId,
    searchId: posting.provenance ? posting.provenance.searchId : null,
    familyId: posting.provenance ? posting.provenance.familyId : null,
    eligibility,
    // Solo una observacion ELIGIBLE puede originar descendientes en fases futuras.
    promotable: eligibility === ELIGIBILITY.ELIGIBLE,
  }));
}

// Identidad reproducible: misma oferta + mismo perfil + mismo modelo/prompt/schema
// => misma clave. Prepara el cache de fases futuras sin implementarlo.
function cacheIdentity({ posting, profile, model }) {
  const postingHash = hash(postingPayload(posting));
  const profileHash = hash(profile);
  const identity = {
    postingHash,
    profileHash,
    model: String(model),
    promptVersion: PROMPT_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
  return { ...identity, cacheKey: hash(identity) };
}

module.exports = {
  CLASSIFICATIONS, DIMENSION_STATES, DIMENSIONS, SOURCE_FIELDS, TERM_TYPES, ELIGIBILITY,
  SEMANTIC_SCHEMA, SemanticContractError,
  CLASSIFIER_VERSION, PROMPT_VERSION, MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS,
  sanitizeText, normalizePosting, postingPayload, locateLiteral,
  validateModelOutput, applyTerminologyGate, cacheIdentity,
};
