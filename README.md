# Nouride

> The source code, official binary releases and container images of [Nouride](https://nouride.com).
> The source is here to read: Nouride is free for personal and other noncommercial use, under the
> [PolyForm Noncommercial License 1.0.0](#licence).


[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg?style=flat-square)](https://polyformproject.org/licenses/noncommercial/1.0.0)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/gadingnst) [![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-29abe0?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/gadingnst) [![Trakteer](https://img.shields.io/badge/Support-Trakteer-red?style=flat-square)](https://trakteer.id/gadingnst) [![KaryaKarsa](https://img.shields.io/badge/Support-KaryaKarsa-ffb800?style=flat-square)](https://karyakarsa.com/gadingnst)

[Nouride](https://nouride.com) is an ultra-lightweight, zero-bloat multi-agent AI engine in a single binary daemon. Built for servers, homelabs, and edge/mini devices (Raspberry Pi, Orange Pi, Geekom, NUC, LXC, Docker, a Mac with Apple Silicon), it connects multiple chat platforms (Discord, Telegram, WhatsApp) to isolated AI agents with individual personas, shared skill pools, tool execution approval gates, scheduled work, long missions an agent finishes on its own, and a web dashboard.

- 🌐 **Website:** [nouride.com](https://nouride.com)
- 📖 **Documentation:** [nouride.com/docs](https://nouride.com/en/docs/start/what-is-nouride/)
- 🚀 **Getting Started:** [nouride.com/docs/start/first-run](https://nouride.com/en/docs/start/first-run/)
- 📦 **Docker Container:** `ghcr.io/nouverse/nouride`, or `ghcr.io/nouverse/nouride-router` with the Nougate AI Router built in

---

## Installation & Quickstart

### 1. Automated Linux Install (Recommended)

Nouride runs as a standalone self-contained binary with its own embedded runtime. On any supported Linux machine (Debian, Ubuntu, RHEL, Alpine, Arch, Raspberry Pi OS), run:

```bash
curl -fsSL https://get.nouride.com/install.sh | sudo sh
```

To review the script before piping it to a shell:

```bash
curl -fsSL https://get.nouride.com/install.sh | less
```

By default, the installer binds the web dashboard to loopback (`127.0.0.1:18254`). To expose it across your local network immediately:

```bash
curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --host 0.0.0.0
```

For the **Router edition** (bundled with the in-process Nougate LLM Gateway and Web Admin Console):

```bash
curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --variant router
# or expose on LAN:
curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --variant router --host 0.0.0.0
```

To update a native install later, use the dashboard's Update page or `nouride update`.

Once installed, open `http://127.0.0.1:18254/` on that machine (or `http://<your-ip>:18254/` if you
installed with `--host 0.0.0.0`) to complete setup. The first-run password is printed by the installer
and in the service log (`journalctl -u nouride | grep -A6 'Nouride is ready'`).

### macOS (Apple Silicon)

On a Mac with Apple Silicon (M1 and later), since 0.7.20, as yourself, **no `sudo`**:

```bash
curl -fsSL https://get.nouride.com/install.sh | sh
# the Router variant:
curl -fsSL https://get.nouride.com/install.sh | sh -s -- --variant router
```

It installs into `~/nouride` and runs as a LaunchAgent while you are logged in. The first-run password is in
`~/nouride/.nouride/data/nouride.log`. Intel Macs are not a published target.

---

### 2. Docker Container

The official multi-arch container image (`linux/amd64` and `linux/arm64`) is published to GitHub Container Registry:

```bash
mkdir -p ~/nouride && cd ~/nouride
docker run -d \
  --name nouride \
  --restart unless-stopped \
  -p 127.0.0.1:18254:18254 \
  -v "$PWD/nouride:/app/.nouride" \
  ghcr.io/nouverse/nouride

docker logs -f nouride          # the first-run password is printed here
```

Docker Compose:

```yaml
services:
  nouride:
    image: ghcr.io/nouverse/nouride
    container_name: nouride
    restart: unless-stopped
    ports:
      - "127.0.0.1:18254:18254"
    volumes:
      - ./nouride:/app/.nouride
```

The port is published on the host's loopback only, as a native install listens: open the dashboard on the machine
itself, or tunnel to it from yours with `ssh -L 18254:127.0.0.1:18254 you@your-server`. To reach it from other
machines, drop `127.0.0.1:` (`"18254:18254"`): the dashboard then answers anyone who can reach the host, and a port
Docker publishes goes around a firewall such as `ufw`. For a public address, keep it on loopback and put a reverse proxy
with TLS in front of it on the same machine (Caddy, nginx, a Cloudflare Tunnel).

Agents install system packages in the container too: `docker exec nouride nouride pkg install <name>`, or an agent asks,
and you approve each change unless the agent is `trusted`. What they installed is kept on the volume and installed again
when the container is recreated, as every update does; nothing the image ships can be removed.
`NOURIDE_SYSTEM_PACKAGES=off` turns it off.

#### Variant: Nougate AI Router

`nouride-router` is the same build **plus the Nougate AI Router in the same process**: model calls
answered from inside the daemon, with no second container and no network hop. Useful on a Pi, an LXC
container, or anywhere that has to answer without a gateway in front of it.

```bash
mkdir -p ~/nouride && cd ~/nouride
docker run -d \
  --name nouride \
  --restart unless-stopped \
  -p 127.0.0.1:18254:18254 \
  -p 127.0.0.1:18256:18256 \
  -v "$PWD/nouride:/app/.nouride" \
  ghcr.io/nouverse/nouride-router
```

Docker Compose:

```yaml
services:
  nouride:
    image: ghcr.io/nouverse/nouride-router
    container_name: nouride
    restart: unless-stopped
    ports:
      - "127.0.0.1:18254:18254"
      - "127.0.0.1:18256:18256"
    volumes:
      - ./nouride:/app/.nouride
```

In the Router edition (`ghcr.io/nouverse/nouride-router`), the in-process Nougate gateway is **enabled by default** on port `18256` and keeps its state (accounts, providers, `nougate.db`) in a folder of its own inside the same volume: `./nouride/nougate/data/`. Nothing else to mount. Its web admin console is at `/frontend/` on port 18256.

Point a provider at it in `.nouride/config.toml`:

```toml
[providers.local]
kind = "openai"
base_url = "http://127.0.0.1:18256/openai/v1"   # or /anthropic/v1
```

To explicitly configure or switch it off, use `[nougate]` in `.nouride/config.toml` (or set `NOUGATE_IN_PROCESS=false` in the daemon's environment):

```toml
[nougate]
in_process = false
port = 18256
```

To update, pull it again and recreate the container. The volume keeps everything:

```bash
docker compose pull && docker compose up -d
```

To check your configuration against a new image before you switch:

```bash
docker run --rm -v ./nouride:/app/.nouride ghcr.io/nouverse/nouride nouride config check
```

An install older than 0.7.28 updates in two steps:
[Updating](https://nouride.com/en/docs/deployment/updating/) has how.

To see which variant an image is without pulling it:

```bash
docker image inspect ghcr.io/nouverse/nouride-router \
  --format '{{index .Config.Labels "tech.nouverse.nouride.edition"}}'
```

---

### 3. Standalone Binary Downloads

Standalone tarballs include the executable, built-in skills, example configuration, and web dashboard assets. You can download the latest release directly or browse specific versions on the [Releases](https://github.com/nouverse/nouride/releases) page.

| Platform | Architecture | C Library | Download |
|---|---|---|---|
| Linux | `x86_64` | glibc | [`nouride-linux-x64.tar.gz`](https://get.nouride.com/latest/nouride-linux-x64.tar.gz) |
| Linux | `aarch64` | glibc | [`nouride-linux-arm64.tar.gz`](https://get.nouride.com/latest/nouride-linux-arm64.tar.gz) |
| Linux (Alpine) | `x86_64` | musl | [`nouride-linux-x64-musl.tar.gz`](https://get.nouride.com/latest/nouride-linux-x64-musl.tar.gz) |
| Linux (Alpine) | `aarch64` | musl | [`nouride-linux-arm64-musl.tar.gz`](https://get.nouride.com/latest/nouride-linux-arm64-musl.tar.gz) |
| macOS | Apple Silicon | not applicable | [`nouride-darwin-arm64.tar.gz`](https://get.nouride.com/latest/nouride-darwin-arm64.tar.gz) |

The Router variant ships the same targets, named `nouride-router-*`:

| Platform | Architecture | C Library | Download |
|---|---|---|---|
| Linux | `x86_64` | glibc | [`nouride-router-linux-x64.tar.gz`](https://get.nouride.com/latest/nouride-router-linux-x64.tar.gz) |
| Linux | `aarch64` | glibc | [`nouride-router-linux-arm64.tar.gz`](https://get.nouride.com/latest/nouride-router-linux-arm64.tar.gz) |
| Linux (Alpine) | `x86_64` | musl | [`nouride-router-linux-x64-musl.tar.gz`](https://get.nouride.com/latest/nouride-router-linux-x64-musl.tar.gz) |
| Linux (Alpine) | `aarch64` | musl | [`nouride-router-linux-arm64-musl.tar.gz`](https://get.nouride.com/latest/nouride-router-linux-arm64-musl.tar.gz) |
| macOS | Apple Silicon | not applicable | [`nouride-router-darwin-arm64.tar.gz`](https://get.nouride.com/latest/nouride-router-darwin-arm64.tar.gz) |

Or let the installer fetch it:

```bash
curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --variant router
```

> **Note on Alpine / Musl:** The `-musl` build requires `libstdc++` (`apk add libstdc++`).

SHA256 checksums are attached to every release: `SHA256SUMS` for the standard build,
`SHA256SUMS-router` for the Router variant.

---

## Source code

This repository holds Nouride's source: the daemon (`apps/engine`), the dashboard (`apps/dashboard`), the documentation
site (`apps/site`) and the packages they share (`packages/`). Nouride Pro's components are not in it.

- [GETTING_STARTED.md](./GETTING_STARTED.md): running it from source.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md): how it is built, and why.
- [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md): the conventions, and how a change is tested.

---

## Contributing & Issues

- **Found a bug or crash?** Please **[Open an Issue](https://github.com/nouverse/nouride/issues)**. Include your OS version, architecture (`uname -m`), deployment method (native or Docker), and relevant terminal output.
- **Feature Proposals:** Have ideas for new homelab integrations, agent tools, or chat adapters? Open an issue with your proposal and rationale.
- **Pull requests** are welcome. By sending one you agree that Nouverse may use, change and license your contribution as part of Nouride, under any terms, and you confirm that it is yours to give.
- **Security Inquiries:** For sensitive security concerns, reach out directly to security@nouverse.tech.

---

## Licence

Nouride is licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE). In short:

- **Free for personal and noncommercial use.** You may read the source and run Nouride for yourself, at home, in a
  homelab, for a hobby project or for study, and in a noncommercial organization such as a school or a charity.
- **Change it and share it, noncommercially.** Fix, adapt and extend your own install, and share your changes, for any
  noncommercial purpose, with these terms beside them.
- **Commercial use needs a licence** from [Nouverse Technologies](https://nouverse.com).
- **The Nouride name and logo** are trademarks of Nouverse and are not licensed: a changed copy is not called Nouride.

Licensed separately: the WhatsApp bridge in `packages/wa-bridge` and the built-in skills and agent templates in
`content/` are MIT, so the agents and skills you run are yours to change. [LICENSE](./LICENSE) lists every exception.
The licence text governs; this summary does not replace it.
