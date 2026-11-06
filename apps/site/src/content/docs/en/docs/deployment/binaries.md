---
title: Builds & Downloads
description: Nouride release variants, resource footprints, and direct download links for standalone deployments.
---

Two editions are public, each as Linux tarballs and as a container image. Both carry WhatsApp in the
binary itself.

## Nouride Variants

| Variant | Binary | Tarball | Idle RSS | Bundle | Description |
|---|---|---|---|---|---|
| **Community** | ~89 MB | ~40 MB | ~58 MB | *None* | The free self-hosted edition. Runs on any Linux server, VM or local computer. |
| **Router** | ~89 MB | ~40 MB | ~60 MB | Nougate | Community plus the [Nougate AI Gateway](/en/docs/providers/nougate/) running inside the daemon on port `18256`. |

Sizes are approximate, measured on `linux-x64` builds of 0.7. The idle RSS figures come from an older
release and have not been re-measured since.

### Variant Overview

- **Community (Self-Hosted):** The standard edition for running AI agents entirely on your own infrastructure. One account with a local password, an in-process SQLite database, and TOML configuration.
- **Router:** The same daemon with the Nougate LLM gateway compiled in, so a provider profile can point at `localhost` instead of a gateway on the network. `[nougate] in_process` defaults to `true` in this edition.

Pro adds multi-user accounts, Nouverse sign-in and Nouride Box pairing, and carries the same LLM gateway,
off until `[nougate] in_process = true`. It is not public: there is no public download or image for it.

---

## Downloads

Tarballs come from `@@DOWNLOAD_DOMAIN@@`, one per target. Each holds the `nouride` executable, the
dashboard, the built-in skills, `config.example.toml`, and `pkg/`, the root service that
[`--allow-packages`](/en/docs/deployment/system-packages/) sets up. A Linux tarball also holds `run/`, the
`nouride-run` helper `install.sh` sets up so [each agent's commands run as its own user](/en/docs/architecture/overview/#each-agent-its-own-user).
A Router tarball adds `frontend/`, the gateway's own console.

### Quick Install via CLI

The simplest way to install or update Nouride on Linux:

```bash
@@INSTALL_CMD@@
```

The installer picks the build for this machine's CPU and C library (glibc or musl), and stops on
32-bit ARM, which has no build.

For the Router edition:

```bash
@@ROUTER_INSTALL_CMD@@
```

That wrapper runs the same installer with `--variant router`.

### Direct Binary Downloads

Download release tarballs directly for your target system:

| Platform | Architecture | C Library | Archive |
|---|---|---|---|
| Linux | `x86_64` | glibc | [`nouride-linux-x64.tar.gz`](@@TARBALL_BASE@@/nouride-linux-x64.tar.gz) |
| Linux | `aarch64` | glibc | [`nouride-linux-arm64.tar.gz`](@@TARBALL_BASE@@/nouride-linux-arm64.tar.gz) |
| Linux (Alpine) | `x86_64` | musl | [`nouride-linux-x64-musl.tar.gz`](@@TARBALL_BASE@@/nouride-linux-x64-musl.tar.gz) |
| Linux (Alpine) | `aarch64` | musl | [`nouride-linux-arm64-musl.tar.gz`](@@TARBALL_BASE@@/nouride-linux-arm64-musl.tar.gz) |
| macOS | Apple Silicon | not applicable | [`nouride-darwin-arm64.tar.gz`](@@TARBALL_BASE@@/nouride-darwin-arm64.tar.gz) |

Router tarballs use the same targets with a `router` infix: `nouride-router-linux-x64.tar.gz`, `nouride-router-linux-arm64-musl.tar.gz`, and so on. macOS tarballs are for Apple Silicon (`darwin-arm64`).

### Container Image (Docker)

For containerized deployments:

```bash
docker pull @@DOCKER_IMAGE@@          # Community
docker pull @@DOCKER_IMAGE@@-router   # Router
```

 Both images provide multi-arch support for both `linux/amd64` and `linux/arm64`. Refer to [Docker & Compose](/en/docs/deployment/docker/) for container configuration.

---

## Compiling from Source (Optional)

To compile the binary locally from the source codebase:

```bash
bun run build:binary                                  # compile for your current host
bun run build:binary --target linux-arm64             # cross-compile for a specific target
bun run build:release                                 # build all four Linux targets
```

`--router` builds the Router edition, and needs the Nougate gateway's source, which is not public.
