#!/bin/sh
# Sign a release's checksum files: `<file>.sig` beside each, the base64 of a raw Ed25519 signature over its exact
# bytes — what `nouride update` (packages/update/src/signing.ts) and install.sh verify before installing anything.
#
#   RELEASE_SIGNING_KEY="$(cat key.pem)" sh scripts/release/sign-checksums.sh dist/CHECKSUMS dist/CHECKSUMS-pro
#
# OpenSSL 3 and nothing else. The release workflow's `sign` job runs it — the one job that holds the key, and one
# that installs no dependencies, since a package's install script would run beside the key. The key reaches openssl
# on stdin and is never written to disk, put in argv or printed. Each signature is checked against the keys install.sh
# embeds — the keys every build trusts; `tests/contracts/install-verify.test.ts` holds the two lists equal — before it
# is kept, so a wrong key fails here, at release time, rather than on every install that then refuses the release.
set -eu

keys_from="${RELEASE_KEYS_FROM:-$(dirname "$0")/../install.sh}"
[ -n "${RELEASE_SIGNING_KEY:-}" ] || { echo "RELEASE_SIGNING_KEY is not set" >&2; exit 1; }
case "$RELEASE_SIGNING_KEY" in
  *"PRIVATE KEY"*) ;;
  *) echo "RELEASE_SIGNING_KEY is not a PEM private key" >&2; exit 1 ;;
esac
[ "$#" -gt 0 ] || { echo "usage: sign-checksums.sh <checksum file>..." >&2; exit 2; }
openssl pkeyutl -help 2>&1 | grep -q -- '-rawin' || { echo "OpenSSL 3 is needed to sign (pkeyutl -rawin)" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The public keys install.sh embeds, one PEM file each.
sed -n '/^# >>> release keys/,/^# <<< release keys/p' "$keys_from" \
  | grep -v '^#' | sed -e "s/^RELEASE_KEYS='//" -e "s/'\$//" \
  | awk -v dir="$work" '/BEGIN PUBLIC KEY/ { n++ } n { print > (dir "/key" n ".pem") }'
ls "$work"/key*.pem >/dev/null 2>&1 || { echo "no release keys between the markers in $keys_from" >&2; exit 1; }

for file in "$@"; do
  printf '%s\n' "$RELEASE_SIGNING_KEY" | openssl pkeyutl -sign -inkey /dev/stdin -rawin -in "$file" -out "$work/sig.bin"
  ok=0
  for key in "$work"/key*.pem; do
    if openssl pkeyutl -verify -pubin -inkey "$key" -rawin -in "$file" -sigfile "$work/sig.bin" >/dev/null 2>&1; then ok=1; fi
  done
  if [ "$ok" != 1 ]; then
    echo "$file: the signature does not verify against the keys every build trusts — wrong RELEASE_SIGNING_KEY?" >&2
    exit 1
  fi
  { openssl base64 -A -in "$work/sig.bin"; echo; } > "$file.sig"
  echo "signed $file → $file.sig"
done
