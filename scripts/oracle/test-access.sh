#!/bin/sh
# Run in a fresh private directory with access-config.js and verify-access.cjs.
set -eu
umask 077
ROOT="$(pwd)"
NAME="jobhunter-access-test-$$"
NODE_IMAGE=mcr.microsoft.com/playwright:v1.62.1-noble
AUTH_IMAGE=authelia/authelia:4.39.28
CADDY_IMAGE=caddy:2.11.7
cleanup() {
  docker rm -f "$NAME-auth" "$NAME-proxy" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker run --rm --network none --entrypoint node -v "$ROOT:/test" -w /test "$NODE_IMAGE" -e '
const fs=require("fs"),crypto=require("crypto");fs.writeFileSync("test-credentials.json",JSON.stringify({mariano:crypto.randomBytes(24).toString("hex"),mariana:crypto.randomBytes(24).toString("hex")}));'
docker run --rm --network none -v "$ROOT:/test" --entrypoint sh "$AUTH_IMAGE" -c '
  for name in mariano mariana; do
    password=$(sed -n "s/.*\"$name\":\"\([^\"]*\)\".*/\1/p" /test/test-credentials.json)
    /app/authelia crypto hash generate argon2 --password "$password" | sed "s/^Digest: //" > "/test/$name.hash"
  done'
docker run --rm --network none --entrypoint node -v "$ROOT:/test" -w /test "$NODE_IMAGE" -e '
const fs=require("fs"),{writeConfiguration}=require("./access-config");const users={users:{}};
for(const name of ["mariano","mariana"])users.users[name]={displayname:name,password:fs.readFileSync(name+".hash","utf8").trim()};
writeConfiguration("config",{host:"hunter.example.com",authHost:"auth.hunter.example.com",port:18443,authPort:19091,marianoPort:19073,marianaPort:19083,internalTLS:true},users);'
docker run --rm --network none -v "$ROOT/config:/config" "$AUTH_IMAGE" authelia validate-config --config /config/configuration.yml
docker run --rm --network none -v "$ROOT/config:/config" "$CADDY_IMAGE" caddy validate --config /config/Caddyfile --adapter caddyfile
docker run -d --name "$NAME-auth" --network host -v "$ROOT/config:/config" "$AUTH_IMAGE" >/dev/null
docker run -d --name "$NAME-proxy" --network host -v "$ROOT/config:/config:ro" "$CADDY_IMAGE" caddy run --config /config/Caddyfile --adapter caddyfile >/dev/null
if ! docker run --rm --network host --entrypoint node -v "$ROOT:/test" -w /test "$NODE_IMAGE" verify-access.cjs /test; then
  docker logs --tail 25 "$NAME-auth"
  docker logs --tail 25 "$NAME-proxy"
  exit 1
fi
