// Usamos el módulo nativo de Playwright para garantizar compatibilidad con el Chrome comercial
const { chromium } = require('playwright');
const { HEADLESS } = require('../config');

/**
 * Lanza una instancia comercial y persistente de Chromium para InfoJobs sin dejar huellas de bot
 * @param {string} profileDir - Ruta del perfil de usuario
 */
async function launchInfoJobsBrowser(profileDir) {
  const contextOptions = {
    headless: ['true', 'false'].includes(process.env.INFOJOBS_HEADLESS)
      ? process.env.INFOJOBS_HEADLESS === 'true' : HEADLESS,
    ...(process.platform === 'win32' ? { channel: 'chrome' } : {
      executablePath: process.env.INFOJOBS_CHROME_EXECUTABLE || '/usr/bin/google-chrome-stable',
    }), // Chrome oficial también en Oracle; sin fallback silencioso a Chromium.
    viewport: null,
    
    // Parámetros regionales esenciales para evitar discrepancias de geolocalización en InfoJobs España
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    
    // CRÍTICO: Forzamos el User-Agent idéntico al de un usuario humano común en Windows
    ...(process.platform === 'win32' ? {userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'} : {}),
    
    // Argumentos nativos para remover barras de control y firmas de automatización
    args: [
      '--disable-blink-features=AutomationControlled', // Esconde la bandera interna de automatización
      '--start-maximized',                              // Simula el comportamiento de pantalla de un humano
      '--no-sandbox',
      '--disable-infobars',                             // Quita la barra de aviso de control remoto
      ...(process.platform === 'linux' && process.env.DISPLAY ? ['--window-size=1440,900'] : []),
    ],
    // Ignora los valores por defecto de la API que delatan a Playwright automáticamente
    ignoreDefaultArgs: ['--enable-automation'],
  };

  const context = await chromium.launchPersistentContext(profileDir, contextOptions);

  // Evasión profunda en tiempo de ejecución modificando variables críticas de JavaScript
  await context.addInitScript(() => {
    // Borra el rastro de navigator.webdriver para que devuelva undefined (comportamiento humano)
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    // Simula las variables internas del ecosistema Chrome de un usuario común
    window.chrome = { runtime: {} };
  });

  return context;
}

module.exports = {
  launchInfoJobsBrowser,
};
