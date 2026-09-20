'use strict';

// Identidad de una operacion que puede tomar el navegador gestionado de LinkedIn.
//
// El PID NO alcanza como dueño: dos operaciones del MISMO proceso (por ejemplo un
// hunt y una exploracion de mercado) deben excluirse entre si. El dueño es, por
// tanto, (proceso + tipo de operacion + instancia de operacion), y la comparacion
// es EXACTA en los tres campos.

const crypto = require('crypto');

const OPERATION_TYPES = Object.freeze({
  HUNT: 'HUNT',
  MARKET_DISCOVERY: 'MARKET_DISCOVERY',
  MANUAL_SESSION: 'MANUAL_SESSION',
  // Verificacion corta de la sesion persistida, previa a un hunt.
  SESSION_PROBE: 'SESSION_PROBE',
  // Herramientas CLI sueltas que abren el mismo perfil persistente.
  CLI_TOOL: 'CLI_TOOL',
  // Compatibilidad: solo para llamadas de bajo nivel que no declaran operacion
  // (tests y utilidades). Nunca coincide con una operacion declarada.
  UNSPECIFIED: 'UNSPECIFIED',
});

const KNOWN_TYPES = new Set(Object.values(OPERATION_TYPES));
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UNSPECIFIED_ID = 'unspecified';

function newOperationId(prefix = 'op') {
  const safePrefix = ID_PATTERN.test(String(prefix)) ? String(prefix) : 'op';
  return `${safePrefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function createOwner(operationType, operationId, pid = process.pid) {
  if (!KNOWN_TYPES.has(operationType)) throw new TypeError(`operationType desconocido: ${String(operationType)}`);
  if (typeof operationId !== 'string' || !ID_PATTERN.test(operationId)) throw new TypeError('operationId invalido.');
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('pid invalido.');
  return Object.freeze({ pid, operationType, operationId });
}

// Dueño por defecto de quien no declara operacion. Es estable dentro del proceso,
// asi que quien adquiere asi puede liberar LO SUYO, pero nunca puede liberar ni
// suplantar a una operacion declarada (HUNT, MARKET_DISCOVERY, MANUAL_SESSION...).
function unspecifiedOwner(pid = process.pid) {
  return createOwner(OPERATION_TYPES.UNSPECIFIED, UNSPECIFIED_ID, pid);
}

function normalizeOwner(owner) {
  if (owner === undefined || owner === null) return unspecifiedOwner();
  if (typeof owner !== 'object') throw new TypeError('owner invalido.');
  return createOwner(owner.operationType, owner.operationId, owner.pid === undefined ? process.pid : owner.pid);
}

// Igualdad EXACTA de dueño. Un registro sin identidad de operacion (formato
// anterior a este contrato) no pertenece a nadie: solo la recuperacion por PID
// muerto puede limpiarlo, nunca una liberacion por PID.
function isSameOwner(record, owner) {
  if (!record || typeof record !== 'object' || !owner || typeof owner !== 'object') return false;
  if (!KNOWN_TYPES.has(record.operationType)) return false;
  if (typeof record.operationId !== 'string' || !record.operationId) return false;
  return record.pid === owner.pid
    && record.operationType === owner.operationType
    && record.operationId === owner.operationId;
}

// Diagnostico interno: identidad de la operacion, sin hostname, rutas ni secretos.
function describeOwner(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    pid: Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null,
    operationType: KNOWN_TYPES.has(record.operationType) ? record.operationType : 'UNKNOWN',
    operationId: typeof record.operationId === 'string' && ID_PATTERN.test(record.operationId) ? record.operationId : null,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt.slice(0, 32) : null,
    sameProcess: record.pid === process.pid,
  };
}

module.exports = {
  OPERATION_TYPES, KNOWN_TYPES, UNSPECIFIED_ID,
  createOwner, unspecifiedOwner, normalizeOwner, isSameOwner, describeOwner, newOperationId,
};
