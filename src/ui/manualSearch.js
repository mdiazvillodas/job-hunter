'use strict';
// Reuses the existing asynchronous runner and shared hunt lock; never starts on GET.
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { createServer } = require('../trigger/server');
function createManualSearch(options = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const root = options.projectRoot || path.resolve(__dirname, '../..');
  const runner = createServer({ ...options, token, projectRoot: root, spawnHunt: options.spawnHunt || (() => {
    const env = { ...process.env };
    // Reload settings from the instance .env in the child, as the scheduler does.
    for (const key of ['OPENAI_API_KEY', 'ANALYZE_LIMIT', 'INFOJOBS_ANALYZE_LIMIT', 'HEADLESS']) delete env[key];
    for(const key of Object.keys(env))if(/^(NTFY_|TELEGRAM_)/.test(key))delete env[key];
    return spawn(process.execPath, [path.join(root, 'src/hunt.js')], { cwd: root, shell: false, env, windowsHide: true });
  }) });
  const handle = function(req, res, url) {
    if (!url.pathname.startsWith('/api/hunt')) return false;
    const routes = { 'GET /api/hunt': '/health', 'POST /api/hunt': '/run', 'GET /api/hunt/runs': '/runs' };
    const target = routes[req.method + ' ' + url.pathname] || (req.method === 'GET' && /^\/api\/hunt\/run\/run_[A-Za-z0-9]+$/.test(url.pathname) ? url.pathname.replace('/api/hunt', '') : null);
    if (!target) { res.writeHead(404); res.end(); return true; }
    if (req.method === 'POST' && req.headers.origin !== 'http://' + req.headers.host) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Origen inválido' })); return true;
    }
    req.url = target;
    req.headers.authorization = 'Bearer ' + token;
    runner.emit('request', req, res);
    return true;
  };
  // Telegram uses the SAME runner/lock/history as the UI. Loopback only; lazy,
  // so disabled Telegram creates neither a listener nor an additional socket.
  let localTrigger;
  handle.getTelegramTrigger = () => localTrigger || (localTrigger = new Promise((resolve,reject) => {
    runner.once('error',reject);
    runner.listen(0,'127.0.0.1',()=>resolve(require('../telegram/triggerClient').createTriggerClient({baseUrl:'http://127.0.0.1:'+runner.address().port,token})));
  }));
  handle.close = () => runner.close();
  return handle;
}
module.exports = { createManualSearch };
