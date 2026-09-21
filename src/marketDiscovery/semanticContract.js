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
// Dimensiones cuyo CONFLICTS invalida por si solo un COMPATIBLE.
//
// `modality` se evalua y se registra igual que las demas, pero NO bloquea:
// Market Discovery responde "¿esta oferta pertenece al mercado profesional que
// queremos entender?", no "¿deberia el usuario inscribirse en ESTA oferta?".
// Que un puesto sea presencial y la preferencia sea hibrida es una restriccion
// logistica para postular; no cambia como el mercado NOMBRA ese puesto, que es
// justo lo que esta exploracion busca aprender.
//
// Esto ademas resuelve una contradiccion interna real: el mapa de perfil declara
// workplacePreference.enforcement = "unspecified" y MD7.0.1 ya establece que la
// modalidad no es filtro duro para Market Discovery, pero esta regla la trataba
// como descalificatoria absoluta y descartaba assessments fundados enteros.
//
// El resto sigue igual de estricto: capacidades, responsabilidades, dominio,
// direccion, seniority, exclusiones y GEOGRAFIA siguen bloqueando.
// Esto NO afecta a Hunter: es el contrato semantico de Market Discovery.
const NON_BLOCKING_DIMENSIONS = Object.freeze(['modality']);
const BLOCKING_DIMENSIONS = Object.freeze(DIMENSIONS.filter((d) => !NON_BLOCKING_DIMENSIONS.includes(d)));
const SOURCE_FIELDS = Object.freeze(['title', 'description']);
const TERM_TYPES = Object.freeze(['ROLE_TITLE', 'DISCRIMINATOR']);
// Solo una oferta COMPATIBLE puede alimentar el vocabulario futuro.
const ELIGIBILITY = Object.freeze({ ELIGIBLE: 'ELIGIBLE', REVIEW_ONLY: 'REVIEW_ONLY' });

const CLASSIFIER_VERSION = 1;
// El prompt cambia el juicio del modelo, asi que versiona la identidad de cache.
const PROMPT_VERSION = 3;
const MAX_DESCRIPTION_CHARS = 12000;
const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 300;
const MAX_TERM_CHARS = 120;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_TERMINOLOGY_ITEMS = 12;
const MAX_RATIONALE_CHARS = 800;
const MAX_REASON_ITEMS = 8;

// Diagnostico persistible. Un fallo de contrato tiene que poder explicarse
// DESPUES, sin volver a llamar al modelo y sin guardar nada del modelo: por eso
// se persiste un CODIGO DE REGLA estable, no solo prosa.
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 160;
const MAX_DIAGNOSTIC_TOKEN_CHARS = 40;

// Identifican QUE regla se rompio. Son nuestros, nunca texto del modelo.
const SEMANTIC_RULES = Object.freeze({
  // Forma: el proveedor ya las garantiza con Structured Outputs estricto.
  OUTPUT_NOT_OBJECT: 'OUTPUT_NOT_OBJECT',
  UNEXPECTED_FIELD: 'UNEXPECTED_FIELD',
  MISSING_FIELD: 'MISSING_FIELD',
  INVALID_CLASSIFICATION: 'INVALID_CLASSIFICATION',
  INVALID_DIMENSIONS: 'INVALID_DIMENSIONS',
  UNEXPECTED_DIMENSION: 'UNEXPECTED_DIMENSION',
  INVALID_DIMENSION_STATE: 'INVALID_DIMENSION_STATE',
  INVALID_RATIONALE: 'INVALID_RATIONALE',
  INVALID_EVIDENCE_ITEM: 'INVALID_EVIDENCE_ITEM',
  INVALID_EVIDENCE_DIMENSION: 'INVALID_EVIDENCE_DIMENSION',
  INVALID_EVIDENCE_SOURCE_FIELD: 'INVALID_EVIDENCE_SOURCE_FIELD',
  INVALID_EVIDENCE_SNIPPET: 'INVALID_EVIDENCE_SNIPPET',
  INVALID_TERMINOLOGY_ITEM: 'INVALID_TERMINOLOGY_ITEM',
  INVALID_TERMINOLOGY_TYPE: 'INVALID_TERMINOLOGY_TYPE',
  INVALID_TERMINOLOGY_SOURCE_FIELD: 'INVALID_TERMINOLOGY_SOURCE_FIELD',
  INVALID_TERMINOLOGY_EXPRESSION: 'INVALID_TERMINOLOGY_EXPRESSION',
  // Identidad: el schema no puede fijar un VALOR concreto sin volverse dinamico.
  POSTING_ID_MISMATCH: 'POSTING_ID_MISMATCH',
  // Cotas de arreglo: declaradas con maxItems en el schema y repetidas en el
  // prompt. Estos codigos son la defensa en profundidad del validador.
  REASON_LIMIT_EXCEEDED: 'REASON_LIMIT_EXCEEDED',
  EVIDENCE_LIMIT_EXCEEDED: 'EVIDENCE_LIMIT_EXCEEDED',
  TERMINOLOGY_LIMIT_EXCEEDED: 'TERMINOLOGY_LIMIT_EXCEEDED',
  // Coherencia semantica: ninguna es expresable en JSON Schema.
  EXCLUSION_CONFLICT_NOT_OUT_OF_SCOPE: 'EXCLUSION_CONFLICT_NOT_OUT_OF_SCOPE',
  COMPATIBLE_WITHOUT_SUPPORT: 'COMPATIBLE_WITHOUT_SUPPORT',
  COMPATIBLE_WITH_CONFLICT: 'COMPATIBLE_WITH_CONFLICT',
  COMPATIBLE_NOT_GROUNDED: 'COMPATIBLE_NOT_GROUNDED',
  // Transporte/parseo.
  INVALID_JSON: 'INVALID_JSON',
});
const RULE_CODES = new Set(Object.values(SEMANTIC_RULES));

// Mensaje acotado y limpio. Es lo UNICO que puede persistirse como prosa.
function boundedDiagnosticMessage(message) {
  if (typeof message !== 'string') return null;
  const cleaned = message
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_DIAGNOSTIC_MESSAGE_CHARS ? cleaned.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS) : cleaned;
}

// Un valor venido del modelo NUNCA se interpola crudo en un mensaje que se
// persiste: se limpia y se acota primero.
function diagnosticToken(value) {
  const bounded = boundedDiagnosticMessage(String(value === undefined ? '' : value));
  if (!bounded) return '<empty>';
  return bounded.length > MAX_DIAGNOSTIC_TOKEN_CHARS ? bounded.slice(0, MAX_DIAGNOSTIC_TOKEN_CHARS) : bounded;
}

class SemanticContractError extends Error {
  constructor(message, code = 'MARKET_SEMANTIC_INVALID') {
    super(message);
    this.name = 'SemanticContractError';
    this.code = code;
    // Ya acotado y saneado en el origen: quien persista no tiene que acordarse.
    this.safeMessage = boundedDiagnosticMessage(message);
  }
}
function fail(message, code) { throw new SemanticContractError(message, code); }

// Diagnostico SEGURO de un fallo semantico, para el ledger de exploracion.
// Solo sale: nombre de error, codigo de regla estable y un mensaje acotado que
// NOSOTROS escribimos. Nunca la respuesta del modelo, la descripcion de la
// oferta, el prompt, el payload de la API ni credenciales: un error ajeno no
// lleva `safeMessage`, asi que su texto no puede colarse.
function toSafeSemanticDiagnostic(error) {
  const source = error && typeof error === 'object' ? error : {};
  const rawCode = typeof source.code === 'string' ? source.code : null;
  return {
    name: typeof source.name === 'string' && source.name ? source.name.slice(0, 64) : 'Error',
    code: rawCode ? rawCode.slice(0, 64) : 'UNKNOWN',
    rule: rawCode && RULE_CODES.has(rawCode) ? rawCode : null,
    message: typeof source.safeMessage === 'string' && source.safeMessage ? source.safeMessage : null,
  };
}

// --- JSON Schema (Structured Outputs strict): object/array/string/enum,
// additionalProperties:false y todas las propiedades en required.
//
// COTAS DE ARREGLO: el mismo limite se declara en TRES niveles, y los tres leen
// la misma constante, asi que no pueden derivar entre si:
//   1. `maxItems` en el schema  -> lo aplica el proveedor al generar.
//      Documentado como soportado para arreglos; NO para modelos fine-tuned.
//      El modelo configurado (gpt-4.1-mini) no es fine-tuned.
//   2. `description` + prompt   -> el modelo sabe el techo ANTES de responder.
//   3. validateModelOutput      -> defensa en profundidad. Se mantiene aunque el
//      proveedor deba impedir el desbordamiento: el contrato no delega en el
//      proveedor su propia integridad, y una respuesta que llegue fuera de
//      limites se sigue rechazando con un codigo estable.
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
    uncertaintyReasons: {
      type: 'array',
      maxItems: MAX_REASON_ITEMS,
      description: `Motivos de incertidumbre. LIMITE: como maximo ${MAX_REASON_ITEMS} elementos; vacio si el juicio no es incierto. Superarlo invalida la respuesta.`,
      items: { type: 'string' },
    },
    evidence: {
      type: 'array',
      maxItems: MAX_EVIDENCE_ITEMS,
      description: `Fragmentos LITERALES de la oferta que sostienen el juicio. LIMITE: como maximo ${MAX_EVIDENCE_ITEMS} elementos; solo los mas fuertes, nunca se rellena hasta el limite. Superarlo invalida la respuesta.`,
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
      maxItems: MAX_TERMINOLOGY_ITEMS,
      description: `Expresiones de mercado observadas LITERALMENTE en la oferta. LIMITE: como maximo ${MAX_TERMINOLOGY_ITEMS} elementos; solo las realmente presentes, nunca se rellena hasta el limite. Superarlo invalida la respuesta.`,
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('semantic output is not an object', SEMANTIC_RULES.OUTPUT_NOT_OBJECT);
  for (const key of Object.keys(raw)) {
    if (!SEMANTIC_SCHEMA.required.includes(key)) fail(`unexpected semantic field: ${diagnosticToken(key)}`, SEMANTIC_RULES.UNEXPECTED_FIELD);
  }
  for (const key of SEMANTIC_SCHEMA.required) {
    if (!(key in raw)) fail(`missing semantic field: ${diagnosticToken(key)}`, SEMANTIC_RULES.MISSING_FIELD);
  }
  if (raw.postingId !== posting.postingId) fail('semantic output posting identity mismatch', SEMANTIC_RULES.POSTING_ID_MISMATCH);
  if (!CLASSIFICATIONS.includes(raw.classification)) fail(`invalid classification: ${diagnosticToken(raw.classification)}`, SEMANTIC_RULES.INVALID_CLASSIFICATION);
  if (!raw.dimensions || typeof raw.dimensions !== 'object' || Array.isArray(raw.dimensions)) fail('dimensions must be an object', SEMANTIC_RULES.INVALID_DIMENSIONS);
  for (const key of Object.keys(raw.dimensions)) {
    if (!DIMENSIONS.includes(key)) fail(`unexpected dimension: ${diagnosticToken(key)}`, SEMANTIC_RULES.UNEXPECTED_DIMENSION);
  }
  const dimensions = {};
  for (const dimension of DIMENSIONS) {
    const state = raw.dimensions[dimension];
    if (!DIMENSION_STATES.includes(state)) fail(`invalid state for ${dimension}: ${diagnosticToken(state)}`, SEMANTIC_RULES.INVALID_DIMENSION_STATE);
    dimensions[dimension] = state;
  }
  if (typeof raw.rationale !== 'string') fail('rationale must be a string', SEMANTIC_RULES.INVALID_RATIONALE);
  if (!Array.isArray(raw.uncertaintyReasons) || raw.uncertaintyReasons.length > MAX_REASON_ITEMS) fail('invalid uncertaintyReasons', SEMANTIC_RULES.REASON_LIMIT_EXCEEDED);
  if (!Array.isArray(raw.evidence) || raw.evidence.length > MAX_EVIDENCE_ITEMS) fail('invalid evidence', SEMANTIC_RULES.EVIDENCE_LIMIT_EXCEEDED);
  if (!Array.isArray(raw.terminology) || raw.terminology.length > MAX_TERMINOLOGY_ITEMS) fail('invalid terminology', SEMANTIC_RULES.TERMINOLOGY_LIMIT_EXCEEDED);

  // Reglas deterministas ANTI-DERIVA. No dependen de que el modelo se porte bien.
  if (dimensions.exclusions === 'CONFLICTS' && raw.classification !== 'OUT_OF_SCOPE') {
    fail('an explicit exclusion conflict must be OUT_OF_SCOPE', SEMANTIC_RULES.EXCLUSION_CONFLICT_NOT_OUT_OF_SCOPE);
  }
  if (raw.classification === 'COMPATIBLE' && dimensions.capabilities !== 'SUPPORTS' && dimensions.responsibilities !== 'SUPPORTS') {
    // Compartir una palabra generica con la semilla no es compatibilidad.
    fail('COMPATIBLE requires supported capabilities or responsibilities', SEMANTIC_RULES.COMPATIBLE_WITHOUT_SUPPORT);
  }
  if (raw.classification === 'COMPATIBLE') {
    for (const dimension of BLOCKING_DIMENSIONS) {
      if (dimensions[dimension] === 'CONFLICTS') fail(`COMPATIBLE cannot conflict on ${dimension}`, SEMANTIC_RULES.COMPATIBLE_WITH_CONFLICT);
    }
  }

  let droppedEvidence = 0;
  const evidence = [];
  for (const item of raw.evidence) {
    if (!item || typeof item !== 'object') fail('evidence item must be an object', SEMANTIC_RULES.INVALID_EVIDENCE_ITEM);
    if (!DIMENSIONS.includes(item.dimension)) fail(`invalid evidence dimension: ${diagnosticToken(item.dimension)}`, SEMANTIC_RULES.INVALID_EVIDENCE_DIMENSION);
    if (!SOURCE_FIELDS.includes(item.sourceField)) fail(`invalid evidence sourceField: ${diagnosticToken(item.sourceField)}`, SEMANTIC_RULES.INVALID_EVIDENCE_SOURCE_FIELD);
    if (typeof item.snippet !== 'string') fail('evidence snippet must be a string', SEMANTIC_RULES.INVALID_EVIDENCE_SNIPPET);
    const located = locateLiteral(fields[item.sourceField], item.snippet.slice(0, MAX_SNIPPET_CHARS));
    // Un fragmento que no esta en la oferta no es evidencia: se descarta.
    if (!located) { droppedEvidence += 1; continue; }
    evidence.push({ dimension: item.dimension, sourceField: item.sourceField, snippet: located.text, offset: located.offset, length: located.length });
  }
  if (raw.classification === 'COMPATIBLE' && !evidence.length) fail('COMPATIBLE requires at least one grounded evidence snippet', SEMANTIC_RULES.COMPATIBLE_NOT_GROUNDED);

  let droppedTerminology = 0;
  const terminology = [];
  const seen = new Set();
  for (const item of raw.terminology) {
    if (!item || typeof item !== 'object') fail('terminology item must be an object', SEMANTIC_RULES.INVALID_TERMINOLOGY_ITEM);
    if (!TERM_TYPES.includes(item.type)) fail(`invalid terminology type: ${diagnosticToken(item.type)}`, SEMANTIC_RULES.INVALID_TERMINOLOGY_TYPE);
    if (!SOURCE_FIELDS.includes(item.sourceField)) fail(`invalid terminology sourceField: ${diagnosticToken(item.sourceField)}`, SEMANTIC_RULES.INVALID_TERMINOLOGY_SOURCE_FIELD);
    if (typeof item.expression !== 'string') fail('terminology expression must be a string', SEMANTIC_RULES.INVALID_TERMINOLOGY_EXPRESSION);
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
  CLASSIFICATIONS, DIMENSION_STATES, DIMENSIONS, BLOCKING_DIMENSIONS, NON_BLOCKING_DIMENSIONS, SOURCE_FIELDS, TERM_TYPES, ELIGIBILITY,
  SEMANTIC_SCHEMA, SemanticContractError, SEMANTIC_RULES,
  toSafeSemanticDiagnostic, boundedDiagnosticMessage, diagnosticToken,
  MAX_DIAGNOSTIC_MESSAGE_CHARS, MAX_EVIDENCE_ITEMS, MAX_TERMINOLOGY_ITEMS, MAX_REASON_ITEMS,
  CLASSIFIER_VERSION, PROMPT_VERSION, MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS,
  sanitizeText, normalizePosting, postingPayload, locateLiteral,
  validateModelOutput, applyTerminologyGate, cacheIdentity,
};
