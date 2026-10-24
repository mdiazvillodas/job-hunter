'use strict';
(() => {
  const button = document.getElementById('manualHuntBtn');
  const status = document.getElementById('manualHuntStatus');
  let timer, runId;
  async function refresh() {
    try {
      const response = await fetch('/api/hunt');
      if (!response.ok) throw Error('No se pudo consultar la búsqueda');
      const state = await response.json();
      button.disabled = state.busy;
      if (state.busy) { runId = state.currentRunId || runId; status.textContent = 'Búsqueda en curso'; timer = setTimeout(refresh, 5000); }
      else if (timer) {
        timer = undefined;
        let details = '';
        if (runId) {
          const finished = await fetch('/api/hunt/run/' + encodeURIComponent(runId));
          if (finished.ok) {
            const result = await finished.json();
            details = Object.values(result.summary?.sources || {}).map(s => s.label + ': ' + (s.status === 'failed' ? 'falló' : s.status === 'interrupted' ? 'interrumpido' : (s.discovery?.uniqueResults || 0) + ' ofertas, ' + (s.analysis?.analyzed || 0) + ' analizadas')).join(' · ');
            if (!details && result.status === 'failed') details = 'La búsqueda falló';
          }
        }
        status.textContent = 'Búsqueda finalizada. ' + details + '. Actualizá la lista para ver el resultado.';
      }
    } catch (error) { status.textContent = error.message; }
  }
  button.addEventListener('click', async () => {
    button.disabled = true; status.textContent = 'Iniciando búsqueda…';
    try {
      const response = await fetch('/api/hunt', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw Error(result.error === 'hunt_already_running' ? 'Ya hay una búsqueda o conexión abierta' : result.error || 'No se pudo iniciar');
      runId = result.runId;
      status.textContent = 'Búsqueda en curso';
      clearTimeout(timer); timer = setTimeout(refresh, 1000);
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  });
  refresh();
})();
