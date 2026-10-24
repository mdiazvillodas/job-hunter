'use strict';
(() => {
  const button = document.getElementById('manualHuntBtn');
  const status = document.getElementById('manualHuntStatus');
  let timer;
  async function refresh() {
    try {
      const response = await fetch('/api/hunt');
      if (!response.ok) throw Error('No se pudo consultar la búsqueda');
      const state = await response.json();
      button.disabled = state.busy;
      if (state.busy) { status.textContent = 'Búsqueda en curso'; timer = setTimeout(refresh, 5000); }
      else if (timer) { status.textContent = 'Búsqueda finalizada. Actualizá la lista para ver el resultado.'; timer = undefined; }
    } catch (error) { status.textContent = error.message; }
  }
  button.addEventListener('click', async () => {
    button.disabled = true; status.textContent = 'Iniciando búsqueda…';
    try {
      const response = await fetch('/api/hunt', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw Error(result.error === 'hunt_already_running' ? 'Ya hay una búsqueda o conexión abierta' : result.error || 'No se pudo iniciar');
      status.textContent = 'Búsqueda en curso';
      clearTimeout(timer); timer = setTimeout(refresh, 1000);
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  });
  refresh();
})();
