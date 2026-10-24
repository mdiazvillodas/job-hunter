/* Shared plain presentation model. Classification is the model opinion, not proof. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProfilePresentation = factory();
})(typeof window === 'undefined' ? globalThis : window, function() {
  function present(analysis) {
    const provenance = analysis.profileProvenance;
    return (analysis.requirementAssessments || []).map((item, index) => {
      const source = provenance?.version === 1 ? provenance.requirements?.[index]?.source : null;
      let category, message;
      if (item.classification === 'NOT_EVIDENCED') {
        category = 'unknown'; message = 'No documentado en el perfil recibido. No implica que no tengas esa experiencia.';
      } else if (['TRANSFERABLE_MATCH', 'SCALE_STRETCH'].includes(item.classification)) {
        category = 'inference'; message = 'La IA propone una posible transferencia profesional. Es una inferencia: no acredita experiencia previa en este requisito.';
      } else {
        category = 'inference'; message = 'La IA propone ' + (['CLEAR_GAP', 'CRITICAL_GAP'].includes(item.classification)
          ? 'una posible brecha que requiere revisión; no se afirma ausencia de experiencia.'
          : 'un posible encaje que requiere revisión; no acredita por sí solo este requisito.');
      }
      return { requirement: item.requirement, category, message,
        source: source || null,
        sourceMessage: source ? 'Texto documentado en el perfil al analizar. Su relación con el requisito no está comprobada.' : 'Sin referencia verificable al perfil. Revisá el fundamento antes de usar esta recomendación.' };
    });
  }
  return { present };
});
