#!/usr/bin/env bash
set -euo pipefail

image="${1:-open-easyx:ci}"
version="${2:-ci-test}"
volume="open-easyx-ci-data-${GITHUB_RUN_ID:-local}-$$"
container="open-easyx-ci-${GITHUB_RUN_ID:-local}-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$volume"
docker run -d --name "$container" -e PUID=99 -e PGID=100 -v "$volume:/data" "$image"

for attempt in {1..20}; do
  if docker exec "$container" node -e "fetch('http://127.0.0.1:3210/api/health').then(r => { if (!r.ok) process.exit(1) })" 2>/dev/null; then
    break
  fi
  if [ "$attempt" = 20 ]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

# The dependency overrides must preserve the imports used by the authentication helper.
docker exec "$container" /opt/ofscraper/bin/python -c 'from ofscraper.main.open import load; from ofscraper.data.api.init import getstatus; import idna, lxml.etree; print("OF-Scraper imports OK", idna.__version__, lxml.etree.LXML_VERSION)'
docker exec "$container" sh -lc 'test "$(awk "/^Uid:/ { print \$2 }" /proc/1/status)" = 99 && test "$(cat /proc/1/comm)" = tini'
docker exec --user 99:100 "$container" sh -c 'runtime_home=$(tr "\0" "\n" </proc/1/environ | sed -n "s/^HOME=//p"); test -d "$runtime_home" && test -w "$runtime_home"'
docker exec "$container" sh -lc 'test -w /data && test -f /data/easyx.sqlite && test -f /data/open-easyx-library.sqlite'
docker exec -e EXPECTED_VERSION="$version" "$container" node -e "fetch('http://127.0.0.1:3210/api/health').then(r=>r.json()).then(v=>{if(v.product!=='Open EasyX'||!v.ok||v.version!==process.env.EXPECTED_VERSION)throw Error(JSON.stringify(v))})"
docker exec -e EXPECTED_VERSION="$version" "$container" node -e "fetch('http://127.0.0.1:3210/api/version').then(r=>r.json()).then(v=>{if(v.version!==process.env.EXPECTED_VERSION)throw Error(JSON.stringify(v))})"
docker exec -i "$container" node --input-type=module <<'JS'
import assert from "node:assert/strict";
const request = (path, options) => fetch("http://127.0.0.1:3210" + path, options);
for (const path of ["/api/scan/status", "/api/performers/refresh/status"]) {
  assert.equal((await request(path)).status, 200);
}
const missing = "/api/unknown-smoke-route";
const conflict = "/api/plugin-repositories/official/refresh";
assert.equal((await request(missing)).status, 404);
assert.equal((await request(conflict, { method: "POST" })).status, 409);
const { entries } = await (await request("/api/logs")).json();
assert.ok(!entries.some(entry => ["incoming request", "request completed"].includes(entry.message)));
for (const url of [missing, conflict]) {
  assert.equal(entries.filter(entry => entry.level === "warn" && entry.details?.url === url).length, 1);
}
JS
docker exec "$container" node -e "fetch('http://127.0.0.1:3210/api/plugin-repositories').then(r=>r.json()).then(v=>{if(!Array.isArray(v)||!v.find(x=>x.id==='official'&&!x.removable))throw Error(JSON.stringify(v))})"
docker exec "$container" node -e "fetch('http://127.0.0.1:3210/api/plugins/org.easyx.manyvids/browser-login/start',{method:'POST'}).then(async r=>{const v=await r.json();if(!r.ok||!v.active||!v.viewerPath)throw Error(JSON.stringify(v))})"
docker exec "$container" node -e "fetch('http://127.0.0.1:3210/browser/vnc.html').then(r=>{if(!r.ok)throw Error('noVNC '+r.status)})"
docker cp scripts/browser-paste-smoke.mjs "$container:/tmp/browser-paste-smoke.mjs"
docker exec "$container" node /tmp/browser-paste-smoke.mjs
docker exec "$container" node -e "fetch('http://127.0.0.1:3210/api/plugins/org.easyx.manyvids/browser-login',{method:'DELETE'}).then(r=>{if(!r.ok)throw Error('stop '+r.status)})"
docker cp scripts/easyx-browser-fetch.test.py "$container:/tmp/easyx-browser-fetch.test.py"
docker exec --user 99:100 -e EASYX_BROWSER_FETCH_SCRIPT=/usr/local/bin/easyx-browser-fetch "$container" /opt/easyx/bin/python /tmp/easyx-browser-fetch.test.py
sleep 1
docker exec "$container" sh -lc 'if ps -eo stat | grep -q "^Z"; then exit 1; fi'
