---
title: Docker & Compose
description: Running the daemon in a container, the compose file, what is in the image, and reaching other machines.
---

```bash
mkdir -p ~/nouride && cd ~/nouride
docker run -d --name nouride --restart unless-stopped --stop-timeout 45 \
  -p 127.0.0.1:@@PORT@@:@@PORT@@ \
  -e HOST=0.0.0.0 \
  -v "$PWD/nouride:/app/.nouride" \
  @@DOCKER_IMAGE@@
```



Nothing to configure first. A fresh install boots with no `config.toml` and no agents, and everything
after that happens in the browser.

```bash
docker logs -f nouride          # the first-run password is printed here
```

:::caution[`HOST=0.0.0.0` is not optional in a container]
Loopback is the right default for a daemon running natively on a host, but a container that binds
loopback binds *its own* loopback and your published port reaches nothing. Verified the other way
round once: `curl` from the host got nothing while the same request inside the container answered.

The image sets it already; the flag above matters when you override the environment.
:::

`--stop-timeout 45` is there for the same reason as `stop_grace_period` below. Docker waits 10
seconds and then sends `SIGKILL`, which is shorter than the daemon's own 30-second drain: a turn still
running when the container stops would be killed before it could finish its step and say so.

## Compose

```yaml
services:
  nouride:
    image: @@DOCKER_IMAGE@@
    container_name: nouride
    restart: unless-stopped
    stop_grace_period: 45s
    ports:
      - "127.0.0.1:@@PORT@@:@@PORT@@"
    volumes:
      - ./nouride:/app/.nouride
```

The port is published on the host's loopback only, as a native install listens: open the dashboard on the
machine itself, or tunnel to it from yours with `ssh -L @@PORT@@:127.0.0.1:@@PORT@@ you@your-server`. To reach
it from other machines, drop `127.0.0.1:` (`"@@PORT@@:@@PORT@@"`): the dashboard then answers anyone who can reach
the host, and a port Docker publishes goes around a firewall such as `ufw`. For a public address, keep it on loopback and put a reverse proxy with TLS in front of it on the same machine
(Caddy, nginx, a Cloudflare Tunnel): the dashboard is a login, and a login over plain HTTP is a password on the wire.

### Production & advanced compose

For production deployments where you want healthchecks, log rotation, and environment variable substitution:

```yaml
services:
  nouride:
    image: @@DOCKER_IMAGE@@
    container_name: nouride
    restart: unless-stopped
    stop_grace_period: 45s
    ports:
      - "127.0.0.1:${PORT:-@@PORT@@}:${PORT:-@@PORT@@}"
    # Every credential reaches the container this way. Secret *names* are chosen in config.toml:
    # `api_key = "nougate"` reads $NOUGATE, so they cannot be enumerated under `environment`.
    env_file:
      - path: .env
        required: false
    environment:
      - HOST=${HOST:-0.0.0.0}
      - PORT=${PORT:-@@PORT@@}
      - LOG_LEVEL=${LOG_LEVEL:-info}
    volumes:
      # The whole install as one mount: config, database, secrets, agent packs, workspace.
      - ./nouride:/app/.nouride:z
    healthcheck:
      test: ["CMD", "bun", "-e", "await fetch('http://localhost:@@PORT@@/health').then(r=>process.exit(r.ok?0:1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

**Why `env_file` and not just `environment`.** Compose reads `.env` either way, but only to substitute
`${...}` in the compose file itself, so any key not also listed under `environment` would be silently
ignored by the daemon. And the list under `environment` is deliberately short, because credential
variable names are chosen in `config.toml` and cannot be enumerated here.

You can also keep credentials out of `.env` entirely and set them from the dashboard. They land in
the secret store, `.nouride/data/secrets.enc`, on the mounted volume, encrypted. Keep its key out of the
volume, so a backup of `.nouride/` carries none: `NOURIDE_ENCRYPTION_KEY` in `.env` (`openssl rand -base64 32`),
or a Docker secret named in `NOURIDE_ENCRYPTION_KEY_FILE`. Without either, Nouride makes a key and keeps it in
the volume, and `nouride doctor` says so; given one later, it moves to it at its next start. Keep a copy of the
key: without it, or a backup password (the dashboard's Secrets page sets one), the store cannot be opened.

## One mount, one backup

```
.nouride/
├── config.toml
├── data/          SQLite and secrets.enc - 0600; the control token - 0640, the CLI's credential (group-readable)
├── agents/        persona packs
├── memory/        the memory vault, once there is something in it
├── home/          the agents' HOME: ~/.ssh, CLI logins
├── bin/ lib/ opt/ what the agents installed for themselves
└── workspace/     what the agents produce
```

The control token is 0640 rather than 0600 so that, on a native install, the members of the service group run
the CLI without sudo. The daemon sets it back to 0640 at every start, and `nouride doctor` accepts nothing more open.

To keep the agents' output on a different disk from the daemon's state, mount `workspace` separately
and point `workspace_dir` at it. The three paths are separate config keys for exactly that.

## Which image

One is public, and this page names it throughout. The other is private:

| Package | What it carries | Notes |
|---|---|---|
| `@@DOCKER_IMAGE@@` | The Community edition, with the Nougate gateway in the same process, off until chosen | The standard image for self-hosting |
| `@@DOCKER_IMAGE@@-pro` | The Pro edition: multi-user accounts and Nouverse sign-in | **Private**, not pullable without access |

Setting `NOURIDE_OAUTH_ISSUER` against the public image is **refused at boot**, with a sentence
saying this build has no external sign-in. It is not ignored, and there is no environment variable
that turns it on: the code is not in there.

[Variants and specifications →](/en/docs/deployment/binaries/)

### Nougate in the container

Nougate is off until you choose **Use Nougate** in setup or turn it on from the **LLM Gateway** page. Its
dashboard is that page, behind the same sign-in, and it keeps its state, its accounts, providers and
`nougate.db`, in `./nouride/nougate/data/`, inside the same single volume mount. Publish port `18256` as well only
for what calls the gateway directly: other tools with a gateway key, or its standalone console at
`http://<your-ip>:18256/frontend/`:

```yaml
services:
  nouride:
    image: @@DOCKER_IMAGE@@
    container_name: nouride
    restart: unless-stopped
    stop_grace_period: 45s
    ports:
      - "127.0.0.1:@@PORT@@:@@PORT@@"
      - "127.0.0.1:18256:18256"   # Nougate, for tools with a gateway key and its console (/frontend/)
    volumes:
      - ./nouride:/app/.nouride
```

[The Nougate page →](/en/docs/providers/nougate/#running-it-inside-the-daemon)

### Coming from nouride-router

The Router image, Community with Nougate on, is part of this image since 0.8.28. Until 0.9,
`@@DOCKER_IMAGE@@-router` still receives each release: it is this image, so its first start keeps Nougate on and
its accounts as they are, and the dashboard asks you to switch the name. Switch it whenever you like, and before 0.9,
when the old name stops receiving releases: change `image:` to `@@DOCKER_IMAGE@@` and run `docker compose up -d`.
Nothing else changes.

## The registry

The public image pulls without a login. A private package, or an image you build and push to a
private registry yourself, needs one:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
```

A classic PAT, or a fine-grained token with `read:packages` and nothing more. For Kubernetes the same
credential becomes an `imagePullSecret`:

```bash
kubectl create secret docker-registry ghcr \
  --docker-server=ghcr.io --docker-username=<github-username> --docker-password="$GHCR_TOKEN"
```

## What is in the image, and what is not

Bun, plus `bash`, `openssh-client`, `util-linux` (for `script(1)`, which is what makes interactive
sessions work), `ripgrep`, `su-exec` for the entrypoint's privilege drop, and `socat` for the package
service. Nothing else: not `git`, not `kubectl`, not Python, not a cloud CLI.

The daemon runs as uid 1000 (`bun`), so `apk add` is not the agent's. System packages go through
`nouride-pkg` instead (0.8.15): the entrypoint, root before it hands over, serves it, the agent asks
for a package by name (`nouride pkg install ffmpeg`), and you approve each change, unless the agent is
`trusted`. What agents installed is kept in `.nouride/system-packages` on the volume and installed again when
the container is recreated, as every update does. `NOURIDE_SYSTEM_PACKAGES=off` turns it off;
[System packages](/en/docs/deployment/system-packages/#in-docker) has the rest. To bake a package into
the image instead:

```bash
docker build --build-arg EXTRA_PACKAGES="git kubectl helm" -t nouride .
```

What an agent installs for itself does work, and it lands in `.nouride/bin` inside the volume, so it
survives a recreate: `bun add -g`, a release binary put in place with `install -m 755`, and `npm`,
`pipx`, `go` or `cargo` installs once those tools are in the image. The base image points
`bun add -g` at `/usr/local/bin`, which uid 1000 cannot write; the daemon replaces a setting it cannot
write with its own.

For infrastructure work over SSH you usually need less than you expect, `kubectl` runs on the
machine at the far end, not in here.

### MCP servers in the container

What a server needs to run decides what you do, and Explore says it on each card:

- **Remote servers** (Notion, Linear, and most hosted ones) need nothing in the image. One that signs in with an
  account shows **needs login** once added; press **Connect**. The login comes back to `NOURIDE_PUBLIC_URL`, or, without
  one, you paste the address the browser ended on into the card.
- **Python servers** (`uvx`) need uv, and uv is one binary: an agent can install it itself into the volume, where it
  outlives the container: `wget -qO- https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=$NOURIDE_BIN UV_NO_MODIFY_PATH=1 sh`.
  The image has `wget`, not `curl`.
- **npm servers** (`npx`) need Node.js, which is a system package here: an agent installs it through
  `nouride pkg install nodejs npm`, on your yes, or build the image with `--build-arg EXTRA_PACKAGES="nodejs npm"`.
  The `node` already in the image is Bun's stand-in, and has no `npx`.
- **Servers that run as an image** (`docker`) cannot be started from inside the container. Use the server's npm or
  Python form when it has one.

### Memory

A native install under systemd keeps every command an agent runs in a cgroup of its own, below the daemon, so a
command that eats memory is the one stopped (0.7.19). A container has no unit to split: the agents' commands run beside
the daemon, and `nouride doctor` says so. Give the container a memory limit, so a runaway command is stopped inside it
rather than pressing on the host, and the entrypoint starts the daemon again if it goes too:

```yaml
services:
  nouride:
    mem_limit: 2g
```

The CLI is in the image too, as `docker exec nouride nouride status`. It runs as uid 1000 even though
`docker exec` is root, so nothing it writes ends up owned by root.

## Reaching other machines over SSH

The image carries `openssh-client`. Two things it cannot carry have to come from outside.

**The key.** Forward your ssh-agent socket rather than mounting a private key. A key on disk with no
passphrase is a secret this process can read and any subprocess it starts can copy; a socket is a
path whose other end decides, per request, whether to sign. It signs with every key the agent holds
for whoever asks, so since 0.7.10 an agent is handed `SSH_AUTH_SOCK` only when its pack says
`ssh_agent = true` under `[security]`; the others do not see it.

```yaml
services:
  nouride:
    environment:
      - SSH_AUTH_SOCK=/ssh-agent
    volumes:
      - ${SSH_AUTH_SOCK}:/ssh-agent          # Linux
      # macOS (Docker Desktop / OrbStack) exposes the host agent at a fixed path instead:
      # - /run/host-services/ssh-auth.sock:/ssh-agent
```

**Host keys.** The agents' HOME is `/app/.nouride/home`, inside the volume, so `~/.ssh` (its
`known_hosts`, a config naming hosts, a key an agent made) survives a recreate with no extra mount.
Before 0.6 it was in the container's own layer and every host was unknown again after each one.

## Interactive sessions

They work in the container, and that is not a small thing. `exec` runs with stdin closed, the right
default for a one-shot command, but the `session` tool opens a persistent process the agent can type
into, so a bare `ssh host`, `kubectl exec -it`, `vim` and a `sudo` password prompt are all reachable.

The terminal comes from `script(1)` in `util-linux`, which is in the image: a child that checks
`isatty` sees a real pty. A native Linux or macOS install gets one from its own `script`.

## Restarting

```bash
docker compose restart
docker compose pull && docker compose up -d      # upgrade
```

A restart from the dashboard, or an agent's `nouride restart`, works inside the container too: the
image's entrypoint supervises the daemon and starts it again within a second, without restarting the
container, whatever its restart policy.

From a 0.7 release, `pull` alone is refused at the first start: run the `0.8.0` tag once on the same volume first,
and from older than 0.7.28 the `0.7` tag once before it. From 0.7.x: see [Upgrading to v0.8](/en/docs/deployment/upgrading-to-0-8/).

[Updating a container →](/en/docs/deployment/updating/#updating-a-container)

## WhatsApp

**WhatsApp runs inside the daemon in every image**: there is no separate bridge container to run, and no bridge image is published.

[WhatsApp →](/en/docs/gateways/whatsapp/)
