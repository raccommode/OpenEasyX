#!/bin/sh
set -eu

puid="${PUID:-1000}"
pgid="${PGID:-1000}"
data_dir="${EASYX_DATA_DIR:-/data}"
media_dir="${EASYX_MEDIA_DIR:-/media}"

case "$puid:$pgid" in
  *[!0-9:]*|:*|*:) echo "PUID and PGID must be numeric" >&2; exit 64 ;;
esac

if [ "$(id -u)" = "0" ]; then
  install -d -m 0775 -o "$puid" -g "$pgid" "$data_dir" "$media_dir"

  # The database and its WAL files must all belong to the runtime identity.
  # This directory stays small, unlike the potentially very large media tree.
  chown -R "$puid:$pgid" "$data_dir"
  chown "$puid:$pgid" "$media_dir"

  # setpriv keeps root's HOME (/root), which the runtime user cannot write: Chromium's crash
  # reporter then aborts at startup ("chrome_crashpad_handler: --database is required") and
  # tools lose their caches. Give the runtime user a home of its own.
  runtime_home="/tmp/easyx-home"
  install -d -m 0700 -o "$puid" -g "$pgid" "$runtime_home"
  export HOME="$runtime_home"

  umask 002
  exec setpriv --reuid="$puid" --regid="$pgid" --clear-groups /usr/bin/tini -- "$@"
fi

exec /usr/bin/tini -- "$@"
