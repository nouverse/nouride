#!/bin/sh
#
# Install or upgrade Nouride (Router edition) on a Linux host, then hand over to the browser.
#
# Fetches the official Nouride installer and runs it with `--variant router`. Kept for the links that name it; every
# page names the installer itself: `curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --variant router`.
#
# Usage:
#   curl -fsSL https://get.nouride.com/install-bundle-router.sh | sudo sh
#   curl -fsSL https://get.nouride.com/install-bundle-router.sh | sudo sh -s -- --host 0.0.0.0
#

set -eu

INSTALL_URL="${NOURIDE_INSTALLER_URL:-https://get.nouride.com/install.sh}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$INSTALL_URL" -o "$STAGE/install.sh"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$STAGE/install.sh" "$INSTALL_URL"
else
  echo "neither curl nor wget is installed" >&2
  exit 1
fi

sh "$STAGE/install.sh" --variant router "$@"
