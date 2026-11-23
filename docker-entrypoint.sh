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

  if ! setpriv --reuid="$puid" --regid="$pgid" --clear-groups sh -c '[ -d "${HOME:-}" ] && [ -w "$HOME" ] && [ -x "$HOME" ]'; then
    HOME="/run/easyx-home-$puid"
    install -d -m 0700 -o "$puid" -g "$pgid" "$HOME"
    export HOME
  fi

  umask 002
  exec setpriv --reuid="$puid" --regid="$pgid" --clear-groups /usr/bin/tini -- "$@"
fi

if [ ! -d "${HOME:-}" ] || [ ! -w "$HOME" ] || [ ! -x "$HOME" ]; then
  HOME=$(mktemp -d "${TMPDIR:-/tmp}/easyx-home.XXXXXXXX")
  export HOME
fi

exec /usr/bin/tini -- "$@"
