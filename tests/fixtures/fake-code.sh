#!/bin/sh
# Fake `code` CLI for tests. Mimics `code serve-web` closely enough for server.ts:
#   code serve-web --help          -> help text (exit 0), or an error in mode no-serve-web
#   code serve-web --host ... etc. -> runs fake-serve-web.mjs in the background and waits,
#                                     like the real wrapper (which does NOT forward SIGTERM,
#                                     so killing only this shell would orphan the server).
# Env: FAKE_CODE_NODE (node binary), FAKE_CODE_MODE, FAKE_CODE_PIDFILE, FAKE_CODE_ARGSFILE,
#      FAKE_CODE_DOWNLOAD_REQUESTS.
here=$(dirname "$0")
node_bin=${FAKE_CODE_NODE:-node}

if [ "$1" = "serve-web" ] && [ "$2" = "--help" ]; then
  if [ "$FAKE_CODE_MODE" = "no-serve-web" ]; then
    echo "error: unrecognized subcommand 'serve-web'" >&2
    exit 2
  fi
  cat <<'HELP'
Runs a local web version of Visual Studio Code

Usage: code-tunnel serve-web [OPTIONS]

Options:
      --host <HOST>
      --port <PORT>
      --connection-token-file <CONNECTION_TOKEN_FILE>
      --accept-server-license-terms
      --server-data-dir <SERVER_DATA_DIR>
      --disable-telemetry
HELP
  exit 0
fi

"$node_bin" "$here/fake-serve-web.mjs" "$@" &
child=$!
wait "$child"
exit $?
