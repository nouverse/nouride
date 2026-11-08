---
title: Environment variables
description: Every variable Nouride reads, what the minimum is, and what turning on Nouverse sign-in needs.
---

Nouride starts with **no environment at all**. A fresh daemon boots on built-in
defaults, prints a one-time admin password to its log, and you finish the rest
in the browser.

Everything below is for the cases where that is not enough.

## The shortest thing that works

Two lines, and only because an unattended install has nobody watching the log:

```sh
INITIAL_ADMIN_USERNAME=you
INITIAL_ADMIN_PASSWORD=something-long
```

That is the whole minimum. No provider key, no public URL, no OAuth. The model
provider, the agents and the chat gateways are all set up from the dashboard
afterwards.

## Two kinds of variable

This is the thing that confuses people, so it comes first.

**Settings** are read by the daemon under a fixed name. There is a complete list
below and it does not change with your config.

**Credentials** are named by *your* `config.toml`, so the list is open-ended:

```toml
[providers.mine]
api_key = "my_key"          # the daemon reads $MY_KEY
```

The name is upper-cased and dashes become underscores. If it collides with
something else in your environment, `$NOURIDE_SECRET_<NAME>` is read too. The
environment always beats the secret store, so a deployment can pin a value a
stale file cannot override.

**The config file never holds the value, only the name.** That is what makes
`config.toml` safe to commit and to paste into a support thread.

## Settings

### The first account

| | |
|---|---|
| `INITIAL_ADMIN_USERNAME` | Username for the account created on first boot |
| `INITIAL_ADMIN_PASSWORD` | Its password |

Read **only while the user table is empty**, and ignored forever after. Unset
means the daemon generates a password and prints it once, right when you are
watching, wrong when nothing is. Add `INITIAL_ADMIN_MUST_CHANGE=1` to make the
account change its password at first login.

### Where it listens

| | default | |
|---|---|---|
| `PORT` | `18254` | Dashboard, control API and `/health`, all on one port |
| `HOST` | `127.0.0.1` | Loopback. A container must set `0.0.0.0` or the published port reaches nothing, the image already does |

### The address people reach it at

| | |
|---|---|
| `NOURIDE_PUBLIC_URL` | e.g. `https://agents.example.com` |

Only needed when that is **not** `host:port`: behind a reverse proxy, or a
container port map. Webhook URLs and the OAuth redirect are both built from it,
and both reach nobody without it.

### Where it keeps things

| | default |
|---|---|
| `NOURIDE_DATA_DIR` | `./.nouride/data`: database, secrets, attachments, backups |
| `NOURIDE_AGENTS_DIR` | `./.nouride/agents`: persona packs |
| `NOURIDE_HOME` | Names the whole install root instead |
| `NOURIDE_CONFIG` | Names one config file outright |

### The secret store's key

| | |
|---|---|
| `NOURIDE_ENCRYPTION_KEY` | The key the secret store is encrypted with (0.8.19): 32 random bytes as base64 (`openssl rand -base64 32`) or as 64 hex digits. `install.sh` keeps it in root's `/etc/nouride/nouride.env`, which the unit loads; in a container, give it here |
| `NOURIDE_ENCRYPTION_KEY_FILE` | A file holding it instead, such as a Docker secret |

Keep it out of the volume, and out of the backup of `.nouride/`: that is what keeps a copy of the data from opening the
store. Without it, or the backup password, the store cannot be opened. Given none, Nouride makes one beside the data,
says so in `nouride doctor`, and moves to one given later at its next start. It takes the key out of its own
environment once read, so nothing it runs inherits it. [Secrets →](/en/docs/architecture/storage/#secrets)

### Odds and ends

| | |
|---|---|
| `TZ` | IANA timezone for the agent's sense of time, and for cron. Default UTC |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error` |
| `NOUGATE_IN_PROCESS` | `true` or `false`, overrides `[nougate] in_process`. Only the Router edition has a gateway to start |
| `NOUGATE_HOME` | Router edition: the bundled gateway keeps its state in `$NOUGATE_HOME/data`. Default `.nouride/nougate` |
| `NOURIDE_SUPERVISOR_MODE` | Any value says something outside Nouride (pm2, supervisord, runit) restarts the daemon when it exits, so `nouride restart` and an update go ahead. Set it only if that is true. Not read inside a container |
| `NOURIDE_WA_LOG_LEVEL` | `debug` turns the WhatsApp bridge's own logging all the way up, on stderr. Default `warn` |
| `NOURIDE_WA_SEND_TIMEOUT_MS` | How long one WhatsApp send may take before it counts as failed. Default `60000` |
| `NOURIDE_MCP_CATALOG_URL` | Where Explore, `nouride mcp search` and `mcp_search` look for MCP servers. Default `https://service.nouverse.tech/mcp-catalog`, Nouverse's mirror of the official MCP registry. Another copy of the catalog may be on your own network; empty turns the search off |

### Behind a network with no direct internet

A managed pod and some corporate networks route outbound traffic through a
proxy. **Everything** the daemon calls goes through it: the model provider, web
search, webhook deliveries, and Nouverse sign-in if you use it.

```sh
HTTP_PROXY=http://proxy.internal:8888
HTTPS_PROXY=http://proxy.internal:8888
NO_PROXY=localhost,127.0.0.1
```

Without these on a network like that, every outbound call fails with
`TypeError: Unable to connect`: which names a network fault rather than a
missing setting, and is easy to spend an afternoon on.

Commands the agents run do not inherit them: `exec` hands a command a fixed list
of variables, and the proxy settings are not on it.

## Sign in with Nouverse

Optional. Skip this whole section and nothing changes: the login page is a
username and a password, exactly as before. It is off unless the issuer is set.

What it adds is a **Continue with Nouverse** button, which is how a self-hosted
install gets Google and GitHub sign-in it could not offer on its own. It cannot
register a Google app for a domain it does not own, so instead it trusts an
issuer that already holds those credentials, and the person picks their provider
on *that* login page.

:::caution[Only the Pro edition reads these]
These variables exist in every build, but only the **Pro** edition has the flow
behind them. On a Community or Router build, setting `NOURIDE_OAUTH_ISSUER` makes the
daemon **refuse to boot** rather than ignore it, the code is not compiled in, so there is nothing to
configure. [The editions →](/en/docs/deployment/binaries/#nouride-variants)
:::

### What you need

| | |
|---|---|
| `NOURIDE_PUBLIC_URL` | **Required here.** The redirect cannot be built without it |
| `NOURIDE_OAUTH_ISSUER` | e.g. `https://service.nouverse.tech/api/auth` |
| `NOURIDE_OAUTH_CLIENT_ID` | Issued for *this* install |
| `NOURIDE_OAUTH_SECRET_NAME` | The **name** of the secret, not the secret |
| `NOURIDE_OAUTH_LABEL` | What the button says. Default `Nouverse` |

The client secret is not set directly. `SECRET_NAME` names it, and the daemon
reads the variable that name maps to, `nouverse_oauth` reads `$NOUVERSE_OAUTH`.

```sh
NOURIDE_PUBLIC_URL=https://agents.example.com
NOURIDE_OAUTH_ISSUER=https://service.nouverse.tech/api/auth
NOURIDE_OAUTH_CLIENT_ID=nvo_...
NOURIDE_OAUTH_SECRET_NAME=nouverse_oauth
NOURIDE_OAUTH_LABEL=Nouverse

NOUVERSE_OAUTH=the-secret-you-were-given
```

### Registering

What you give the issuer is one URL, and they compare it **byte for byte**:

```
<NOURIDE_PUBLIC_URL>/api/control/auth/oauth/callback
```

A trailing slash difference is a failed login. For Nouverse, the procedure is in
`docs/OAUTH_PROVIDER.md` in the `nouverse-core` repository.

### An identity never creates an account

The email that comes back is matched against an **existing** account's username,
and a match is required. The provider authenticates every user it has, not only
the ones your install knows about, so if a login created accounts, anybody with
an account at that issuer who found your URL would get one on your daemon.

So: create the account first, with the person's email as its username, then they
sign in with the button.

### Set all three or none

Half of them is refused at boot rather than shown as a button that fails. The
same applies to a configured issuer with no `NOURIDE_PUBLIC_URL`: that one
would draw a working button, authenticate the user, and be refused at the
exchange, which is the least useful moment to find out.

## Turning off password sign-in

```sh
NOURIDE_PASSWORD_LOGIN=false
```

The login page then shows only **Continue with Nouverse**: no username, no
password field.

**Refused at boot unless the Nouverse block above is complete**, because
otherwise nothing could sign in at all. Nothing is deleted: existing passwords
are kept and work again the moment you turn it back on.

There is an easier place to do this: **Dashboard → Settings → Users**, where an admin gets
a switch. That one applies immediately, and it refuses if the client secret does
not actually resolve, a check the config file cannot make, because it is read
before the secret store is open.

## Credentials your config names

No fixed list. These are examples; keep what your own `config.toml` references.

```sh
# A model provider. One key can serve several profiles:
#   [providers.nougate-anthropic]  api_key = "nougate"
#   [providers.nougate-openai]     api_key = "nougate"
NOUGATE=

# A profile of your own can name a conventional variable, e.g. api_key = "anthropic_api_key"
ANTHROPIC_API_KEY=

# One per chat connection, which is what gives each agent its own bot:
#   [gateways.telegram.nouva]  token = "telegram-nouva"
TELEGRAM_NOUVA=
DISCORD_MAIN=

# Web search: [security.web] search_api_key = "brave_search_api_key"
BRAVE_SEARCH_API_KEY=

# WhatsApp session encryption, 64 hex chars: openssl rand -hex 32
#   [gateways.whatsapp.main]  encryption_key = "wa-encryption-key"
WA_ENCRYPTION_KEY=
```

## Not for a deployment

`NOURIDE_URL` and `NOURIDE_TOKEN` point the `nouride` CLI at a daemon on another
machine. They belong in your shell, not in a daemon's environment.

`NOURIDE_ALLOW_SCHEMA_DRIFT=1` lets a daemon start against a database whose
schema this build does not recognise. It is for getting a box back up, not a
fix: it accepts nothing, so the next start without it refuses again. The
refusal names the real ways out: the matching build, a snapshot, or
`nouride db adopt`.

The WhatsApp bridge inside the daemon gets its session directory and key from
the config, never from the environment.

## What the agents' commands get

A command an agent runs does not get the daemon's environment, so no key the
daemon holds can leak into it. It gets a fixed list:

- `PATH`, with `.nouride/bin` first. `NOURIDE_PATH` holds the same value and
  `NOURIDE_BIN` names `.nouride/bin`, so a login shell that resets `PATH` gets
  it back;
- `HOME`, `LANG`, `LC_ALL`, `TZ` and `TERM`, from the daemon;
- `SSH_AUTH_SOCK`, from the daemon, only for an agent whose pack says `ssh_agent = true` under
  `[security]`, since 0.7.10, when every command of every agent stopped getting it;
- `TMPDIR`, `TMP` and `TEMP`, pointed at the agent's scratchpad;
- `NOURIDE_CREDENTIALS_DIR`, and the secrets the agent's `exec_secrets` binds to that command;
- `NOURIDE_AGENT_ID`, `NOURIDE_GATEWAY_ID` and `NOURIDE_CHAT_ID` on what the
  `nouride` tool runs, so a CLI call knows which conversation it came from.

The `NOURIDE_*` ones are set by the daemon, and setting them yourself does
nothing useful. Under systemd or in the container, `HOME` is `.nouride/home`,
since 0.6.

Where `HOME` is `.nouride/home`, the daemon also points the installers at
`.nouride`, so a global install lands in `.nouride/bin` with no root and no
flags: `NPM_CONFIG_PREFIX`, `BUN_INSTALL_BIN`, `UV_TOOL_BIN_DIR`,
`PIPX_BIN_DIR`, `GOBIN`, `CARGO_INSTALL_ROOT`, `XDG_BIN_HOME` and a few beside
them. `PATH` then also carries the shared Python env after `.nouride/bin`, and
`~/.local/bin` and `~/.cargo/bin` at the end. These installer settings are the
exception: a value you put in the daemon's environment wins and is what the
agents get, unless it names a directory the daemon cannot write.

Where [each agent is its own user](/en/docs/architecture/overview/#each-agent-its-own-user) (a Linux service with the
`nouride-run` helper), `HOME` is the agent's own folder, `workspace/private/<id>`, and the installer settings point at
its own `~/.local` instead: `NOURIDE_BIN` is `~/.local/bin`, first on its `PATH`, with its own Python env after it and
the shared `.nouride/bin` behind them, to run and not to write. An external agent's CLI and an agent's stdio MCP
servers get the same `HOME`. On Docker, macOS or without the helper, every agent gets `.nouride/home`, as above.
