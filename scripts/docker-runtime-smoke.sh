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
# Exercise the packaged plugin and its writable runtime as the actual server UID.
docker exec --user 99:100 "$container" ffmpeg -loglevel error -f lavfi -i color=size=32x32:duration=0.2 -an -c:v mpeg4 /media/subtitle-smoke.mp4
docker exec -i "$container" node --input-type=module <<'JS'
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout } from "node:timers/promises";
const request = (route, options) => fetch("http://127.0.0.1:3210/api" + route, options);
assert.equal((await (await request("/subtitles/status")).json()).pluginEnabled, false);
assert.ok(!fs.existsSync("/data/subtitle-runtime") && !fs.existsSync("/opt/subtitles"));
assert.equal((await request("/scan", { method: "POST" })).status, 200);
const { items } = await (await request("/library?q=subtitle")).json();
const media = items.find(item => item.relativePath === "subtitle-smoke.mp4");
assert.ok(media);
const plugin = "/plugins/org.easyx.subtitles";
assert.equal((await request(plugin + "/install", { method: "POST" })).status, 200);
const route = "/media/" + media.id + "/subtitles";
let status;
for (let attempt = 0; attempt < 30; attempt++) {
  status = await (await request(route)).json();
  if (status.status === "no_audio") break;
  await setTimeout(500);
}
assert.equal(status.status, "no_audio", JSON.stringify(status));
assert.ok(!fs.existsSync("/data/subtitle-models"));
const upload = await request(route + "/fr", { method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ content: "1\n00:00:00,000 --> 00:00:00,200\nBonjour" }) });
assert.equal(upload.status, 200);
assert.equal((await request(plugin, { method: "DELETE" })).status, 200);
status = await (await request(route)).json();
assert.equal(status.pluginEnabled, false);
assert.equal(status.tracks.length, 1);
assert.match(await (await fetch("http://127.0.0.1:3210" + status.tracks[0].url)).text(), /^WEBVTT[\s\S]*Bonjour/);
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
