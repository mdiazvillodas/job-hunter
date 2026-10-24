'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function configuration({ host, authHost, port = 443, authPort = 49091, marianoPort = 46773, marianaPort = 46783, internalTLS = false }, users) {
  const hostname = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
  for (const value of [host, authHost]) if (!hostname.test(value || '') || !value.includes('.') || value.includes('..')) throw Error('Hostname inválido');
  if (host === authHost || !authHost.endsWith('.' + host)) throw Error('Usar auth.<hostname de Job Hunter>');
  for (const value of [port, authPort, marianoPort, marianaPort]) if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    if (value !== 443) throw Error('Puerto inválido');
  }
  for (const name of ['mariano', 'mariana']) if (!/^\$argon2id\$/.test(users?.users?.[name]?.password || '')) throw Error('Falta hash Argon2id de ' + name);
  if (Object.keys(users.users).sort().join(',') !== 'mariana,mariano') throw Error('Solo se admiten los dos usuarios previstos');
  const suffix = port === 443 ? '' : ':' + port;
  const origin = 'https://' + host + suffix;
  const authOrigin = 'https://' + authHost + suffix;
  const config = {
    server: { address: 'tcp://127.0.0.1:' + authPort },
    log: { level: 'info' },
    authentication_backend: { password_reset: { disable: true }, password_change: { disable: true }, file: { path: '/config/users.yml' } },
    access_control: { default_policy: 'deny', rules: [{ domain: host, subject: ['user:mariano', 'user:mariana'], policy: 'one_factor' }] },
    session: { secret: crypto.randomBytes(48).toString('hex'), name: 'jobhunter_session', same_site: 'lax', inactivity: '15m', expiration: '8h', remember_me: -1, cookies: [{ domain: host, authelia_url: authOrigin, default_redirection_url: origin }] },
    regulation: { modes: ['user', 'ip'], max_retries: 5, find_time: '15m', ban_time: '15m' },
    storage: { encryption_key: crypto.randomBytes(48).toString('hex'), local: { path: '/config/storage.sqlite3' } },
    notifier: { filesystem: { filename: '/config/notifications.txt' } }
  };
  const tls = internalTLS ? 'tls internal' : '';
  const caddy = `{
  admin off
  auto_https disable_redirects
  skip_install_trust
}
${authOrigin} {
  bind 127.0.0.1
  ${tls}
  reverse_proxy 127.0.0.1:${authPort}
}
${origin} {
  bind 127.0.0.1
  ${tls}
  route {
    request_header -Remote-User
    request_header -Remote-Groups
    request_header -Remote-Email
    request_header -Remote-Name
    request_header -X-Forwarded-For
    request_header -X-Forwarded-Host
    request_header -X-Forwarded-Proto
    forward_auth 127.0.0.1:${authPort} {
      uri /api/authz/forward-auth
      copy_headers Remote-User
    }
    @foreign {
      method POST PUT PATCH DELETE
      not header Origin ${origin}
    }
    respond @foreign "Origen no permitido" 403
    @mariano header Remote-User mariano
    handle @mariano {
      reverse_proxy 127.0.0.1:${marianoPort} {
        header_up Origin http://${host}${suffix}
      }
    }
    @mariana header Remote-User mariana
    handle @mariana {
      reverse_proxy 127.0.0.1:${marianaPort} {
        header_up Origin http://${host}${suffix}
      }
    }
    respond "Acceso no autorizado" 403
  }
}
`;
  return { config, caddy, users };
}

function writeConfiguration(directory, options, users) {
  if (fs.existsSync(directory)) throw Error('El directorio ya existe: no se sobrescriben credenciales ni sesiones');
  const result = configuration(options, users);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, content] of [['configuration.yml', JSON.stringify(result.config, null, 2)], ['users.yml', JSON.stringify(result.users, null, 2)], ['Caddyfile', result.caddy]]) fs.writeFileSync(path.join(directory, name), content + '\n', { mode: 0o600 });
  return directory;
}
if (require.main === module) {
  const [directory, host, authHost, usersFile] = process.argv.slice(2);
  if (!directory || !usersFile) throw Error('Uso: node access-config.js DIRECTORIO HOST AUTH_HOST ARCHIVO_USUARIOS_CON_HASHES');
  console.log(writeConfiguration(path.resolve(directory), { host, authHost }, JSON.parse(fs.readFileSync(usersFile, 'utf8'))));
}
module.exports = { configuration, writeConfiguration };
