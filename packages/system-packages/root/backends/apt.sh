# nouride-pkg backend: apt (Debian, Ubuntu, Raspberry Pi OS). Sourced by nouride-pkg; see README.md.

export DEBIAN_FRONTEND=noninteractive

# A config file changed on both sides keeps the operator's copy. The alternative is a prompt, and there
# is nobody at this one: dpkg would wait until the request timed out and leave the install half done.
APT_RUN="-y -q -o Dpkg::Use-Pty=0 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o DPkg::Lock::Timeout=120"

pkg_detect() {
  command -v apt-get >/dev/null 2>&1 && command -v dpkg-query >/dev/null 2>&1
}

pkg_protected() {
  # Reaching the box: ssh, networking, name resolution, certificates, a way to become root.
  printf '%s\n' openssh-server openssh-client ssh sudo ca-certificates \
    iproute2 ifupdown netplan.io network-manager systemd-resolved isc-dhcp-client dhcpcd dhcpcd-base \
    wpasupplicant
  # Running at all: init, libc, the package manager, and what Nouride's own binary and update use.
  printf '%s\n' systemd systemd-sysv init base-files libc6 libgcc-s1 libstdc++6 apt dpkg \
    login passwd util-linux coreutils bash dash tar gzip
}

# `apt-cache pkgnames` matches a literal prefix. `apt-cache show` and `apt-get install` do not: a name
# with a dot that is not a package is read as a regular expression, and `j.q` plans a dozen unrelated
# packages. Found on Debian 13 (apt 3.0). So a name is known only when it is listed exactly.
pkg_known() {
  apt-cache pkgnames "$1" 2>/dev/null | grep -qxF -- "$1"
}

pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'
}

# apt's simulation prints `Inst name ...` and `Remv name ...`, the name with `:arch` on a foreign
# architecture. Every other line is noise here.
apt_simulate() {
  op="$1"
  shift
  case "$op" in
    install) apt-get -s install "$@" ;;
    remove) apt-get -s remove "$@" ;;
    upgrade) if [ "$#" -eq 0 ]; then apt-get -s upgrade; else apt-get -s install --only-upgrade "$@"; fi ;;
  esac
}

pkg_plan() {
  sim=$(apt_simulate "$@" 2>&1) || { printf '%s\n' "$sim" >&2; return 1; }
  printf '%s\n' "$sim" | awk '
    $1 == "Inst" { n = $2; sub(/:.*/, "", n); print "+ " n }
    $1 == "Remv" { n = $2; sub(/:.*/, "", n); print "- " n }'
}

pkg_run() {
  op="$1"
  shift
  # shellcheck disable=SC2086
  case "$op" in
    install) apt-get $APT_RUN install "$@" ;;
    remove) apt-get $APT_RUN remove "$@" ;;
    upgrade) if [ "$#" -eq 0 ]; then apt-get $APT_RUN upgrade; else apt-get $APT_RUN install --only-upgrade "$@"; fi ;;
  esac
}

pkg_refresh() {
  apt-get -q update
}
