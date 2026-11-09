#!/bin/sh
# Starts a public image on a port of its own and checks it answers as the release and edition it says it is, and that
# its CLI finds the daemon from inside the container, as a person asking `docker exec <container> nouride status` would.
#
#   sh scripts/release/image-smoke.sh <image> <version> <edition>    e.g. ghcr.io/nouverse/nouride:0.8.29-amd64 0.8.29 basic
#
# `public-release.yml` runs it on each image it built before it pushes it: the free image, and the same image under
# Router's name, which must answer `basic` too.
set -eu
image="${1:?usage: image-smoke.sh <image> <version> <edition>}"
version="${2:?}"
edition="${3:?}"
port="${SMOKE_PORT:-18301}"
name="smoke-$$"

fail() {
  echo "::error::$*"
  exit 1
}

docker run -d --name "$name" -e PORT="$port" -p "127.0.0.1:$port:$port" "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
health=""
for _ in $(seq 1 60); do
  health="$(curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null || true)"
  case "$health" in *'"version"'*) case "$health" in *starting*) ;; *) break ;; esac ;; esac
  sleep 1
done
echo "/health: $health"
case "$health" in
  *"\"version\":\"$version\""*"\"edition\":\"$edition\""* | *"\"edition\":\"$edition\""*"\"version\":\"$version\""*) ;;
  *) docker logs "$name" 2>&1 | tail -20; fail "$image did not answer as $edition $version" ;;
esac
docker exec "$name" nouride status
echo "smoke: $image ok ($edition $version)"
