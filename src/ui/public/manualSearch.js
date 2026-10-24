'use strict';
(() => {
  const button = document.getElementById('manualHuntBtn');
  const status = document.getElementById('manualHuntStatus');
  let timer, runId;
  function activity(mode){
    const bar=document.getElementById('huntActivity');
    if(bar){bar.hidden=mode==='idle';bar.setAttribute?.('data-state',mode);}
    button.setAttribute?.('aria-busy',String(mode==='busy'));
    button.textContent=mode==='busy'?'Buscando…':'Buscar ofertas';
  }
  async function refresh() {
    try {
      const response = await window.SessionApi.request('/api/hunt');
      if (!response.ok) throw Error('No se pudo consultar la búsqueda');
      const state = await response.json();
      button.disabled = state.busy;
      activity(state.busy?(state.huntRunning?'busy':'occupied'):'idle');
      if (state.busy) { runId = state.currentRunId || runId; status.textContent = state.huntRunning ? 'Búsqueda en curso' : 'Instancia ocupada por una búsqueda o conexión manual'; timer = setTimeout(refresh, 5000); }
      else if (timer) {
        timer = undefined;
        let details = '';
        if (runId) {
          const finished = await window.SessionApi.request('/api/hunt/run/' + encodeURIComponent(runId));
          if (finished.ok) {
            const result = await finished.json();
            details = Object.values(result.summary?.sources || {}).map(s => s.label + ': ' + (s.status === 'failed' ? 'falló' : s.status === 'interrupted' ? 'interrumpido' : (s.discovery?.uniqueResults || 0) + ' ofertas, ' + (s.analysis?.analyzed || 0) + ' analizadas')).join(' · ');
            if (!details && result.status === 'failed') details = 'La búsqueda falló';
          }
        }
        status.textContent = runId ? 'Búsqueda finalizada. ' + details : 'Instancia disponible.';
        activity('complete'); window.dispatchEvent(new Event('hunt-finished')); runId = undefined;
      }
    } catch (error) { activity('error'); status.textContent = error.message + ' Volviendo a comprobar…'; timer = setTimeout(refresh, 10000); }
  }
  button.addEventListener('click', async () => {
    button.disabled = true; activity('busy'); status.textContent = 'Iniciando búsqueda…';
    try {
      const response = await window.SessionApi.request('/api/hunt', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw Error(result.error === 'hunt_already_running' ? 'Ya hay una búsqueda o conexión abierta' : result.error || 'No se pudo iniciar');
      runId = result.runId;
      status.textContent = 'Búsqueda en curso';
      clearTimeout(timer); timer = setTimeout(refresh, 1000);
    } catch (error) { activity('error'); status.textContent = error.message; button.disabled = false; }
  });
  refresh();
})();
