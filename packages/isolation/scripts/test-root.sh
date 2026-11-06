#!/bin/sh
# The helper's tests as they must run: in a Linux container, as root, with real users and groups — the escape tests
# need all three. Throwaway: the container goes, and the users with it. Needs Docker.
#
#   sh packages/isolation/scripts/test-root.sh
set -eu
here=$(cd "$(dirname "$0")/../root/nouride-run" && pwd)
docker volume create nr-cargo >/dev/null
# AppArmor's docker-default profile refuses the mount propagation `unshare --mount` sets, which the mount-namespace test
# needs (GitHub's Ubuntu runners have it on; a Mac's VM has no AppArmor).
exec docker run --rm --cap-add SYS_PTRACE --cap-add SYS_ADMIN --security-opt apparmor=unconfined -v "$here":/src:ro -v nr-cargo:/usr/local/cargo/registry -w /src \
  -e CARGO_TARGET_DIR=/tmp/target rust:1.99-bookworm \
  sh -c 'rustup component add clippy rustfmt >/dev/null 2>&1; cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test -- --test-threads=1'
