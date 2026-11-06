#!/bin/sh
set -e

# If running as root (the default container behaviour before privilege drop),
# ensure all runtime state directories exist and are owned by user bun (UID 1000).
# This fixes the common EACCES issue when volumes are mounted from the host (e.g. -v ./data:/app/.nouride).
# Then this same script runs again as bun.
if [ "$(id -u)" = '0' ]; then
  mkdir -p /app/.nouride/data /app/.nouride/agents /app/.nouride/workspace/shared 2>/dev/null || true
  # Only what is not bun's already: `chown -R` rewrote every file of every tool cache and Python env on
  # each start. `-h` changes a link itself, never the system file a link in .nouride/bin points at.
  # `system-packages` stays root's: what is in it, root installs again at the next start.
  find /app/.nouride -path /app/.nouride/system-packages -prune -o ! -user bun -exec chown -h bun:bun {} + 2>/dev/null || true
  # System packages (0.8.15), for the daemon and not a one-off command: agents install through
  # nouride-pkg, as on a host installed with --allow-packages, and what they installed comes back when
  # the container is recreated. Root here is the container's; NOURIDE_SYSTEM_PACKAGES=off turns it off.
  for last in "$@"; do :; done
  pkg=/usr/local/lib/nouride-pkg/container/nouride-pkg-container
  if [ "${last:-}" = "start" ] && [ "${NOURIDE_SYSTEM_PACKAGES:-on}" != "off" ] && [ -x "$pkg" ]; then
    "$pkg" start || echo "nouride-pkg: the package service did not start, so agents cannot install system packages here" >&2
  fi
  exec su-exec bun "$0" "$@"
fi

# Anything but the daemon — `docker run <image> nouride status`, a shell — runs as given.
for last in "$@"; do :; done
if [ "${last:-}" != "start" ]; then
  exec "$@"
fi

# The daemon, supervised here rather than by the container.
#
# `nouride restart`, the dashboard's restart and an update all end the daemon and expect whatever
# supervises it to start a new one. Left to the container, that is its restart policy — which we
# cannot see from inside, and which is simply absent under a bare `docker run` and in Dokploy's
# default service. So the entrypoint is the supervisor: a daemon that exits is started again in this
# same container, and only a stop of the container itself (SIGTERM/SIGINT to this script) ends it.
# `NOURIDE_CONTAINER_SUPERVISOR` is how the daemon learns a restart is safe to promise.
# HOME inside the volume. The image user's own home is in the container's writable layer, so what an
# agent kept there — ssh keys and config, known hosts, a CLI it logged in to — was gone on every
# recreate or upgrade. `.nouride/home` is where a native install keeps it too.
export HOME=/app/.nouride/home
mkdir -p "$HOME/.ssh" 2>/dev/null && chmod 700 "$HOME" "$HOME/.ssh" 2>/dev/null || true

export NOURIDE_CONTAINER_SUPERVISOR=entrypoint

stopping=0
child=0
trap 'stopping=1; [ "$child" -ne 0 ] && kill -TERM "$child" 2>/dev/null' TERM INT
set +e
delay=1
while :; do
  # A lock left by a daemon that did not exit cleanly (a crash, a killed container). Only this loop
  # starts daemons in this container, so the one that held it is gone.
  rm -f /app/.nouride/data/nouride.lock 2>/dev/null
  started=$(date +%s)
  "$@" &
  child=$!
  wait "$child"
  code=$?
  # A trapped signal interrupts `wait` before the child has finished shutting down; wait it out.
  while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    code=$?
  done
  child=0
  [ "$stopping" = 1 ] && exit "$code"
  # A clean exit is a restart someone asked for: straight back. A daemon that keeps dying at boot
  # (a broken config) is retried slower and slower, not in a tight loop.
  if [ "$code" = 0 ] || [ $(( $(date +%s) - started )) -ge 30 ]; then delay=1; else delay=$(( delay * 2 > 30 ? 30 : delay * 2 )); fi
  echo "nouride exited (code $code); starting it again in ${delay}s" >&2
  sleep "$delay" &
  wait $!
  [ "$stopping" = 1 ] && exit "$code"
done
