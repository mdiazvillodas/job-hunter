'use strict';

// MD8 — aplicar una propuesta de Market Discovery a las queries de Hunter.
//
// SEMANTICA: REEMPLAZO. Las queries propuestas SUSTITUYEN al portafolio actual;
// no se mezclan con el. Es una decision de producto explicita: la propuesta se
// defiende como CONJUNTO (cobertura incremental, redundancia y familias se
// evaluaron juntas en MD6), asi que fusionarla con las queries antiguas
// produciria un portafolio que nadie ha evaluado.
//
// Nada de esto ocurre solo: aplicar SIEMPRE nace de una accion explicita del
// usuario. Este modulo no arranca un hunt, no relanza Market Discovery, no
// notifica por Telegram ni por ntfy y no toca ningun otro ajuste del usuario.
//
// PRESERVACION: se parte de la configuracion REAL en disco y solo se sustituye
// search.queryGroups. Todo lo demas -identidad, ubicaciones, modalidades,
// targetAnalyzedJobs, notifications, telegram y cualquier bloque futuro- se
// conserva tal cual. Deliberadamente NO se reutiliza setupService.saveUserConfig,
// porque aquel RECONSTRUYE el fichero desde un formulario plano y perderia los
// bloques que no forma parte de ese formulario.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateUserConfig } = require('../config/userConfig');

// Grupo de queries propiedad de Market Discovery. Es el unico que escribe.
const MARKET_DISCOVERY_FAMILY = 'market-discovery';
const MARKET_DISCOVERY_LABEL = 'Propuesta de Explorar mercado';

class ProposalApplyError extends Error {
  constructor(message, code = 'MARKET_PROPOSAL_APPLY_FAILED') {
    super(message);
    this.name = 'ProposalApplyError';
    this.code = code;
    this.expose = true;
    this.statusCode = code === 'PROPOSAL_NOT_FOUND' ? 404 : 409;
  }
}

function atomicWrite(filePath, content) {
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, filePath);
  } catch (error) {
    // Un fallo a mitad NO puede dejar el fichero real a medias: el temporal se
    // limpia y la configuracion previa sigue intacta porque nunca se sobrescribio.
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (e) { /* noop */ }
    throw error;
  }
}

// Las queries que la propuesta defiende, en su orden de seleccion.
function proposedQueries(proposal) {
  const selected = proposal && Array.isArray(proposal.selectedQueries) ? proposal.selectedQueries : [];
  const seen = new Set();
  const queries = [];
  for (const entry of selected) {
    const text = entry && typeof entry.expression === 'string' ? entry.expression.trim() : '';
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ query: text, enabled: true });
  }
  return queries;
}

// Lo que el usuario vera ANTES de confirmar: exactamente que cambia.
function describeChange(currentConfig, proposal) {
  const current = [];
  for (const group of (currentConfig.search && currentConfig.search.queryGroups) || []) {
    for (const item of group.queries || []) {
      if (item && typeof item.query === 'string') current.push({ query: item.query, enabled: item.enabled !== false, family: group.family || null });
    }
  }
  const proposed = proposedQueries(proposal).map((item) => ({ query: item.query, enabled: true, family: MARKET_DISCOVERY_FAMILY }));
  const currentSet = new Set(current.map((item) => item.query.toLowerCase()));
  const proposedSet = new Set(proposed.map((item) => item.query.toLowerCase()));
  return {
    mode: 'REPLACE',
    current,
    proposed,
    removed: current.filter((item) => !proposedSet.has(item.query.toLowerCase())),
    added: proposed.filter((item) => !currentSet.has(item.query.toLowerCase())),
    kept: proposed.filter((item) => currentSet.has(item.query.toLowerCase())),
  };
}

function createProposalApplyService(options = {}) {
  const runStore = options.runStore;
  const userConfigPath = options.userConfigPath || require('../runtime').USER_CONFIG_PATH;
  const readConfig = options.readUserConfig || (() => JSON.parse(fs.readFileSync(userConfigPath, 'utf8')));
  const writeConfig = options.writeUserConfig || ((config) => atomicWrite(userConfigPath, JSON.stringify(config, null, 2) + '\n'));

  function loadProposal(runId) {
    const artifact = runStore.readArtifact(runId, 'proposal');
    const proposal = artifact && artifact.proposal ? artifact.proposal : null;
    if (!proposal) throw new ProposalApplyError('No hay propuesta para esa exploración.', 'PROPOSAL_NOT_FOUND');
    return proposal;
  }

  // Vista previa: NO escribe nada. Es lo que la confirmacion muestra.
  function preview(runId) {
    const proposal = loadProposal(runId);
    const config = readConfig();
    return {
      runId,
      proposalId: proposal.proposalId,
      applied: proposal.applied === true,
      applicable: proposedQueries(proposal).length > 0,
      warnings: Array.isArray(proposal.warnings) ? proposal.warnings : [],
      change: describeChange(config, proposal),
    };
  }

  function apply(runId) {
    const proposal = loadProposal(runId);
    const queries = proposedQueries(proposal);

    // Falla cerrado: una propuesta vacia NO puede borrar el portafolio del
    // usuario. Sin queries defendibles no hay nada que aplicar.
    if (!queries.length) {
      throw new ProposalApplyError('La propuesta no contiene consultas defendibles: no se puede aplicar.', 'PROPOSAL_EMPTY');
    }

    const current = readConfig();
    const change = describeChange(current, proposal);

    // Idempotente: si ya esta aplicada y la configuracion ya coincide, no se
    // reescribe nada y se informa del hecho.
    const alreadyInPlace = change.removed.length === 0 && change.added.length === 0
      && change.current.length === change.proposed.length;
    if (proposal.applied === true && alreadyInPlace) {
      return { runId, proposalId: proposal.proposalId, applied: true, changed: false, reason: 'already_applied', change };
    }

    // REEMPLAZO: solo cambia search.queryGroups. Todo lo demas se conserva.
    const next = {
      ...current,
      search: {
        ...current.search,
        queryGroups: [{
          family: MARKET_DISCOVERY_FAMILY,
          label: MARKET_DISCOVERY_LABEL,
          enabled: true,
          priority: 1,
          queries,
        }],
      },
    };
    // Se valida ANTES de escribir: una propuesta que produciria una
    // configuracion invalida no llega nunca al disco.
    validateUserConfig(next);
    writeConfig(next);

    // applied:true SOLO despues de que la escritura de configuracion salio bien.
    // Si el marcado fallara, la configuracion ya es correcta y la propuesta se
    // queda como no aplicada: se puede reintentar sin romper nada.
    const artifact = runStore.readArtifact(runId, 'proposal');
    runStore.writeArtifact(runId, 'proposal', {
      ...artifact,
      proposal: { ...proposal, applied: true, appliedAt: new Date().toISOString() },
    });

    return { runId, proposalId: proposal.proposalId, applied: true, changed: true, reason: 'applied', change };
  }

  return { preview, apply, describeChange, proposedQueries };
}

module.exports = {
  createProposalApplyService,
  ProposalApplyError,
  MARKET_DISCOVERY_FAMILY,
  MARKET_DISCOVERY_LABEL,
};
