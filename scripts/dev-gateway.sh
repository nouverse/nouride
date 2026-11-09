#!/bin/sh
#
# Run Nouride from source with its LLM gateway switched on: nougate answering in this process, as an installed
# build does once `[nougate] in_process = true` is set.
#
# ## Why this exists and `bun run dev` does not do it
#
# The gateway is behind a dynamic `import("@nouverse/nougate-backend")`, and that package is not a
# workspace member — the build (`scripts/build/core.ts`) symlinks it into `node_modules` for the duration of a build
# and the symlink is not otherwise there. So from a plain source checkout the import fails, and the
# daemon refuses `[nougate] in_process = true` as a build without the gateway does. This makes the
# same symlink the builder makes, so the source tree runs the shape a built binary has with the gateway on.
#
# It is the dev loop, not the artefact. To check what actually ships, build one — with internals/nougate checked
# out, the free build carries the gateway:
#
#   bun run build:binary --require-gateway
#
# ## What it does not do
#
# Touch your real install. Everything lands in a scratch directory under the system temp dir, so the
# daemon this starts has its own config, its own database and its own agents, and stopping it leaves
# nothing behind. `--home` points it somewhere else if you want state that survives.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOME_DIR="${NOURIDE_DEV_HOME:-${TMPDIR:-/tmp}/nouride-dev-gateway}"
PORT="${PORT:-18254}"
NOUGATE_PORT="${NOUGATE_PORT:-18256}"

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="${2:?--home needs a path}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --nougate-port) NOUGATE_PORT="${2:?--nougate-port needs a number}"; shift 2 ;;
    --fresh) rm -rf "$HOME_DIR"; shift ;;
    -h|--help)
      cat <<'USAGE'
nouride dev — from source, with the LLM gateway on

  scripts/dev-gateway.sh [--home PATH] [--port N] [--nougate-port N] [--fresh]

  --home PATH        where the scratch install lives. Default: $TMPDIR/nouride-dev-gateway
  --port N           the daemon's own port. Default: 18254
  --nougate-port N   the in-process gateway's port. Default: 18256
  --fresh            delete the scratch install first and set it up again
USAGE
      exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1m▸\033[0m %s\n' "$1"; }

# ── The symlink the builder makes ───────────────────────────────────────────
#
# Checked rather than assumed: an uninitialised submodule is an empty directory, and symlinking one
# produces an import that resolves to nothing and fails at the first request instead of here.
# Removed on the way out, the way the build removes its own in a `finally` (`withPluginsResolvable`).

#
# Not tidiness. The link makes the typechecker follow into nougate's source, which has its own `@/`
# alias that resolves to nothing from here — sixteen errors, so `lint:types` fails, so the
# pre-commit hook and CI fail, on a tree where nothing is wrong. Leaving it behind would mean every
# commit after a dev session is blocked by a symlink nobody remembers making.
cleanup() {
  rm -f "$ROOT/node_modules/@nouverse/nougate-backend"
  # The daemon is a child, and a shell that is signalled does not take its children with it.
  [ -n "${CHILD:-}" ] && kill "$CHILD" 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

say "Linking the bundled gateway"
if [ ! -f "$ROOT/internals/nougate/apps/backend/package.json" ]; then
  echo "✗ internals/nougate is not checked out." >&2
  echo "  git submodule update --init internals/nougate" >&2
  echo "  (it is a private repository — you need read access to nouverse/nougate)" >&2
  exit 1
fi
mkdir -p "$ROOT/node_modules/@nouverse"
ln -sfn "$ROOT/internals/nougate/apps/backend" "$ROOT/node_modules/@nouverse/nougate-backend"
echo "  @nouverse/nougate-backend → internals/nougate/apps/backend"

# ── The dashboard, which is a build and not a watcher ───────────────────────
#
# `--watch` below restarts the *engine*. The engine serves `apps/dashboard/dist`, a static build, so
# an edit to a React file changes nothing an operator can see and the page keeps serving whatever was
# built last. That cost a round trip: a wizard change was verified live over `/setup/state`, reported
# as working, and was invisible in the browser because the bundle was three hours old.
say "Building the dashboard"
(cd "$ROOT/apps/dashboard" && bun run build >/dev/null 2>&1) \
  || { echo "✗ dashboard build failed — run it by hand for the error" >&2; exit 1; }
echo "  apps/dashboard/dist"

# ── A scratch install, created once ─────────────────────────────────────────
say "Scratch install"
if [ -f "$HOME_DIR/.nouride/config.toml" ]; then
  echo "  reusing $HOME_DIR"
else
  mkdir -p "$HOME_DIR"
  echo "  setting up $HOME_DIR"
  # `--api-key-from-env` rather than a key on the command line: an argument lands in shell history
  # and in `ps`. Unset is fine — setup writes the profile and leaves the secret empty, which is what
  # a dev loop wants until there is a real key to point at.
  NOURIDE_HOME="$HOME_DIR" bun run "$ROOT/apps/engine/src/cli/main.ts" setup \
    --api-key-from-env NOURIDE_DEV_API_KEY >/dev/null 2>&1 || true
fi

# Written every run, not only on first setup: the ports are arguments to this script and somebody
# passing `--nougate-port` expects them to take effect on an install they already have.
CONFIG="$HOME_DIR/.nouride/config.toml"
mkdir -p "$(dirname "$CONFIG")"
touch "$CONFIG"
grep -v '^in_process\s*=\|^\[nougate\]\|^port\s*=\s*'"$NOUGATE_PORT" "$CONFIG" > "$CONFIG.tmp" || true
mv "$CONFIG.tmp" "$CONFIG"
printf '\n[nougate]\nin_process = true\nport = %s\n' "$NOUGATE_PORT" >> "$CONFIG"

say "Starting"
echo "  dashboard      http://127.0.0.1:$PORT/dashboard/"
echo "  gateway        http://127.0.0.1:$NOUGATE_PORT/openai/v1   (and /anthropic/v1)"
echo "  loopback only  — the gateway binds 127.0.0.1 by design; a browser elsewhere cannot reach it"
echo

# `--watch` so editing the engine restarts it. The gateway restarts with it, which is the same thing
# a built binary with the gateway on does on `nouride restart`.
#
# **Not `exec`.** That replaces this shell, and the `trap` above goes with it — the symlink would
# then survive every session and `lint:types` would fail on a clean tree until somebody found it by
# hand. Running it as a child costs one process and keeps the cleanup.
#
# Backgrounded and waited on, rather than run in the foreground. A `sh` blocked inside a foreground
# command defers its traps until that command returns — so Ctrl-C reached the daemon, the shell died
# without running `cleanup`, and the symlink survived. `wait` is interruptible; the trap fires.
NOURIDE_HOME="$HOME_DIR" PORT="$PORT" bun run --watch "$ROOT/apps/engine/src/cli/main.ts" start &
CHILD=$!
wait "$CHILD"
