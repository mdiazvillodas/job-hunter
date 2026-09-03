'use strict';
/* UI del Job Hunter. Consume /api (que a su vez usa jobService -> repository).
 * La lógica de lista (filtro/orden/búsqueda) viene de /jobListLogic.js (compartida con los tests). */

const L = window.JobListLogic;

const state = {
  jobs: [],
  reasons: [],
  filters: { status: 'inbox', aiDecision: 'all', easyApply: 'all', minScore: 0, families: [], company: '', matchedQuery: '', search: '' },
  sort: 'overall',
  selectedId: null,
  userConfig: null,
  setupReady: false,
  linkedinSession: null,
  hunt: null,
};

/* ---------- utils ---------- */
function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(id) { return document.getElementById(id); }
function scoreClass(v) { if (v == null) return 's-na'; if (v >= 80) return 's-high'; if (v >= 60) return 's-mid'; return 's-low'; }
function fmtDate(iso) { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(); }
function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/* ---------- traducción de labels/enums (SOLO presentación; no cambia valores persistidos) ---------- */
const STATUS_LABELS = { all: 'Todas', new: 'Nueva', read: 'Leída', interested: 'Interesada', discarded: 'Descartada', applied: 'Aplicada', priority: 'Prioridad' };
// Etiquetas de los filtros de navegación (en plural / forma de vista). Separadas de STATUS_LABELS,
// que rotula el estado de UNA oferta (chip "Usuario: Interesada").
const FILTER_LABELS = { inbox: 'Bandeja', all: 'Todas', new: 'Nuevas', read: 'Leídas', interested: 'Me interesan', applied: 'Aplicadas', discarded: 'Descartadas', priority: 'Prioridad' };
const DECISION_LABELS = { YES: 'SÍ', MAYBE: 'QUIZÁS', NO: 'NO' };
const CLASSIFICATION_LABELS = { DIRECT_MATCH: 'COINCIDENCIA DIRECTA', TRANSFERABLE_MATCH: 'EXPERIENCIA TRANSFERIBLE', SCALE_STRETCH: 'DESAFÍO DE ESCALA', NOT_EVIDENCED: 'NO EVIDENCIADO', CLEAR_GAP: 'BRECHA CLARA', CRITICAL_GAP: 'BRECHA CRÍTICA' };
const RATING_LABELS = { STRONG: 'FUERTE', MODERATE: 'MODERADA', TRANSFERABLE: 'TRANSFERIBLE', NOT_EVIDENCED: 'NO EVIDENCIADA', ABSENT: 'AUSENTE' };
const DIMENSION_LABELS = { interest: 'interés', professional_fit: 'fit profesional', both: 'ambas', unknown: 'desconocida' };
const DIRECTION_LABELS = { avoid: 'evitar', seek: 'buscar' };
const TIER_LABELS = { signal: 'señal', emerging: 'emergente', established: 'establecida', none: 'ninguna' };
const CONFIDENCE_LABELS = { low: 'baja', medium: 'media', high: 'alta', none: 'ninguna' };
const SIGNAL_LABELS = { ai_overestimated_interest: 'IA sobreestimó interés', ai_underestimated_interest: 'IA subestimó interés', ai_overestimated_professional_fit: 'IA sobreestimó fit profesional', ai_underestimated_professional_fit: 'IA subestimó fit profesional', ai_correct: 'IA acertó', unknown: 'desconocido' };
const REASON_LABELS = { role_type: 'Tipo de rol', too_commercial: 'Demasiado comercial', too_sales_driven: 'Muy orientado a ventas', too_product: 'Demasiado producto', too_project_management: 'Demasiado project management', insufficient_ownership: 'Poco ownership', insufficient_seniority: 'Seniority insuficiente', too_senior: 'Demasiado senior', insufficient_technical_fit: 'Fit técnico insuficiente', insufficient_business_fit: 'Fit de negocio insuficiente', industry: 'Industria', company: 'Empresa', location: 'Ubicación', compensation: 'Compensación', employment_type: 'Tipo de contrato', work_environment: 'Entorno de trabajo', repetitive_work: 'Trabajo repetitivo', low_interest: 'Poco interés', other: 'Otro' };
// Mapea un valor a su etiqueta en castellano. Si no está en el mapa, usa el fallback (o el valor tal cual).
function lbl(map, key, fb) { if (key != null && map[key]) return map[key]; return fb !== undefined ? fb : (key == null ? '' : String(key)); }
function reasonLabel(k) { return lbl(REASON_LABELS, k, titleCase(String(k || '').replace(/_/g, ' '))); }

/* ---------- LinkedIn del usuario (configuracion publica local) ---------- */
async function copyUserLinkedinLink(btn) {
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  let ok = false;
  // 1) Preferimos el Clipboard API (contexto seguro + gesto del usuario).
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(state.userConfig.linkedinUrl);
      ok = true;
    }
  } catch (e) {
    ok = false; // permiso denegado / no disponible: probamos el fallback.
  }
  // 2) Fallback execCommand('copy') si el Clipboard API no existe o fue rechazado.
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = state.userConfig.linkedinUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {
      ok = false;
    }
  }
  if (ok) {
    btn.textContent = '¡Enlace copiado!';
    btn.classList.add('copied');
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1600);
  } else {
    toast('No se pudo copiar el enlace', true);
  }
}

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError) {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- data ---------- */
async function loadAll() {
  try {
    const [{ jobs }, { reasons }] = await Promise.all([api('/api/jobs'), api('/api/reasons')]);
    state.jobs = jobs || [];
    state.reasons = reasons || [];
    renderFilters();
    renderList();
  } catch (e) {
    toast('No se pudieron cargar las ofertas: ' + e.message, true);
  }
}

async function loadUserConfig() {
  try {
    state.userConfig = await api('/api/user-config');
    const link = el('userLinkedinLink');
    const copyBtn = el('copyLinkedinBtn');
    link.href = state.userConfig.linkedinUrl;
    link.textContent = `LinkedIn de ${state.userConfig.name} ↗`;
    link.hidden = false;
    copyBtn.hidden = false;
  } catch (_) {
    // Un clon sin configurar sigue mostrando la UI y ofrece el setup local.
    el('setupNotice').hidden = false;
  }
}

/* ---------- LinkedIn session + hunt operativo ---------- */
const SESSION_LABELS = {
  NOT_INITIALIZED: 'No conectado', LOGIN_REQUIRED: 'Requiere login',
  AUTHENTICATED: 'Sesión activa', CHECKPOINT_REQUIRED: 'Verificación necesaria', ERROR: 'Error',
};
const HUNT_LABELS = { IDLE: 'Sin ejecutar', STARTING: 'Iniciando', RUNNING: 'Buscando oportunidades', COMPLETED: 'Completado', FAILED: 'Error' };
let huntPollTimer = null;

function renderOperations() {
  const session = state.linkedinSession || { state: 'NOT_INITIALIZED', windowOpen: false };
  const hunt = state.hunt || { status: 'IDLE' };
  el('linkedinSessionStatus').textContent = SESSION_LABELS[session.state] || 'Estado desconocido';
  el('linkedinOpenBtn').disabled = !!session.windowOpen;
  el('linkedinCloseBtn').disabled = !session.windowOpen;
  el('huntStatus').textContent = HUNT_LABELS[hunt.status] || hunt.status;
  const active = hunt.status === 'STARTING' || hunt.status === 'RUNNING';
  el('huntStartBtn').disabled = !state.setupReady || session.state !== 'AUTHENTICATED' || session.windowOpen || active;
  el('completeSetupLink').hidden = state.setupReady;
  const summary = hunt.summary;
  const summaryEl = el('huntSummary');
  if (summary && summary.discovery && summary.analysis) {
    summaryEl.textContent = `${summary.discovery.uniqueResults || 0} encontradas · ${summary.discovery.newJobs || 0} nuevas · ${summary.analysis.analyzed || 0} analizadas`;
    summaryEl.hidden = false;
  } else {
    summaryEl.hidden = true;
  }
}

async function refreshSession() {
  state.linkedinSession = await api('/api/linkedin/session/status');
  renderOperations();
}

async function refreshHunt() {
  state.hunt = await api('/api/hunt/status');
  renderOperations();
  if (state.hunt.status === 'COMPLETED' || state.hunt.status === 'FAILED') {
    clearInterval(huntPollTimer);
    huntPollTimer = null;
    if (state.hunt.status === 'COMPLETED') loadAll();
  }
}

function startHuntPolling() {
  clearInterval(huntPollTimer);
  huntPollTimer = setInterval(() => refreshHunt().catch((e) => toast(e.message, true)), 2000);
}

async function loadOperations() {
  try {
    const [setup, session, hunt] = await Promise.all([
      api('/api/setup/status'), api('/api/linkedin/session/status'), api('/api/hunt/status'),
    ]);
    state.setupReady = !!setup.readyForHunt;
    state.linkedinSession = session;
    state.hunt = hunt;
    renderOperations();
    if (hunt.status === 'STARTING' || hunt.status === 'RUNNING') startHuntPolling();
  } catch (e) { toast('No se pudo cargar el estado operativo: ' + e.message, true); }
}

async function openLinkedinSession() {
  try {
    state.linkedinSession = await api('/api/linkedin/session/open', 'POST');
    renderOperations();
    toast('Se abrió LinkedIn. Iniciá sesión manualmente y luego verificá la sesión.');
  } catch (e) { toast(e.message, true); }
}

async function closeLinkedinSession() {
  try { state.linkedinSession = await api('/api/linkedin/session/close', 'POST'); renderOperations(); }
  catch (e) { toast(e.message, true); }
}

async function startHunt() {
  try {
    state.hunt = await api('/api/hunt', 'POST');
    renderOperations();
    startHuntPolling();
  } catch (e) { toast(e.message, true); }
}

function currentView() {
  let list = L.filterJobs(state.jobs, state.filters);
  list = L.sortJobs(list, state.sort);
  return list;
}

/* ---------- filters render ---------- */
// Orden de navegación: Bandeja (pendientes, por defecto) primero; luego las vistas de consulta.
// Priority se conserva al final (no es una decisión que saque del Inbox, pero sigue siendo consultable).
const STATUSES = ['inbox', 'all', 'new', 'read', 'interested', 'applied', 'discarded', 'priority'];
function renderFilters() {
  const counts = L.countByStatus(state.jobs);
  el('statusFilter').innerHTML = STATUSES.map((s) => {
    const label = lbl(FILTER_LABELS, s, titleCase(s));
    const active = state.filters.status === s ? ' active' : '';
    return `<button class="status-pill${active}" data-status="${s}">${label}<span class="count">${counts[s] ?? 0}</span></button>`;
  }).join('');
  el('statusFilter').querySelectorAll('.status-pill').forEach((b) =>
    b.addEventListener('click', () => { state.filters.status = b.dataset.status; renderFilters(); renderList(); }));

  const fams = L.deriveFamilies(state.jobs);
  const famBox = el('familyFilter');
  if (!fams.length) famBox.innerHTML = '<span class="chip muted">sin familias</span>';
  else famBox.innerHTML = fams.map((f) => `<button class="chip${state.filters.families.includes(f) ? ' active' : ''}" data-fam="${esc(f)}">${esc(f)}</button>`).join('');
  famBox.querySelectorAll('.chip[data-fam]').forEach((c) => c.addEventListener('click', () => {
    const f = c.dataset.fam;
    const i = state.filters.families.indexOf(f);
    if (i >= 0) state.filters.families.splice(i, 1); else state.filters.families.push(f);
    renderFilters(); renderList();
  }));

  const queries = L.deriveQueries(state.jobs);
  const qSel = el('queryFilter');
  const cur = state.filters.matchedQuery;
  qSel.innerHTML = '<option value="">Todas las búsquedas</option>' + queries.map((q) => `<option value="${esc(q)}">${esc(q)}</option>`).join('');
  qSel.value = cur;
}

/* ---------- job list ---------- */
function jobItemHtml(job) {
  const v = L.listItemView(job);
  const unread = v.status === 'new' ? ' unread' : '';
  const selected = v.jobId === state.selectedId ? ' selected' : '';
  const sc = v.overall == null ? '—' : v.overall;
  const sub = [v.company || 'Empresa no informada', v.location || ''].filter(Boolean).join(' · ');
  const ai = v.aiDecision || 'none';
  return `<li class="job-item${unread}${selected}" data-id="${esc(v.jobId)}">
    <div class="score-badge ${scoreClass(v.overall)}">${sc}</div>
    <div class="job-main">
      <div class="job-title">${esc(v.title || 'Sin título')}</div>
      <div class="job-sub">${esc(sub)}</div>
      <div class="job-tags">
        <span class="badge ai-${ai}">${v.aiDecision ? esc(lbl(DECISION_LABELS, v.aiDecision, v.aiDecision)) : 'IA —'}</span>
        <span class="status-chip st-${v.status}">${esc(lbl(STATUS_LABELS, v.status, titleCase(v.status)))}</span>
        ${v.easyApply ? '<span class="badge easy">Easy Apply</span>' : ''}
        <span class="muted small">${fmtDate(v.firstSeenAt)}</span>
      </div>
    </div>
  </li>`;
}
function renderList() {
  const list = currentView();
  el('listCount').textContent = list.length;
  const box = el('jobList');
  if (!state.jobs.length) { box.innerHTML = '<li class="empty" style="padding:24px">No hay ofertas almacenadas todavía.</li>'; return; }
  if (!list.length) { box.innerHTML = '<li class="empty" style="padding:24px">Ninguna oferta coincide con los filtros.</li>'; return; }
  box.innerHTML = list.map(jobItemHtml).join('');
  box.querySelectorAll('.job-item').forEach((li) => li.addEventListener('click', () => selectJob(li.dataset.id)));
}

/* ---------- detail ---------- */
async function selectJob(jobId) {
  state.selectedId = jobId;
  document.body.classList.add('detail-open');
  try {
    let { job, calibration } = await api('/api/job/' + encodeURIComponent(jobId));
    // Auto-read SOLO al abrir y SOLO si está 'new' (no pisa interested/discarded).
    if (job.userState.status === 'new') {
      const r = await api('/api/job/' + encodeURIComponent(jobId) + '/read', 'POST', {});
      job = r.job; calibration = r.calibration;
    }
    upsertLocal(job);
    renderDetail(job, calibration);
    renderList();
    renderFilters();
  } catch (e) {
    toast('No se pudo abrir la oferta: ' + e.message, true);
  }
}

function upsertLocal(job) {
  const i = state.jobs.findIndex((j) => j.jobId === job.jobId);
  if (i >= 0) state.jobs[i] = job; else state.jobs.push(job);
}

function listSection(title, arr, opts) {
  if (!arr || !arr.length) return '';
  const cls = opts && opts.critical ? ' critical' : '';
  return `<div class="section${cls}"><h2>${esc(title)}</h2><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}

function scoreCard(label, val) {
  const has = typeof val === 'number';
  return `<div class="score-card"><div class="val">${has ? val : '—'}</div><div class="lbl">${label}</div><div class="meter"><span style="width:${has ? val : 0}%"></span></div></div>`;
}

function disagreementHtml(job, cal) {
  const ai = job.aiAnalysis && job.aiAnalysis.decision;
  const st = job.userState.status;
  const positive = ['interested', 'applied', 'priority'];
  let msg = null;
  if ((ai === 'YES' || ai === 'MAYBE') && st === 'discarded') msg = `La IA recomendó esta oportunidad (<strong>${esc(lbl(DECISION_LABELS, ai, ai))}</strong>), pero la descartaste.`;
  else if (ai === 'NO' && positive.includes(st)) msg = `La IA no la recomendó (<strong>NO</strong>), pero la marcaste como <strong>${esc(lbl(STATUS_LABELS, st, titleCase(st)))}</strong>.`;
  if (!msg) return '';
  const reasons = job.feedback && job.feedback.reasons && job.feedback.reasons.length ? `<div>Motivo: ${esc(job.feedback.reasons.map(reasonLabel).join(', '))}</div>` : '';
  const sig = cal && cal.calibrationSignal && cal.calibrationSignal !== 'unknown' ? `<div class="small muted">calibración: ${esc(lbl(SIGNAL_LABELS, cal.calibrationSignal, cal.calibrationSignal))}</div>` : '';
  return `<div class="disagreement">${msg}${reasons}${sig}</div>`;
}

function feedbackHistoryHtml(job) {
  const ev = job.feedbackEvents || [];
  if (!ev.length) return '<div class="section"><h2>HISTORIAL DE FEEDBACK</h2><p class="muted small">Sin feedback todavía.</p></div>';
  const items = ev.slice().reverse().map((e) => {
    const reasons = e.reasons && e.reasons.length ? `<div class="fe-reasons">Motivos: ${esc(e.reasons.map(reasonLabel).join(', '))}</div>` : '';
    const comment = e.comment ? `<div>“${esc(e.comment)}”</div>` : '';
    return `<div class="feedback-event type-${esc(e.type)}"><div class="fe-head">${esc(lbl(STATUS_LABELS, e.type, titleCase(e.type)))} · <span class="muted small">${fmtDate(e.createdAt)}</span></div>${reasons}${comment}</div>`;
  }).join('');
  return `<div class="section"><h2>HISTORIAL DE FEEDBACK</h2>${items}</div>`;
}

/* Diagnóstico estructurado (requirementAssessments + coreCapabilityCoverage) — solo lectura del aiAnalysis. */
function diagnosisHtml(a) {
  let html = '';
  const ra = a.requirementAssessments || [];
  if (ra.length) {
    html += '<div class="section"><h2>EVALUACIÓN DE REQUISITOS</h2><ul class="assess-list">' +
      ra.map((r) => `<li><span class="cls-badge cls-${esc(r.classification)}">${esc(lbl(CLASSIFICATION_LABELS, r.classification, r.classification))}</span> <span class="assess-req">${esc(r.requirement)}</span>${r.note ? `<div class="assess-note muted small">${esc(r.note)}</div>` : ''}</li>`).join('') +
      '</ul></div>';
  }
  const cc = a.coreCapabilityCoverage || [];
  if (cc.length) {
    html += '<div class="section"><h2>COBERTURA DE CAPACIDADES CENTRALES</h2><ul class="assess-list">' +
      cc.map((c) => `<li><span class="rate-badge rate-${esc(c.rating)}">${esc(lbl(RATING_LABELS, c.rating, c.rating))}</span> <span class="assess-req">${esc(c.capability)}</span>${c.note ? `<div class="assess-note muted small">${esc(c.note)}</div>` : ''}</li>`).join('') +
      '</ul></div>';
  }
  return html;
}

function renderDetail(job, cal) {
  el('detailEmpty').hidden = true;
  const c = el('detailContent');
  c.hidden = false;
  const a = job.aiAnalysis || {};
  const meta = [job.employmentType, job.workplaceType, job.seniority].filter(Boolean).map((m) => `<span class="dot">${esc(m)}</span>`).join('');
  const easy = job.easyApply ? '<span class="badge easy">Easy Apply</span>' : '';
  const aiBadge = `<span class="badge ai-${a.decision || 'none'}">IA: ${a.decision ? esc(lbl(DECISION_LABELS, a.decision, a.decision)) : '—'}</span>`;
  const stBadge = `<span class="status-chip st-${job.userState.status}">Usuario: ${esc(lbl(STATUS_LABELS, job.userState.status, titleCase(job.userState.status)))}</span>`;

  const found = (job.matchedQueries || []).length ? `<div class="section"><h2>ENCONTRADA A TRAVÉS DE</h2><div class="tag-list">${job.matchedQueries.map((q) => `<span class="chip muted">${esc(q)}</span>`).join('')}</div></div>` : '';
  const fams = (job.matchedFamilies || []).length ? `<div class="section"><h2>FAMILIAS DE ROL</h2><div class="tag-list">${job.matchedFamilies.map((f) => `<span class="chip muted">${esc(f)}</span>`).join('')}</div></div>` : '';

  c.innerHTML = `
    <div class="detail-head">
      <h1>${esc(job.title || 'Sin título')}</h1>
      <div class="detail-company">${esc(job.company || 'Empresa no informada')}</div>
      <div class="meta-line">${job.location ? `<span>${esc(job.location)}</span>` : ''}${meta}</div>
      <div class="head-badges">${aiBadge}${stBadge}${easy}
        ${job.url ? `<a class="btn small" href="${esc(job.url)}" target="_blank" rel="noopener">Abrir en LinkedIn ↗</a>` : ''}
      </div>
    </div>

    <div class="actions">
      <button class="btn primary" data-act="interested">✓ Me interesa</button>
      <button class="btn danger" data-act="discard">❌ Descartar</button>
      <button class="btn" data-act="read">👁 Marcar leída</button>
      <button class="btn" data-act="applied">📩 Apliqué</button>
      <button class="btn" data-act="priority">⭐ Prioridad</button>
    </div>

    ${disagreementHtml(job, cal)}

    <div class="scores">
      ${scoreCard('General', a.overallMatchScore)}
      ${scoreCard('Profesional', a.professionalFitScore)}
      ${scoreCard('Interés', a.interestFitScore)}
      ${scoreCard('CV', a.cvFitScore)}
      ${scoreCard('Confianza', a.confidence)}
    </div>

    ${a.summary ? `<div class="section"><h2>RESUMEN</h2><p>${esc(a.summary)}</p></div>` : ''}
    ${diagnosisHtml(a)}
    ${listSection('POR QUÉ ENCAJA', a.whyItFits)}
    ${listSection('EXPERIENCIA TRANSFERIBLE', a.transferableExperience)}
    ${listSection('BRECHAS', a.gaps)}
    ${listSection('REQUISITOS CRÍTICOS NO CUMPLIDOS', a.criticalRequirementsUnmet, { critical: true })}
    ${listSection('SEÑALES DE ALERTA', a.redFlags, { critical: true })}
    ${a.reasoning ? `<div class="section"><h2>RAZONAMIENTO</h2><p class="reasoning">${esc(a.reasoning)}</p></div>` : ''}
    ${!job.aiAnalysis ? '<div class="section"><h2>ANÁLISIS DE IA</h2><p class="muted small">Esta oferta todavía no tiene análisis de OpenAI.</p></div>' : ''}

    ${found}${fams}

    <div class="section"><h2>DESCRIPCIÓN DE LA OFERTA</h2><div class="description">${esc(job.description || 'Sin descripción disponible.')}</div></div>

    ${feedbackHistoryHtml(job)}
  `;

  c.querySelectorAll('.actions [data-act]').forEach((b) => b.addEventListener('click', () => onAction(job.jobId, b.dataset.act)));
}

/* ---------- actions ---------- */
async function onAction(jobId, act) {
  if (act === 'discard') return openDiscardModal(jobId);
  try {
    const { job, calibration } = await api('/api/job/' + encodeURIComponent(jobId) + '/' + act, 'POST', {});
    upsertLocal(job);
    renderDetail(job, calibration);
    renderList(); renderFilters();
    toast('Estado actualizado: ' + lbl(STATUS_LABELS, job.userState.status, titleCase(job.userState.status)));
  } catch (e) {
    toast('No se pudo actualizar: ' + e.message, true);
  }
}

/* ---------- discard modal ---------- */
let discardTargetId = null;
function openDiscardModal(jobId) {
  discardTargetId = jobId;
  el('discardReasons').innerHTML = state.reasons.map((r) =>
    `<label><input type="checkbox" value="${esc(r.key)}" /> ${esc(reasonLabel(r.key))} <span class="muted small">(${esc(lbl(DIMENSION_LABELS, r.dimension, r.dimension))})</span></label>`).join('');
  el('discardComment').value = '';
  el('discardModal').hidden = false;
}
function closeDiscardModal() { el('discardModal').hidden = true; discardTargetId = null; }
async function confirmDiscard() {
  const reasons = Array.from(el('discardReasons').querySelectorAll('input:checked')).map((i) => i.value);
  const comment = el('discardComment').value.trim() || null;
  try {
    const { job, calibration } = await api('/api/job/' + encodeURIComponent(discardTargetId) + '/discard', 'POST', { reasons, comment });
    upsertLocal(job);
    closeDiscardModal();
    renderDetail(job, calibration);
    renderList(); renderFilters();
    toast('Oferta descartada');
  } catch (e) {
    toast('No se pudo descartar: ' + e.message, true);
  }
}

/* ---------- diagnostics ---------- */
async function openDiagnostics() {
  el('diagPanel').hidden = false;
  try {
    const [lp, cal] = await Promise.all([api('/api/learned-preferences'), api('/api/calibration')]);
    const prefs = lp.preferences || [];
    el('learnedPrefs').innerHTML = prefs.length
      ? prefs.map((p) => `<div class="pref tier-${esc(p.tier)}"><div class="pref-key">${esc(reasonLabel(p.key))}</div><div class="pref-meta">${esc(lbl(DIRECTION_LABELS, p.direction, p.direction))} · ${p.count} señales · ${esc(lbl(DIMENSION_LABELS, p.dimension, p.dimension))} · nivel ${esc(lbl(TIER_LABELS, p.tier, p.tier))} · confianza ${esc(lbl(CONFIDENCE_LABELS, p.confidence, p.confidence))}</div></div>`).join('')
      : '<p class="muted small">Sin preferencias aprendidas todavía.</p>';
    const cals = cal.calibrations || [];
    el('calibration').innerHTML = cals.length
      ? cals.map((c) => `<div class="pref"><div class="pref-key">${esc(c.jobId)}</div><div class="pref-meta">IA ${esc(lbl(DECISION_LABELS, c.aiDecision, c.aiDecision))} vs usuario ${esc(lbl(STATUS_LABELS, c.userStatus, c.userStatus))} → <strong>${esc(lbl(SIGNAL_LABELS, c.calibrationSignal, c.calibrationSignal))}</strong>${c.reasons && c.reasons.length ? ' · ' + esc(c.reasons.map(reasonLabel).join(', ')) : ''}</div></div>`).join('')
      : '<p class="muted small">Sin señales de calibración todavía.</p>';
  } catch (e) {
    toast('No se pudieron cargar los diagnósticos: ' + e.message, true);
  }
}

/* ---------- wire up ---------- */
function init() {
  el('globalSearch').addEventListener('input', (e) => { state.filters.search = e.target.value; renderList(); });
  el('sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
  el('aiDecisionFilter').addEventListener('change', (e) => { state.filters.aiDecision = e.target.value; renderList(); });
  el('easyApplyFilter').addEventListener('change', (e) => { state.filters.easyApply = e.target.value; renderList(); });
  el('scoreFilter').addEventListener('change', (e) => { state.filters.minScore = Number(e.target.value); renderList(); });
  el('companyFilter').addEventListener('input', (e) => { state.filters.company = e.target.value; renderList(); });
  el('queryFilter').addEventListener('change', (e) => { state.filters.matchedQuery = e.target.value; renderList(); });

  el('discardCancel').addEventListener('click', closeDiscardModal);
  el('discardConfirm').addEventListener('click', confirmDiscard);
  el('discardModal').addEventListener('click', (e) => { if (e.target.id === 'discardModal') closeDiscardModal(); });

  const copyBtn = el('copyLinkedinBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => copyUserLinkedinLink(copyBtn));

  el('diagBtn').addEventListener('click', openDiagnostics);
  el('diagClose').addEventListener('click', () => { el('diagPanel').hidden = true; });
  el('diagPanel').addEventListener('click', (e) => { if (e.target.id === 'diagPanel') el('diagPanel').hidden = true; });

  el('linkedinOpenBtn').addEventListener('click', openLinkedinSession);
  el('linkedinVerifyBtn').addEventListener('click', () => refreshSession().catch((e) => toast(e.message, true)));
  el('linkedinCloseBtn').addEventListener('click', closeLinkedinSession);
  el('huntStartBtn').addEventListener('click', startHunt);

  loadAll();
  loadUserConfig();
  loadOperations();
}
document.addEventListener('DOMContentLoaded', init);
