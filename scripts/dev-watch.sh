#!/bin/sh
# Dev supervisor for the container in docker-compose.dev.yml.
#
# Installs deps, builds the dashboard, runs the engine, and restarts or rebuilds
# whichever half you edited.
#
# Why polling instead of inotify (or `bun --watch`):
#   Both need filesystem *events*. A bind mount from a macOS host shows the new file
#   contents but delivers no inotify events into the Linux VM, so an event-based
#   watcher silently never fires — you edit, nothing happens, and nothing says why.
#   Polling a few dozen files every couple of seconds costs nothing measurable and
#   behaves the same on every host.
set -eu

cd /app

POLL_INTERVAL="${DEV_POLL_INTERVAL:-2}"
# Every package's source, not a hand-kept subset: the dashboard's `ui-*` packages rebuild the dashboard, and every other
# package restarts the engine — the plugins included, since the engine imports them too.
#
# The list was written out and missed mcp, update, system-packages, wa-bridge and ui-graph, so an edit to one changed
# nothing until the container was restarted by hand — a fix that appears not to work, which sends you looking at the
# code you just corrected. Read from the tree when the container starts, so a package added later is watched.
ENGINE_PATHS="/app/apps/engine/src"
DASHBOARD_PATHS="/app/apps/dashboard/src /app/apps/dashboard/index.html"
for src in /app/packages/*/src; do
  case "$src" in
    /app/packages/ui-*) DASHBOARD_PATHS="$DASHBOARD_PATHS $src" ;;
    *) ENGINE_PATHS="$ENGINE_PATHS $src" ;;
  esac
done
STAMP_DIR="/tmp/nouride-dev"

engine_pid=""
docs_pid=""

rule() { echo "══════════════════════════════════════════"; }

start_engine() {
  bun run apps/engine/src/index.ts &
  engine_pid=$!
}

stop_engine() {
  [ -n "$engine_pid" ] || return 0
  # SIGTERM, not SIGKILL: the daemon's graceful shutdown sequence runs on every
  # dev restart, which is the cheapest possible test of it.
  kill -TERM "$engine_pid" 2>/dev/null || true
  wait "$engine_pid" 2>/dev/null || true
  engine_pid=""
}

start_docs() {
  (cd /app/apps/site && bun run dev --host 0.0.0.0 --port "${SITE_PORT:-4321}") &
  docs_pid=$!
}

stop_docs() {
  [ -n "$docs_pid" ] || return 0
  kill -TERM "$docs_pid" 2>/dev/null || true
  wait "$docs_pid" 2>/dev/null || true
  docs_pid=""
}

# Any file newer than the stamp — including a directory, so creating or deleting a
# file counts too.
changed() {
  name="$1"
  shift
  stamp="$STAMP_DIR/$name"
  [ -n "$(find "$@" -newer "$stamp" 2>/dev/null | head -n 1)" ]
}

mark() {
  touch "$STAMP_DIR/$1"
}

build_dashboard() {
  (cd /app/apps/dashboard && bun run build 2>&1 | tail -6)
}

on_exit() {
  stop_engine
  stop_docs
  exit 0
}
trap on_exit TERM INT

mkdir -p "$STAMP_DIR"

rule
echo "  🌌 Nouride Dev — installing deps..."
rule
bun install --frozen-lockfile 2>/dev/null || bun install

echo "  Building dashboard..."
build_dashboard
echo "✅ Dashboard built → /app/apps/dashboard/dist"

mark engine
mark dashboard

rule
echo "  🟢 Starting engine & docs (polling watch, ${POLL_INTERVAL}s)"
echo "  📡 Engine    → http://localhost:${PORT:-18254}"
echo "  📊 Dashboard → http://localhost:${PORT:-18254}/dashboard/"
echo "  📚 Site      → http://localhost:${SITE_PORT:-4321}"
rule
start_engine
start_docs

while true; do
  sleep "$POLL_INTERVAL"

  if changed engine $ENGINE_PATHS; then
    mark engine
    echo ""
    echo "🔄 Engine change detected, restarting..."
    stop_engine
    start_engine
  fi

  if changed dashboard $DASHBOARD_PATHS; then
    mark dashboard
    echo ""
    echo "🔄 Dashboard change detected, rebuilding..."
    build_dashboard
    echo "✅ Dashboard rebuilt at $(date '+%H:%M:%S')"
  fi

  # The engine exiting on its own — a boot failure after a bad edit — should not
  # leave the container idling with nothing listening.
  if [ -n "$engine_pid" ] && ! kill -0 "$engine_pid" 2>/dev/null; then
    echo "⚠️  Engine exited. Restarting in ${POLL_INTERVAL}s..."
    engine_pid=""
    sleep "$POLL_INTERVAL"
    start_engine
  fi

  if [ -n "$docs_pid" ] && ! kill -0 "$docs_pid" 2>/dev/null; then
    echo "⚠️  Docs exited. Restarting in ${POLL_INTERVAL}s..."
    docs_pid=""
    sleep "$POLL_INTERVAL"
    start_docs
  fi
done
