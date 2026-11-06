# nouride-pkg backend: apk (Alpine). Sourced by nouride-pkg; see README.md.

pkg_detect() {
  command -v apk >/dev/null 2>&1
}

pkg_protected() {
  # Reaching the box: ssh, networking, certificates, a way to become root.
  printf '%s\n' openssh openssh-server openssh-client sudo doas ca-certificates ca-certificates-bundle \
    iproute2 ifupdown-ng dhcpcd wpa_supplicant
  # Running at all: init, libc, the package manager, and what Nouride's binary needs on musl.
  printf '%s\n' alpine-base alpine-baselayout apk-tools busybox musl libc-utils openrc \
    libstdc++ libgcc tar gzip
}

# `apk search -e` still expands globs, and prints `name-version`. Known only when a line is exactly
# this name followed by a version, which on Alpine always starts with a digit.
pkg_known() {
  apk search -e "$1" 2>/dev/null | while IFS= read -r line; do
    case "$line" in "$1"-[0-9]*) echo yes; break ;; esac
  done | grep -q yes
}

pkg_installed() {
  apk info -e "$1" >/dev/null 2>&1
}

apk_simulate() {
  op="$1"
  shift
  case "$op" in
    install) apk add --simulate "$@" ;;
    remove) apk del --simulate "$@" ;;
    upgrade) if [ "$#" -eq 0 ]; then apk upgrade --simulate; else apk add --simulate --upgrade "$@"; fi ;;
  esac
}

# `(1/2) Installing name (version)`, `Upgrading`, `Downgrading`, `Reinstalling`, `Purging`.
pkg_plan() {
  sim=$(apk_simulate "$@" 2>&1) || { printf '%s\n' "$sim" >&2; return 1; }
  printf '%s\n' "$sim" | awk '
    $2 == "Installing" || $2 == "Upgrading" || $2 == "Downgrading" || $2 == "Reinstalling" { print "+ " $3 }
    $2 == "Purging" || $2 == "Deleting" { print "- " $3 }'
}

pkg_run() {
  op="$1"
  shift
  case "$op" in
    install) apk add --no-progress "$@" ;;
    remove) apk del --no-progress "$@" ;;
    upgrade) if [ "$#" -eq 0 ]; then apk upgrade --no-progress; else apk add --no-progress --upgrade "$@"; fi ;;
  esac
}

pkg_refresh() {
  apk update
}
