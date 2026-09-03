'use strict';

const byId = (id) => document.getElementById(id);
let currentDraft = null;

async function api(path, method, body) {
  const response = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

function renderStatus(status) {
  const basic = status.readyForProfileSetup ? 'Configuración básica completa.' : 'Configuración básica pendiente.';
  const profiles = status.readyForHunt ? 'Perfiles listos para buscar.' : 'Siguiente paso: crear perfil profesional.';
  byId('setupStatus').textContent = `${basic} ${profiles}`;
  byId('profileStatus').textContent = status.profileDraft && !status.profileDraftValid
    ? 'Existe un borrador inválido. Descartalo o regenerá el perfil.'
    : status.profileDraftValid
      ? 'Generado — pendiente de confirmación'
    : status.readyForHunt ? 'Generado y confirmado' : 'Pendiente';
}

function listText(value) {
  return Array.isArray(value) && value.length ? value.map((item) => `• ${item}`).join('\n') : 'No evidenciado';
}

function renderDraft(draft) {
  currentDraft = draft;
  const summary = draft.summary;
  byId('previewPositioning').textContent = summary.positioning || 'No evidenciado';
  byId('previewRoles').textContent = listText(summary.targetRoles);
  byId('previewCapabilities').textContent = listText(summary.capabilities);
  byId('previewExperience').textContent = listText(summary.experience);
  byId('previewSeniority').textContent = summary.seniority || 'No evidenciado';
  byId('previewStrengths').textContent = listText(summary.strengths);
  byId('previewUnknowns').textContent = listText(summary.notEvidenced);
  byId('previewPreferences').textContent = listText(summary.preferences);
  byId('previewAvoid').textContent = listText(summary.rolesToAvoid);
  byId('profileTechnicalDetail').textContent = JSON.stringify({
    careerContext: draft.careerContext,
    profile: draft.profile,
    matchingProfile: draft.matchingProfile,
    metadata: draft.metadata,
  }, null, 2);
  byId('profilePreview').hidden = false;
  byId('discardDraft').hidden = false;
  byId('generateProfile').textContent = 'Regenerar perfil';
  byId('profileStatus').textContent = 'Generado — pendiente de confirmación';
}

async function loadSetup() {
  try {
    const [editable, status] = await Promise.all([api('/api/setup'), api('/api/setup/status')]);
    byId('name').value = editable.name || '';
    byId('linkedinUrl').value = editable.linkedinUrl || '';
    byId('location').value = editable.location || '';
    byId('queries').value = (editable.queries || []).join('\n');
    document.querySelectorAll('[name="modality"]').forEach((box) => { box.checked = (editable.modalities || []).includes(box.value); });
    if (editable.openAiKeyConfigured) {
      byId('openAiKey').placeholder = 'Configurada — dejar vacío para conservar';
    }
    renderStatus(status);
    if (status.profileDraftValid) renderDraft(await api('/api/setup/profile/draft'));
    if (status.profileDraft && !status.profileDraftValid) byId('discardDraft').hidden = false;
  } catch (error) {
    byId('setupMessage').textContent = error.message;
    byId('setupMessage').className = 'setup-message error';
  }
}

byId('setupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = byId('setupMessage');
  message.textContent = 'Guardando…';
  message.className = 'setup-message';
  const userConfig = {
    name: byId('name').value,
    linkedinUrl: byId('linkedinUrl').value,
    location: byId('location').value,
    queries: byId('queries').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    modalities: Array.from(document.querySelectorAll('[name="modality"]:checked')).map((box) => box.value),
  };
  try {
    await api('/api/setup/user-config', 'PUT', userConfig);
    await api('/api/setup/openai-key', 'PUT', { openAiKey: byId('openAiKey').value });
    byId('openAiKey').value = '';
    message.textContent = 'Configuración guardada.';
    const status = await api('/api/setup/status');
    renderStatus(status);
    if (status.openAiKey) byId('openAiKey').placeholder = 'Configurada — dejar vacío para conservar';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'setup-message error';
  }
});

byId('generateProfile').addEventListener('click', async () => {
  const button = byId('generateProfile');
  const message = byId('profileMessage');
  button.disabled = true;
  message.className = 'setup-message';
  message.textContent = 'Generando…';
  byId('profileStatus').textContent = 'Generando';
  try {
    const draft = await api('/api/setup/profile/generate', 'POST', {
      professionalText: byId('professionalText').value,
      preferencesText: byId('preferencesText').value,
    });
    renderDraft(draft);
    message.textContent = 'Borrador generado. Revisalo antes de confirmar.';
  } catch (error) {
    byId('profileStatus').textContent = currentDraft ? 'Generado — pendiente de confirmación' : 'Error';
    message.textContent = error.message;
    message.className = 'setup-message error';
  } finally {
    button.disabled = false;
  }
});

byId('confirmProfile').addEventListener('click', async () => {
  const button = byId('confirmProfile');
  const message = byId('profileMessage');
  button.disabled = true;
  try {
    await api('/api/setup/profile/confirm', 'POST');
    currentDraft = null;
    byId('profilePreview').hidden = true;
    byId('discardDraft').hidden = true;
    byId('generateProfile').textContent = 'Generar perfil';
    message.textContent = 'Perfil confirmado y listo para usar.';
    renderStatus(await api('/api/setup/status'));
  } catch (error) {
    message.textContent = error.message;
    message.className = 'setup-message error';
  } finally {
    button.disabled = false;
  }
});

byId('discardDraft').addEventListener('click', async () => {
  const message = byId('profileMessage');
  try {
    await api('/api/setup/profile/draft', 'DELETE');
    currentDraft = null;
    byId('profilePreview').hidden = true;
    byId('discardDraft').hidden = true;
    byId('generateProfile').textContent = 'Generar perfil';
    message.textContent = 'Borrador descartado. Los perfiles confirmados no cambiaron.';
    renderStatus(await api('/api/setup/status'));
  } catch (error) {
    message.textContent = error.message;
    message.className = 'setup-message error';
  }
});

loadSetup();
