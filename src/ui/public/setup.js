'use strict';

const byId = (id) => document.getElementById(id);

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

loadSetup();
