# Nouride — multi-stage build producing one image (TD-003).
#
# The engine is built into a single minified bundle (nouride.bundle.js) during
# the build stage, names mangled as the binaries' are. No raw TypeScript source
# files, no internal packages, no tests and no source map are shipped inside the
# runtime container image.
#
# The bundle's private source map is written beside it in the build stage and
# leaves only through the `source-map` stage below, which `release.yml` exports,
# checks against the bundle in the pushed image and uploads to the internal
# release. A frame from a container (`/app/nouride.bundle.js:LINE:COL`) is read
# back with `bun run symbolize --target image`.
#
# ## The three images
#
# One build arg, and it names an edition rather than a mechanism — the same three
# words the builds take (`build:binary`, and `build:pro` for Pro), each of which
# produces an image:
#
# | `EDITION` | package | nougate | Nouverse sign-in | public |
# |---|---|---|---|---|
# | `basic` (default) | `ghcr.io/nouverse/nouride` | **absent** | **absent** | yes |
# | `router` | `ghcr.io/nouverse/nouride-router` | in this process | **absent** | yes |
# | `pro` | `ghcr.io/nouverse/nouride-pro` | in this process, off until asked | in this process | no |
#
# `pro` is the same edition a Nouride Box runs from a tarball; in a pod it has no
# appliance identity, so pairing stays inert. It carries the LLM gateway since Pro
# Router became Pro (0.7.20), off until `[nougate] in_process = true` or
# `NOUGATE_IN_PROCESS=1`: a pod that wants it no longer needs another image.
#
# **The two public images carry no Pro plugin.** Neither has
# `internals/pro/packages/oauth`, which is the difference between a feature switched off
# and a feature that is not there. A `NOURIDE_OAUTH_ISSUER` set against one is
# refused at boot with a sentence saying this build has no external sign-in,
# rather than ignored.
#
# WhatsApp used to be absent from the basic image and present in the binary of
# the same name — the image staged no second executable, so its basic edition
# simply had no bridge to run. Every edition bundles the bridge into the artifact
# itself now, so the image and the binary carry the same thing and the
# `bundled.wa-bridge` label is `1` on all of them.
#
# The runtime image has no source, no `internals/` and no `node_modules` at all: it
# is `nouride.bundle.js`, and `--bundle-only` runs the same `assertEmbedded` /
# `assertAbsent` pair the compiled binary does. (Until 2026-09-15 this comment
# claimed the image "runs source under Bun", which was wrong.)
#
# Which edition. Declared here, above every `FROM`, because an ARG placed after
# one belongs to that stage — and this is interpolated into a stage NAME in
# stage 4, which is a different scope. That mistake fails as
# `invalid reference format`, which does not name the cause.
#
# `basic`, `router` or `pro`. An empty value is not allowed for the same
# reason: `edition-` is not a valid image reference.
ARG EDITION=basic
# The Bun this image builds and runs on: `.bun-version`, the one CI tests on and the tarballs embed. A Dockerfile cannot
# read a file into a `FROM`, so the default is a copy, and `apps/engine/tests/contracts/build-hygiene.test.ts` holds it to the file.
# It was the floating `1.4-alpine`, so an image ran whichever 1.4.x was newest the day it was built.
ARG BUN_VERSION=1.4.4
# And the exact image, by digest beside the tag: a tag can be pushed again with other bytes under it — a rebuild on a
# newer Alpine — and a digest cannot, so a release is built from the base CI's image build was. The digest is the
# multi-platform index's, so amd64 and arm64 each still resolve their own image from it. Bumping `.bun-version` means
# reading the new one (`docker buildx imagetools inspect oven/bun:<version>-alpine`) and moving both lines together:
# the test holds the version this line names to the file, and each stage below refuses a Bun that is not `BUN_VERSION`.
# BUN_DIGEST is oven/bun:1.4.4-alpine's index digest, read on 2026-10-22.
ARG BUN_DIGEST=sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a

# ---- Stage 1: dependencies ----
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine@${BUN_DIGEST} AS deps
# A digest of another version's image would otherwise build silently on a Bun `.bun-version` does not name.
ARG BUN_VERSION
RUN test "$(bun --version)" = "$BUN_VERSION" || { echo "BUN_DIGEST is not oven/bun:${BUN_VERSION}-alpine: this image runs Bun $(bun --version)" >&2; exit 1; }
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/engine/package.json ./apps/engine/
COPY apps/dashboard/package.json ./apps/dashboard/
# The whole packages tree, not each manifest.
#
# `bun install` only needs the manifests, and enumerating them would keep this layer cached
# across source edits — but Docker's COPY flattens a `packages/*/package.json` glob, so the
# enumeration has to be written out by hand, and it silently goes stale the moment a package
# is added. Trading a few seconds of install cache for a build that cannot drift.
COPY packages ./packages
RUN bun install --frozen-lockfile

# ---- Stage 2: build the dashboard ----

FROM deps AS dashboard-builder
WORKDIR /app
COPY apps/dashboard ./apps/dashboard
# The dashboard's `build` script runs `scripts/sync-brand.ts` first, which copies
# the favicon out of `packages/shared/assets` because a favicon has to be a real
# file rather than an import. Without this line the image build fails with
# `Module not found "../../scripts/sync-brand.ts"` — which it did, from the
# commit that added that step until this one. `packages/` is already here: this
# stage is FROM deps.
COPY scripts/sync-brand.ts ./scripts/sync-brand.ts
# The dashboard compiles the `ui-*` packages it imports from source, and their tsconfig extends the
# root one; without it Vite stops at `Tsconfig not found /app/tsconfig.base.json` — which it did, on
# the v0.6.6 tag, the first release with a `ui-*` package.
COPY tsconfig.base.json ./
RUN cd apps/dashboard && bun run build

# ---- Stage 3: build the engine bundle ----
FROM deps AS engine-builder
WORKDIR /app
ARG EDITION=basic
COPY apps/engine ./apps/engine
COPY internals ./internals
# The private plugins' tsconfigs extend the root one too (0.7.9), and the setup console's Vite build reads them: without
# it the Pro image stopped at `Tsconfig not found /app/tsconfig.base.json` — on the v0.7.9 tag.
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY content ./content
COPY --from=dashboard-builder /app/apps/dashboard/dist ./apps/dashboard/dist
# The WhatsApp bridge is a workspace member, so `deps` installed Baileys with everything else.
# What follows is for the private extensions, which keep their own lockfiles.

# `nougate` only when it is checked out, because only `router` and `pro` carry it and a build
# without the private submodule has an empty directory here.
#
# Missing until 2026-09-16, and nothing noticed: no image edition bundled nougate, because
# `EDITION=router` fell through an `if cloud … else` and silently produced a **basic** bundle. The
# first router image built with its own flag failed on `Could not resolve: "drizzle-orm"` — the one
# dependency nougate has.
#
# Both frozen, against the lockfiles nougate tracks: the image and the tarball of one edition resolve the same tree.
# The backend's was excluded in .dockerignore while nougate kept it untracked, so the image installed with no lockfile
# at all and the release tarball with one.
RUN if [ -f /app/internals/nougate/apps/backend/package.json ]; then \
      (cd /app/internals/nougate/apps/backend && bun install --production --frozen-lockfile); \
    fi && \
    mkdir -p /app/internals/nougate/apps/frontend/dist && \
    if [ -f /app/internals/nougate/apps/frontend/package.json ]; then \
      (cd /app/internals/nougate/apps/frontend && bun install --frozen-lockfile && bun run build); \
    fi

# The edition flag and the entry point, mapped from the build arg.
#
# Two entry points since 2026-09-16: `scripts/build-binary.ts` knows the public editions and
# `internals/pro/packages/build-pro/build.ts` knows the rest, so the recipe for what is not published stays out of
# a public tree. Each refuses the other's flags, so a wrong pairing fails at the flag check.
#
# `--bundle-only` produces `nouride.bundle.js` rather than a compiled binary: the runtime image has
# Bun in it already, so compiling would embed a second copy. It also writes the bundle's private source
# map, `dist/nouride[-<edition>]-image.map`, stamped with the version, the edition and the hash of the
# bundle (`writeImageBundle` in scripts/build/core.ts). Only the `source-map` stage copies it.
#
# Every edition needs its own case. There was an `if cloud … else` here, so `EDITION=router` fell to
# the else branch and produced a **basic** bundle wearing router's labels — an image that claimed to
# carry the LLM gateway and did not.
RUN case "$EDITION" in \
      basic)      SCRIPT=scripts/build-binary.ts;     FLAG="" ;; \
      router)     SCRIPT=scripts/build-binary.ts;     FLAG="--router" ;; \
      pro)        SCRIPT=internals/pro/packages/build-pro/build.ts;  FLAG="--pro" ;; \
      *) echo "unknown EDITION: $EDITION" >&2; exit 1 ;; \
    esac && \
    bun run "$SCRIPT" --bundle-only $FLAG

# ---- The private source map, and nothing else ----
#
# Built only when asked for by name (`--target source-map`), with a local output: `release.yml` takes the map
# out this way, from the same cached build stage the pushed image's bundle came from, and proves the two fit
# before uploading it to the internal release. No runtime stage is built from this one, and none copies a
# `.map` — the map is the private source, Pro plugins included.
FROM scratch AS source-map
COPY --from=engine-builder /app/dist/*.map /

# ---- Stage 4: runtime ----
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_DIGEST} AS runtime-base
ARG BUN_VERSION
RUN test "$(bun --version)" = "$BUN_VERSION" || { echo "BUN_DIGEST is not oven/bun:${BUN_VERSION}-alpine: this image runs Bun $(bun --version)" >&2; exit 1; }
WORKDIR /app

# What the agent gets, and why the list is short.
#
# It is short because guessing which tools an operator's work wants produces a list that is both
# incomplete and stale. What the agent can add itself is what installs without root — npm, pip, cargo
# and go tools, and release binaries — into `.nouride/bin` on the volume, so they survive a recreate.
# System packages it adds through nouride-pkg, as on a host installed with `--allow-packages` (0.8.15):
# the daemon runs as uid 1000 and cannot `apk add`, so the entrypoint, root before it hands over,
# serves nouride-pkg and installs again from the volume what agents installed — a recreate keeps them
# (`packages/system-packages/root/container`). `EXTRA_PACKAGES` below still bakes one into the image.
#
# `openssh-client` because reaching other machines is a *documented* deployment shape — a container
# that cannot do it is a broken promise rather than a missing convenience.
#
# `util-linux` for `script(1)`, which is how an interactive session gets a real terminal without a
# native module: a child that checks `isatty` sees one, so colours, `kubectl exec -it` and anything
# curses-based work. A native macOS install uses the BSD `script` every Mac has, fed through a pipe
# (`packages/runtime/src/process-terminal.ts`).
#
# `ripgrep` because `rg` is in the daemon's default exec allowlist — the list of commands blessed as
# harmless enough to run without asking. Shipping an image where the blessed path fails with ENOENT
# sends the agent to look for a mistake of its own.
#
# `bash` because the `exec` tool tells the model to reach for a shell as `["bash", "-lc", "…"]` — its
# own description says so — and Alpine has only BusyBox `sh`. Every pipe an agent wrote failed with
# "bash: not found" in the container while working on every native install.
#
# See docs/DEPLOY.md for the socket and known_hosts that have to come from outside.
# `su-exec` is included to allow entrypoint step-down from root to user `bun` after volume permission fixes.
#
# `socat` listens on nouride-pkg's socket, one request per connection, as systemd's socket does on a host.
RUN apk add --no-cache bash openssh-client util-linux ripgrep su-exec socat

# Anything else this particular operator's work needs — `git`, `kubectl`, `helm`, a cloud CLI.
ARG EXTRA_PACKAGES=""
RUN if [ -n "$EXTRA_PACKAGES" ]; then apk add --no-cache $EXTRA_PACKAGES; fi

# Copy ONLY the minified bundle, built dashboard, skills, and config template.
# No raw TypeScript files, no source directories, no tests — and never the bundle's map, which would also be read
# by Bun itself if it sat beside the bundle as `nouride.bundle.js.map`.
COPY --from=engine-builder /app/dist/nouride.bundle.js ./nouride.bundle.js
COPY --from=dashboard-builder /app/apps/dashboard/dist ./apps/dashboard/dist
COPY content/skills ./skills
COPY config.example.toml ./
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# The CLI, in two places for two callers. Without it the image had no `nouride` at all.
#
# - `/app/nouride`, beside the install: the agent's `nouride` tool is offered only when
#   `<install>/nouride` exists (`boot/tools.ts`), so without this file an agent in a container had no
#   way to its daemon — `exec` refuses the bare name and points at a tool that was never offered.
# - `/usr/local/bin/nouride`, on PATH, for `docker exec <container> nouride …`.
#
# See the script for why it sets NOURIDE_HOME.
COPY scripts/docker-nouride.sh /app/nouride
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /app/nouride && ln -s /app/nouride /usr/local/bin/nouride
# nouride-pkg, its backends and its container service: what runs as root, where install.sh puts it on a host.
COPY packages/system-packages/root /usr/local/lib/nouride-pkg
RUN chmod 755 /usr/local/lib/nouride-pkg/nouride-pkg /usr/local/lib/nouride-pkg/container/nouride-pkg-container

# All mutable state lives under /app/.nouride and nothing config-like is baked into the image, so
# there is exactly one place to look when a deployment misbehaves — and exactly one path to mount.
#
# Nothing else under /app is created for state — `/app/data` in particular. That is the standalone
# nougate image's data directory, and an in-process nougate used it whenever it existed: its accounts
# and providers landed outside the volume and a recreate wiped them. Nougate now writes to
# `$NOUGATE_HOME/data` (= /app/.nouride/nougate/data), which this image never has to know about.
RUN mkdir -p /app/.nouride/data /app/.nouride/agents /app/.nouride/workspace/shared \
    && chown -R bun:bun /app/.nouride

# `wa-bridge="1"` on every edition: it stopped being a switch on 2026-09-16.
# The licence is the repository's own, for every edition: LICENSE is the PolyForm Strict License 1.0.0, and this is its
# SPDX id, as the manifests say it. The public images once carried `LicenseRef-Nouride`, a placeholder no file defined.
FROM runtime-base AS edition-basic
LABEL org.opencontainers.image.licenses="PolyForm-Strict-1.0.0"
LABEL tech.nouverse.nouride.edition="basic"
LABEL tech.nouverse.nouride.bundled.wa-bridge="1"
LABEL tech.nouverse.nouride.bundled.oauth="0"

# The free build plus the LLM gateway, and nothing else.
FROM runtime-base AS edition-router
LABEL org.opencontainers.image.licenses="PolyForm-Strict-1.0.0"
LABEL tech.nouverse.nouride.edition="router"
LABEL tech.nouverse.nouride.bundled.wa-bridge="1"
LABEL tech.nouverse.nouride.bundled.nougate="1"
LABEL tech.nouverse.nouride.bundled.oauth="0"
COPY --from=engine-builder /app/internals/nougate/apps/frontend/dist /usr/local/bin/frontend
EXPOSE 18256

# Everything, the gateway included since 0.7.20. Its frontend is beside the bundle as Router's is,
# and its port is declared, though nothing listens on it until the gateway is switched on.
FROM runtime-base AS edition-pro
LABEL org.opencontainers.image.licenses="PolyForm-Strict-1.0.0"
LABEL tech.nouverse.nouride.edition="pro"
LABEL tech.nouverse.nouride.bundled.wa-bridge="1"
LABEL tech.nouverse.nouride.bundled.nougate="1"
LABEL tech.nouverse.nouride.bundled.oauth="1"
COPY --from=engine-builder /app/internals/nougate/apps/frontend/dist /usr/local/bin/frontend
EXPOSE 18256

FROM edition-${EDITION} AS runtime

EXPOSE 18254

ENV HOST=0.0.0.0

ENTRYPOINT ["docker-entrypoint.sh"]
# `--smol`, as the compiled binary has in its execArgv: a smaller heap, collected more often (E8). The image ran
# without it, at about 29 % more peak memory than the same daemon from a tarball, in the place a cap is likeliest.
#
# `--no-install`, because /app has no node_modules, and there Bun installs from npm any package an import names and
# nothing resolves. Every import an edition leaves out is such a name — `nouride-oauth`, which each boot tries in order
# to learn that it is not there, and Baileys' `sharp` — and none of them is a package of ours on npm, so whoever
# published one under that name would have had it run inside every container that started. A compiled binary never
# did this; with the flag the image does not either, and an import of a plugin it does not carry fails as it should.
CMD ["bun", "--smol", "--no-install", "run", "nouride.bundle.js", "start"]
