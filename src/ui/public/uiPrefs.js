/* Preferencias de UI del navegador (tema claro/oscuro). Logica pura + un par de
 * helpers de aplicacion, para poder testearla en Node sin DOM.
 * UMD: funciona en Node (require) y en el navegador (window.UiPrefs).
 * NO contiene reglas de dominio ni toca datos de ofertas. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UiPrefs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_KEY = 'jobhunter.theme';
  var LIGHT = 'light';
  var DARK = 'dark';

  function isValidTheme(value) {
    return value === LIGHT || value === DARK;
  }

  // Lee la preferencia guardada. Cualquier valor invalido o un storage inaccesible
  // (modo privado, storage deshabilitado) se tratan como "sin preferencia".
  function readStoredTheme(storage) {
    try {
      if (!storage || typeof storage.getItem !== 'function') return null;
      var raw = storage.getItem(STORAGE_KEY);
      return isValidTheme(raw) ? raw : null;
    } catch (e) {
      return null;
    }
  }

  // Guarda la preferencia. Nunca lanza: si el storage falla, la UI sigue funcionando.
  function storeTheme(storage, theme) {
    try {
      if (!storage || typeof storage.setItem !== 'function' || !isValidTheme(theme)) return false;
      storage.setItem(STORAGE_KEY, theme);
      return true;
    } catch (e) {
      return false;
    }
  }

  // La preferencia explicita del usuario gana siempre; si no hay, se usa el
  // prefers-color-scheme del sistema; si tampoco, claro.
  function resolveTheme(stored, prefersDark) {
    if (isValidTheme(stored)) return stored;
    return prefersDark ? DARK : LIGHT;
  }

  function nextTheme(current) {
    return current === DARK ? LIGHT : DARK;
  }

  // Escribe el tema en el elemento raiz. El CSS reacciona a [data-theme].
  function applyTheme(rootEl, theme) {
    if (!rootEl) return null;
    var value = isValidTheme(theme) ? theme : LIGHT;
    if (rootEl.setAttribute) rootEl.setAttribute('data-theme', value);
    return value;
  }

  function prefersDarkFrom(win) {
    try {
      return !!(win && typeof win.matchMedia === 'function'
        && win.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return false;
    }
  }

  // Conveniencia de arranque: se llama desde <head> ANTES de la hoja de estilos
  // para evitar el flash de tema incorrecto.
  function applyStoredTheme(win, doc) {
    var w = win || (typeof window !== 'undefined' ? window : null);
    var d = doc || (w && w.document) || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.documentElement) return null;
    var stored = readStoredTheme(w && w.localStorage);
    var theme = resolveTheme(stored, prefersDarkFrom(w));
    return applyTheme(d.documentElement, theme);
  }

  function currentTheme(rootEl) {
    var raw = rootEl && rootEl.getAttribute ? rootEl.getAttribute('data-theme') : null;
    return isValidTheme(raw) ? raw : LIGHT;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    LIGHT: LIGHT,
    DARK: DARK,
    isValidTheme: isValidTheme,
    readStoredTheme: readStoredTheme,
    storeTheme: storeTheme,
    resolveTheme: resolveTheme,
    nextTheme: nextTheme,
    applyTheme: applyTheme,
    prefersDarkFrom: prefersDarkFrom,
    applyStoredTheme: applyStoredTheme,
    currentTheme: currentTheme,
  };
});
