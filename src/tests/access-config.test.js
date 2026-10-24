'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { configuration, writeConfiguration } = require('../../scripts/oracle/access-config');
const users = { users: { mariano: { displayname: 'Mariano', password: '$argon2id$synthetic' }, mariana: { displayname: 'Mariana', password: '$argon2id$synthetic' } } };
const options = { host: 'hunter.example.com', authHost: 'auth.hunter.example.com', port: 18443, internalTLS: true };
test('acceso: usuarios separados, bloqueo temporal y sesiones con caducidad', () => {
  const { config, caddy } = configuration(options, users);
  assert.equal(config.access_control.default_policy, 'deny');
  assert.deepEqual(config.access_control.rules[0].subject, ['user:mariano', 'user:mariana']);
  assert.equal(config.regulation.max_retries, 5); assert.equal(config.regulation.ban_time, '15m');
  assert.equal(config.session.cookies[0].authelia_url, 'https://auth.hunter.example.com:18443');
  assert.equal(config.session.remember_me, -1);
  assert(caddy.includes('request_header -Remote-User')); assert(caddy.indexOf('forward_auth') < caddy.indexOf('@mariano'));
  assert(caddy.includes('not header Origin https://hunter.example.com:18443'));
  assert(caddy.includes('bind 127.0.0.1')); assert(caddy.includes('127.0.0.1:46773')); assert(caddy.includes('127.0.0.1:46783'));
});
test('acceso: rechaza nombres inyectados, usuarios adicionales y contraseñas sin hash', () => {
  for (const patch of [{ host: 'x\nrespond 200' }, { authHost: 'auth.other.com' }, { port: 22 }]) assert.throws(() => configuration({ ...options, ...patch }, users));
  assert.throws(() => configuration(options, { users: { ...users.users, admin: users.users.mariano } }));
  assert.throws(() => configuration(options, { users: { ...users.users, mariano: { password: 'plaintext' } } }));
});
test('acceso: secretos nuevos y escritura que nunca reemplaza una instalación', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-access-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.notEqual(configuration(options, users).config.session.secret, configuration(options, users).config.session.secret);
  const target = path.join(dir, 'private'); writeConfiguration(target, options, users);
  assert.throws(() => writeConfiguration(target, options, users));
});
