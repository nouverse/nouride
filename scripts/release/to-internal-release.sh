#!/bin/sh
# Files onto the internal release, nouverse/nouride-pro's for the tag, which is made first when it is missing: where
# every source map goes, a free edition's too (2026-11-08). This repository went public in 0.8.21 and keeps no map, and
# the Pro half builds only Pro, so a Community install's stack trace had no map to be read with (`bun run symbolize`).
#
# Made as the Pro half's own release step makes it (its release.yml in nouverse/nouride-pro): at the Pro commit the tag
# pins, with the same title, words and visibility, so whichever of the two comes first, the release is the same one.
#
#   to-internal-release.sh <tag> <pro commit> <file>...
#   QUIET=yes for a quiet release, LTS=yes for a long-term patch, as the Pro half is told.
set -eu

if [ "$#" -lt 3 ]; then
  echo "usage: to-internal-release.sh <tag> <pro commit> <file>..." >&2
  exit 2
fi
tag="$1"
pro="$2"
shift 2
repo=nouverse/nouride-pro

if ! gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  visibility=""
  if [ "${QUIET:-no}" = "yes" ]; then visibility="--prerelease --latest=false"; fi
  if [ "${LTS:-no}" = "yes" ]; then visibility="--latest=false"; fi
  # Another leg of the build may make it at the same moment: that is the release this one wanted.
  # shellcheck disable=SC2086 # $visibility is flags, split on purpose
  gh release create "$tag" --repo "$repo" --target "$pro" --title "$tag" $visibility \
    --notes "The Pro editions of nouverse/nouride ${tag}: tarballs, their signed checksum file and source maps." \
    || gh release view "$tag" --repo "$repo" >/dev/null
fi
gh release upload "$tag" "$@" --repo "$repo" --clobber
