---
title: FAQ
description: The questions people actually ask before and after installing it.
---

## Before installing

**Do I need a GPU?**
No. Nouride does not run a model. It calls an endpoint you point it at, so RAM and CPU are unaffected
by which model an agent uses.

**Do I need Docker?**
No. The binary carries its own runtime, no Node, no Bun, no Python, no package manager. Docker is
one way to run it, not a requirement.

**Does it work on a Raspberry Pi?**
Yes, on a **64-bit** OS. `uname -m` must say `aarch64`. There is no 32-bit ARM build.

**Does it work on a Mac?**
Yes, on Apple Silicon (M1 and later), since 0.7.20: the same installer, without `sudo`, installs it as a
LaunchAgent that runs while you are logged in. [Install →](/en/docs/start/install/)

**What does it cost to run?**
64 MB of RAM is the measured floor, a first start included (2026-10-17), and 512 MB is the recommendation. Around 95 MB of disk. Under 1%
of one core at idle. An external agent's coding CLI is a process of its own on top: idle, about 330 MB for Claude Code
and 190 MB for Codex. [Every measurement →](/en/docs/architecture/performance/)

**Which models can I use?**
Anything speaking the Anthropic Messages or OpenAI Chat Completions wire format, so Claude, GPT,
OpenRouter, a company gateway, a local Ollama, or your own proxy.

**Can I use my Claude or ChatGPT subscription?**
Two ways. An [external agent](/en/docs/manual/external-agents/) is answered by Claude Code or Codex itself, signed in
with your subscription, through the official ACP adapters that Zed and JetBrains use. Or switch on
[Nougate](/en/docs/providers/nougate/#running-it-inside-the-daemon), which signs in to a Claude, ChatGPT, Copilot, Gemini or
Kiro account and serves its models to any agent as a provider. What a subscription allows is its maker's terms to say.

**Does anything phone home?**
No. The conversations, the memory and the credentials are files in one directory on your machine.
Outbound traffic goes to the model endpoint you configured, the chat platforms you connected, web
search when an agent uses it, the skill indexes when someone searches for a skill, and, when the
dashboard's update badge or `nouride update` asks, the public release list on GitHub. That last
request sends nothing about your install.

**Is it open source?**
The source is public under the Functional Source License 1.1 (`FSL-1.1-ALv2`), which is not open source yet: you may use
Nouride for anything but a competing product, at home, at work and for your clients, change it and share your changes.
Offering Nouride, or something that does what it does, to others as a commercial product or service needs a licence from
Nouverse Technologies. Each version becomes open source, Apache 2.0, two years after it is released. The WhatsApp bridge
and the built-in skills and agent templates are MIT, so you can change the agents and skills you run. The source is at [github.com/nouverse/nouride](https://github.com/nouverse/nouride).

## Setting up

**Do I need a bot token to try it?**
No. `nouride chat` and the dashboard's chat both work with no token at all, through a real in-process
gateway.

**I missed the first-run password.**
It is shown once, and nothing stores it (on a Mac it is still in `~/nouride/.nouride/data/nouride.log`). Stop the daemon, run `sudo nouride users reset` (no `sudo` on a Mac), and start
it again: every account is removed, so a new admin is created and its password printed, and
conversations, secrets and agents are untouched. With Docker, run
`docker compose run --rm nouride nouride users reset` while the daemon's container is stopped. Set
`INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` in `.env` before the first start and this
cannot happen.

**Where does my API key end up?**
In the secret store, `data/secrets.enc`, encrypted at mode `0600`, or in an environment variable.
`config.toml` gets only the *name* of the credential. That is why a config file is safe to commit and to render in a browser.
The store's key is kept apart from it (0.8.19), on Linux in root's `/etc/nouride/nouride.env`, so a copy of the data
does not open it. [Secrets →](/en/docs/architecture/storage/#secrets)

**I lost the secret store's key.**
Nouride refuses to start and says which key it needs. With a backup password set (the dashboard's Secrets page), stop
it and run `sudo nouride secret restore --stdin` with that password: the secrets are written again under a key this
machine has. Without one, the secrets are gone with the key, and each is set again.

**Can I run more than one agent?**
That is the point. Each is a directory of Markdown and costs about 0.4 MB of RAM. Give each one its
own bot token and they have separate identities on the same platform.

**Can two agents talk to each other?**
Yes, and in two different ways depending on where. In a group, they tag each other and the tag *is*
the handover. In a one-to-one chat that cannot work, each bot has its own private conversation with
you, so an agent uses the `ask_agent` tool instead, and the one you are talking to stays the only
one that speaks. Work that takes the other agent more than 45 seconds goes on in the background, and
you hear the answer when it comes. [Details →](/en/docs/manual/chatting/#two-agents-in-one-room)

## Running it

**My bot ignores group messages.**
On Telegram, privacy mode. BotFather → `/setprivacy` → Disable, or make the bot an admin. On Discord,
the **Message Content intent**: without it every message arrives empty.

**I saved a connection and nothing happened.**
Gateway adapters are built at boot. Adding or changing a gateway needs a restart, and the dashboard
says so and offers the button.

**A stranger messaged my bot and got a code.**
That is `pair` mode, the default. `nouride access approve <code>`, or the dashboard's Access page. Switch to
`allowlist` once the people you want are in: `nouride access mode allowlist`.

**Why does it keep asking about `terraform destroy`?**
Tearing infrastructure down is on the fixed list: under `careful` it asks every time and can never become a
standing grant. Creating and changing (`terraform apply`) ask once, as any new command does, and the read halves,
`plan`, `get`, `describe`, `--dry-run`, are not gated at all.

**Why does it *not* ask about most things?**
Where nobody set a level it is `balanced`: only changing a `config.toml`, giving someone access, stopping this
daemon, replacing a stored secret, a credential leaving and changing this machine's system packages ask, besides the
few [every level asks](/en/docs/manual/approvals/#the-fixed-list). `/approvals careful` in a chat asks before anything
new for you. A new install is `balanced` too; one set up before 0.8.34 was written `careful`, and keeps it.

**The agent forgot something after `/new`.**
`/new` starts a new conversation, and the old one is saved to memory first. The agent finds it again
with `memory_search`; once the nightly pass has filed it, its summary is among the recent ones in
every prompt. That pass is off until you turn it on: `nouride memory set pass on`. Facts that must be
there every time belong in `MEMORY.md` or a person's notes in People.
[Access & people →](/en/docs/manual/access/#names-not-ids)

**Can it read a PDF I send it?**
Yes, but not by sending it to a model. Documents land in the agent's workspace and it opens them with
`read` or a command, so a PDF costs nothing until the agent looks. Images and voice notes *are* sent
to a model, if `read_images` and `read_audio` are on.

**Can it browse the web?**
It can search and fetch pages, and the built-in **browser-automation** skill drives a real browser:
log in, click through a site, fill in a form. The browser is Playwright, installed by the agent and
run through `exec`, so every step meets the same approval gate as any other command. It needs Node
and about a gigabyte of free memory, and it is not part of the daemon.
[Built-in skills →](/en/docs/manual/skills/#built-in)

**Can an agent install a program?**
Yes, without root, as a service or in the container. Global `npm`, `bun`, `pipx`, `uv`, `go` and
`cargo` installs land in `.nouride/bin`, and `pip install` goes into one Python env every agent
shares. System packages go through `nouride pkg`: on a host it is off unless `install.sh --allow-packages`
turned it on, in Nouride's Docker image it is on, and it asks you every time unless the agent is `trusted`. `nouride
doctor` lists what the agents have installed.
Where [each agent is its own user](/en/docs/architecture/overview/#each-agent-its-own-user), what one agent installs
lands in its own `~/.local`, and a program for every agent is the orchestrator's to install with `nouride tools run`,
which asks you every time.

**Can I add my own tools?**
Yes, through the Model Context Protocol, declared per agent.
[MCP servers →](/en/docs/architecture/agents/#mcp-servers)

## Operating it

**How do I back it up?**
`tar` over `.nouride/` and `.env` with the daemon stopped. `nouride db backup` snapshots the database
on its own and `nouride db restore <file>` puts one back (daemon stopped), but those snapshots live
under `data/`, on the same disk. The secret store's key is not in `.nouride/` (0.8.19): keep a copy of it apart, or
set a backup password on the Secrets page, which recovers the secrets on its own. [Maintenance →](/en/docs/manual/maintenance/)

**How do I upgrade?**
`nouride update --check`, then take it from the dashboard's **Update** page or with
`nouride update --start`, which restarts once nothing is running: a turn or an approval is waited
for ten minutes at most, a background job until it finishes. `--now` does not wait. Re-running the
installer works too. Either way the binary is replaced and `.nouride/` is left alone; migrations run
at boot. A container is updated by pulling the image. From 0.7.x: see [Upgrading to v0.8](/en/docs/deployment/upgrading-to-0-8/).
[Updating →](/en/docs/deployment/updating/)

**What happens to a reply in progress when the daemon restarts?**
Nothing is lost. Every step of a turn is saved as it happens, so after the restart the agent says
what it finished and what was cut off, and carries on by itself if the daemon was back within 15
minutes; after longer, it carries on when you say "continue". A message sent while the daemon was
down is answered once it is back, if it is under 15 minutes old; an older one gets a short note
instead.

**`nouride status` says there is no daemon, but it is running.**
The CLI uses the install in your working directory when there is one, and the one beside the binary
otherwise, so standing inside another install or a checkout points it there. The error names the
path it read. "Permission denied" means the control token belongs to the service account:
`sudo nouride status`, or add yourself to its group.

**`nouride restart` refuses.**
It works by asking the daemon to exit so its supervisor brings it back. With nothing supervising it,
that would just be a stop, so it refuses and says what to do: `nouride service install` on a host,
`docker restart` in a container. Under a supervisor of your own, set `NOURIDE_SUPERVISOR_MODE` in the
daemon's environment.

**Can I run the CLI against a remote box?**
Yes. `NOURIDE_URL` and `NOURIDE_TOKEN`, and every command that talks to the daemon works. The ones
that work on files act on this machine, not the remote one: `start`, `stop`, `setup`, `service`,
`config`, `db`, `pkg` and `gateway rename`.

**Can I run two daemons against one bot token?**
No. Two Telegram bots polling one token get half the messages each. When migrating, stop the old one
before starting the new one.

## Security

**Is the approval gate a security boundary?**
No, and it does not claim to be. A determined model routes around any classifier. It exists so
ordinary work does not surprise you. What actually holds is the service account, each agent's own
user where it has one, the systemd hardening, the workspace roots and the access gate.

**Can an agent read my API keys?**
Not through its file tools. `read` refuses the secret store, the control token and the credentials
directory outright, and opens other credential files (`.env`, `.npmrc`, private keys) with the values
hidden. A command can reach the credentials directory through `$NOURIDE_CREDENTIALS_DIR`: that is what
it is for, a script that needs a key file by path. No key the daemon holds reaches a command unless
the agent's `exec_secrets` names it, it never enters the prompt, and if a command prints it, the agent
sees it masked.

**Can an agent give itself more permissions?**
It has a `nouride` tool, so treat that as a real question rather than a rhetorical one. Three things
answer it. `[security] approvals = "trusted"` has **no** CLI write path and no chat command, only the
dashboard behind a login and the config file. Changing a `config.toml` (its own, another agent's or the daemon's)
is on the fixed list, asked at `careful` and `balanced` alike; where each agent runs as its own user the file is not
its to write at all. So an agent cannot wave its own permissions wider.

**Can an agent read another agent's files?**
Not with its file tools, unless its pack declares that directory as a root. On a Linux service with the
`nouride-run` helper, a command it runs through `exec` runs as its own user, which cannot read another agent's folder
or the daemon's data. On Docker, macOS or without the helper it runs as the same account as every other agent, so
there the account is the boundary, not the agent.
[Each agent its own user →](/en/docs/architecture/overview/#each-agent-its-own-user)
What one agent knows about another comes from its own `AGENTS.md` and from messages on the bus.

**Is the dashboard safe to expose?**
It is a login, so put TLS in front of it if it is reachable from anywhere you do not control. The
default is loopback-only and an `ssh -L` tunnel, which is the right answer for most people.

## Things that are not built

Stated plainly, because a missing feature that reads as a bug wastes more time than one that is
documented.

- **Off-host backup.** The daemon snapshots its database, the persona packs and the memory vault
  daily, but every snapshot lives under `data/`: on the same disk as what it protects.
- **Telegram webhook mode.** Long polling only.
- **A spend limit in dollars you can rely on.** `max_daily_cost_usd` defaults to off, and it can only
  see models it has a price for. `max_daily_tokens` is the ceiling that applies to every model, it
  also defaults to off, and it is the one to set.
- **32-bit ARM.**
