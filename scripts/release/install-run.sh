#!/bin/sh
# install.sh, run whole as root on a fresh system, twice (REVIEW B1): 994 lines of POSIX sh nothing ran end to end,
# and 0.5.10 and 0.5.11 shipped one that dash refused at its last block. In a container of the given image and
# platform: the first run installs the tarball, the daemon is started by hand (a container has no systemd, and
# install.sh says so) and must answer /health with the tarball's version; the second run is the re-run every upgrade
# is, and must leave `.nouride/` as it was and answer again.
#
#   sh scripts/release/install-run.sh <tarball> <image> <platform> <version>
#   e.g. sh scripts/release/install-run.sh nouride-linux-arm64.tar.gz ubuntu:24.04 linux/arm64 0.8.18
#
# The install.sh run is this checkout's, the one the release ships. Prints one line per check; exits 1 on the first
# that fails.
set -eu
TARBALL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
IMAGE=$2
PLATFORM=$3
VERSION=$4
HERE=$(cd "$(dirname "$0")/../.." && pwd)

docker run --rm --platform "$PLATFORM" \
  -v "$TARBALL:/tmp/nouride.tar.gz:ro" -v "$HERE/scripts/install.sh:/tmp/install.sh:ro" \
  -e VERSION="$VERSION" "$IMAGE" sh -euc '
  say() { printf "  %s\n" "$*"; }
  fail() { printf "  ✗ %s\n" "$*"; exit 1; }
  # What a fresh system of this kind lacks and the install docs ask for: curl, and on Alpine the C++ runtime.
  if command -v apk >/dev/null; then apk add -q curl libstdc++ >/dev/null
  else apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null 2>&1; fi
  start() {
    # What install.sh tells a system with no service manager to run.
    (nohup su -s /bin/sh nouride -c "cd /srv/nouride && ./nouride start" >/tmp/daemon.log 2>&1 &)
    i=0
    while [ "$i" -lt 90 ]; do
      got=$(curl -fsS --max-time 2 http://127.0.0.1:18254/health 2>/dev/null || true)
      case "$got" in *"\"version\":\"$VERSION\""*) say "✓ /health answers $VERSION ($1)"; return 0 ;; esac
      i=$((i + 1)); sleep 1
    done
    tail -n 20 /tmp/daemon.log
    fail "/health did not answer $VERSION within 90s ($1)"
  }
  # By the pid the daemon writes in its lock: a minimal image has no pkill.
  stop() {
    pid=$(cat /srv/nouride/.nouride/data/nouride.lock 2>/dev/null || true)
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
    i=0; while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do i=$((i + 1)); sleep 1; done
  }

  sh /tmp/install.sh --tarball /tmp/nouride.tar.gz >/tmp/install-1.log 2>&1 || { code=$?; tail -n 30 /tmp/install-1.log; fail "the first install.sh run exited $code"; }
  say "✓ installed: $(/srv/nouride/nouride --version)"
  [ "$(/srv/nouride/nouride --version)" = "$VERSION" ] || fail "the installed binary says $(/srv/nouride/nouride --version), not $VERSION"
  start "the first run"
  # The secret store, encrypted at its first value (0.8.19): with no systemd here, its key a line in the install.sh .env.
  printf "stand-in-value" | su -s /bin/sh nouride -c "cd /srv/nouride && ./nouride secret set ci_check --stdin" >/dev/null || fail "could not store a secret"
  [ -s /srv/nouride/.nouride/data/secrets.enc ] || fail "the secret store is not encrypted"
  [ ! -e /srv/nouride/.nouride/data/secrets.json ] || fail "secrets.json is there beside the encrypted store"
  ! grep -q stand-in-value /srv/nouride/.nouride/data/secrets.enc || fail "the value can be read in secrets.enc"
  grep -q "^NOURIDE_ENCRYPTION_KEY=" /srv/nouride/.env || fail "no key line in the install .env"
  say "✓ the secret store is encrypted, its key in the install .env"
  stop
  echo kept > /srv/nouride/.nouride/kept-by-the-rerun
  chown nouride /srv/nouride/.nouride/kept-by-the-rerun
  sh /tmp/install.sh --tarball /tmp/nouride.tar.gz >/tmp/install-2.log 2>&1 || { code=$?; tail -n 30 /tmp/install-2.log; fail "the second install.sh run exited $code"; }
  [ "$(cat /srv/nouride/.nouride/kept-by-the-rerun)" = kept ] || fail "the re-run touched .nouride/"
  say "✓ the re-run left .nouride/ alone"
  start "the re-run"
  su -s /bin/sh nouride -c "cd /srv/nouride && ./nouride secret list" | grep -q ci_check || fail "the secret is gone after the re-run"
  say "✓ the secret opens after the re-run"
  stop
'
