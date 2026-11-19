#!/bin/sh
# Fake `code` CLI for tests. Mimics `code serve-web` closely enough for server.ts:
#   code serve-web --help          -> help text (exit 0), or an error in mode no-serve-web
#   code serve-web --host ... etc. -> runs fake-serve-web.mjs in the background and waits,
#                                     like the real wrapper (which does NOT forward SIGTERM,
#                                     so killing only this shell would orphan the server).
# Env: FAKE_CODE_NODE (node binary), FAKE_CODE_MODE, FAKE_CODE_PIDFILE, FAKE_CODE_ARGSFILE,
#      FAKE_CODE_DOWNLOAD_REQUESTS, FAKE_CODE_HELP_DELAY (seconds `serve-web --help` takes to answer),
#      FAKE_CODE_LEDGER (a file: one line is appended for each server this wrapper starts, see ledger_append below).
here=$(dirname "$0")
node_bin=${FAKE_CODE_NODE:-node}

if [ "$1" = "serve-web" ] && [ "$2" = "--help" ]; then
  if [ -n "$FAKE_CODE_HELP_DELAY" ]; then sleep "$FAKE_CODE_HELP_DELAY"; fi
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

# Watchdog, so that a test run that is killed (SIGKILL runs no cleanup) does not leave this fake behind. Nothing else can do it:
# macOS has no parent-death signal, and the node server's parent is this wrapper, which stays alive. The owner is this wrapper's
# own parent (the test process that started it), recorded now with its start time; a background loop polls it every 2 s and,
# once the owner is gone (or is a zombie, or its pid now belongs to another process), ends this wrapper, the server and
# everything the server started. It also ends them after FAKE_CODE_MAX_LIFETIME_S seconds (default 600), for a fake started by hand;
# fake-serve-web.mjs enforces the same cap itself, because this loop dies with a wrapper that is killed alone. There is no way
# to switch the watchdog off. Only this file is needed: a test that copies the fixtures into a temp dir gets it from the copy.
# Env: FAKE_CODE_MAX_LIFETIME_S (positive whole seconds; anything else means 600).
wrapper=$$
owner=$PPID
owner_start=$(ps -o lstart= -p "$owner" 2>/dev/null)
cap=${FAKE_CODE_MAX_LIFETIME_S:-600}
case $cap in '' | *[!0-9]*) cap=600 ;; esac
[ "$cap" -gt 0 ] 2>/dev/null || cap=600

# True when pid $1 is gone, or is a zombie (killed, not yet reaped by its parent: `kill -0` still succeeds on it).
is_gone() {
  kill -0 "$1" 2>/dev/null || return 0
  case $(ps -o stat= -p "$1" 2>/dev/null) in *Z*) return 0 ;; esac
  return 1
}

# True when the owner is gone, a zombie, or its pid now has another start time (the pid was reused). When `ps` cannot say,
# the owner counts as alive: ending a live test's server is worse than ending a dead test's server at the cap.
owner_gone() {
  is_gone "$owner" && return 0
  if [ -n "$owner_start" ]; then
    now_start=$(ps -o lstart= -p "$owner" 2>/dev/null)
    if [ -n "$now_start" ] && [ "$now_start" != "$owner_start" ]; then return 0; fi
  fi
  return 1
}

# True when word $1 is in the space-separated list $2.
in_list() {
  case " $2 " in *" $1 "*) return 0 ;; esac
  return 1
}

# The descendants of pid $1 (not $1), space separated, from the process table. Prints nothing when `ps` fails.
tree_of() {
  table=$(ps -A -o pid=,ppid= 2>/dev/null) || return 0
  level=$1
  found=""
  depth=0
  while [ -n "$level" ] && [ "$depth" -lt 30 ]; do
    next=$(printf '%s\n' "$table" | while read -r p pp; do
      if in_list "$pp" "$level"; then echo "$p"; fi
    done)
    level=$(echo $next)
    found="$found $level"
    depth=$((depth + 1))
  done
  echo $found
}

# End the server $1, every process under it and every `setsid` process the server recorded in FAKE_CODE_PIDFILE that was
# re-parented to init, then this wrapper. Only pids from the descendant walk and from that file are signalled, never a process
# found by name. The walk stops each process first (a stopped shell starts nothing new) and repeats until it finds no new
# one, so a shell that ignores SIGTERM and keeps starting `sleep` cannot leave a child behind; then everything gets SIGKILL.
end_all() {
  victims=""
  round=0
  while [ "$round" -lt 6 ]; do
    fresh=""
    for p in $1 $(tree_of "$1"); do
      in_list "$p" "$victims" || fresh="$fresh $p"
    done
    [ -n "$fresh" ] || break
    kill -STOP $fresh 2>/dev/null
    victims="$victims $fresh"
    round=$((round + 1))
  done
  if [ -n "$FAKE_CODE_PIDFILE" ] && [ -f "$FAKE_CODE_PIDFILE" ]; then
    while read -r kind p rest; do
      [ "$kind" = setsid ] || continue
      case $p in '' | *[!0-9]*) continue ;; esac
      # Only a process that is still a `sleep` re-parented to init: a pid that was reused since is not ours to end.
      [ "$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')" = 1 ] || continue
      cmd=$(ps -o comm= -p "$p" 2>/dev/null)
      [ "${cmd##*/}" = sleep ] && victims="$victims $p"
    done <"$FAKE_CODE_PIDFILE"
  fi
  [ -z "$victims" ] || kill -KILL $victims 2>/dev/null
  kill -KILL "$wrapper" 2>/dev/null
}

watchdog() {
  started=$(date +%s)
  while :; do
    # A wrapper killed alone (a test that orphans the server on purpose) takes the loop with it and leaves the server to its own cap.
    is_gone "$wrapper" && exit 0
    if owner_gone; then end_all "$child"; exit 0; fi
    now=$(date +%s)
    if [ $((now - started)) -ge "$cap" ]; then end_all "$child"; exit 0; fi
    sleep 2
  done
}

# The test temp dir this server belongs to, for the ledger: the marked directory (`vscode-workbench-test-<runner pid>-<random>`) on
# the command line, which is where `tempDir()` puts the token file and the data dirs; else the token file's own directory.
temp_dir_of() {
  prev=""
  for a in "$@"; do
    case $a in
      */vscode-workbench-test-[0-9]*-*)
        rest=${a#*/vscode-workbench-test-}
        printf '%s\n' "${a%%/vscode-workbench-test-*}/vscode-workbench-test-${rest%%/*}"
        return 0
        ;;
    esac
    if [ "$prev" = --connection-token-file ]; then token_dir=$(dirname "$a"); fi
    prev=$a
  done
  printf '%s\n' "${token_dir:-$PWD}"
}

# One line per server this wrapper starts, for the end-of-run leak report (tests/leak-report.ts): the node server's pid, its start
# time and the temp dir, separated by tabs. Written with a single `>>` so lines from forks that run together do not interleave.
# Only when FAKE_CODE_LEDGER is set: a hand-started fake, and the copy in a temp app dir, write nothing. A write that fails
# (an unwritable path, a full disk) is not an error: the fake starts and exits as it would without a ledger.
ledger_append() {
  [ -n "$FAKE_CODE_LEDGER" ] || return 0
  child_start=$(LC_ALL=C ps -o lstart= -p "$child" 2>/dev/null)
  [ -n "$child_start" ] || return 0 # the server is already gone: nothing to report
  child_start=$(echo $child_start)
  dir=$(temp_dir_of "$@")
  ( printf '%s\t%s\t%s\n' "$child" "$child_start" "$dir" >>"$FAKE_CODE_LEDGER" ) 2>/dev/null || :
  return 0
}

"$node_bin" "$here/fake-serve-web.mjs" "$@" &
child=$!
ledger_append "$@"
watchdog </dev/null >/dev/null 2>&1 &
wait "$child"
exit $?
