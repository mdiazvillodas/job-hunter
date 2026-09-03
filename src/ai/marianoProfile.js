'use strict';

// Loader de perfiles del candidato, optimizados para job matching.
//
// Fuente unica de la verdad: ./marianoProfile.json
// Todo el contenido esta respaldado por el documento profesional ("Resumen Profesional / CV").
// Este modulo NO llama a OpenAI: solo expone el perfil como objeto para que otras capas lo usen.

const fs = require('fs');
const path = require('path');
const { PROFILE_DIR } = require('../runtime');
const { ConfigurationRequiredError } = require('../config/configurationError');

const PROFILE_FILES = Object.freeze({
  profile: 'profile.json',
  matchingProfile: 'matchingProfile.json',
  careerContext: 'careerContext.json',
});

function loadProfile(fileName) {
  const filePath = path.join(PROFILE_DIR, fileName);
  if (!fs.existsSync(filePath)) throw new ConfigurationRequiredError(`Falta profile/${fileName}.`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`La configuracion ${fileName} no es valida: ${error.message}`);
  }
}

/**
 * Devuelve el perfil completo del candidato como objeto.
 * Se devuelve una copia profunda para evitar mutaciones accidentales del perfil base.
 * @returns {object} perfil completo
 */
function getProfile() {
  const profile = loadProfile(PROFILE_FILES.profile);
  return JSON.parse(JSON.stringify(profile));
}

/**
 * Devuelve la version condensada del perfil, optimizada para job matching (Milestone 6A.1).
 * Es una destilacion del perfil completo (sin informacion nueva). Se devuelve copia profunda.
 * Nota: el analyzer todavia NO la usa automaticamente; se expone para revision/uso explicito.
 * @returns {object} matching profile
 */
function getMatchingProfile() {
  const matchingProfile = loadProfile(PROFILE_FILES.matchingProfile);
  return JSON.parse(JSON.stringify(matchingProfile));
}

/**
 * Devuelve el Career Context (fuente maestra de contexto profesional) como copia profunda.
 * IMPORTANTE: es la verdad conceptual detras del matching profile. NO debe enviarse completo
 * a OpenAI (el analyzer usa el matching profile). Se expone para referencia/analisis, no para el prompt.
 * @returns {object} career context
 */
function getCareerContext() {
  const careerContext = loadProfile(PROFILE_FILES.careerContext);
  return JSON.parse(JSON.stringify(careerContext));
}

/**
 * Resumen compacto del perfil (util para logging o para un prompt breve).
 * @returns {object}
 */
function getProfileSummary() {
  const profile = loadProfile(PROFILE_FILES.profile);
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
  getProfile,
  getMatchingProfile,
  getCareerContext,
  getProfileSummary,
  // Aliases temporales para consumidores externos/legacy.
  getMarianoProfile: getProfile,
  getMarianoMatchingProfile: getMatchingProfile,
  getMarianoCareerContext: getCareerContext,
  getMarianoProfileSummary: getProfileSummary,
  ConfigurationRequiredError,
  PROFILE_FILES,
};
