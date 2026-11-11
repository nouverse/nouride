#!/bin/sh
#
# Install or upgrade Nouride on a Linux host with its LLM gateway switched on, then hand over to the browser.
#
# Fetches the official Nouride installer and runs it with `--variant router`, which installs Nouride Community with
# `[nougate] in_process = true` (install.sh, "gateway on", "download names"): Router is part of Community. Kept for
# links that still name it; no page offers it, and 0.9.0 removes it with the rest of Router's names (v0.8.28_RFC).
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
