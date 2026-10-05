'use strict';

const { launchManagedBrowser, getInitialPage } = require('../linkedin/browser');

// Navegador de InfoJobs: el mismo Chromium gestionado que usa LinkedIn (el que
// prepara el instalador), con un perfil PROPIO para no mezclar cookies ni
// sesion entre plataformas. Idioma y zona horaria de España, que es donde
// opera InfoJobs. Ventana visible, igual que LinkedIn: si aparece un CAPTCHA
// la automatizacion se detiene y la persona lo ve.
// El lock del navegador lo toma quien lanza el hunt (ver src/hunt.js).
async function launchInfoJobsBrowser(profileDir) {
  return launchManagedBrowser(profileDir, { locale: 'es-ES', timezoneId: 'Europe/Madrid' });
}

module.exports = { launchInfoJobsBrowser, getInitialPage };
