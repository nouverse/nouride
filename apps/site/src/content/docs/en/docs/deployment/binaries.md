---
title: Builds & Downloads
description: Nouride release variants, resource footprints, and direct download links for standalone deployments.
---

One edition is public, Community, as Linux and macOS tarballs and as a container image. It carries WhatsApp
and the [Nougate LLM gateway](/en/docs/providers/nougate/) in the binary itself.

## Editions

| Edition | Binary | Tarball | Idle RSS | Description |
|---|---|---|---|---|
| **Community** | ~89 MB | ~40 MB | ~58 MB | The free self-hosted edition. Runs on any Linux server, VM or local computer. |

Sizes are approximate, measured on `linux-x64` builds of 0.7. The idle RSS figure comes from an older
release and has not been re-measured since.

Community is one account with a local password, an in-process SQLite database, and TOML configuration. Nougate
is in the same process and stays off until you choose **Use Nougate** in setup or turn it on from the
dashboard's **LLM Gateway** page (`[nougate] in_process = true`). Carried and off, it costs about 0.5 MB of
binary and 1.3 MB of memory; on and idle, about 3.6 MB more. It is not a second process.

The Router edition, which was Community with the gateway on, is part of Community since 0.8.29. Until 0.9 each
release still carries its old names, `nouride-router-*` and `@@DOCKER_IMAGE@@-router`, so a Router install
updates onto Community by itself, with Nougate kept on.

Pro adds multi-user accounts, Nouverse sign-in and Nouride Box pairing, and carries the same LLM gateway,
off until `[nougate] in_process = true`. It is not public: there is no public download or image for it.

---

## Downloads

Tarballs come from `@@DOWNLOAD_DOMAIN@@`, one per target. Each holds the `nouride` executable, the
dashboard, the built-in skills, `config.example.toml`, and `pkg/`, the root service that
[`--allow-packages`](/en/docs/deployment/system-packages/) sets up. A Linux tarball also holds `run/`, the
`nouride-run` helper `install.sh` sets up so [each agent's commands run as its own user](/en/docs/architecture/overview/#each-agent-its-own-user).
It also holds `frontend/`, the gateway's own console.

### Quick Install via CLI

The simplest way to install or update Nouride on Linux:

```bash
@@INSTALL_CMD@@
```

The installer picks the build for this machine's CPU and C library (glibc or musl), and stops on
32-bit ARM, which has no build.

### Direct Binary Downloads

Download release tarballs directly for your target system:

| Platform | Architecture | C Library | Archive |
|---|---|---|---|
| Linux | `x86_64` | glibc | [`nouride-linux-x64.tar.gz`](@@TARBALL_BASE@@/nouride-linux-x64.tar.gz) |
| Linux | `aarch64` | glibc | [`nouride-linux-arm64.tar.gz`](@@TARBALL_BASE@@/nouride-linux-arm64.tar.gz) |
| Linux (Alpine) | `x86_64` | musl | [`nouride-linux-x64-musl.tar.gz`](@@TARBALL_BASE@@/nouride-linux-x64-musl.tar.gz) |
| Linux (Alpine) | `aarch64` | musl | [`nouride-linux-arm64-musl.tar.gz`](@@TARBALL_BASE@@/nouride-linux-arm64-musl.tar.gz) |
| macOS | Apple Silicon | not applicable | [`nouride-darwin-arm64.tar.gz`](@@TARBALL_BASE@@/nouride-darwin-arm64.tar.gz) |

macOS tarballs are for Apple Silicon (`darwin-arm64`).

### Container Image (Docker)

For containerized deployments:

```bash
docker pull @@DOCKER_IMAGE@@
```

The image provides multi-arch support for both `linux/amd64` and `linux/arm64`. Refer to [Docker & Compose](/en/docs/deployment/docker/) for container configuration.

---

## Compiling from Source (Optional)

To compile the binary locally from the source codebase:

```bash
bun run build:binary                                  # compile for your current host
bun run build:binary --target linux-arm64             # cross-compile for a specific target
bun run build:release                                 # build all four Linux targets
```

The Nougate gateway is built in when its source, `internals/nougate`, is checked out. It is not public: without
it the build is the same daemon without the gateway, and setup does not offer it.
