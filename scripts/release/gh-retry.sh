#!/bin/sh
# gh-retry.sh <command…>: the command, run again after a pause when it fails, four tries in all. GitHub's API answers a
# moment's 500 or 502 now and then; one, on a release asset's download, stopped a public release at a job that had
# nothing wrong with it. Its last failure's exit code is its own.
#
# GH_RETRY_WAITS sets the pauses in seconds, "5 15 30" by default (the tests run with no pause).
set -u
waits="${GH_RETRY_WAITS:-5 15 30}"
tries=1
for wait in $waits ""; do
  "$@" && exit 0
  status=$?
  [ -z "$wait" ] && break
  echo "::warning::try $tries failed (exit $status): $1 ${2:-} ${3:-}; again in ${wait}s" >&2
  tries=$((tries + 1))
  sleep "$wait"
done
exit "$status"
