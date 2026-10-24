'use strict';
// Integration test only: synthetic users/backends and an ephemeral local TLS CA.
const fs = require('fs'), path = require('path'), http = require('http'), https = require('https'), assert = require('assert/strict');
const directory = process.argv[2];
const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'test-credentials.json')));
const app = 'hunter.example.com', auth = 'auth.hunter.example.com', port = 18443;
let calls = { mariano: 0, mariana: 0 };
const servers = ['mariano', 'mariana'].map((name, i) => http.createServer((req, res) => {
  calls[name]++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ instance: name, origin: req.headers.origin, path: req.url }));
}).listen(19073 + i * 10, '127.0.0.1'));
function request(host, pathname, { method = 'GET', body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({ host: '127.0.0.1', servername: host, port, path: pathname, method,
      // Only this synthetic integration test accepts its freshly generated private CA.
      rejectUnauthorized: false,
      headers: { Host: host + ':' + port, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), Origin: 'https://' + host + ':' + port } : {}), ...headers }
    }, res => { let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text })); });
    req.setTimeout(10000, () => req.destroy(Error('request timeout'))); req.on('error', reject); req.end(data);
  });
}
async function login(username, password) {
  return request(auth, '/api/firstfactor', { method: 'POST', body: { username, password, keepMeLoggedIn: false, targetURL: 'https://' + app + ':' + port, requestMethod: 'GET' } });
}
async function main() {
  let ready = false;
  for (let i = 0; i < 30; i++) { try { if ((await request(auth, '/api/health')).status === 200) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 500)); }
  assert(ready, 'Auth portal did not become ready');
  for (const pathname of ['/', '/api/jobs', '/api/profile', '/api/settings']) {
    const r = await request(app, pathname, { headers: { 'Remote-User': 'mariana', 'X-Forwarded-For': '198.51.100.2' } });
    assert([302, 401].includes(r.status), 'Anonymous or spoofed request was accepted: ' + pathname);
  }
  assert.deepEqual(calls, { mariano: 0, mariana: 0 });
  for (const name of ['mariano', 'mariana']) {
    const logged = await login(name, credentials[name]); assert.equal(logged.status, 200, logged.text);
    const cookies = logged.headers['set-cookie'] || []; assert(cookies.some(c => /HttpOnly/i.test(c) && /Secure/i.test(c)));
    const cookie = cookies.map(c => c.split(';')[0]).join('; ');
    for (const pathname of ['/', '/api/jobs', '/api/profile', '/?user=' + (name === 'mariano' ? 'mariana' : 'mariano')]) {
      const result = await request(app, pathname, { cookie, headers: { 'Remote-User': name === 'mariano' ? 'mariana' : 'mariano' } });
      assert.equal(result.status, 200, result.text); assert.equal(JSON.parse(result.text).instance, name);
    }
    const valid = await request(app, '/api/settings', { method: 'POST', body: {}, cookie });
    assert.equal(valid.status, 200); assert.equal(JSON.parse(valid.text).origin, 'http://' + app + ':' + port);
    const before = { ...calls };
    const foreign = await request(app, '/api/settings', { method: 'POST', body: {}, cookie, headers: { Origin: 'https://foreign.example.com' } });
    assert.equal(foreign.status, 403); assert.deepEqual(calls, before);
  }
  for (let i = 0; i < 5; i++) assert.notEqual((await login('mariano', 'synthetic-wrong-password')).status, 200);
  const banned = await login('mariano', credentials.mariano); assert.notEqual(banned.status, 200, 'Correct password bypassed temporary ban');
  fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify({ anonymousDenied: true, spoofingDenied: true, userRouting: true, apisSeparated: true, foreignOriginDenied: true, secureCookies: true, fiveFailuresBan: true, backendCalls: calls, syntheticOnly: true, paidCalls: 0, realScraping: 0 }, null, 2));
  console.log('PASS: anonymous denied, two users isolated, spoofing/CSRF denied, Secure cookies, five failures temporarily banned');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => servers.forEach(s => s.close()));
