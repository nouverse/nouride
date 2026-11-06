#!/bin/sh
# `nouride` on PATH inside the image — the CLI the docs, the dashboard and the agents all call.
#
# The image carries the engine as one bundle and no compiled binary, so without this there was no
# `nouride` at all: `nouride restart` in `docker exec` and an agent's own `nouride …` both failed with
# "not found". The bundle is the CLI (`start` is just one of its commands).
#
# `NOURIDE_HOME` because the CLI finds its install from the working directory or its executable's
# directory, and neither is `/app` here — `docker exec` lands in `/app`, an agent works in its
# workspace, and the executable is bun's. An explicit `NOURIDE_HOME`/`NOURIDE_CONFIG` still wins.
#
# As bun, not root: `docker exec` is root by default, and a CLI that writes into the install as root
# leaves files the daemon (uid 1000) can no longer change.
#
# `--no-install` as the daemon's CMD has it: with no node_modules here, Bun would otherwise fetch from npm any package
# an import names that the bundle does not carry — see the Dockerfile.
: "${NOURIDE_HOME:=/app}"
export NOURIDE_HOME
# The daemon in this container listens on `PORT` (the compose file passes it), and the CLI as a client deliberately
# does not read `PORT` — on a laptop it is a web project's. Here it is this daemon's and nothing else's: without this,
# `docker exec nouride nouride status` on a container run with another port asked 18254 and found nobody.
if [ -n "${PORT:-}" ] && [ -z "${NOURIDE_URL:-}" ]; then
  NOURIDE_URL="http://127.0.0.1:${PORT}"
  export NOURIDE_URL
fi
if [ "$(id -u)" = '0' ]; then
  exec su-exec bun bun --no-install /app/nouride.bundle.js "$@"
fi
exec bun --no-install /app/nouride.bundle.js "$@"
