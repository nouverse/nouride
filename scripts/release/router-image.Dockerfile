# check=skip=InvalidDefaultArgInFrom
# The Router image, as it is from 0.8.29: the free image, with one line added.
#
# `BASE` has no default on purpose (the directive above quiets BuildKit's warning about it): a default would be an
# image to wrap when the workflow forgot to say which, and a build that stops is the better answer.
#
# Router became part of the free build (v0.8.29_RFC) — Community carries the LLM gateway, off until
# `[nougate] in_process = true` — so there is no Router build to put in an image. But compose files and
# `docker run` lines out there pull `ghcr.io/nouverse/nouride-router`, and a package that stopped getting
# releases would leave every one of them on its version for good. So the public half of each release
# (`.github/workflows/public-release.yml`) pushes the free image under that name too, with the same tags,
# built from this: the image it just built and checked, and `NOURIDE_IMAGE_MOVED_TO`, which the
# dashboard reads to tell the person running it which image to pull from now on. Its labels, its bundle
# and its edition (`basic`) are the free image's own.
#
#   docker buildx build --build-arg BASE=ghcr.io/nouverse/nouride:<version>-<arch> - < scripts/release/router-image.Dockerfile
#
# 0.9.0 removes this, and stops pushing `nouride-router` (v0.8.29_RFC).
ARG BASE
FROM ${BASE}
ENV NOURIDE_IMAGE_MOVED_TO=ghcr.io/nouverse/nouride
