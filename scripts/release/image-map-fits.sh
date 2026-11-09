#!/bin/sh
#
# Whether an image's private source map fits the bundle in the image itself — on every platform it was pushed for —
# and whether that image carries no source map at all. `release.yml` runs it on the pushed image before the map goes
# to the internal release; `ci-image.yml` runs it on the image a pull request builds.
#
# The map comes out of the `source-map` stage of the Dockerfile, a second build of the same cached stage, so it is
# checked against what was actually shipped rather than trusted: the stamp's `codeSha256` (`writeImageBundle` in
# scripts/build/core.ts) must be the SHA-256 of `/app/nouride.bundle.js` as each platform's image carries it. A map
# that does not fit names a wrong line for every frame, and `bun run symbolize` could not tell.
#
# Everything comes from the environment, so the workflows and a test feed it the same way:
#
#   MAP_DIR    where `--target source-map` exported to: exactly one map, named for the edition
#   IMAGE      the image, by the reference it was pushed (or loaded) under
#   EDITION    the edition it was built as: basic or pro
#   VERSION    the version being built, without a `v`
#   PLATFORMS  the platforms to read, space-separated (default: linux/amd64 linux/arm64)
#   PULL       `no` for an image that is only local (`ci-image.yml` loads it rather than pushing it)

set -eu

fail() {
  echo "::error::$*"
  exit 1
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

case "${EDITION}" in
  basic) name="nouride-image.map" ;;
  *) name="nouride-${EDITION}-image.map" ;;
esac

found=$(cd "${MAP_DIR}" && ls -- *.map 2>/dev/null || true)
[ "${found}" = "${name}" ] || fail "the source-map stage exported '${found:-nothing}' to ${MAP_DIR}; the ${EDITION} image's map is ${name}, and only it"
map="${MAP_DIR}/${name}"

stamp=$(jq -r '.x_nouride | "\(.version) \(.edition) \(.target) \(.codeSha256)"' "${map}")
# shellcheck disable=SC2086 # four words, split on purpose
set -- ${stamp}
[ "$1 $2 $3" = "${VERSION} ${EDITION} image" ] || fail "${name} is stamped '$1 $2 $3', not '${VERSION} ${EDITION} image'"
want=$4

work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT

for platform in ${PLATFORMS:-linux/amd64 linux/arm64}; do
  [ "${PULL:-yes}" = "no" ] || docker pull --quiet --platform "${platform}" "${IMAGE}" >/dev/null
  id=$(docker create --platform "${platform}" "${IMAGE}")
  docker cp "${id}:/app/nouride.bundle.js" "${work}/bundle.js" >/dev/null
  # Every file in the image, not only /app: the base image and the gateway's frontend are in it too.
  maps=$(docker export "${id}" | tar -t | grep -E '(^|/)[^/]+\.map$' || true)
  docker rm "${id}" >/dev/null

  got=$(sha256 "${work}/bundle.js")
  [ "${got}" = "${want}" ] || fail "${IMAGE} (${platform}) carries a bundle that is not the one ${name} maps: sha256 ${got}, the map was written for ${want}"
  [ -z "${maps}" ] || fail "${IMAGE} (${platform}) carries a source map: $(echo "${maps}" | tr '\n' ' ')"
  if grep -qE '//[#@] sourceMappingURL=([A-Za-z0-9./@_-]+\.map|data:application/json[^,]*;base64,[A-Za-z0-9+/]{40})' "${work}/bundle.js"; then
    fail "${IMAGE} (${platform}) carries a bundle that names a source map"
  fi
  echo "${platform}: /app/nouride.bundle.js is the bundle ${name} maps (sha256 ${got}), and the image carries no source map"
done
