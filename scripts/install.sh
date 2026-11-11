#!/bin/sh
#
# Install or upgrade Nouride on a Linux host, then hand over to the browser.
#
# The bootstrap problem this solves: everything after the daemon is running can be done from the
# dashboard — the setup wizard covers the provider and the first agent, which are the only two things
# a fresh install cannot answer for itself. But nothing can serve that page before something has put a
# binary on the box and started it, and that was eight manual steps in DEPLOY.md.
#
#   sh install.sh --tarball /tmp/nouride-linux-x64.tar.gz
#   → open the printed URL
#
# Deliberately POSIX sh and readable top to bottom: this is the one thing here that runs as root on a
# machine nobody has logged into yet, so it should be something an operator can read before piping it
# to a shell.
#
# Safe to re-run. A second run upgrades the binary and leaves `.nouride/` — the database, the secrets,
# the agent packs — untouched.

set -eu

# Where a release is fetched from. The download domain is the default because that is what the
# published one-liner points at; `--repo` switches to GitHub releases for a build that has not been
# promoted to the CDN yet, and `--tarball` skips the network entirely.
BASE_URL="${NOURIDE_BASE_URL:-https://get.nouride.com}"
REPO="nouverse/nouride"
FROM_REPO=0
INSTALL_DIR="/srv/nouride"
SERVICE_USER="nouride"
BIND_HOST=""
TARBALL=""
VERSION="latest"
PORT="18254"
# Whether --host and --port were given on this run: only then does a value already in .env give way.
HOST_GIVEN=0
PORT_GIVEN=0
# Which of the three builds to fetch. Empty is the ordinary one, whose artefacts keep the bare
# `nouride-<target>` name so every published install command stays true. See --variant in usage.
VARIANT=""
# A Pro server's licence: the device.json Nouverse's admin made for it (`--identity`).
IDENTITY=""
# `nouride-pkg`, the root service agents install system packages through. Off unless asked for:
# 1 is --allow-packages, 0 is --no-packages, empty keeps whatever an earlier run set up.
PACKAGES=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --tarball PATH   install from a tarball already on this machine (built with
                   `bun run build:binary`). Use this until a release exists.
  --version TAG    release to download instead, e.g. v0.1.0. Default: latest
  --base-url URL   where to download from. Default: https://get.nouride.com
  --repo OWNER/N   download from GitHub releases instead of --base-url
  --variant NAME   which edition: `basic` (the default, the free one) or `pro`
                   Both carry the LLM gateway, on with `[nougate] in_process = true`.
                   `router` is still taken: Router is part of Nouride now, and this
                   installs Nouride with its LLM gateway switched on.
                   `pro` adds multi-user accounts, Nouverse sign-in and Box pairing. It is
                   licensed, not public: it needs --tarball. WhatsApp is in all of them.
                   Any other name is refused.
  --identity FILE  a Pro server's licence: the device.json Nouverse's admin made for it.
                   With --variant pro. Its updates then come from Nouverse, as a box's do.
  --dir PATH       install directory. Default: /srv/nouride
  --user NAME      service account to create and run as. Default: nouride
  --host ADDR      address the dashboard binds to. Default: 127.0.0.1 (loopback only;
                   reach it with `ssh -L 18254:127.0.0.1:18254 user@host`).
                   Pass 0.0.0.0 to expose it on the network instead.
  --port PORT      dashboard port. Default: 18254
  --allow-packages let agents install, remove and upgrade system packages from this
                   system's own repositories, asking a person before every change unless
                   an agent's approvals are "trusted" (nouride-pkg, a small root service).
                   Without it they install only into their own bin directory. Kept by
                   later runs without the flag.
  --no-packages    remove it again.
  -h, --help       this

The daemon boots with no configuration. The provider, its credential and the first
agent are set in the browser afterwards.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL="${2:?--tarball needs a path}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a tag}"; shift 2 ;;
    --base-url) BASE_URL="${2:?--base-url needs a URL}"; FROM_REPO=0; shift 2 ;;
    --repo) REPO="${2:?--repo needs owner/name}"; FROM_REPO=1; shift 2 ;;
    --variant) VARIANT="${2:?--variant needs a name}"; shift 2 ;;
    --identity) IDENTITY="${2:?--identity needs a file}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --user) SERVICE_USER="${2:?--user needs a name}"; shift 2 ;;
    --host) BIND_HOST="${2:?--host needs an address}"; HOST_GIVEN=1; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; PORT_GIVEN=1; shift 2 ;;
    --allow-packages) PACKAGES=1; shift ;;
    --no-packages) PACKAGES=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
[ "$OS" = "Linux" ] || [ "$OS" = "Darwin" ] || die "Linux and macOS only."

if [ "$OS" = "Darwin" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    SERVICE_USER="$SUDO_USER"
    USER_HOME="$(eval echo "~$SUDO_USER")"
  else
    SERVICE_USER="${USER:-$(id -un)}"
    USER_HOME="${HOME:-$HOME}"
  fi
  if [ "$INSTALL_DIR" = "/srv/nouride" ]; then
    INSTALL_DIR="$USER_HOME/nouride"
  fi
else
  [ "$(id -u)" = "0" ] || die "run as root on Linux: this creates a user and a system service"
  USER_HOME="/root"
fi
# >>> service group
# The group what this installs is given to. On Linux, the one `useradd --system` makes beside the account, which the
# socket and the `usermod -aG` below name too. On macOS a person's own primary group: no group is named after them, so
# `-g $SERVICE_USER` stopped the install at the home directory with `unknown group`.
if [ "$OS" = "Darwin" ]; then SERVICE_GROUP="$(id -gn "$SERVICE_USER")"; else SERVICE_GROUP="$SERVICE_USER"; fi
# <<< service group

# ── Which build ──────────────────────────────────────────────────────────────
#
# Architecture *and* C library, because a mismatch in either fails on the first run and not before —
# and the failure reads like a corrupt download rather than the wrong file. Alpine additionally needs
# libstdc++, which the binary links and a bare Alpine does not ship.
detect_target() {
  if [ "$OS" = "Darwin" ]; then
    libc="Mach-O"
    case "$(uname -m)" in
      arm64) TARGET="darwin-arm64" ;;
      x86_64) TARGET="darwin-x64" ;;
      *) die "unsupported macOS architecture: $(uname -m)" ;;
    esac
    return
  fi

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac

  # glibc is the default because Debian, Ubuntu and RHEL are, and a wrong guess in that direction is
  # caught immediately by the version check below rather than silently.
  if [ -f /etc/alpine-release ] || ldd /bin/sh 2>/dev/null | grep -qi musl; then
    libc="musl"
    TARGET="linux-${arch}-musl"
  else
    libc="glibc"
    TARGET="linux-${arch}"
  fi

  # The binary links libstdc++, which a bare Alpine does not ship. Without it the loader reports
  # missing C++ symbols, which reads like a corrupt download rather than a missing package.
  if [ "$libc" = "musl" ] && ! (command -v apk >/dev/null 2>&1 && apk info -e libstdc++ >/dev/null 2>&1); then
    warn "musl detected and libstdc++ was not found. Install it first: apk add libstdc++"
  fi
}

step "Checking this machine"
detect_target
# The public editions are published for Apple Silicon only on a Mac (darwin-arm64). An Intel Mac has no public build, so
# a download there only ever 404'd, and said "if no release exists yet" about a release that existed. Pro has an Intel
# build (0.8.4), which its licence link hands this script as --tarball.
# >>> mac target
if [ "$OS" = "Darwin" ] && [ "$TARGET" != "darwin-arm64" ] && [ -z "$TARBALL" ]; then
  die "no build is published for an Intel Mac: macOS releases are Apple Silicon only. Build one here (\`bun run build:binary --target ${TARGET}\`) and pass --tarball dist/nouride-${TARGET}.tar.gz"
fi
# <<< mac target
# >>> editions
# The three editions — `EDITIONS` in scripts/targets.ts, which a test holds this list to — and no other name. Every
# name they had before (`device`, `device-pro`, `cloud`, `pro-router`) is refused like any other. `basic` is the
# default spelled out, and its artefacts keep the bare `nouride-<target>` name.
case "$VARIANT" in
  basic) VARIANT="" ;;
  ""|router|pro) ;;
  *) die "unknown --variant: $VARIANT (the editions are basic and pro)" ;;
esac
# <<< editions
# >>> gateway on
# Router is part of Nouride since 0.8.28 (v0.8.28_RFC): the free build carries the LLM gateway, off until
# `[nougate] in_process = true`. `--variant router`, which older scripts and Nouride Home still run, installs it with
# the gateway switched on, as a Router install had it ("download names" below says which files). 0.9.0 removes this,
# with Router's names.
GATEWAY_ON=0
case "$VARIANT" in router) GATEWAY_ON=1 ;; esac

# gateway_config <install dir> — the config.toml the daemon reads there, in the order its loader looks:
# `.nouride/config.toml`, then a bare `config.toml` beside the install; the first when neither is there yet.
gateway_config() {
  if [ -f "$1/.nouride/config.toml" ] || [ ! -f "$1/config.toml" ]; then printf '%s' "$1/.nouride/config.toml"; else printf '%s' "$1/config.toml"; fi
}

# gateway_state <config file> — `set` when it says `in_process` for [nougate] either way, `table` when it has the
# [nougate] table without the key, `other` when it writes the gateway's settings in a form this does not edit (a
# dotted key or an inline table at the top), `none` when it says nothing of the gateway.
gateway_state() {
  awk '
    /^[[:space:]]*\[\[/ { table = "[]"; next }
    /^[[:space:]]*\[/ {
      t = $0; sub(/^[[:space:]]*\[[[:space:]]*/, "", t); sub(/[[:space:]]*\].*$/, "", t); table = t
      if (t == "nougate") has = 1
      next
    }
    table == "" && /^[[:space:]]*nougate[[:space:]]*\.[[:space:]]*in_process[[:space:]]*=/ { set = 1 }
    table == "" && /^[[:space:]]*nougate[[:space:]]*=.*in_process/ { set = 1 }
    table == "" && /^[[:space:]]*nougate[[:space:]]*[.=]/ { other = 1 }
    table == "nougate" && /^[[:space:]]*in_process[[:space:]]*=/ { set = 1 }
    END { if (set) print "set"; else if (other) print "other"; else if (has) print "table"; else print "none" }
  ' "$1"
}

# gateway_on <config file> <owner> <group> — `in_process = true` for [nougate], unless the file already says either
# way: an operator who switched it off keeps it off. A file made here starts `careful` as well, as the setup wizard
# starts the one it makes (`beginInstall`, apps/engine/src/modules/setup/service.ts) — which it leaves alone once a file
# is there. An edit goes through `cat >`, so the file keeps its owner and its mode.
gateway_on() {
  go_file="$1"
  if [ ! -f "$go_file" ]; then
    install -o "$2" -g "$3" -m 640 /dev/null "$go_file"
    printf '[security]\napprovals = "careful"\n\n[nougate]\nin_process = true\n' > "$go_file"
    say "on: $go_file says [nougate] in_process = true"
    return 0
  fi
  go_tmp="$go_file.install.$$"
  case "$(gateway_state "$go_file")" in
    set) say "$go_file already says whether it is on ([nougate] in_process), left as it is"; return 0 ;;
    other) warn "$go_file sets the gateway in a form this does not edit: add in_process = true to its [nougate] by hand"; return 0 ;;
    table) awk 'done != 1 && /^[[:space:]]*\[[[:space:]]*nougate[[:space:]]*\][[:space:]]*(#.*)?$/ { print; print "in_process = true"; done = 1; next } { print }' "$go_file" > "$go_tmp" ;;
    none) { cat "$go_file"; [ -z "$(tail -c 1 "$go_file")" ] || echo; printf '\n[nougate]\nin_process = true\n'; } > "$go_tmp" ;;
  esac
  cat "$go_tmp" > "$go_file"
  rm -f "$go_tmp"
  say "on: $go_file says [nougate] in_process = true"
}
# <<< gateway on
# Pro builds are licensed and published only to the internal repository, never to the public
# download: fetching one here always 404'd, reading like a missing release rather than the wrong door.
case "$VARIANT" in
  pro)
    [ -n "$TARBALL" ] || die "the $VARIANT edition is not a public download. Build it (\`bun run build:pro --$VARIANT\`) or take it from the internal release, then pass --tarball PATH. A paired box updates itself." ;;
esac
# >>> identity
# A Pro server's licence (0.8.2): the device.json Nouverse's admin made for it, put where a box's flashed one is, so the
# daemon syncs, is licensed and takes its updates from Nouverse as a box does. Checked before anything on this machine
# changes; written once the data directory exists. Another licence is never written over the one an install holds — a
# server given a second would lose the one its updates come from — but the same one is: Nouverse's install link mints
# its secret afresh each time it is run, so a run after one that stopped half way brings a newer file for that id.
identity_id() { sed -n 's/.*"deviceId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1; }
check_identity() {
  ci_file="$1"; ci_data="$2"
  [ "$VARIANT" = "pro" ] || die "--identity is a Pro server's licence: pass --variant pro with it"
  { [ -f "$ci_file" ] && [ -r "$ci_file" ]; } || die "--identity $ci_file is not a file this can read"
  for ci_key in deviceId deviceSecret endpoint appUrl; do
    grep -q "\"$ci_key\"[[:space:]]*:[[:space:]]*\"[^\"]" "$ci_file" || die "--identity $ci_file is not a device.json from Nouverse: it has no $ci_key"
  done
  IDENTITY_ID=$(identity_id "$ci_file")
  if [ -f "$ci_data/appliance/device.json" ] && [ "$(identity_id "$ci_data/appliance/device.json")" != "$IDENTITY_ID" ]; then
    die "this install is licensed already, as $(identity_id "$ci_data/appliance/device.json") ($ci_data/appliance/device.json); remove that file first if $ci_file replaces it"
  fi
}
# place_identity <file> <data dir> <owner> <group>
place_identity() {
  install -d -o "$3" -g "$4" -m 700 "$2/appliance"
  install -o "$3" -g "$4" -m 600 "$1" "$2/appliance/device.json"
}
# <<< identity
if [ -n "$IDENTITY" ]; then check_identity "$IDENTITY" "$INSTALL_DIR/.nouride/data"; fi
# >>> download names
# Whose files a release is asked for. `router` asks for Community's own: from 0.8.28 Router's names hold the same bytes
# (scripts/release/router-alias.ts), so a new install never asks for Router's, and 0.9.0 drops those names without
# touching this path. Only a --version from before 0.8.28, when Router was a build of its own with the gateway in it,
# still downloads Router's.
router_build() {
  case "$1" in latest) return 1 ;; esac
  rb="${1#v}"; rb="${rb%%-*}"
  rb_major="${rb%%.*}"; rb_rest="${rb#*.}"; rb_minor="${rb_rest%%.*}"; rb_patch="${rb_rest#*.}"; rb_patch="${rb_patch%%.*}"
  [ "$rb_major" -eq 0 ] 2>/dev/null || return 1
  [ "$rb_minor" -lt 8 ] 2>/dev/null && return 0
  [ "$rb_minor" -eq 8 ] 2>/dev/null && [ "$rb_patch" -lt 28 ] 2>/dev/null
}
NAMES="$VARIANT"
if [ "$VARIANT" = "router" ] && ! router_build "$VERSION"; then NAMES=""; fi
# <<< download names
# One name, three URLs below plus this log line. Derived once because a suffix applied in some
# places and not others downloads the wrong build and reports the right one.
if [ -n "$NAMES" ]; then ARTIFACT="nouride-${NAMES}-${TARGET}"; else ARTIFACT="nouride-${TARGET}"; fi
say "architecture   $(uname -m)"
say "C library      $libc"
say "build          ${ARTIFACT}"
# A `case` rather than `[ ] || [ ] && say`. That chain leaves the list's exit status at 1 whenever
# both tests fail — which is the ordinary build, the common path — and whether `set -e` acts on it
# depends on the shell and on where the line sits. Not worth knowing: this says the same thing and
# has one status.
case "$VARIANT:$NAMES" in
  pro:*) say "bundled        LLM gateway + multi-user accounts, Nouverse sign-in, Box pairing" ;;
  router:) say "Router is part of Nouride Community now: this installs Community, with its LLM gateway switched on" ;;
  router:*) say "a release from before Router joined Community: this installs Router's own build, its LLM gateway on" ;;
esac

command -v systemctl >/dev/null 2>&1 && HAS_SYSTEMD=1 || HAS_SYSTEMD=0
if [ "$OS" = "Darwin" ]; then
  command -v launchctl >/dev/null 2>&1 && HAS_LAUNCHD=1 || HAS_LAUNCHD=0
  [ "$HAS_LAUNCHD" = "1" ] || warn "no launchctl found, so the daemon will be installed but not supervised"
else
  HAS_LAUNCHD=0
  [ "$HAS_SYSTEMD" = "1" ] || warn "no systemd here, so the daemon will be installed but not supervised"
fi

# ── The tarball ──────────────────────────────────────────────────────────────
# Prefer /var/tmp over /tmp if TMPDIR is unset: single-board computers (like Raspberry Pi)
# and containers frequently mount /tmp as a tiny tmpfs in RAM (e.g. 200MB), which runs out
# of disk space during extraction of large binaries.
if [ -z "${TMPDIR:-}" ] && [ -d "/var/tmp" ]; then
  TMPDIR="/var/tmp"
  export TMPDIR
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ── Is it the release Nouverse published ─────────────────────────────────────
#
# This runs as root, and installed whatever the download said it was — while `nouride update`, unprivileged,
# refused the same file unsigned. The chain is the update's (packages/update/src/signing.ts): the checksum file
# is signed, the tarball is checked against it, and where the file came from is no part of it.
#
# The keys are the ones compiled into Nouride; a test holds this copy to that list.
# >>> release keys
RELEASE_KEYS='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnm2hXYQAFI/oKB065wPWCyew0ZxILlSkhE1KFK7cvBw=
-----END PUBLIC KEY-----'
# <<< release keys

# >>> verify release
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Whether this openssl can check an Ed25519 signature over raw bytes — 3.0 and later.
openssl_verifies() {
  command -v openssl >/dev/null 2>&1 && openssl pkeyutl -help 2>&1 | grep -q -- '-rawin'
}

# verify_release <tarball> <checksum file> <signature file, or empty> <artifact name>
# Returns when the tarball is the one the checksum file names and the file is signed by a release key; dies otherwise.
verify_release() {
  vr_tarball="$1"; vr_sums="$2"; vr_sig="$3"; vr_name="$4"
  VERIFIED_SIGNATURE=0
  if [ -n "$vr_sig" ]; then
    if openssl_verifies; then
      vr_keys="$(mktemp -d)"
      printf '%s\n' "$RELEASE_KEYS" | awk -v dir="$vr_keys" '/BEGIN PUBLIC KEY/ { n++ } { print > (dir "/key" n ".pem") }'
      tr -d ' \n\r' < "$vr_sig" | openssl base64 -d -A > "$vr_keys/sig.bin" 2>/dev/null
      vr_ok=0
      for vr_key in "$vr_keys"/key*.pem; do
        if openssl pkeyutl -verify -pubin -inkey "$vr_key" -rawin -in "$vr_sums" -sigfile "$vr_keys/sig.bin" >/dev/null 2>&1; then
          vr_ok=1
        fi
      done
      rm -rf "$vr_keys"
      [ "$vr_ok" = "1" ] || die "the release's checksum file is not signed by Nouverse; refusing to install it"
      VERIFIED_SIGNATURE=1
    else
      warn "no openssl 3 here to check the release's signature, so its checksum is checked against an unverified file"
    fi
  fi
  vr_want="$(awk -v name="$vr_name.tar.gz" '{ file = $2; sub(/^\*/, "", file); sub(/^\.\//, "", file); if (file == name) print $1 }' "$vr_sums")"
  [ -n "$vr_want" ] || die "$vr_name.tar.gz is not in the release's checksum file; refusing it"
  vr_have="$(sha256_of "$vr_tarball")"
  [ "$vr_want" = "$vr_have" ] || die "checksum mismatch for $vr_name.tar.gz: the release says $vr_want, the download is $vr_have"
}

# sums_listing <directory> <tarball file name> — prints the checksum file in that directory that lists the tarball, if
# one does: `SHA256SUMS` beside a public edition's tarball, `SHA256SUMS-<edition>` beside the others, and from 0.8.0
# `CHECKSUMS` and `CHECKSUMS-<edition>` (sums_base_for). Found by what it lists rather than by `--variant`, which a
# `--tarball` install of a Pro build could leave out — and then the install looked for `SHA256SUMS`, found none, and
# checked nothing.
sums_listing() {
  for sl_file in "$1/CHECKSUMS" "$1"/CHECKSUMS-* "$1/SHA256SUMS" "$1"/SHA256SUMS-*; do
    case "$sl_file" in *.sig) continue ;; esac
    [ -f "$sl_file" ] || continue
    if awk -v name="$2" '{ file = $2; sub(/^\*/, "", file); sub(/^\.\//, "", file); if (file == name) found = 1 } END { exit !found }' "$sl_file"; then
      printf '%s' "$sl_file"
      return 0
    fi
  done
  return 1
}

# Whether a release must be signed: `latest`, and every tag from v0.7.4, the first one signed.
must_be_signed() {
  case "$1" in latest) return 0 ;; esac
  mbs="${1#v}"; mbs="${mbs%%-*}"
  mbs_major="${mbs%%.*}"; mbs_rest="${mbs#*.}"; mbs_minor="${mbs_rest%%.*}"; mbs_patch="${mbs_rest#*.}"
  case "$mbs_major$mbs_minor$mbs_patch" in *[!0-9]*|"") return 0 ;; esac
  [ "$mbs_major" -gt 0 ] || [ "$mbs_minor" -gt 7 ] || { [ "$mbs_minor" -eq 7 ] && [ "$mbs_patch" -ge 4 ]; }
}
# <<< verify release

# ── Has this install crossed the release's floor ─────────────────────────────
#
# 0.8.0 upgrades only from the last 0.7.x, and every release after it only from 0.8.0: the floor, whose one start carries
# the data across. A release says so in its checksum file — `# nouride-min-version: 0.7.14`, inside what the signature
# covers — and every version from 0.7.11 records the version that last started in the data directory
# (`apps/engine/src/boot/last-run.ts`, whose file name a test holds this copy to). An install whose data has not been through the floor's version is refused, before anything on this
# machine changes; one with data and no record ran something older than 0.7.11. A fresh install has nothing to carry
# across, and is never refused.
# >>> upgrade floor
LAST_RUN_FILE="last-run-version"

# release_floor <checksum file> — the floor it declares, or nothing.
release_floor() {
  tr -d '\r' < "$1" | sed -n 's/^#[[:space:]]*nouride-min-version:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' | head -n 1
}

is_version() { printf '%s\n' "${1#v}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; }

# version_below A B — whether A is below B: by the three numbers, and a pre-release below its own release.
version_below() {
  vb_a="${1#v}"; vb_b="${2#v}"; vb_ap=""; vb_bp=""
  case "$vb_a" in *-*) vb_ap="${vb_a#*-}"; vb_a="${vb_a%%-*}" ;; esac
  case "$vb_b" in *-*) vb_bp="${vb_b#*-}"; vb_b="${vb_b%%-*}" ;; esac
  for vb_i in 1 2 3; do
    vb_x=$(printf '%s' "$vb_a" | cut -d. -f"$vb_i"); vb_y=$(printf '%s' "$vb_b" | cut -d. -f"$vb_i")
    if [ "$vb_x" -lt "$vb_y" ]; then return 0; fi
    if [ "$vb_x" -gt "$vb_y" ]; then return 1; fi
  done
  [ -n "$vb_ap" ] && [ -z "$vb_bp" ]
}

# check_floor <checksum file> <data directory> — returns when this release may be installed over that data; dies
# saying which version to install first otherwise.
check_floor() {
  cf_floor="$(release_floor "$1")"
  [ -n "$cf_floor" ] || return 0
  [ -f "$2/nouride.db" ] || return 0
  is_version "$cf_floor" || die "this release declares a minimum version this script cannot read ($cf_floor); refusing it"
  cf_floor="${cf_floor#v}"
  case "$VARIANT" in
    pro) cf_how="take it from the internal release" ;;
    *) cf_how="sh install.sh --version v$cf_floor" ;;
  esac
  cf_last=""
  [ -f "$2/$LAST_RUN_FILE" ] && cf_last="$(head -n 1 "$2/$LAST_RUN_FILE" | tr -d ' \r')"
  if [ -z "$cf_last" ] || ! is_version "$cf_last"; then
    die "this release upgrades only from $cf_floor, and this install has data with no record of the version that last ran it (a release before 0.7.11). Install $cf_floor first ($cf_how), start it once, then install this one."
  fi
  if version_below "$cf_last" "$cf_floor"; then
    die "this release upgrades only from $cf_floor, and this install last ran ${cf_last#v}. Install $cf_floor first ($cf_how), start it once, then install this one."
  fi
}
# <<< upgrade floor

# >>> downloads
# Every download is tried again when it fails for a moment: five tries, 2, 5, 10 and 20 seconds apart (NOURIDE_FETCH_WAITS
# sets the pauses; the tests give none). A transfer that stalls is cut so it can be tried again, and the tarball goes on
# from the bytes it already has. Phones on a home Wi-Fi lost the 57 MB tarball midway on every first start, and one try
# ended the install there. A 404 or 410 is an answer, and is not tried again.
FETCH_WAITS="${NOURIDE_FETCH_WAITS:-2 5 10 20}"

# fetch_once <url> <file> [resume] — one try. Prints `ok`, `missing` (a 404 or 410, or a file:// that is not there), or
# what failed instead (`HTTP 504`, `no answer`, `cut off midway`). With `resume`, it goes on from the file's bytes and
# keeps what came if it fails; otherwise what was written for a failure is removed. A server's error page is never
# written into the file (`--fail`), so going on from it never appends one.
fetch_once() {
  fo_exit=0
  fo_resume=""
  if command -v curl >/dev/null 2>&1; then
    [ "${3:-}" = "resume" ] && [ -s "$2" ] && fo_resume="-C -"
    # shellcheck disable=SC2086
    fo_code="$(curl -sSLf --connect-timeout 20 --speed-limit 1024 --speed-time 30 $fo_resume -o "$2" -w '%{http_code}' "$1" 2>/dev/null)" || fo_exit=$?
  else
    [ "${3:-}" = "resume" ] && [ -s "$2" ] && fo_resume="-c"
    # shellcheck disable=SC2086
    wget -S -T 30 -t 1 $fo_resume -O "$2" "$1" 2>"$2.headers" || fo_exit=$?
    fo_code="$(awk '/^ *HTTP\//{c=$2} END{print c}' "$2.headers" 2>/dev/null)"
    rm -f "$2.headers"
  fi
  case "$fo_code" in
    2??) [ "$fo_exit" -eq 0 ] && { echo ok; return 0; } ;;
    404 | 410) rm -f "$2"; echo missing; return 1 ;;
    # Asked to go on from a file that was already whole.
    416) [ -n "$fo_resume" ] && { echo ok; return 0; } ;;
  esac
  if [ "$fo_exit" -eq 0 ] && { [ -z "$fo_code" ] || [ "$fo_code" = "000" ]; }; then echo ok; return 0; fi
  [ "${3:-}" = "resume" ] || rm -f "$2"
  case "$1" in file://*) rm -f "$2"; echo missing; return 1 ;; esac
  case "$fo_code" in
    2??) echo "cut off midway" ;;
    "" | 000) echo "no answer" ;;
    *) echo "HTTP $fo_code" ;;
  esac
  return 1
}

# fetch_status <url> <file> [resume] — the download, tried again on any failure but `missing`, each failed try said on
# one line. Prints `ok`, `missing`, or the last failure and how many tries it took (`HTTP 504, 5 tries`). A release's
# checksum file that GitHub failed to serve for a moment was once reported as one the release does not have, which
# reads as an unsigned release: only a file that is not there is said to be missing.
fetch_status() {
  fr_try=1
  for fr_wait in $FETCH_WAITS ""; do
    fr_how="$(fetch_once "$1" "$2" "${3:-}")" && { echo ok; return 0; }
    [ "$fr_how" = "missing" ] && { echo missing; return 1; }
    [ -z "$fr_wait" ] && break
    warn "download try $fr_try failed ($fr_how): $1; trying again in ${fr_wait}s"
    sleep "$fr_wait"
    fr_try=$((fr_try + 1))
  done
  if [ "$fr_try" -gt 1 ]; then echo "$fr_how, $fr_try tries"; else echo "$fr_how"; fi
  return 1
}
# The refusal for a download that failed, as against one that is not there: the release is not at fault, and the same
# command a few minutes later usually works.
fetch_failed() {
  die "could not download $1 ($2), so nothing was installed. The connection or GitHub failed for a moment: run the same command again in a few minutes"
}
# <<< downloads

# >>> checksum names
# sums_base_for <tag> — the name of a release's checksum files: `SHA256SUMS` through 0.7.x, `CHECKSUMS` from 0.8.0, and
# nothing for `latest`, which is whichever release is newest. 0.8.0 upgrades only from the last 0.7.x, and the updaters
# from before 0.7.11 know no floor: they pick a release by `SHA256SUMS`, so 0.8.0 carries none and they stop at the last
# 0.7.x, whose updater knows this name (`CHECKSUMS_RENAMED_IN`, packages/update/src/edition.ts).
sums_base_for() {
  case "$1" in latest) return 0 ;; esac
  sb="${1#v}"; sb="${sb%%-*}"
  sb_major="${sb%%.*}"; sb_rest="${sb#*.}"; sb_minor="${sb_rest%%.*}"
  if [ "$sb_major" -gt 0 ] 2>/dev/null || [ "$sb_minor" -ge 8 ] 2>/dev/null; then printf 'CHECKSUMS'; else printf 'SHA256SUMS'; fi
}

# fetch_sums <release directory URL> <tag or latest> <variant> <stage> — downloads the release's checksum file into the
# stage and sets SUMS to its name. For `latest`, the newest release's name: `CHECKSUMS` when it carries one, which every
# release from 0.8.0 does, and `SHA256SUMS` otherwise.
fetch_sums() {
  fs_base="$(sums_base_for "$2")"
  if [ -z "$fs_base" ]; then
    fs_base="CHECKSUMS"
    if ! fs_how="$(fetch_status "$1/$fs_base${3:+-$3}" "$4/$fs_base${3:+-$3}")"; then
      [ "$fs_how" = "missing" ] || fetch_failed "$fs_base${3:+-$3}" "$fs_how"
      fs_base="SHA256SUMS"
    fi
  fi
  SUMS="$fs_base${3:+-$3}"
  [ -f "$4/$SUMS" ] && return 0
  fs_how="$(fetch_status "$1/$SUMS" "$4/$SUMS")" && return 0
  [ "$fs_how" = "missing" ] || fetch_failed "$SUMS" "$fs_how"
  die "the release has no $SUMS; refusing to install what nothing vouches for"
}
# <<< checksum names

step "Fetching the release"
# The checksum file the tarball was checked against, whose floor is read below. None for a build of one's own.
FLOOR_SUMS=""
if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "no such file: $TARBALL"
  say "using $TARBALL"
  cp "$TARBALL" "$STAGE/nouride.tar.gz"
  # Checked when its release's checksum file sits beside it, as it does when both were downloaded together — and its
  # signature with it, which every release from v0.7.4 carries, the Pro ones on the internal release from v0.7.10. A
  # build of your own has neither, and there is nothing to check it against.
  if sums="$(sums_listing "$(dirname "$TARBALL")" "$(basename "$TARBALL")")"; then
    sig=""
    [ -f "$sums.sig" ] && sig="$sums.sig"
    verify_release "$STAGE/nouride.tar.gz" "$sums" "$sig" "$(basename "$TARBALL" .tar.gz)"
    FLOOR_SUMS="$sums"
    if [ "$VERIFIED_SIGNATURE" = "1" ]; then
      say "checked against $sums, signed by Nouverse"
    elif [ -z "$sig" ]; then
      warn "checked against $sums alone: no $(basename "$sums").sig beside it, so nothing says Nouverse published that file"
    else
      say "checked against $sums"
    fi
  else
    say "not checked: no checksum file beside it lists $(basename "$TARBALL")"
  fi
else
  if [ "$FROM_REPO" = "1" ]; then
    if [ "$VERSION" = "latest" ]; then
      url="https://github.com/${REPO}/releases/latest/download/${ARTIFACT}.tar.gz"
    else
      url="https://github.com/${REPO}/releases/download/${VERSION}/${ARTIFACT}.tar.gz"
    fi
  else
    # `latest` is a path segment rather than a redirect, so the same URL shape serves a channel and a
    # tag and there is nothing to special-case here.
    url="${BASE_URL%/}/${VERSION}/${ARTIFACT}.tar.gz"
  fi
  say "downloading $url"
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "neither curl nor wget is installed"
  if [ "$OS" = "Darwin" ]; then dl_hint="a release before macOS builds were published carries none for a Mac: build one here (\`bun run build:binary --target ${TARGET}\`) and pass --tarball"; else dl_hint="if no release exists yet, build one and pass --tarball"; fi
  if ! dl_how="$(fetch_status "$url" "$STAGE/nouride.tar.gz" resume)"; then
    [ "$dl_how" = "missing" ] && die "there is no ${ARTIFACT}.tar.gz at $url: $dl_hint"
    fetch_failed "$url" "$dl_how"
  fi
  # The release's checksum file and its signature, from beside the tarball.
  fetch_sums "${url%/*}" "$VERSION" "$NAMES" "$STAGE"
  sig=""
  if must_be_signed "$VERSION"; then
    if ! sig_how="$(fetch_status "${url%/*}/$SUMS.sig" "$STAGE/$SUMS.sig")"; then
      [ "$sig_how" = "missing" ] || fetch_failed "$SUMS.sig" "$sig_how"
      die "the release has no signature for $SUMS, which every release from v0.7.4 has; refusing it"
    fi
    sig="$STAGE/$SUMS.sig"
  fi
  verify_release "$STAGE/nouride.tar.gz" "$STAGE/$SUMS" "$sig" "$ARTIFACT"
  FLOOR_SUMS="$STAGE/$SUMS"
  if [ "$VERIFIED_SIGNATURE" = "1" ]; then say "checked against its $SUMS, signed by Nouverse"; else say "checked against its $SUMS"; fi
fi

# Before anything on this machine changes: a release whose floor this install's data has not crossed.
if [ -n "$FLOOR_SUMS" ]; then check_floor "$FLOOR_SUMS" "$INSTALL_DIR/.nouride/data"; fi

tar -xzf "$STAGE/nouride.tar.gz" -C "$STAGE"
rm -f "$STAGE/nouride.tar.gz"
[ -x "$STAGE/nouride" ] || die "the tarball has no \`nouride\` executable in it"
# The dashboard is a directory of hash-named assets, so it cannot be compiled in and is loaded from
# beside the executable. Shipping one without the other gives a daemon whose UI 404s.
[ -d "$STAGE/dashboard" ] || warn "no dashboard/ in the tarball, so the web UI will not be served"
# WhatsApp is inside `nouride` in every edition, which the build proves of each artefact it makes, so there is
# nothing beside it to look for.
[ -d "$STAGE/skills" ] || warn "no skills/ in the tarball, so the built-in skills will not be available"

# ── The account ──────────────────────────────────────────────────────────────
#
# Not root, and `nouride service install` refuses to write a unit that runs as root anyway: this daemon
# executes commands chosen by a language model, reachable from a chat app. Every other boundary in it
# assumes an unprivileged account.
step "Service account and directory"
if [ "$OS" = "Darwin" ]; then
  say "running as user $SERVICE_USER"
  mkdir -p "$INSTALL_DIR"
else
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    say "user $SERVICE_USER already exists"
  else
    # Its home is the agents' HOME, `.nouride/home` (made below): OpenSSH reads `~/.ssh/config` from the home
    # /etc/passwd gives, not from `$HOME`, so one home is the only way one ssh config holds (0.7.17).
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --no-create-home --home-dir "$INSTALL_DIR/.nouride/home" --shell /usr/sbin/nologin "$SERVICE_USER"
    else
      # Alpine without `shadow`: busybox's own, with the group `useradd --system` would have made beside the account.
      # Without this the install stopped here, on the one system the docs name a build for (`install-run.sh`, 0.8.18).
      addgroup -S "$SERVICE_USER" 2>/dev/null || true
      adduser -S -D -H -h "$INSTALL_DIR/.nouride/home" -s /sbin/nologin -G "$SERVICE_USER" "$SERVICE_USER"
    fi
    say "created user $SERVICE_USER"
  fi

  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    if id "$SUDO_USER" >/dev/null 2>&1; then
      usermod -aG "$SERVICE_USER" "$SUDO_USER" 2>/dev/null || true
      say "added $SUDO_USER to group $SERVICE_USER (run CLI commands without sudo)"
    fi
  fi

  mkdir -p "$INSTALL_DIR"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"
  chmod 755 "$INSTALL_DIR"
fi
say "install directory $INSTALL_DIR"

# ── Binary ───────────────────────────────────────────────────────────────────
#
# Stopped first: replacing the executable of a running process is how you get a daemon that is half
# the old version until something restarts it.
UPGRADE=0
[ -x "$INSTALL_DIR/nouride" ] && UPGRADE=1
AGENT_HOME_FOR_LAUNCHER="$INSTALL_DIR/.nouride/home"
# Root's file for the secret store's key (0.8.19), read by the unit and by the launcher below: "Secret store key".
SYSTEM_KEY_FILE=/etc/nouride/nouride.env
if [ "$UPGRADE" = "1" ]; then
  if [ "$HAS_SYSTEMD" = "1" ] && systemctl is-active --quiet nouride 2>/dev/null; then
    step "Stopping the running daemon"
    systemctl stop nouride
    say "stopped"
  elif [ "$OS" = "Darwin" ] && [ -f "$USER_HOME/Library/LaunchAgents/tech.nouverse.nouride.plist" ]; then
    step "Stopping the running daemon"
    launchctl unload "$USER_HOME/Library/LaunchAgents/tech.nouverse.nouride.plist" 2>/dev/null || true
    say "stopped"
  fi
fi

# >>> swapped
# What an upgrade replaces beside the binary, and keeps the old copy of: the engine's `SWAPPED`
# (apps/engine/src/service/update-guard.ts), which `nouride update` swaps and the unit's guard puts back. A test holds
# this copy to that list, as it does the release keys above: a script piped to a shell cannot import it. `pkg/` is not
# in it — that is installed as root, outside the install directory, further down.
SWAPPED="nouride dashboard skills frontend run config.example.toml"

# The build being replaced goes to `.nouride-previous/`, where `nouride update` keeps it too, so
# `nouride update --rollback` puts back this one and not whatever an earlier update left there. Moved,
# with the daemon stopped, and only what this tarball replaces. The same build again is a reinstall, and
# what came before it stays the way back. `release.json` says which version put it aside — the old
# binary is not run to ask its own: it is the service account's, and this is root. An update still
# waiting to be confirmed is superseded by this install, so the unit's guard is not left to act on it.
keep_previous() {
  if cmp -s "$STAGE/nouride" "$INSTALL_DIR/nouride"; then return 0; fi
  prev="$INSTALL_DIR/.nouride-previous"
  # Another build of the version the kept one was put aside for — a fix to the same release: the way back is
  # still the version before it, so that one stays, and this build is simply replaced.
  kept_by=$(sed -n 's/.*"by":"v\{0,1\}\([^"]*\)".*/\1/p' "$prev/release.json" 2>/dev/null || true)
  if [ -n "$1" ] && [ "$kept_by" = "${1#v}" ]; then return 0; fi
  rm -rf "$prev"
  mkdir -p "$prev"
  for f in $SWAPPED; do
    if [ -e "$STAGE/$f" ] && [ -e "$INSTALL_DIR/$f" ]; then mv "$INSTALL_DIR/$f" "$prev/$f"; fi
  done
  printf '{"version":null,"by":"%s","at":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$prev/release.json"
  rm -f "$INSTALL_DIR/.nouride-pending-update" "$INSTALL_DIR/.nouride-pending-update.attempts"
  if [ "$(id -u)" = 0 ]; then chown -R "$SERVICE_USER:$SERVICE_GROUP" "$prev"; fi
  say "kept the build it replaces in $prev"
}

# Everything in SWAPPED but the binary, from the release into the install directory, each only when the release
# carries it — the Router editions' `frontend/`, say. Given to the service account, which is what lets
# `nouride update` replace it later without root.
install_beside() {
  for f in $SWAPPED; do
    if [ "$f" = nouride ] || [ ! -e "$STAGE/$f" ]; then continue; fi
    rm -rf "${INSTALL_DIR:?}/$f"
    cp -R "$STAGE/$f" "$INSTALL_DIR/$f"
    if [ "$(id -u)" = 0 ]; then chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/$f"; fi
  done
}
# <<< swapped
if [ "$UPGRADE" = "1" ]; then keep_previous "$("$STAGE/nouride" --version 2>/dev/null | grep -E '^v?[0-9]+[.][0-9]+[.][0-9]+' | head -n 1)"; fi

step "$([ "$UPGRADE" = "1" ] && echo "Upgrading" || echo "Installing") the binary"
if [ "$OS" = "Darwin" ]; then
  cp -p "$STAGE/nouride" "$INSTALL_DIR/nouride"
  chmod 755 "$INSTALL_DIR/nouride"
  xattr -dr com.apple.quarantine "$INSTALL_DIR/nouride" 2>/dev/null || true
  install_beside

  if [ -w "/usr/local/bin" ]; then
    ln -sf "$INSTALL_DIR/nouride" /usr/local/bin/nouride
    say "installed $INSTALL_DIR/nouride (also on PATH as \`nouride\`)"
  elif [ -d "$USER_HOME/.local/bin" ]; then
    ln -sf "$INSTALL_DIR/nouride" "$USER_HOME/.local/bin/nouride"
    say "installed $INSTALL_DIR/nouride (also on PATH as ~/.local/bin/nouride)"
  else
    say "installed $INSTALL_DIR/nouride"
  fi
else
  install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 755 "$STAGE/nouride" "$INSTALL_DIR/nouride"
  install_beside
  # The second executable an install from before 2026-09-16 kept beside the binary. Every edition carries the bridge
  # inside `nouride` since then, nothing runs this, and `nouride update` never removed it.
  if [ -d "$INSTALL_DIR/wa-bridge" ]; then
    rm -rf "$INSTALL_DIR/wa-bridge"
    say "removed the standalone wa-bridge an older install left: the bridge is inside nouride"
  fi

  # `nouride` on PATH is a launcher, not a link. The binary belongs to the service account, which is what
  # lets `nouride update` replace it without root — and every command the agents run is that account too.
  # A link made root run a file those commands could rewrite; the launcher runs the CLI as the service
  # account instead, which also keeps what the CLI writes into .nouride/ owned by the daemon. Root-owned,
  # outside the install directory, for the same reason nouride-pkg is.
  rm -f /usr/local/bin/nouride
  cat > /usr/local/bin/nouride <<LAUNCHER
#!/bin/sh
# Written by install.sh. Run by root, the CLI runs as $SERVICE_USER: the binary is that account's, so
# root never runs a file another account can change. Anyone else runs it as themselves.
bin='$INSTALL_DIR/nouride'
if [ "\$(id -u)" = 0 ]; then
  # The secret store's key is root's file, which $SERVICE_USER cannot read: handed over in the environment, never as
  # an argument, so decrypt, restore and a rollback find it as the service does. The CLI takes it out of its own
  # environment as it starts, so nothing it runs inherits it.
  key=\$(grep -E '^[[:space:]]*(export[[:space:]]+)?NOURIDE_ENCRYPTION_KEY[[:space:]]*=' '$SYSTEM_KEY_FILE' 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "\"' \t\r")
  if [ -n "\$key" ]; then NOURIDE_ENCRYPTION_KEY=\$key; export NOURIDE_ENCRYPTION_KEY; fi
  unset key
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid='$SERVICE_USER' --regid='$SERVICE_USER' --init-groups -- \\
      /usr/bin/env HOME='$AGENT_HOME_FOR_LAUNCHER' USER='$SERVICE_USER' LOGNAME='$SERVICE_USER' "\$bin" "\$@"
  elif command -v runuser >/dev/null 2>&1; then
    exec runuser -u '$SERVICE_USER' -- \\
      /usr/bin/env HOME='$AGENT_HOME_FOR_LAUNCHER' USER='$SERVICE_USER' LOGNAME='$SERVICE_USER' "\$bin" "\$@"
  elif command -v su-exec >/dev/null 2>&1; then
    exec su-exec '$SERVICE_USER' \\
      /usr/bin/env HOME='$AGENT_HOME_FOR_LAUNCHER' USER='$SERVICE_USER' LOGNAME='$SERVICE_USER' "\$bin" "\$@"
  fi
  # Nothing here can drop to the service account, and running its binary as root is the one thing this
  # launcher exists to prevent: that account — every command an agent runs — can replace the file.
  echo "nouride: nothing on this host can run it as $SERVICE_USER (setpriv, runuser or su-exec)." >&2
  echo "Run it as $SERVICE_USER instead, or install one: util-linux, or su-exec on Alpine." >&2
  exit 1
fi
exec "\$bin" "\$@"
LAUNCHER
  chown root:root /usr/local/bin/nouride
  chmod 755 /usr/local/bin/nouride
  say "installed $INSTALL_DIR/nouride (on PATH as \`nouride\`, which root runs as $SERVICE_USER)"
fi
say "version $("$INSTALL_DIR/nouride" --version 2>/dev/null || echo 'unknown (the binary did not run)')"

# ── Credentials file ─────────────────────────────────────────────────────────
#
# Created *before* the unit is generated: `nouride service install` only writes `EnvironmentFile=` when
# the file already exists, so the order here is what decides whether the service can ever see a key.
step "Environment file"
if [ -f "$INSTALL_DIR/.env" ]; then
  say ".env already there, left alone"
else
  if [ "$OS" = "Darwin" ]; then
    touch "$INSTALL_DIR/.env"
    chmod 600 "$INSTALL_DIR/.env"
  else
    install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 600 /dev/null "$INSTALL_DIR/.env"
  fi
  say "created $INSTALL_DIR/.env (0600)"
fi

# >>> env file
# set_env KEY VALUE — KEY=VALUE in .env, in place of a line already there. Called only for a flag given on this run:
# a value .env has and no flag names stays the operator's. `--host 0.0.0.0` on an existing install used to leave HOST
# alone ("already set — left alone") and then print a network URL for a daemon that stayed on loopback. Rewritten
# through `cat >`, so the file keeps its owner and its 0600, and the copy beside it is made under umask 077: .env holds
# credentials.
set_env() {
  key="$1"; value="$2"
  if grep -q "^${key}=" "$INSTALL_DIR/.env" 2>/dev/null; then
    se_tmp="$INSTALL_DIR/.env.install.$$"
    (umask 077; { grep -v "^${key}=" "$INSTALL_DIR/.env" || true; printf '%s=%s\n' "$key" "$value"; } > "$se_tmp")
    cat "$se_tmp" > "$INSTALL_DIR/.env"
    rm -f "$se_tmp"
    say "set $key=$value, in place of what .env had"
  else
    printf '%s=%s\n' "$key" "$value" >>"$INSTALL_DIR/.env"
    say "set $key=$value"
  fi
}

# env_value KEY DEFAULT — what .env says KEY is, the last line winning as it does for the daemon, or DEFAULT. The
# health probe and the closing URL use what the daemon will, not this run's flags: a re-run without the first run's
# --port probed the default port and warned about a daemon that was answering on its own.
env_value() {
  ev=$(sed -n "s/^$1=//p" "$INSTALL_DIR/.env" 2>/dev/null | tail -n 1)
  ev=${ev#\"}; ev=${ev%\"}
  if [ -n "$ev" ]; then printf '%s' "$ev"; else printf '%s' "$2"; fi
}
# <<< env file

if [ "$HOST_GIVEN" = "1" ]; then set_env HOST "$BIND_HOST"; fi
if [ "$PORT_GIVEN" = "1" ]; then set_env PORT "$PORT"; fi
BIND_HOST=$(env_value HOST "")
PORT=$(env_value PORT 18254)

# ── The secret store's key ───────────────────────────────────────────────────
#
# Since 0.8.19 the secret store is encrypted, and what that is worth is how far its key is from the data. Here it is
# kept outside the install: on Linux with systemd, root's /etc/nouride/nouride.env, which systemd reads before it starts
# the service as its account (the unit's `EnvironmentFile=-`), so that account never reads the file and a copy of the
# install folder carries no key; on a Mac, ~/.config/nouride/nouride.env, outside the install folder. Made once, never
# over one that is there. A key the daemon made itself on an install that only updated (a line in .env, or
# .nouride/encryption.key) is moved here as it is: the same key, so nothing has to be encrypted again.
step "Secret store key"
KEY_VAR=NOURIDE_ENCRYPTION_KEY
KEY_NOTE="# Nouride: the secret store key. Keep a copy: without it, or the backup passphrase, the store cannot be opened."
if [ "$OS" = "Darwin" ]; then
  KEY_FILE="$USER_HOME/.config/nouride/nouride.env"
elif [ "$HAS_SYSTEMD" = "1" ]; then
  KEY_FILE=$SYSTEM_KEY_FILE
else
  KEY_FILE=""
fi
# key_in FILE: the key a file of KEY=value lines holds, the last line winning, as for systemd.
key_in() { grep -E "^${KEY_VAR}=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2-; }
if [ -z "$KEY_FILE" ]; then
  say "no systemd here: the daemon keeps the key itself, and \`nouride doctor\` says where"
elif [ -n "$(key_in "$KEY_FILE")" ]; then
  say "kept in $KEY_FILE, left alone"
else
  KEY_FROM=""
  KEY=$(key_in "$INSTALL_DIR/.env")
  if [ -n "$KEY" ]; then
    KEY_FROM="$INSTALL_DIR/.env"
  elif [ -s "$INSTALL_DIR/.nouride/encryption.key" ]; then
    KEY=$(head -n 1 "$INSTALL_DIR/.nouride/encryption.key")
    KEY_FROM="$INSTALL_DIR/.nouride/encryption.key"
  else
    KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
  fi
  KEY_DIR=$(dirname "$KEY_FILE")
  if [ "$OS" = "Darwin" ]; then
    mkdir -p "$KEY_DIR"
    chown "$SERVICE_USER" "$USER_HOME/.config" "$KEY_DIR" 2>/dev/null || true
  else
    install -d -o root -g root -m 755 "$KEY_DIR"
  fi
  (umask 077; printf '%s\n%s=%s\n' "$KEY_NOTE" "$KEY_VAR" "$KEY" > "$KEY_FILE.install.$$")
  if [ "$OS" = "Darwin" ]; then chown "$SERVICE_USER" "$KEY_FILE.install.$$" 2>/dev/null || true; else chown root:root "$KEY_FILE.install.$$"; fi
  chmod 600 "$KEY_FILE.install.$$"
  mv "$KEY_FILE.install.$$" "$KEY_FILE"
  [ "$(key_in "$KEY_FILE")" = "$KEY" ] || die "could not write the secret store key to $KEY_FILE"
  if [ "$KEY_FROM" = "$INSTALL_DIR/.env" ]; then
    # Rewritten through `cat >`, so .env keeps its owner and its 0600; the note the daemon wrote above its line goes too.
    ke_tmp="$INSTALL_DIR/.env.install.$$"
    (umask 077; grep -v -E "^${KEY_VAR}=" "$INSTALL_DIR/.env" | grep -v -F "# The secret store's key (Nouride" > "$ke_tmp" || true)
    cat "$ke_tmp" > "$INSTALL_DIR/.env"
    rm -f "$ke_tmp"
  elif [ -n "$KEY_FROM" ]; then
    rm -f "$KEY_FROM"
  fi
  if [ -n "$KEY_FROM" ]; then
    say "moved the key from $KEY_FROM to $KEY_FILE (0600): the same key, so nothing is encrypted again"
  else
    say "made $KEY_FILE (0600): keep a copy somewhere safe, or set a backup passphrase (nouride secret seal --stdin)"
  fi
fi

# ── A home the service can write to ──────────────────────────────────────────
#
# The unit sets HOME to `.nouride/home`, because `ProtectHome=read-only` makes the service user's real
# home unwritable — and inside `.nouride/`, because what lives there is state the agents built: ssh keys
# and config, known hosts, a CLI they logged in to. Copying `.nouride/` then moves an install whole.
#
# Until 0.6 HOME was the install directory itself, and before that the service user's own home. What
# either held is copied across once — never over something already there, and never removed from where
# it was, so a downgrade still finds it. This runs on every upgrade.
step "Home directory for the service"
# >>> home
AGENT_HOME="$INSTALL_DIR/.nouride/home"
# `.nouride/` itself only if missing: its mode on an existing install is the operator's.
[ -d "$INSTALL_DIR/.nouride" ] || install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$INSTALL_DIR/.nouride"
# The data directory too, before the daemon makes it with its own default mode: open to every account until the
# chmod after the health wait, which a slow first boot never reached. On macOS as well: the LaunchAgent writes the
# daemon's output to `.nouride/data/nouride.log`, and launchd never creates the directory above a log — so the first
# boot's output, the one-time admin password with it, went nowhere.
if [ ! -d "$INSTALL_DIR/.nouride/data" ]; then
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 750 "$INSTALL_DIR/.nouride/data"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 700 "$AGENT_HOME"
if [ -n "${IDENTITY:-}" ]; then
  place_identity "$IDENTITY" "$INSTALL_DIR/.nouride/data" "$SERVICE_USER" "$SERVICE_GROUP"
  say "licensed by Nouverse as ${IDENTITY_ID}; its updates come from Nouverse"
fi
SERVICE_HOME=$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6)
carried=""
for old in "$INSTALL_DIR" "$SERVICE_HOME"; do
  [ -n "$old" ] && [ -d "$old" ] || continue
  for entry in .ssh .gitconfig .config .local .npmrc .netrc .docker .kube .aws .gnupg; do
    if [ -e "$old/$entry" ] && [ ! -e "$AGENT_HOME/$entry" ]; then
      cp -a "$old/$entry" "$AGENT_HOME/$entry"
      carried="$carried $entry"
    fi
  done
done
[ -d "$AGENT_HOME/.ssh" ] || install -d -m 700 "$AGENT_HOME/.ssh"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$AGENT_HOME"
# <<< home
if [ -n "$carried" ]; then
  say "HOME is $AGENT_HOME; copied across:$carried"
else
  say "HOME is $AGENT_HOME"
fi

# The gateway, for `--variant router` (above, "gateway on"): before the unit starts the daemon, which reads it then.
if [ "$GATEWAY_ON" = "1" ]; then
  step "The LLM gateway"
  gateway_on "$(gateway_config "$INSTALL_DIR")" "$SERVICE_USER" "$SERVICE_GROUP"
fi

# ── Each agent its own user ──────────────────────────────────────────────────
#
# `nouride-run`: the root helper that runs each agent's commands as that agent's own user, nr-<agent> — so a command
# reaches its own agent's folders and nothing of another agent's or of the daemon's. Root-owned and outside the install
# directory, for the reason nouride-pkg is: a copy the service account could edit would be root for whatever runs as
# it. Its units come from `nouride service install`, below. Where there is no systemd or no useradd (Alpine without
# `shadow`), agents' commands run as the service account, as before, and the daemon says so at boot.
# >>> agent users
RUN_LIB=/usr/local/lib/nouride-run
RUN_READY=0
if [ "$OS" = "Linux" ] && [ "$HAS_SYSTEMD" = "1" ]; then
  step "Each agent its own user"
  if [ ! -x "$STAGE/run/nouride-run" ]; then
    warn "this release does not carry nouride-run: agents' commands run as $SERVICE_USER"
  elif ! command -v useradd >/dev/null 2>&1 || ! command -v groupadd >/dev/null 2>&1 || ! command -v usermod >/dev/null 2>&1; then
    warn "no useradd, groupadd or usermod here (on Alpine: apk add shadow): agents' commands run as $SERVICE_USER"
  else
    getent group nr-agents >/dev/null 2>&1 || groupadd --system nr-agents
    getent group nr-creds >/dev/null 2>&1 || groupadd --system nr-creds
    # The daemon reads what agents make in shared/; it is never in an agent's own group, nor an agent in its.
    usermod -aG nr-agents "$SERVICE_USER"
    install -d -o root -g root -m 755 "$RUN_LIB"
    install -o root -g root -m 755 "$STAGE/run/nouride-run" "$RUN_LIB/nouride-run"
    NR="$INSTALL_DIR/.nouride"
    # Every agent passes through .nouride to its own folders, and lists nothing there.
    chmod o=x "$NR"
    # The programs installed for every agent: theirs to run, the daemon's to change. Setgid, so what the daemon adds
    # later — the shared Python env — takes the group too. What each agent installs itself lands in its own HOME.
    for d in bin lib opt; do
      [ -d "$NR/$d" ] || install -d -o "$SERVICE_USER" -g nr-agents -m 2750 "$NR/$d"
      chgrp -R nr-agents "$NR/$d"
      find "$NR/$d" -type d -exec chmod g+rxs {} +
      chmod -R g+rX "$NR/$d"
    done
    RUN_READY=1
    say "each agent's commands run as its own user, nr-<agent>, through $RUN_LIB/nouride-run"
  fi
fi
# <<< agent users

# ── System packages ──────────────────────────────────────────────────────────
#
# `nouride-pkg`: the one way the sandboxed daemon can change this machine's packages, by rules it cannot
# change — read them in pkg/nouride-pkg in the tarball. Only with --allow-packages, and kept by a later
# run without the flag, so an upgrade never turns it off. Installed root-owned and outside the install
# directory, which the service account can write: a copy it could edit would be a root shell for
# anything running as it. Before the unit, so the daemon starts with the socket already there.
#
# A Nouride Box gets none, and the Box flasher installs none: its daemon runs as root with the sandbox dropped
# (`--privileged --user root`), so there is no root half for it to ask. That changes if a Box ever runs
# unprivileged.
PKG_LIB=/usr/local/lib/nouride-pkg
PKG_UNIT=/etc/systemd/system/nouride-pkg.socket
if [ "$PACKAGES" = "0" ]; then
  if [ -f "$PKG_UNIT" ]; then
    step "System packages"
    systemctl disable --now nouride-pkg.socket >/dev/null 2>&1 || true
    rm -f "$PKG_UNIT" "/etc/systemd/system/nouride-pkg@.service" /usr/local/sbin/nouride-pkg
    rm -rf "$PKG_LIB"
    systemctl daemon-reload
    say "off: agents install only into their own bin directory"
  fi
elif [ "$PACKAGES" = "1" ] || [ -f "$PKG_UNIT" ]; then
  step "System packages"
  if [ "$HAS_SYSTEMD" != "1" ] || [ "$OS" = "Darwin" ]; then
    warn "--allow-packages needs systemd on Linux; skipped"
  elif [ ! -f "$STAGE/pkg/nouride-pkg" ]; then
    warn "this release does not carry nouride-pkg; skipped"
  else
    rm -rf "$PKG_LIB"
    install -d -o root -g root -m 755 "$PKG_LIB" "$PKG_LIB/backends"
    install -o root -g root -m 755 "$STAGE/pkg/nouride-pkg" "$PKG_LIB/nouride-pkg"
    for backend in "$STAGE"/pkg/backends/*.sh; do
      install -o root -g root -m 644 "$backend" "$PKG_LIB/backends/"
    done
    ln -sf "$PKG_LIB/nouride-pkg" /usr/local/sbin/nouride-pkg
    # Only root and the service account's group may connect: the daemon, and the operators added to it.
    sed "s/@GROUP@/$SERVICE_USER/" "$STAGE/pkg/systemd/nouride-pkg.socket" > "$PKG_UNIT"
    install -m 644 "$STAGE/pkg/systemd/nouride-pkg@.service" "/etc/systemd/system/nouride-pkg@.service"
    systemctl daemon-reload
    systemctl enable nouride-pkg.socket >/dev/null 2>&1 || true
    systemctl restart nouride-pkg.socket
    backend=$("$PKG_LIB/nouride-pkg" status 2>/dev/null | sed -n 's/.*backend=//p')
    kept=""
    [ "$PACKAGES" = "1" ] || kept=" (kept from an earlier --allow-packages; --no-packages turns it off)"
    if [ -n "$backend" ]; then
      say "on ($backend): agents may install packages from this system's repositories, asking a person every time unless an agent's approvals are \"trusted\"$kept"
    else
      say "installed, but this system's package manager is not supported yet$kept"
    fi
  fi
fi

# ── The unit ─────────────────────────────────────────────────────────────────
if [ "$HAS_SYSTEMD" = "1" ]; then
  step "systemd unit"
  su -s /bin/sh "$SERVICE_USER" -c \
    "cd '$INSTALL_DIR' && '$INSTALL_DIR/nouride' service install --user '$SERVICE_USER' --dir '$INSTALL_DIR'" \
    >/dev/null || die "could not generate the unit; run it by hand to see why"

  [ -f "$INSTALL_DIR/nouride.service" ] || die "the unit was not written to $INSTALL_DIR/nouride.service"
  cp "$INSTALL_DIR/nouride.service" /etc/systemd/system/nouride.service
  # The helper's socket before the daemon: boot asks it once whether agents' commands run as their own users.
  if [ "$RUN_READY" = "1" ] && [ -f "$INSTALL_DIR/nouride-run.socket" ] && [ -f "$INSTALL_DIR/nouride-run@.service" ]; then
    cp "$INSTALL_DIR/nouride-run.socket" "$INSTALL_DIR/nouride-run@.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable nouride-run.socket >/dev/null 2>&1 || true
    systemctl restart nouride-run.socket
  fi
  systemctl daemon-reload
  systemctl enable --now nouride >/dev/null 2>&1
  say "installed and started (read it at /etc/systemd/system/nouride.service)"
elif [ "$OS" = "Darwin" ] && [ "$HAS_LAUNCHD" = "1" ]; then
  step "macOS launchd agent"
  # >>> launchd agent
  # `--kind launchd` named, not left to the binary's own idea of its platform: a build that thought it was Linux wrote
  # `nouride.service`, and this stopped at "launchd plist was not written". HOME is the account's, whose
  # `~/.local/bin` the plist puts on the job's PATH — under sudo it would otherwise be root's.
  HOME="$USER_HOME" "$INSTALL_DIR/nouride" service install --kind launchd --user "$SERVICE_USER" --dir "$INSTALL_DIR" >/dev/null || die "could not generate launchd plist"
  PLIST="$INSTALL_DIR/tech.nouverse.nouride.plist"
  [ -f "$PLIST" ] || die "launchd plist was not written to $PLIST"
  mkdir -p "$USER_HOME/Library/LaunchAgents"
  cp "$PLIST" "$USER_HOME/Library/LaunchAgents/tech.nouverse.nouride.plist"
  launchctl unload "$USER_HOME/Library/LaunchAgents/tech.nouverse.nouride.plist" 2>/dev/null || true
  launchctl load -w "$USER_HOME/Library/LaunchAgents/tech.nouverse.nouride.plist"
  # <<< launchd agent
  say "installed and started (read it at ~/Library/LaunchAgents/tech.nouverse.nouride.plist)"
else
  step "No service manager"
  say "start it by hand:"
  # `start`, as the service account: there is no `run` command (it said so until 0.8.18, found by
  # `scripts/release/install-run.sh`), and a daemon started as root leaves files the account cannot write.
  say "  su -s /bin/sh $SERVICE_USER -c 'cd $INSTALL_DIR && ./nouride start'"
fi

# ── Did it come up ───────────────────────────────────────────────────────────
#
# Polled rather than assumed. `systemctl start` returning 0 means the process was spawned, not that it
# is serving — and the whole point of this script is to hand over a working URL.
HEALTH_HOST="127.0.0.1"

# >>> health probe
# health_answers URL — whether a daemon answers /health at all. A 503 is an answer: /health says it while the daemon
# is starting and while it is degraded — a gateway down, a provider failing — and `curl -f` read that as no daemon,
# so a slow or degraded first boot ended in "did not answer" and skipped the modes below. The body names a status
# either way. GNU wget keeps an error's body only when asked, and BusyBox's does not know the option.
health_answers() {
  if command -v curl >/dev/null 2>&1; then
    curl -sS --max-time 5 "$1" 2>/dev/null | grep -q '"status"'
  else
    { wget -qO- --content-on-error "$1" 2>/dev/null || wget -qO- "$1" 2>/dev/null; } | grep -q '"status"'
  fi
}
# <<< health probe

if [ "$HAS_SYSTEMD" = "1" ] || [ "$OS" = "Darwin" ]; then
  step "Waiting for it to answer"
  i=0
  ready=0
  if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
    while [ "$i" -lt 30 ]; do
      if health_answers "http://${HEALTH_HOST}:${PORT}/health"; then ready=1; break; fi
      i=$((i + 1))
      sleep 1
    done
  fi

  # Whatever the answer: the modes are the install's, not a reward for a quick boot. A first boot slower than the
  # wait used to leave the data directory open to every account on the machine.
  if [ -d "$INSTALL_DIR/.nouride/data" ]; then
    chmod 750 "$INSTALL_DIR/.nouride/data" 2>/dev/null || true
    # .nouride itself: passed through by every agent's own user to its folders where the helper is in place (above)
    # — 750 there shut every agent's command out of its own working directory.
    if [ "$RUN_READY" = "1" ]; then chmod 751 "$INSTALL_DIR/.nouride" 2>/dev/null || true; else chmod 750 "$INSTALL_DIR/.nouride" 2>/dev/null || true; fi
    if [ -f "$INSTALL_DIR/.nouride/data/.control-token" ]; then chmod 640 "$INSTALL_DIR/.nouride/data/.control-token" 2>/dev/null || true; fi
  fi

  if [ "$ready" = "1" ]; then
    say "answering"
  else
    warn "it did not answer on ${HEALTH_HOST}:${PORT} within 30s"
    if [ "$HAS_SYSTEMD" = "1" ]; then
      warn "look at: journalctl -u nouride -n 50 --no-pager"
    elif [ "$OS" = "Darwin" ]; then
      warn "look at: tail -n 50 $INSTALL_DIR/.nouride/data/nouride.log"
    fi
  fi
fi

# ── Where to go next ─────────────────────────────────────────────────────────
printf '\n\033[32m✓\033[0m Nouride is installed.\n\n'

# Linux only, as the `usermod -aG` it reports is: on macOS the install is the person's own, and nobody was added.
if [ "$OS" != "Darwin" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  say "CLI access: user '$SUDO_USER' was added to group '$SERVICE_USER'."
  say "To run \`nouride\` without sudo in this shell session, run: newgrp $SERVICE_USER"
  say ""
fi

# >>> dashboard address
if [ "$BIND_HOST" = "0.0.0.0" ]; then
  if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  elif [ "$OS" = "Darwin" ]; then
    addr="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<this-host>")"
  else
    addr="<this-host>"
  fi
  say "Dashboard:  http://${addr}:${PORT}/dashboard/"
else
  if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    lan="$(hostname -I 2>/dev/null | awk '{print $1}')"
  elif [ "$OS" = "Darwin" ]; then
    lan="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<this-host>")"
  else
    lan="<this-host>"
  fi
  if [ "$OS" = "Darwin" ]; then
    # A Mac is most often the machine its person sits at: the first thing it told them was to tunnel to itself.
    say "The dashboard is bound to loopback. On this Mac, open  http://127.0.0.1:${PORT}/dashboard/"
    say "From another machine:  ssh -L ${PORT}:127.0.0.1:${PORT} <you>@${lan}  and open the same address there"
  else
    say "The dashboard is bound to loopback. From your own machine:"
    say "  ssh -L ${PORT}:127.0.0.1:${PORT} <you>@${lan}"
    say "then open  http://127.0.0.1:${PORT}/dashboard/"
  fi
  say ""
  say "To expose it on the network instead, re-run with --host 0.0.0.0"
fi
# <<< dashboard address

if [ "$UPGRADE" = "0" ]; then
  printf '\n'
  say "The first login is printed once, and only once, when the daemon first starts:"
  if [ "$HAS_SYSTEMD" = "1" ]; then
    say "  journalctl -u nouride | grep -A12 'Nouride is ready'"
  elif [ "$OS" = "Darwin" ]; then
    say "  grep -A12 'Nouride is ready' $INSTALL_DIR/.nouride/data/nouride.log"
  else
    # Without a supervisor the banner goes to whatever started the daemon, so pointing at a journal
    # that does not exist would send the operator looking for a log nothing writes.
    say "  it goes to the terminal you start it from; do not close it before reading the password"
  fi
  say ""
  say "The wizard there asks two things: your model endpoint and who the first"
  say "agent should be. Bot tokens go in the dashboard, which keeps them in the"
  say "secret store; $INSTALL_DIR/.env works too, but its values sit in the daemon's"
  say "environment for as long as it runs."
fi
printf '\n'
