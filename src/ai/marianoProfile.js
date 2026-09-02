'use strict';

// Perfil profesional estructurado de Mariano Díaz Villodas, optimizado para job matching.
//
// Fuente unica de la verdad: ./marianoProfile.json
// Todo el contenido esta respaldado por el documento profesional ("Resumen Profesional / CV").
// Este modulo NO llama a OpenAI: solo expone el perfil como objeto para que otras capas lo usen.

const profile = require('./marianoProfile.json');
const matchingProfile = require('./marianoMatchingProfile.json');
// Fuente maestra de contexto profesional (creada manualmente, AUTORIZADA).
// Es la verdad conceptual DETRAS del matching profile; NO se envia completa a OpenAI.
const careerContext = require('./marianoCareerContext.json');

/**
 * Devuelve el perfil completo de Mariano como objeto.
 * Se devuelve una copia profunda para evitar mutaciones accidentales del perfil base.
 * @returns {object} perfil completo
 */
function getMarianoProfile() {
  return JSON.parse(JSON.stringify(profile));
}

/**
 * Devuelve la version condensada del perfil, optimizada para job matching (Milestone 6A.1).
 * Es una destilacion del perfil completo (sin informacion nueva). Se devuelve copia profunda.
 * Nota: el analyzer todavia NO la usa automaticamente; se expone para revision/uso explicito.
 * @returns {object} matching profile
 */
function getMarianoMatchingProfile() {
  return JSON.parse(JSON.stringify(matchingProfile));
}

/**
 * Devuelve el Career Context (fuente maestra de contexto profesional) como copia profunda.
 * IMPORTANTE: es la verdad conceptual detras del matching profile. NO debe enviarse completo
 * a OpenAI (el analyzer usa el matching profile). Se expone para referencia/analisis, no para el prompt.
 * @returns {object} career context
 */
function getMarianoCareerContext() {
  return JSON.parse(JSON.stringify(careerContext));
}

/**
 * Resumen compacto del perfil (util para logging o para un prompt breve).
 * @returns {object}
 */
function getMarianoProfileSummary() {
  return {
    person: profile.meta.person,
    headline: profile.positioning.headline,
    centralPositioning: profile.positioning.centralPositioning.statement,
    targetFamilies: profile.targetRoles.families.map((f) => ({ family: f.family, relevance: f.relevance })),
    seniority: profile.seniority.assessedLevel,
    experienceCount: profile.experience.length,
    evaluationPrincipleCount: profile.evaluationPrinciples.length,
  };
}

module.exports = {
  getMarianoProfile,
  getMarianoMatchingProfile,
  getMarianoCareerContext,
  getMarianoProfileSummary,
};
