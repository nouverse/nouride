<div align="center">

<img src="packages/shared/assets/mascot/standing/01-waving.webp" alt="The Nouride cat, waving hello" width="200">

# Nouride

### AI agents that live on your box

Nouride runs a few AI agents on a small box you own, and uses very little of it.<br>
Chat with them on Telegram, Discord, WhatsApp or right in your browser.

[**Website**](https://nouride.com) · [**Docs**](https://nouride.com/en/docs/start/what-is-nouride/) · [**Getting started**](https://nouride.com/en/docs/start/first-run/) · [**Releases**](https://github.com/nouverse/nouride/releases)

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/License-FSL--1.1--ALv2-blue.svg?style=flat-square)](#licence)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/gadingnst)
[![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-29abe0?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/gadingnst)
[![Trakteer](https://img.shields.io/badge/Support-Trakteer-red?style=flat-square)](https://trakteer.id/gadingnst)
[![KaryaKarsa](https://img.shields.io/badge/Support-KaryaKarsa-ffb800?style=flat-square)](https://karyakarsa.com/gadingnst)

<br>

<img src="apps/site/public/media/dashboard-overview.png" alt="Nouride's dashboard: Home, with what needs you, what is moving and a quick line to an agent" width="880">

</div>

<br>

## What it does

<table>
<tr>
<td width="110" align="center"><img src="packages/shared/assets/mascot/standing/05-laptop.webp" alt="" width="96"></td>
<td><b>A few agents, each its own.</b> Every agent has its own personality, model, chat apps and tools. They all run in
one small daemon from a single binary, which starts in 64 MB of memory and sits under 1% of one CPU core while it
waits.</td>
</tr>
<tr>
<td align="center"><img src="packages/shared/assets/mascot/standing/10-pointing.webp" alt="" width="96"></td>
<td><b>Say hi from the apps you already use.</b> Telegram, Discord, WhatsApp, or the web dashboard. Put several agents in
one room and tag the one you mean.</td>
</tr>
<tr>
<td align="center"><img src="packages/shared/assets/mascot/states/05-security.webp" alt="" width="96"></td>
<td><b>Risky stuff waits for your yes.</b> A command that changes the system, touches credentials or cannot be undone
asks first: allow it once, always, or not at all, from the chat or the dashboard.</td>
</tr>
<tr>
<td align="center"><img src="packages/shared/assets/mascot/states/09-schedule.webp" alt="" width="96"></td>
<td><b>Give it a goal, go to bed.</b> Missions an agent works through on its own, with a checklist you can follow;
scheduled jobs; webhooks that wake an agent when something happens elsewhere.</td>
</tr>
<tr>
<td align="center"><img src="packages/shared/assets/mascot/states/03-knowledge.webp" alt="" width="96"></td>
<td><b>It remembers.</b> People, facts and your documents, kept on the box and found again in any language. A nightly
pass tidies what it learned.</td>
</tr>
<tr>
<td align="center"><img src="packages/shared/assets/mascot/states/02-searching.webp" alt="" width="96"></td>
<td><b>Skills and connectors.</b> One pool of skills every agent can switch on, skills learned from work it did,
connectors to the services you use, and web search.</td>
</tr>
<tr>
<td align="center"><img src="packages/shared/assets/mascot/standing/12-head.webp" alt="" width="80"></td>
<td><b>Claude Code and Codex as agents.</b> An agent can work inside a coding CLI on your own subscription, with the
same chats, approvals and missions as the rest.</td>
</tr>
<tr>
<td align="center"><img src="packages/shared/assets/mascot/standing/02-thumbs-up.webp" alt="" width="96"></td>
<td><b>Your box, your data.</b> Conversations, memory and keys stay on your machine, keys encrypted at rest. What leaves
is what an agent sends to the models and services you chose.</td>
</tr>
</table>

<br>

## Get it running

**Linux** (Debian, Ubuntu, RHEL, Alpine, Arch, Raspberry Pi OS), one line:

```bash
curl -fsSL https://get.nouride.com/install.sh | sudo sh
```

**macOS** (Apple Silicon), as yourself, no `sudo`:

```bash
curl -fsSL https://get.nouride.com/install.sh | sh
```

**Docker**:

```bash
mkdir -p ~/nouride && cd ~/nouride
docker run -d --name nouride --restart unless-stopped \
  -p 127.0.0.1:18254:18254 -v "$PWD/nouride:/app/.nouride" \
  ghcr.io/nouverse/nouride
```

Then open `http://127.0.0.1:18254/` on that machine and follow the setup: connect a model, name your first agent, done.
The first-run password is printed by the installer (and in `docker logs nouride`).

<details>
<summary><b>More on the Linux install</b></summary>

<br>

Nouride runs as a standalone binary with its own embedded runtime. To review the script before piping it to a shell:

```bash
curl -fsSL https://get.nouride.com/install.sh | less
```

By default the dashboard listens on loopback (`127.0.0.1:18254`). To expose it across your local network:

```bash
curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --host 0.0.0.0
```

To update a native install later, use the dashboard's Update page or `nouride update`.

Once installed, open `http://127.0.0.1:18254/` on that machine (or `http://<your-ip>:18254/` if you installed with
`--host 0.0.0.0`) to complete setup. The first-run password is printed by the installer and in the service log
(`journalctl -u nouride | grep -A6 'Nouride is ready'`).

</details>

<details>
<summary><b>More on macOS</b></summary>

<br>

On a Mac with Apple Silicon (M1 and later), since 0.7.20:

```bash
curl -fsSL https://get.nouride.com/install.sh | sh
```

It installs into `~/nouride` and runs as a LaunchAgent while you are logged in. The first-run password is in
`~/nouride/.nouride/data/nouride.log`. Intel Macs are not a published target.

</details>

<details>
<summary><b>More on Docker</b>: Compose, the network, packages and updates</summary>

<br>

The official multi-arch image (`linux/amd64` and `linux/arm64`) is on GitHub Container Registry. With Docker Compose:

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

</details>

<details>
<summary><b>Nougate</b>: sign in with an AI account instead of an API key</summary>

<br>

Every install carries the Nougate LLM gateway in the same process: model calls answered from inside the daemon, with
no second container and no network hop. It stays off until you choose **Use Nougate** in setup, or turn it on from the
dashboard's **LLM Gateway** page; then setup signs in to a Claude, ChatGPT, Copilot, Gemini or Kiro account you
already have instead of asking for an API key. Off, it costs about 1.3 MB of memory.

On, it listens on port `18256` and keeps its state (accounts, providers, `nougate.db`) in a folder of its own inside
the same volume: `./nouride/nougate/data/`. Publish `18256` only for other tools that call it with a gateway key. To
point a provider at it by hand, in `.nouride/config.toml`:

```toml
[providers.local]
kind = "openai"
base_url = "http://127.0.0.1:18256/openai/v1"   # or /anthropic/v1
```

**Coming from the Router edition?** Router is part of Community since 0.8.28. A Router install updates onto
Community by itself and keeps Nougate on. Until 0.9 the `nouride-router` image still receives each release; change
`image:` to `ghcr.io/nouverse/nouride` whenever you like before then.

</details>

<details>
<summary><b>Standalone downloads</b>: every platform's tarball</summary>

<br>

Standalone tarballs include the executable, built-in skills, example configuration and the dashboard. Download the
latest directly, or browse every version on the [Releases](https://github.com/nouverse/nouride/releases) page.

| Platform | Architecture | C Library | Download |
|---|---|---|---|
| Linux | `x86_64` | glibc | [`nouride-linux-x64.tar.gz`](https://get.nouride.com/latest/nouride-linux-x64.tar.gz) |
| Linux | `aarch64` | glibc | [`nouride-linux-arm64.tar.gz`](https://get.nouride.com/latest/nouride-linux-arm64.tar.gz) |
| Linux (Alpine) | `x86_64` | musl | [`nouride-linux-x64-musl.tar.gz`](https://get.nouride.com/latest/nouride-linux-x64-musl.tar.gz) |
| Linux (Alpine) | `aarch64` | musl | [`nouride-linux-arm64-musl.tar.gz`](https://get.nouride.com/latest/nouride-linux-arm64-musl.tar.gz) |
| macOS | Apple Silicon | not applicable | [`nouride-darwin-arm64.tar.gz`](https://get.nouride.com/latest/nouride-darwin-arm64.tar.gz) |

> **Alpine / musl:** the `-musl` build needs `libstdc++` (`apk add libstdc++`).

Every release carries its checksum file, signed: `CHECKSUMS`, with its `.sig`. The installer checks both before it
installs anything.

</details>

<br>

## Nouride Home, on a phone

**[nouverse/nouride-android-appliance](https://github.com/nouverse/nouride-android-appliance)** is Nouride Home, the
Android app that runs Nouride on a phone, with no terminal and no root. It has its own releases and updates itself; the
APK is on its [Releases](https://github.com/nouverse/nouride-android-appliance/releases) page, and how to use it is in
the [Nouride Home guide](https://nouride.com/en/docs/deployment/nouride-home/).

## The source

This repository holds Nouride's source: the daemon (`apps/engine`), the dashboard (`apps/dashboard`), the documentation
site (`apps/site`) and the packages they share (`packages/`). Nouride Pro's components are not in it.

- [GETTING_STARTED.md](./GETTING_STARTED.md): running it from source.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md): how it is built, and why.
- [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md): the conventions, and how a change is tested.

## Contributing and issues

- **Found a bug or crash?** [Open an issue](https://github.com/nouverse/nouride/issues) with your OS version,
  architecture (`uname -m`), how you run it (native or Docker), and the output you saw.
- **An idea?** New chat apps, agent tools, homelab integrations: open an issue with what it is for.
- **Pull requests** are welcome. Before the first one is merged, its author agrees to the
  [Contributor Licence Agreement](./docs/CLA.md): you keep your copyright, and Nouverse may use your contribution in
  every edition, under any terms.
- **Security:** for anything sensitive, write to security@nouverse.tech.

## Licence

Nouride is licensed under the [Functional Source License 1.1, ALv2 Future License](./LICENSE) (`FSL-1.1-ALv2`). In
short:

- **Use it for anything but a competing product.** At home, in a homelab, at work, inside your company, and to set it
  up for a client. Change it and share your changes, with these terms beside them.
- **A competing product needs a licence** from [Nouverse Technologies](https://nouverse.com): Nouride, or something
  that does what it does, made available to others commercially, such as a hosted Nouride or a device sold with it.
- **Each version becomes Apache 2.0** two years after it is released.
- **The Nouride name and logo** are trademarks of Nouverse and are not licensed: a changed copy is not called Nouride.

Licensed separately: the WhatsApp bridge in `packages/wa-bridge` and the built-in skills and agent templates in
`content/` are MIT, so the agents and skills you run are yours to change. [LICENSE](./LICENSE) lists every exception.
The licence text governs; this summary does not replace it.

<br>

<div align="center">
<img src="packages/shared/assets/mascot/standing/06-sleeping.webp" alt="The Nouride cat, asleep" width="140">
<br>
<sub>Nothing is waiting for you. Made by <a href="https://nouverse.com">Nouverse</a>.</sub>
</div>
