'use strict';

// Prueba manual de la integracion ntfy:  npm run test:notification
//
// Envia UNA notificacion ficticia usando la configuracion real del entorno.
// NO toca ningun job, NO llama a OpenAI, NO abre Playwright, NO hace discovery.

const { getNtfyConfig, defaultSend } = require('./notifications/ntfy');

async function main() {
  const config = getNtfyConfig();

  if (!config.enabled) {
    console.error('[notify-test] NTFY_ENABLED no es "true": no se envia nada.');
    console.error('[notify-test] Configura NTFY_ENABLED=true y NTFY_TOPIC para probar.');
    process.exitCode = 1;
    return;
  }
  if (config.configError) {
    console.error('[notify-test] configuracion invalida: ' + config.configError);
    process.exitCode = 1;
    return;
  }

  const message = {
    title: 'Job Hunter - Test',
    body: 'Notification integration working',
    priority: 'high',
    click: null,
  };

  console.error(`[notify-test] POST ${config.baseUrl}/${config.topic}`);
  try {
    const res = await defaultSend(config.url, message);
    console.log(JSON.stringify({ ok: true, status: res.status, topic: config.topic }, null, 2));
    console.error('[notify-test] enviada. Revisa el iPhone.');
  } catch (err) {
    console.error('[notify-test] fallo: ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main };
