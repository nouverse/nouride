# The `nouride` CLI

> New here? `GETTING_STARTED.md` at the repository root installs it and puts you in front of a first
> agent, with no bot token.
>
> Operating the daemon: chatting with agents, diagnosing a setup, answering approvals,
> restarting gateways, reading the audit trail.

```bash
bun run build:binary      # → dist/nouride, one file, runs without Bun installed
bun run cli -- <command>  # or drive it from source
```

---

## Who the CLI is for

**The CLI is the operator's — and, through one tool, the agents'.**

An agent learns what it can do from the **harness block** in its system prompt, generated each turn from live state, and acts through typed tools — `agent_create`, `skill_create`, `memory_write` — each gated and audited by name.
For operating the daemon itself — gateways, approvals, jobs, cron, people, memory, config — it has the `nouride` tool: this CLI, with `argv[0]` fixed to the install's own binary, so it reaches the control API and nothing else on the machine.
The harness tells it to run `help` before a command it does not know, which is why every command the CLI dispatches must be in `nouride help`: `lint:cli` fails otherwise.

The tool is gated like `exec`: it is on the default `approval_required` list, it meets the exec policy, and the commands that change the daemon are on the fixed list (`SPEC.md` §17.4) — `nouride update --start` and `nouride cron add … --command` ask under `careful`; a `config.toml` changed, someone given access or the daemon stopped ask under `balanced` too; and `nouride tools run`, an install for every agent, asks at every level, `trusted` included.
Some commands notice where they run: `memory episodes` and `memory show` refuse inside an agent's turn and point at `memory_search`, which answers only what that chat may see; `update --start` and `restart` from an agent take `--then`.
No CLI verb writes the `trusted` approval level — that is the dashboard's, or `config.toml`'s.

---

## How it connects

Everything except `start`, `stop`, `setup`, `service` and the commands `nouride help` lists under *Without a running daemon* talks to a **running** daemon over the control API:

```
nouride chat ──HTTP──> daemon (port 18254) ──> router, queue, tool loop, agents
```

It does not boot its own daemon to answer a question. A second copy would report on a process
nobody is using, and `nouride chat` would talk to an engine with its own gateway connections —
two Telegram bots polling the same token.

Auth is a token in `.nouride/data/.control-token` (0640: the service user's, and readable by its group, so an
operator in that group runs the CLI without sudo), generated on first boot and read by the CLI when it runs on
the same machine.

| Variable | For |
|---|---|
| `NOURIDE_URL` | a daemon somewhere else, e.g. `http://box.local:18254` |
| `NOURIDE_TOKEN` | that daemon's token, when you cannot read its file |
| `NOURIDE_PORT` | this install's daemon on a port its config does not say |

`PORT` and `HOST` are the daemon's — a container sets them — and the CLI does not read them: a web project's
`.env` sets both. The token read from this install's file is sent only to this install's daemon: before its
first request the CLI asks `/health` which install answers, and refuses another's (since 0.7.7). A token in
`NOURIDE_TOKEN` goes wherever `NOURIDE_URL` says.

Turn the surface off entirely with `[control] enabled = false`.

### Finding the install

`nouride` works from any directory. It looks for an install in this order, first hit wins:

| | |
|---|---|
| `$NOURIDE_CONFIG` | an explicit config file — no searching at all |
| `$NOURIDE_HOME` | an explicit install root |
| the working directory | a source checkout, or standing inside the install — a bare `config.toml` there only beside a `.nouride/`, so a project's own config.toml is not mistaken for this one |
| the binary's own directory | `install.sh`'s launcher on `PATH` runs the binary from the install itself, and a link is resolved first, so either finds `/srv/nouride` |
| built-in defaults | a fresh checkout with no config still boots |

The working directory comes **before** the binary's own, so running against a checkout while a
daemon is installed never silently reaches the daemon's config.

Relative paths inside `config.toml` resolve against the install the config was found in, never
against the working directory. That is not a detail: `data_dir = "./.nouride/data"` resolved against
the wrong base does not fail, it creates an empty database beside the real one and reports a healthy
boot with no agents and no history.

### Exit codes, `--json`, and how flags are read

| Exit code | |
|---|---|
| 0 | done |
| 1 | it failed: the daemon refused or could not be reached, or `doctor` found a problem |
| 2 | it was asked wrongly: an unknown command or action, a flag or a word the command does not take, a missing or malformed argument — and a command given too little to act on, which prints its own usage |

Any command takes `--json` and prints one object on stdout instead of lines — the same exit codes, and on
failure the same message and hint the lines would have said:

```json
{"ok": true, "data": {"jobs": []}, "error": null, "hint": null}
{"ok": false, "data": null, "error": "`nouride jobs` has no \"lst\".", "hint": "nouride jobs   Background jobs …"}
```

`data` is what the command answered with: for most, the daemon's own answer the lines were printed from;
the commands that answer without a daemon — `doctor`, `db`, `users reset`, `config`, `policy`, `gateway rename`, `pkg`,
`service` — give what they found.

**A flag a command does not read is refused**, naming it and what the command does read, with
exit 2: `nouride memory pass --dry-run` used to run a real pass. The list of what each command takes is
`apps/cli/src/grammar.ts`, and `nouride help` shows all of it. A daemon that answers with something that is
not JSON — a proxy's HTML 502 while it restarts — is exit 1 with that said, and under `--json` still one
envelope. `chat`, `start`, `setup`, `logs -f` and `events -f` keep the terminal rather than answering
once, and refuse `--json`.

**So is a word it does not read** (since 0.7.11), the way an unknown action is: `nouride agents reload` used to list the agents and drop `reload`; it is exit 2 now.
Both are refused before the daemon is asked anything or a file is written, and a word the command a letter away takes is pointed at it — `reload` at `nouride agent reload`.
`help` and `version` answer whatever follows them.

What a command's own work logs goes to stderr, at `warn` unless `LOG_LEVEL` says otherwise, so stdout is only
ever the answer. `nouride start` is the exception: that is the daemon, and its log is stdout.

A flag's value goes after it or after `=` — `--limit 5` is `--limit=5`, and `--message=-x` is a value that
starts with a dash. After a bare `--` nothing is a flag: `nouride policy check -- ls --help` asks about
`ls --help`.

A secret is read from stdin with `--stdin`, never taken as an argument, where it would land in shell history,
`ps` and the audit log: `printf '%s' "$KEY" | nouride secret set nougate --stdin`.

**The old spellings 0.7.x still read are refused by name** since 0.8.0, exit 2, with what to write instead — not
"does not take", which would leave a script's author to find out what each became:

| Old spelling | Write instead |
|---|---|
| `--value-stdin`, `--key-stdin`, `--token-stdin` | `--stdin` |
| `--isolated` on `cron add` and `webhook add` | `--session isolated` |
| `approvals approve` | `approvals allow-once` |
| `people forget` | `people remove` |

When the daemon cannot be reached, the hint names how it runs on this machine: `systemctl` where the systemd
unit is installed, `launchctl` for the launchd agent, `docker compose` inside a container, `nouride start`
otherwise.

---

## Commands

### `nouride setup`

Turns an empty directory into a working install. The one command that does **not** need the daemon
running — it produces what the daemon needs.

```bash
nouride setup                    # asks, in a terminal
```

It asks for a provider (`anthropic` or `openai` — the wire format), its base URL and its API key, then for the first agent: its id, its model and a one-line persona. (What it calls you is People's, not a pack's.)
The key is probed against the endpoint before anything is written, because a credential that does not work otherwise surfaces on the agent's first message — long after setup said it succeeded.
What it creates:

```
.nouride/
  config.toml           provider profile and orchestrator
  data/                 SQLite, secrets.enc (encrypted), control token, attachments
  agents/<id>/          the persona pack
  workspace/shared/     where agents work, and how they hand work to each other
  workspace/private/    one directory per agent, unreadable by the others
```

Unattended, for a provisioning script with no terminal to answer:

```bash
nouride setup --yes --provider anthropic \
  --api-key-from-env ANTHROPIC_API_KEY --agent nouva --model claude-sonnet-4-20250514
```

| Flag | |
|---|---|
| `--yes` | never prompt; fail instead of asking |
| `--provider` | `anthropic` or `openai` — the wire format |
| `--base-url` | defaults to the provider's public endpoint |
| `--api-key-from-env VAR` | read the key from that environment variable |
| `--agent`, `--name`, `--model` | the first agent's id, display name and model: `nourider`, `Nourider` unless given |
| `--prompt` | its persona (→ `SOUL.md`); the Pilot's unless given |
| `--headline` | one short line, 150 characters at most, that the other agents read to decide whom to ask (→ `IDENTITY.md`); empty is its preset's |
| `--config` | write somewhere other than `./.nouride/config.toml` |

The first agent gets no `exec`: a shell is the one capability whose reach is the host rather than a file, so it is given deliberately, afterwards.

**There is no `--api-key`.** A key on a command line lands in shell history, in `ps` output, and in
any CI log that echoes its commands. The interactive prompt reads it without echoing; either way
`config.toml` stores the secret's *name* and the value goes to `data/secrets.enc` at `0600`, encrypted (0.8.19).

**The dashboard wizard and this command are the same code.** Both drive one `SetupService` and ask for the same fields, so an install made from a terminal and one made from a browser produce the same `config.toml`, the same secret, and the same pack.
That is pinned by a test rather than left as an intention.

It refuses to run when `config.toml` already exists. A second run would look identical to the first
while having repointed the provider and replaced the orchestrator.

### Giving an agent's commands a credential

```sh
printf %s "$TOKEN" | nouride secret set github_token --stdin
```

Then name it in the agent's `config.toml`, with the commands that need it:

```toml
[security.exec_secrets]
github_token = ["gh release create", "git push"]
```

A command that starts with one of those gets `$GITHUB_TOKEN` (upper-cased, non-alphanumerics become
`_`); no other command does, and no other agent. A command line is read part by part — `gh release
create v1 && curl …` gets nothing, since the `curl` is not bound — and a part that runs another
command inside it (`$(…)`, `env`, `sh -c`) gets nothing either. A command handed a secret this way
asks before it runs, at every approval level but `trusted`, naming the variables it would get; **allow
always** remembers the secrets and the content of any script it runs, so binding another secret to it
or editing the script asks again. `"*"` hands the secret to every command — an interactive session
included — without asking, as every secret was before 0.7.4. The old list form, `exec_secrets =
["github_token"]`, which meant that, is refused since 0.8.0: that agent does not load, and the message
names the table.

The value never enters the prompt, and if a command prints it anyway, tool results and background-job
wake-ups show `[REDACTED:GITHUB_TOKEN]` instead — its base64 and URL-encoded forms too, and its first
characters when a command prints only part of it. Output is masked with every secret the agent holds,
whichever command printed it. File-shaped credentials go in the credentials directory, reached as
`$NOURIDE_CREDENTIALS_DIR`.

### `nouride start`

Runs the engine in this process. Everything else needs this to be up.

```bash
nouride start                    # foreground
PORT=19000 nouride start         # override the port
LOG_LEVEL=debug nouride start
```

Already running? You get a message that says so rather than a stack trace pointing at the
HTTP adapter.

### `nouride chat [agent]`

Interactive chat with no Discord or Telegram token — the fastest end-to-end test there is.

```bash
nouride chat            # the orchestrator, or the only one running
nouride chat nox        # address a specific agent
```

Messages travel the **real** path: allowlist, routing, hooks, queue, prompt assembly, tool
loop, session persistence. Slash commands work (`/status`, `/new`, `/prompt`).
`/attach <path> [text]` sends a file with the message, and `/quit` leaves.

While a turn works, its steps are drawn as they happen — `▸` something it is doing, timed while it runs; `·` a
result or a remark; `│` its reasoning — a helper's marked `↳`, an agent it asked marked `[nox]`. They come from the
conversation's event stream (`docs/EVENTS.md`), this chat only; a daemon that refuses the stream is said once, and
the answers still arrive.

When a turn asks for approval, the prompt appears inline:

```
you › delete the old logs
⚠ approval needed exec (apr_9f2c…)
{ "command": ["rm", "-rf", "logs/old"] }
approve? [y]es / [a]lways / [N]o
```

Piped stdin is supported and detected. Each line is one message, sent once the one before it
is answered, and the chat ends after the last line or at `/quit`. Approvals are **printed, not
prompted**, along with the command to answer them. They then expire as denials, which is the
safe default when nobody is watching:

```bash
printf 'who are you?\nwhat did I just ask?\n/compact\n' | nouride chat
```

### `nouride pkg`

System packages through `nouride-pkg`, the root service `install.sh --allow-packages` sets up — off
otherwise, kept by later runs without the flag, removed by `--no-packages`. In Nouride's container image the
entrypoint serves it, on unless `NOURIDE_SYSTEM_PACKAGES=off`, and what agents installed is kept in
`.nouride/system-packages` and installed again when the container is recreated (0.8.15, `DEPLOY.md`). Needs no daemon.

```bash
nouride pkg                                    # on (apt) — or off, and the command that turns it on
nouride pkg check install poppler-utils        # the plan: + installed, - removed; changes nothing
nouride pkg install|remove <name…>
nouride pkg upgrade [name…]                    # no names: everything with an update
nouride pkg refresh                            # the package lists
```

The service refuses options, paths, versions and globs, a name the repositories do not carry exactly,
and any change that would remove a protected package (ssh, networking, sudo, init, libc, the package
manager), including as a dependency — in the container, also anything the image ships. Through the `nouride` tool,
`install`, `remove` and `upgrade` are `system-packages` on the fixed list (`SPEC.md` §17.4, 0.8.15): `careful` and
`balanced` ask every time, allow-once only, and in a chat only an admin answers; `trusted` does not ask. From 0.8.0 to
0.8.14 they were on no class, and `balanced` let them run. A change runs as a background job, so an install longer than
the foreground limit is not cut off halfway. Exits 0 on success, 2 on a refusal, 1 on a failure. Its log: `journalctl
-t nouride-pkg`, or the container's own.

Without it, what agents install needs no root at all: into `.nouride/bin`, or where each agent is its own user,
into that agent's own `~/.local` (`SPEC.md` §7.1).

### `nouride tools run`

```bash
nouride tools run -- npm i -g @agentclientprotocol/codex-acp    # a program every agent runs
nouride tools run -- pipx upgrade-all
```

Installs or updates a program every agent runs (0.8.0), as the daemon's user, in its HOME (`.nouride/home`), with
every installer pointed at the shared folders — `npm i -g` into `.nouride/bin` — and then makes it every agent's to
run. Needs no daemon. It runs an installer and nothing else: npm or bun with `-g`, pipx, `uv tool`, pip, cargo,
`go install`, rustup, `claude update` (`toolchain/installers.ts`). A flag that would put what it installs elsewhere
or read a file (`--prefix`, `-r`, `--report`, …) and a path in any word are refused, `--flag=value` too: what is
installed is a package by its name.

Where each agent is its own user, an agent's own installs land in its HOME and this is the one way into the shared
folders, which only the daemon's user writes: the `nouride` tool offers it to the orchestrator alone, while its pack
does not say `[security] shared_tools = false`. Its install scripts run as the user that owns every pack, the database
and the secret store, so through the tool it asks at every approval level, `trusted` included (`shared-tools`,
`SPEC.md` §17.4), *allow once* only, and in a chat only an admin answers it (0.8.9). Exits 0 once every agent can run it; 1 when it refused the command, the install
failed, or the program could not be shared.

### `nouride doctor`

Everything that commonly stops a fresh install from working, in one screen. Each finding says
what to do about it. Exits 1 on a real problem, so it works in a healthcheck; `--json` gives every result.

```
✓ config: /app/.nouride/config.toml
✓ sqlite: 3.51.0, with FTS5
✓ daemon reachable at http://localhost:18254 (up 41s)
✓ daemon memory: 72.8MB resident, 8.7MB of it JavaScript heap in use
✓ work at once: 4 helpers in the background for each agent (from this machine), 4 missions at once (from this machine); this machine: 6 cores, 8.0GB of memory (5.9GB of it for the agents' commands)
✓ memory index: FTS5 integrity check passed
✓ providers with credentials: nougate-anthropic
! provider "openai" has no credential
    Unusable until it does.
✗ no agent is running
    Create one under agents/. IDENTITY.md is the only required file.
```

It checks, in order, the half that needs no daemon — config source and data directory, **semantic config problems** (below), the SQLite inside this binary, system packages, the toolchain (below), whether the systemd unit still kills a running command on restart (re-run `install.sh` once to fix that), the free disk in the data directory against 1 GB, the database's own `quick_check` (read-only, as `nouride db verify` runs it), and the modes of the files that hold a secret — the control token no more open than 0640, the secret store, the database and its log 0600, the credentials directory 0700 — then daemon reachability, the daemon's own memory as its `/health` reports it (resident, and the JavaScript heap in use; since 0.7.11), what its `/health` counts as an issue (a dead gateway, a provider failing in a row, a write-ahead log past its threshold), what compaction and the memory pass ran into with their models in the last 24 h — failures, or a pass or summary model the agents' own stood in for — with how often, the last error and the setting to change (since 0.7.25), the memory index's own integrity check, durable turns, provider credentials, agent packs that failed to load, whether anything is actually running, workspace roots that do not exist, agents pointing at a profile with no key, gateway connection states, each installed coding CLI's version against the versions this Nouride was tested with (as `nouride agents scan` says it, since 0.8.24), waiting approvals, queue depth, and skills naming software this box does not have.

The semantic checks run *before* the daemon check, and that ordering is deliberate: the daemon check
returns early when nothing is reachable, and a config broken enough to matter is usually why nothing
is reachable. They cover the combinations that are individually valid and together do not work —
a search endpoint on a private address while `allow_private_urls = false`, a `search_kind` with no
credential and no proxy, a name in `fallback_backends` that no backend answers to, a queue timeout
below the turn deadline, `exec` running unreviewed, no alert channel, no spend cap.

`--fix` narrows a file mode that is more open than the daemon makes it — the one change doctor makes, because it
is safe to repeat and the daemon would set the same bits on its next write.

**0.8.0 starts only on data 0.7.28 has run on**, and refuses every form 0.7.x rewrote on disk where it is read (`DEPLOY.md` § The upgrade window), so the section that listed them before an upgrade (0.7.11–0.7.28) is gone: what it named stops the daemon or that agent now, saying what to write instead.

**The toolchain lines** are read from disk, so they answer with the daemon down:

- what agents have installed in `.nouride/bin`, and which of those are found ahead of the system's own;
- a link into a cache, a link to nothing, or a program that hides one the daemon or every agent depends on (`sh`, `git`, `curl`, `tar`, `python3`, `node`…);
- an `npm install` run in `.nouride/` itself rather than a global install;
- where installs land, the shared Python env at `.nouride/opt/python` and its `pip check`, and how much disk the toolchain and its caches take;
- `/usr/local/bin/nouride` still a link to a binary the service account owns, which root would run as root — re-run `install.sh` once to replace it with the launcher.

Who installed what is in `nouride audit`; this is the state, not the history.

### `nouride config`

Three subcommands, none of which talk to the daemon — they have to work on a box where the config is
broken enough that nothing is running, which is exactly when they are wanted.

```
nouride config check [file]      would this configuration start?
nouride config schema [section]  every valid key, as JSON Schema
nouride config explain <path>    what one key is, and what it needs
```

A bare `nouride config` is its help: these lines, exit 0, and `{ help }` under `--json` (since 0.7.11).

`check` runs the same validation the daemon runs at boot, then reports the semantic problems above.
The distinction matters: `check` answers *would it start*, and a semantic finding never changes that
verdict — it starts, and then fails at the first call.

Its `at once` line says how many helpers each agent may have in the background and how many missions run at
once, and for each whether the file set the number or the machine decides it (`atOnce` under `--json`). It
reads the machine itself, with no daemon to ask; `nouride doctor` says the running daemon's own figure, which
also knows the cgroup its agents' commands run in.

An agent pack that will not load does change it (since 0.7.11), because the daemon would start without that agent.
Each enabled one is `✗ agent <id> will not load:` with why, the verdict is `this configuration would start, but 1 agent will not load`, and the exit code is 1, with the packs under `failed` in `--json`.
A disabled pack that would not load is said, and fails nothing: nothing would run it.
What loading the packs logs is said as lines of the report, not as JSON above it.

A value the daemon cannot use is a refusal, with every one in the file named at once and what to write
instead: one of the wrong type (`allow_private_urls = "false"` is a string, not a boolean) or a number out
of its bounds (a negative cap or retention, a percentage over 100). 0.7.7 reported these as bad and ran on
the default; since 0.7.10 the daemon does not start with them. `config schema` carries the bounds as
`minimum` and `maximum`. An unknown key under `[providers.*]` or `[gateways.*.*]` is warned about at load,
as one anywhere else is.

`schema` and `explain` exist for a reader with no source tree, which is what a packaged install is.
An agent inside one cannot discover that the search endpoint lives under `[security.web]` rather than
`[web]`, that `search_api_key` holds the **name** of a credential and never the key, or that pointing
an endpoint at `192.168.0.10` does nothing until `allow_private_urls = true`. Without a way to ask, it
configures by trial and error against a daemon that refuses to boot — and a failed boot takes the
conversation that could have fixed it.

Both are derived from the loader's own defaults rather than maintained by hand, so a key the loader
accepts is a key they describe. `explain` is the one to reach for first, because the caveat is the
part that cannot be inferred from a working example:

```
$ nouride config explain security.web.search_endpoint
security.web.search_endpoint
type    string
default ""
applies after a restart: the daemon reads it at boot, so a saved change waits for `nouride restart`

Base URL of the search API or the proxy in front of it. Empty uses the backend's own default.

watch out  A private address here needs `allow_private_urls = true`. Setting this also relaxes the
           API-key requirement, on the grounds that a proxy is handling authentication upstream.

in TOML
  search_endpoint = "http://192.168.0.10:9088/res/v1/web/search"
```

`schema` emits JSON Schema, nested the way the TOML is — the mistake it answers is `[web]` versus
`[security.web]`, and a flat list of dotted paths would answer the easy half. A section argument
narrows it: `nouride config schema security.web`. Caveats travel as `x-caveat`, examples as
`x-example`, and a field holding a credential *name* is marked `x-secret-ref` so nothing pastes a key
into a file a person may share.

`applies` (`x-live` in the schema, `live` under `--json`) says when a change takes effect: at once when
the dashboard or a `nouride` command saves it, or after a restart for a key the daemon reads at boot. A
hand edit to `config.toml` always waits for a restart. Every command that saves a setting ends the same
way — `applied`, or `saved (takes effect after a restart)` and the restart to run.

### `nouride status`

One-screen summary: uptime, agents running versus loaded, gateway states, queue depth,
waiting approvals, packs that failed.

### `nouride agents` · `nouride agent <action> <id>`

```bash
nouride agents                     # ids, what each is doing, provider/model (an external agent: its CLI, model, profile), tools, skills
nouride agent sleep nouva          # takes no work until wake; stays connected
nouride agent wake nouva
nouride agent reload nouva         # re-read persona files and config from disk
nouride agent disable nouva        # written to config.toml, so it survives a restart
nouride agent enable nouva
```

Asleep (0.8.0) is the state `/sleep` and `/stop` set from chat, and it lasts until `wake` — a restart, a nightly
update included, keeps it. What it was doing stops at its next step; its jobs in the background run on and report
when it wakes. An asleep agent stays addressable — that is what lets `/wake` and `/start` reach it.
`pause` and `resume`, the words before 0.8.0, are still taken for `sleep` and `wake`.
Through the `nouride` tool, `sleep` and `wake` are a person's: they ask as someone given access does (`access`,
`SPEC.md` §17.4).

What each agent is doing (since 0.7.18) is one of four, the first that is true: **waiting for you** (an approval
waiting on a person), **working** (a turn running, or a background job — and in how many chats), **asleep**, **idle**.
Beside it, **unavailable** and why, when the agent could not work if asked: switched off in its pack, a pack that
failed to load, or a model provider with no credential. `/status` in chat and the Agents pages say the same.
`reload` also reaches a pack that failed to load (since 0.7.11): fixed, it loads; still broken, it says why.
An external agent (`docs/SPEC.md` §4.4) is unavailable for its CLI's reasons instead: not installed, not signed in,
failing to start, or a new version that did not answer its check.

### `nouride agent external <id> <cli>` · `nouride agent internal <id>`

```bash
nouride agent external coder claude-code                # a coding CLI answers coder instead of its model
nouride agent external coder codex --profile work       # on another account than "default"
nouride agent internal coder                            # its model answers it again
```

Whether a coding CLI answers an agent that exists (0.8.1): `external` writes `[external] cli` (and `profile`) into
its pack's `config.toml`, `internal` takes the block out. Its persona files, memory and notes stay. A CLI that is not
installed on this machine is refused, with the command that installs it — `nouride agents scan` lists them — and so
is the orchestrator, which stays a Nouride agent. After `external` the agent answers nothing until its CLI is signed
in. Admin only; through the `nouride` tool it is a `config.toml` changed (`config`, `SPEC.md` §17.4).

### `nouride agent skill-root add|rm <id> <path>`

```bash
nouride agent skill-root add nix /opt/projects/home-app   # nix takes the skills in its .agents/skills as its own
nouride agent skill-root add nix .                        # the folder you are in
nouride agent skill-root rm nix /opt/projects/home-app
```

A folder whose `.agents/skills/` an agent takes as its own skills (0.8.24), without editing its `config.toml` by hand:
the path is checked (a folder the daemon can open, not one that holds the credentials folder, not one the agent has),
then written into its `[workspace] skill_roots` as the dashboard's Files tab saves the file — the version before kept
as `config.toml.bak.1`, the agent reloaded, the change in the audit log. `add` prints the skills the folder brings. A
relative path is read against where the command runs. Admin only; the agent's Skills tab does the same, and an agent
asks for one itself with its `skill_root` tool, which an admin answers in the chat at every approval level.

### `nouride agents scan` · `nouride agents login <id>` · `nouride agents update <cli>`

```bash
nouride agents scan                # the coding CLIs this box has for external agents, and their versions — looked at now
nouride agents login coder         # sign coder's CLI in, on its own profile
nouride agents update claude-code  # to the newest version this Nouride was tested with, checked before its agents work
nouride agents update claude-code 0.95.0   # the way back, after a version failed its check
```

`scan` runs each CLI's version command — the two built in, Claude Code and Codex, and every `[[external_clis]]` row
— and prints which are installed, each with the command that starts it and its version (for the built-in two, the
ACP adapter's: `claude-agent-acp`, `codex-acp`), and how to install the others. On a box whose agents' commands have
less than 512 MiB it says so in one line and lists none.

For each built-in CLI that is installed, a second line says where its version stands (0.8.24): against the lowest and
highest versions of its package this Nouride was tested with, and the newest the npm registry has published, read at
most once a day. Up to date, a newer tested version out, older than this Nouride supports, or newer than it was tested
with, which runs, untested. With no network nothing is said of the newest;
a CLI that is not installed is not asked about. `nouride doctor` prints the same line for each, a warning for the
last two.

`login` signs in the agent's own profile: it runs the CLI's sign-in in a terminal on the box, as the agent, and
prints what that terminal prints — the link to open, and the code where the flow has one. A line typed here is the
terminal's next input — the code a browser gave back, a choice. Ctrl-D stops it. It exits 0 once signed in, and the
agent's CLI starts with the sign-in at its next turn; 1 when the sign-in ended without one. Admin only, as the
dashboard's **Sign in** is. A CLI with no sign-in that runs in a terminal says what to do instead.
A Codex account signs in this way, once per agent on it. A shared Claude Code account is signed in once for every
agent on it, on the dashboard's **Models → Coding CLIs**, and there is no command for it.

`update` (0.8.24), in order: the CLI is held at the daemon, so no new turn starts in it, until none runs (one still
running after ten minutes: nothing is installed, exit 1); its package is installed at the version as `nouride tools run`
installs, as this user; then the daemon starts it again for the first of its agents and checks its handshake for what
Nouride uses — steering, the modes its presets set; no prompt is sent. Passed, exit 0. Failed, exit 1: only that CLI's
agents are unavailable, saying so, and the version before (the last that passed) is named to go back to. With no
version it installs the newest this Nouride was tested with. Through the `nouride` tool it is asked as `tools run` is
(`shared-tools`, at every level); the dashboard's **Update** asks the orchestrator to run it.

### `nouride acp [--agent <id>]`

Nouride's agents in Zed and the editors that speak the Agent Client Protocol. The editor runs it; nobody types it:

```json
{ "agent_servers": { "Nouride": { "command": "nouride", "args": ["acp", "--agent", "nouva"] } } }
```

It speaks ACP on stdin and stdout and the daemon's control API on this machine, with the control token every command
reads. A session is a conversation on the local connection; a prompt is that conversation's message, and what the
turn does — its reasoning, each tool call with its arguments and result, the answer as it is written — arrives in the
editor as it happens. A call that needs a person is the editor's permission prompt (always only where the daemon would
keep it); a cancel is `/stop`; a reopened session shows what was asked and answered in it. The agent runs in the daemon
as always — its workspace, sandbox, approvals and audit — and the editor's files and terminal are not borrowed: a
session opened in a folder that is not one of the agent's roots is refused, naming `[workspace] roots` in its pack.
Without `--agent`, the orchestrator answers. Everything said for a person goes to stderr.

The editor has to run it on the machine the daemon runs on: it reads that install's control token and reaches its
control API there, and the session's folder is a path on that machine, one of the agent's roots. It has no network
mode of its own: an editor on a laptop reaches a daemon on a homelab box only through remote development over SSH, and
only where the editor starts its agent servers on that machine.

### `nouride provider` · `nouride secret`

```bash
nouride provider                                   # profiles, and which have a credential
printf %s "$KEY" | nouride provider add groq --kind openai \
  --url https://api.groq.com/openai/v1 --stdin
printf %s "$KEY" | nouride secret set local_api_key --stdin
nouride provider add local --kind openai --url http://localhost:11434/v1   # picks up local_api_key
nouride provider rm groq

nouride secret                                     # names, their fields, where each resolves from — never values
printf %s "$TOKEN" | nouride secret set discord_nox_token --stdin
printf %s "$TOKEN" | nouride secret set github_token --stdin --field domain=github.com --field username=nouva-bot
nouride secret field github_token what="the bot's account" --remove username   # the value stays as it is
nouride secret rm discord_nox_token
nouride secret seal --stdin                        # the backup passphrase: config snapshots hold the store, sealed
nouride secret unseal <snapshot>/secrets.sealed --stdin --out /tmp/secrets.json
nouride secret restore --stdin                     # the store back from data/secrets.sealed, for a lost key (stopped)
sudo nouride secret decrypt --out /tmp/secrets.json   # the way back to 0.8.18: secrets.json as it reads it
```

A profile is a wire format, a base URL and the *name* of a credential; agents name the profile they run on.
The key is stored as `<name>_api_key`, and a profile added with no key picks up one already stored under that name.
`add` probes the endpoint before saving unless `--no-probe`.
A value arrives on stdin: anything in `argv` is kept in the exec grant, the audit table and the daemon's log table, so `--value` and an inline key exist only for a person who has decided that is fine.
There is no command that prints a secret back.
What is said about a secret, its fields (0.8.19), is not secret: shown by `nouride secret`, the dashboard and to agents
beside the secret's name, and refused when a text has the shape of a key or a password.
`restore` and `decrypt` run on the machine, with no daemon: `restore` with Nouride stopped, `decrypt` as the user who
can read the store's key (root, where `install.sh` kept it in `/etc/nouride/nouride.env`); both write at `0600` and
never over a file that is there.
`secret rm` deletes one everywhere: it goes from every agent's `exec_secrets` too, unless the environment still sets it.
`secret seal` (0.8.18) keeps the public half of a key the passphrase derives as `[daemon] backup_seal` and takes a config snapshot at once; `secret seal --off` stops it. `secret unseal` is local, needs no daemon, writes the store to a new file at 0600 and refuses one that is there.

### `nouride gateway`

```bash
nouride gateway                    # connection state per instance
nouride gateway restart telegram:nouva
nouride gateway restart telegram:nouva --then "check it reconnected"
printf %s "$BOT_TOKEN" | nouride gateway add --platform telegram --name nouva \
  --agent nouva --stdin
nouride gateway rm telegram:nouva
nouride gateway rename telegram:main telegram:nouva            # what it would change
nouride gateway rename telegram:main telegram:nouva --apply    # the daemon must be stopped
```

Instances are named (`platform:name`), because each one is a separate bot identity.
`--stdin` reads the token from standard input, so it never reaches the argv the grant and the audit log keep; `--token <value>` puts it inline, and both of those keep it for good.
`--token-secret <name>` points at a secret already stored instead, `--session-dir <path>` sets where a WhatsApp connection keeps its login, and `--disabled` writes the instance without connecting it.
A gateway added or changed connects at the next restart: adapters are built at boot.
`rename` rewrites everything that names the gateway — the database, `config.toml`, every agent pack's `[channels]` and `sender_allowlist`, and the memory vault (snapshotted first, under `data/backups/memory/<stamp>-before-rename`) — so it refuses while the daemon runs, and it is a dry run until `--apply` — what it protects against is a rename that reached the sessions but not the allowlist.
The audit log keeps the name the gateway had at the time; the report lists what it keeps.
It refuses, before anything is written, a database this build has not migrated (start the daemon once, then stop it), a new name rows already use (a removed gateway leaves its rows behind — pick another), a message still waiting or a turn that never ended on the old name (start the daemon, let it settle, stop it), and a pack that loads now and would not after.

### `nouride skills`

```bash
nouride skills                     # every agent: what it carries, and when each was last read
nouride skills nouva -v            # one agent, with descriptions and paths
nouride skills --all               # the pool: every skill, who has it on, what the host is missing
nouride skills off document-authoring nouva
nouride skills on  document-authoring nouva
nouride skills search "release notes"      # skills.sh, ClawHub, well-known indexes
nouride skills install owner/repo          # fetched as a draft, for you to approve
```

Three views because there are three questions. The default answers *what does this agent know* —
including the last-read column, which is the one that changes decisions: a skill costs a line of the
system prompt on **every** turn, and twenty that nobody has ever opened is a budget nobody chose to
spend.

`--all` answers *who has this skill*, which is the question the single pool created. Every skill in
`agents/skills/` is on for every agent until somebody switches it off, so curation happens per skill
rather than per agent — and this is the view where a skill nobody carries is visible at all. It also
reports the `requires:` software each skill names and whether it is installed here.

`on` / `off` writes `agents/<id>/skills.toml` and reloads that pack. The agent argument is required
and never defaulted: a toggle that guessed which agent it meant would be a switch flipped on somebody
else's prompt.

`install` takes a hub ref, `owner/repo[/path]`, a URL or `clawhub:<slug>`, and queues the skill as a draft: nothing is in any prompt, and no script has run, until it is approved.

Deleting one is a dashboard action (Skills Workshop, the bin on each row) or a plain `rm -rf` of its
directory followed by `nouride agent reload`. Built-in skills cannot be deleted at all — they ship
with the binary, so removing one would be undone by the next upgrade while looking permanent in
between; switch it off per agent instead, or copy it into `agents/skills/` to change it.

### `nouride skills drafts` — what the agents have proposed

```bash
nouride skills drafts                      # the queue, plus what was recently decided
nouride skills draft dft_9f2c…             # one draft in full, with the turn it came from
nouride skills approve restart-stuck-ingress
nouride skills deny    dft_9f2c…
nouride skills review                      # the weekly review, now: tighten, merge, archive — proposals land here
```

Skill learning (`[skills.learning]`) drafts a skill when a kind of work comes back — the first time it is only noted —
or when somebody asks for one, and waits. Approving writes it into `agents/skills/` and reloads every pack; a skill
learning wrote is on for the agent that learned it, and `nouride skills on <skill> <agent>` gives it to another.
Denying deletes the draft and its transcript outright.

`review` reads the library the way the weekly review does: what grew past its size or names this environment is
tightened, skills covering one subject are merged, a skill nobody has read in 45 days is archived to
`agents/skills/.archive/`. Each is a draft here, and waits whatever the mode.

A draft can be named by its skill name rather than its id, because the id is unmemorable and the chat
message that announced it named the skill. An ambiguous name is refused rather than guessed at.

`draft <id>` prints the body *and* the scrubbed transcript of the turn that produced it. Approving a
procedure you cannot trace back to the work it came from is approving a model's word for it.

Nothing here expires. A pending draft waits indefinitely — unlike an approval, which blocks a turn
and times out. `[skills.learning] mode = "off"` turns the proposing off; the queue stays readable either way.

### `nouride approvals`

```bash
nouride approvals                          # what is waiting, with full parameters and the reason
nouride approvals allow-once               # the only pending one
nouride approvals allow-once apr_9f2c…
nouride approvals allow-always apr_9f2c…   # …and stop asking for that exact command
nouride approvals deny apr_9f2c…
```

Three answers, not two. `allow-always` is what makes a gate you keep switched on: without it
`exec` asks about `git status` for the fortieth time and the only escape is to stop asking at all.

`always` is short for `allow-always`, as `/approve always` is in a chat. `approve`, which 0.7.x read as
`allow-once`, is refused since 0.8.0, exit 2, naming `allow-once`.

In interactive `nouride chat` the prompt is `[y]es / [a]lways / [N]o`, and `[a]` is only offered
when it would actually do something. Anything that is not clearly a yes is a no.

Unanswered requests expire as **denials** — an unattended request never becomes a yes.
How much is asked at all is the approval level (`SPEC.md` §7.3): set per agent, per person with `/approvals` in chat, or for the daemon.

**An agent answering one is asked about first.** The CLI reads the admin token off disk, so an agent's
`nouride` tool reached this same route — and `allow-always` with no id answers whatever is first, which
can be the agent's own request. Answering is on the fixed list (`access`): a person sees the call, at every
level but `trusted`. Run by an agent, the command also needs the id spelled out, and refuses a request
its own agent made — that one was put to a person, who can answer it in chat or in the dashboard.

**What you see is a summary, not the arguments.**

| The call | What the prompt shows |
|---|---|
| `write` to a path that does not exist | `landing/index.html · new file · 146 lines, 5.2 KB` |
| `write` over an existing file | `replaces 400 lines (12 KB) with 12 lines (300 B)`, and says the file is replaced entirely |
| `edit` | the diff, removals then additions, split evenly if it is large |
| `exec` | the command as a shell would show it |
| anything else | compact JSON |

Nothing is silently shortened — an over-long value is marked `clipped`, and `nouride approvals` shows the
parameters in full.

**`[a]lways` on a file tool is scoped to the agent's workspace.** `exec` grants bind a command identity
(argv, cwd, and the sha256 of any script it runs); a `write` has no equivalent, so its grant binds a
*directory* instead — that tool, anywhere under `.nouride/workspace/shared/`, until revoked. A path under a
configured `[workspace] roots` entry is **not** grantable: a standing permission to write into your own
source tree is not something to hand out from a one-line prompt, so those keep asking.

Some commands are never grantable, however you answer: the fixed list (`SPEC.md` §17.4) — a `config.toml`
changed, access given, this daemon stopped or replaced, a secret replaced, a credential leaving, the database,
a delete outside the workspace, infrastructure torn down, a job that runs unasked, a session, a force-push, this
machine's system packages changed, a program installed for every agent, an agent's persona or People changed, and work
nobody watches sending somewhere its job did not name.
`allow-always` on one runs it once and tells you it was downgraded. A command touching a credential path is
grantable, like any new command.

### `nouride grants`

Standing permissions — everything `allow-always` has ever written, in two lists.

Commands and directories are shown separately rather than merged: an exec grant *is* its argv, a tool grant
is a directory, and flattening them would need a shape that is neither. `revoke --all` clears both.

```bash
nouride grants                     # active grants: command, directory, how often used
nouride grants --all               # including revoked ones
nouride grants revoke gnt_4b81…
nouride grants revoke --all        # end every standing permission, now
nouride grants revoke --all --agent nouva
```

Also available in chat as `/grants` and `/grants revoke <id|all>`, because "what is this agent
allowed to do without asking me" is a question you ask from wherever you are.

Worth knowing about the grant list:

- **A grant is bound to the exact command, the directory, and the agent.** `npm run build` in one
  repo is not the same grant as in another.
- **A grant on a script is bound to the script's contents.** `bash deploy.sh` stops being granted
  the moment `deploy.sh` changes — otherwise one "always" is a standing grant for arbitrary code.
- **Usage counts are shown** so you can tell a grant carrying daily work from one made in a hurry
  and never used again. That is the only sound basis for pruning the list.
- **Revoking is a tombstone, not a delete.** `--all` keeps the history: when you approved
  something, and when you took it back, both stay answerable.

### `nouride policy`

The fixed list — what always asks, at which approval level — and what is on no list.

```bash
nouride policy                              # the whole list, both halves
nouride policy check rm -rf /tmp/x          # would this be gated? nothing is run
nouride policy check ssh prod "dropdb main"
```

`check` runs the real classifier rather than a printed copy of it, so it cannot drift from what the
daemon does. It needs no daemon either — the classifier is a pure function, and the moment you most
want to ask "why was that refused" is when something is refusing things.

A command inside `sh -c`, or after `ssh <host>`, is classified by **what it would run**, not by the
program on the command line — otherwise `sh -lc "rm -rf /x"` and `ssh host "rm -rf /x"` would pass
every rule that `rm -rf /x` meets.

The second half of the output is a guarantee, not an omission. Reading, simulating (`terraform plan`,
`--dry-run`, `--check`), installing, reversible service work and ordinary file edits are never
gated — a prompt that fires on routine work is one an operator learns to click through, and then it
protects nothing.

### `nouride tool-budget` · `nouride turn-budget`

```bash
nouride tool-budget                       # tool round-trips one reply may spend: daemon and per agent
nouride tool-budget 40                    # the daemon default
nouride tool-budget --agent nouva 60      # one agent's
nouride tool-budget --agent nouva follow  # back to the daemon default
nouride turn-budget                       # seconds one reply may take, the same two scopes
nouride turn-budget --agent nouva 900
```

Two budgets because they are two questions: an agent can burn its clock waiting inside three calls, or its round-trips on twenty calls that each return at once.
`follow` removes the agent's own value rather than writing today's default into its file.

### `nouride jobs`

Work that outlives a turn.

```bash
nouride jobs                       # what runs, then the last five ended — status, duration, log size, freshness
nouride jobs --all                 # every job the daemon keeps (up to 100)
nouride jobs log <id>
nouride jobs kill <id>
```

The agent reaches this with `exec` + `background: true`. It gets a job id immediately, the turn ends,
and when the command finishes the agent is **woken**: a message enters the conversation that started
the job, so it reports back in its own voice instead of you having to ask. Obvious long-running
commands are also routed there automatically when the agent forgets to ask for the background path.

With `keep_working: true` the turn goes on instead, for other work that does not need the job's result —
a build running while the agent fixes an unrelated file. The result still comes as a wake-up, after
that turn. When the next step needs the result, the agent leaves it off and waits.
A server — a dev server, a tunnel — is started with `service: true`, and runs until it is stopped.

Anything over a couple of minutes has to use it — a foreground `exec` is capped at 240s, below the turn
deadline, and a command killed there loses its work. The prompt tells the agent this.

`nouride jobs` also shows whether the process is still alive plus the current job-log size and last
update time, so "slow" and "stuck" stop looking identical. Each command is one line of the list — its first line,
cut at 100 characters; `nouride jobs log <id>` prints it whole, with the same header, before the log tail.

**A helper is a job too** (0.7.15): `delegate` with `background: true` hands a task to a helper that works
on its own while the agent stays free to talk, and its handoff wakes the agent when it finishes — each
helper as it finishes. A helper the agent waits for, without `background`, is waited for up to 45 seconds; one still
working then becomes a job the same way. It is listed as `helper: <goal>`, marked `helper at work` while this daemon runs
it; its log is its steps as it takes them and, at the end, what it reported. `nouride jobs kill <id>`
stops one, and `/stop` in its chat stops the agent's helpers there. How many one agent may run at once is
`[delegate] max_background` (unset: what the machine has room for, 4 at most; 0 off), its own on its Settings page in the dashboard; one over
it is refused with what is running. A restart closes it as interrupted, and its agent is told what it had
done and that it is not resumed ([SPEC.md §13.3](./SPEC.md#133-helpers-in-the-background-0715)).

### `nouride mission`

Long work an agent finishes alone (0.8.0): it runs turn after turn, survives a restart, parks what needs a person and
is done when its checks pass. A chat starts one (`/mission <goal>`), as do the dashboard's Missions page and an agent
when the work needs it; a terminal is not a chat to report to, so this command does not start one.

```bash
nouride mission                          # what needs you first, then what runs, then the last five ended
nouride mission --all                    # every ended one too
nouride mission show <id>                # its goal, checks, checklist, limits, parked approvals, report and folder
nouride mission answer <id> <answer>     # the answer to the question it waits on
nouride mission continue <id> [text]     # on past a limit it reached, with a line for it if you like
nouride mission accept <id>              # done, where it waits for your yes
nouride mission tell <id> <words>        # words for it while it works (0.8.10): read before its next step, never a new goal
nouride mission stop <id>
```

`tell` answers with where the words went: into the turn at work, into a coding CLI's running prompt, or kept for its
next turn with what moves it if it waits. They are kept on the mission and shown on every page after, and to its
reviewer; the goal, checks and limits do not change ([SPEC.md](./SPEC.md), missions).

`show` names the folder it works in. A mission in a git repository works in a worktree of its own, on the branch
`mission/<id>`, where the box has room for one — merging the branch is the agent's call
([SPEC.md §13.5](./SPEC.md#135-a-mission-in-a-repository-081)). Operator and up. The limits are `[missions]` in
`config.toml`.

**So is an ask that runs long** (0.7.19): `ask_agent` waits for the other agent's answer up to 45 seconds, then
lets it carry on as a job of the asking agent's — listed as `ask <agent>: <task>`, marked `ask at work` —
and the answer wakes the asking agent in that chat when it comes; `background: true` moves it at once.
`nouride jobs kill <id>` and `/stop` in that chat stop it. It counts with the agent's helpers against
`[delegate] max_background` ([SPEC.md §13.4](./SPEC.md#134-asks-that-run-long-0719)).

| | |
|---|---|
| Output | a file, `0600`, in `data/jobs/` — a build log is megabytes, and the agent can `read` it with an offset |
| Concurrency | 4 commands per agent, and the cap is a **refusal**, not a queue; helpers and asks are counted apart, against `[delegate] max_background` |
| A restart | kills the children and marks the rows `interrupted`. We cannot tell `bun test` from `docker compose up -d`, and orphaning unknown processes is worse than stopping them. Each job's agent is told after the restart, once the messages that arrived during it have been answered |
| Running too long | `[security] job_max_ms`, off by default: a job that is not a service and is still running after it is stopped as `kill` stops one, recorded `killed`, and its agent is told it ran out of time and did not finish — the daemon posts that line itself. The agent is told the limit when the job starts (since 0.7.6) |

### `nouride cron`

Scheduled work: reminders, recurring checks, daily reports, and commands that run without a model.
See [SPEC.md §8](./SPEC.md#8-cron-system) for the job model.

```bash
nouride cron                       # what is scheduled, when it next fires, how it has been doing
nouride cron --all                 # including paused and self-disabled jobs
nouride cron run <id>              # fire it now, without consuming the next scheduled occurrence
nouride cron runs <id>             # the last twenty runs and what they produced
nouride cron update <id> --every 30m      # also --name, --at, --cron, --tz, --message
nouride cron enable|disable <id>
nouride cron rm <id>
```

`nouride cron run` is the one to reach for first.
Waiting until 09:00 to discover a daily report is broken is not a way to find out, and forcing a run deliberately leaves tonight's real occurrence alone.

Creating a job takes a schedule, a payload and a target:

```bash
# long work every Monday, as a mission: it survives a restart, asks in the chat when it needs someone, and counts
# as done once the reviewer agrees — nobody accepts each run (0.8.0)
nouride cron add --name "customer mail" --cron "0 9 * * 1" \
  --gateway telegram:main --chat -100200 --agent nouva \
  --mission "Sum up last week's customer mail for the team: one line per thread, the open ones first."

# a reminder in two hours, delivered as-is — no model call at all
nouride cron add --name "deploy check" --at 2h \
  --gateway telegram:main --chat 12345 --agent nouva \
  --text "Check whether the deploy finished."

# a probe every fifteen minutes; its output goes straight to a Discord channel
nouride cron add --name "queue depth" --every 15m \
  --gateway discord:main --chat 987654321098765432 --agent nouva \
  --command "./check-queue.sh"

# the same probe, but the agent reads the output and reports what it means — one model call,
# instead of a turn that has to discover it should run something first
nouride cron add --name "queue depth" --every 15m \
  --gateway discord:main --chat 987654321098765432 --agent nouva \
  --command "./check-queue.sh" --then agent

# a standup summary at 09:00 Jakarta, in its own history so the daily runs do not fill the chat
nouride cron add --name "standup" --cron "0 9 * * 1-5" --tz Asia/Jakarta \
  --gateway telegram:main --chat 12345 --agent nouva --session fresh \
  --message "Summarise what changed since yesterday. Reply in Indonesian."
```

| Flag | |
|---|---|
| `--at` | once — a duration (`2h`, `90m`) or a timestamp (`2026-08-19 09:00`, read in `--tz`) |
| `--every` | an interval, measured from the end of the last run so a slow job never queues against itself |
| `--cron` | a 5-field expression. Day-of-month and day-of-week are **OR** when both are set — `0 9 15 * 1` fires on the 15th *and* every Monday |
| `--tz` | IANA zone. Without it, `[daemon] timezone` |
| `--gateway` `--chat` | the conversation the job is about — a gateway **instance** id (`discord:main`), and the chat, channel or group id |
| `--text` | a reminder, delivered as-is. No provider call, so it still works when the model is down |
| `--message` | wake the agent with this instead |
| `--command` | run a shell line on this host with no model (`--cwd` for where). `--then agent` hands what it printed to one turn. A run that prints nothing sends nothing and runs no turn |
| `--session` | whose history the turn reads: `fresh` (none — the default), `isolated` (private, at `cron:<jobId>`, kept across runs), or `chat` (the target conversation's, read *and* appended to) |
| `--quiet` | deliver nothing. The run is still recorded |
| `--keep` | do not delete a one-shot after it fires |

**`--command` is an operator-only capability, and deliberately.**
A command job runs argv on the host with no model and no approval gate — nothing inspects it.
For an agent this argv is classified as itself, and otherwise as `unattended` on the fixed list: asked under `careful` — under `balanced` too when the command is one `balanced` asks — and never a standing grant. An agent that wants a script run on a schedule can also schedule an agent turn and call `exec` inside it, where the gate sees it as it runs.

The agent uses these same commands when you ask in chat — there is no separate scheduling tool.
Jobs it creates always belong to the conversation it was asked in, and it cannot point one somewhere else.

A job whose run was cut off by a restart keeps running: a recurring one is given its next time, and a one-shot is disabled with the reason `daemon restart`, for `nouride cron run` to retry.

### `nouride webhook`

A job that runs when something calls its URL, not on a clock.

```bash
nouride webhook                             # the endpoints, with their URLs
nouride webhook add --name "ci failed" --agent nouva --gateway telegram:main --chat 12345 \
  --message "The CI run at the end of this message failed. Find out why."
nouride webhook rotate <id>                 # a new URL; the old one stops working
nouride webhook test <id>                   # whether a call from the internet arrives
```

The URL is `POST /hooks/<token>`, and the token is the credential: anyone holding it can fire the job, so `rotate` exists.
An unknown or disabled token answers the same 404, the call returns 202 at once (`?wait=1` waits for the outcome), a call while the last one is still running answers 409 and is not run, and each token is rate limited.
The caller's body is appended to the job's message, marked as data to read rather than instructions.
Underneath, a webhook is a cron job: `rm`, `enable`, `disable`, `run` and `runs` are `nouride cron`'s.
`test` posts to the hook through `[dashboard] public_url`, marked as a test that the route counts and does not run; the
list and the dashboard then say whether the hook is reachable from the internet, local network only, or unknown.

### `nouride access`

Who may talk to your agents. **Default posture is pairing.**

```bash
nouride access                              # everyone: pending, paired, denied, blocked
nouride access pending                      # or approved, denied, blocked
nouride access approve DFY-HXR              # the code the stranger was shown
nouride access approve DFY-HXR --me         # …and it is you, on another platform: agents know it is the same person
nouride access approve DFY-HXR --as sam     # …it is somebody already in [[people]] (by key)
nouride access approve DFY-HXR --new "Sam"  # …it is somebody new
nouride access allow telegram:nouva:555000111 --name "Sam"  # in before they ask: Approved, revocable
nouride access deny telegram:nouva:555000111     # no, this time: ignored for a day, then may ask again
nouride access reset telegram:nouva:555000111    # …end that wait now
nouride access block telegram:nouva:555000111    # no, until unblocked
nouride access unblock telegram:nouva:555000111
nouride access revoke telegram:nouva:555000111   # take an approval back; they may ask again
nouride access mode                         # which posture is in force
nouride access mode allowlist               # stop admitting anyone new
```

How pairing goes:

1. A stranger messages the bot. They get a code and **nothing else** — no agent name, no tool list, no
   hint of who runs it. Their message is dropped.
2. You get the same code in your alert channel (`DEPLOY.md`, Alerts), so approving does not mean watching the agent's chats.
3. `nouride access approve <code>` — they are told in the chat they used, and remembered on disk. Say who they are (`--me`, `--as <key>`, `--new "<name>"`) and their id is added to that person in `[[people]]`, so every agent knows them by name. Approving is an admin's.

The dashboard's **Access** page does all of this for every agent at once — Pending, Approved, Denied,
Blocked and History tabs — and its History is the audit log's `access_*` rows: requested, approved, denied,
blocked, revoked, reset, unblocked, expired.

| | |
|---|---|
| Identity | `(gateway instance, sender id)`. Pairing with `telegram:nouva` does **not** admit you to `telegram:nox` |
| Code | 6 characters, no `O`/`0`/`I`/`1`/`U`, expires in 15 minutes, single use |
| Repeat messages | one code, not one pending request per message; the "I don't know you" reply is rate limited |
| Denied sender | dropped in silence for `deny_cooldown_ms` (a day), then their next message is a new request with a new code. `reset` ends the wait. Telling them invites retrying and confirms the bot is live |
| Blocked sender | dropped in silence until `unblock`, which lets them ask again — it admits nobody. A block beats `allowlist` and `open` too |
| `allow` | an admin's: approved without a code, before they have written. Not past a block. What `allowlist` was the only way to do, now revocable from the Access page |
| `revoke` vs `deny` vs `block` | revoke takes an approval back; deny is no for now; block is no until unblocked. Each also drops their own approval level |
| A stale answer | each answer touches only its own state — `deny` a pending request, `revoke` an approval, `reset` a denial, `unblock` a block — so `revoke` or `deny` on a blocked sender is refused rather than lifting or softening the block |
| Before 0.7.0 | deny was the block. A denial from then has no end, and `tidy` at boot makes it the block it was |

```toml
[security.access]
mode = "pair"                 # "pair" | "allowlist" | "open"
allowlist = []                # honoured in every mode: "123456789" or "telegram:nouva:123456789"
code_ttl_ms = 900000
notify_cooldown_ms = 300000
deny_cooldown_ms = 86400000   # how long a denied sender is ignored before they may ask again
```

`mode = "allowlist"` admits only listed and already-paired ids, **everyone else dropped in
silence** — no reply at all. Use the qualified spelling when one daemon runs bots on several
platforms, since a Telegram id and a Discord snowflake are both numeric.

**Turning pairing off, once you have paired the people you want.** `nouride access mode allowlist`, or
the switch on the dashboard's Agent Settings page — it is daemon-wide, so it is not inside any one agent.
Senders already approved keep talking — the store answers `approved` before the mode is consulted — and
every unknown sender is dropped at the gate: no code, no reply, nothing queued, no agent turn. That is
the anti-spam posture, and it takes effect on the next message, with no restart, because an operator
switching it off is usually reacting to a flood right now. Switching back to `pair` re-opens the door.

Going the other way, to `open`, is refused from the dashboard and the CLI whenever boot itself would
refuse it — a chat gateway enabled plus an agent holding `exec` plus no allowlist is a remote shell,
and saving that config would leave a daemon that cannot be started again.

The dashboard's own chat and `nouride chat` (the `web` gateway) are exempt: they are behind a login or
a token already, and making you pair with your own daemon would be theatre.

### `nouride people`

Who the agents know.

```bash
nouride people                                          # [[people]], and paired senders nobody has named yet
nouride people set sam --name "Kak Sam"                 # somebody by key — new, with no account yet
nouride people set telegram:555000111 --name "Sam" --note "Alex's partner"   # whoever holds that account
nouride people remove sam                               # by key, or by an account they hold; their memory stays — `memory forget` removes it
```

`[[people]]` in `config.toml` is one entry per person, found by its `key` — unique, set once, the name of their memory profile (`SPEC.md` §12) — with the accounts they send from in `ids`, so the agent knows who is speaking. Accounts are optional: somebody added by name is attached to theirs when they pair (`nouride access approve <code> --as <key>`).
The second list is the useful half: a sender the daemon answers and cannot name is somebody every agent greets as nobody.
Naming is identification, never permission — `nouride access` decides who may talk at all.
Removing somebody revokes their MCP tokens and leaves their memory under their key; until `nouride memory forget <key>` clears it, that key is not given to anyone new — a key made from a name steps around it, and `--reattach` gives it on purpose, with what it holds.

### `nouride memory`

What the agents remember (`SPEC.md` §12 says what it does).
Each conversation is one episode, filed by the nightly pass into a summary, tags and facts about the people in it.
People are named by their `[[people]] key`; the files live under `[memory] dir`, outside the persona packs.

```
nouride memory                                   # the nightly pass and what waits for it, facts, semantic search
nouride memory set pass_at 02:30                 # also pass, pass_per_night, pass_max_tokens, max_attempts, facts, propose_shared, archive
nouride memory set pass_model nougate/gemini-3.5-flash  # one model for every agent's pass, and its compaction summaries
nouride memory set pass_model small              # each agent's own small-tier model, on its own provider (0.8.0)
nouride memory set pass_model -                  # back to each agent's own
nouride memory set prompt_recent 5               # conversation summaries in each prompt (3 by default)
nouride memory set recall off                    # nothing remembered in prompts; the pass still learns, agents still search
nouride memory set transcript_days 14            # 0 keeps them forever
nouride memory episodes bali --person alex --since 2026-09-01
nouride memory show 2026-09-25-1405-nouva        # one conversation, whole
nouride memory pass                              # run the nightly pass now
nouride memory proposals                         # what the pass proposed and waits for you
nouride memory approve <id>                      # or: deny <id>
nouride memory changes --person alex           # what memory changed, and why, newest first
nouride memory failed                            # conversations the pass could not file
nouride memory retry [<episode>]                 # try those again on the next pass
nouride memory undo alex                         # a profile (or `shared`) back one version
nouride memory forget ibu                        # their profile and conversations, for good
nouride memory forget ibu --anonymize            # or only hide their name where others mention them
nouride memory tags                              # tags by use; how many are on one conversation only
nouride memory tags tidy                         # what the rules would merge, trim and cap — changes nothing
nouride memory tags tidy --apply                 # do it (the vault is backed up first); --only merge,trim,cap, or rules R1, R2, R3, R5
nouride memory tags suggest                      # the model's view of tags that mean one subject — shown, not applied
nouride memory tags merge reminders --into reminder   # a hand merge, recorded like a tidy
nouride memory tags undo                         # put the newest tidy back
nouride memory reindex                           # rebuild the index from the files
nouride memory embed                             # vectors for everything not yet embedded
```

The dashboard's **Memory** menu is the same surface: each agent's notes, each person's profile (editable, with history
and undo), the timeline of conversations with the nightly pass on top, shared knowledge, the
proposals, settings, the graph, and the tags. Serving memory to other tools is `nouride mcp-server`.

Conversations are cut into episodes on `/new` and `/reset`, and the nightly pass cuts every chat
still open at `[memory] pass_at`, then files what is waiting, within today's `[llm.limits]`. It runs
while `pass` is on — off until the setup wizard's last step asks. Facts are off until chosen:
`facts = "auto"` keeps every fact at once, readable only where it was said; `"ask"` makes every
change wait; a person's own `facts` (People tab) overrides it. Shared knowledge is proposed only with
`propose_shared`, and always waits for you.

Memory is written in English whatever language a conversation was in — summaries, facts, notes,
tags. Transcripts are the exception: they stay as they were said. A pass answer that is not English
is asked for once more and otherwise left raw for the next night; `memory_write` refuses it.

**Tags** stay one vocabulary. The pass shows its model the tags already in use, folds a new spelling
into one in use where the match is certain (`reminders` → `reminder`), and lets a conversation coin at
most one new tag (three while an audience has fewer than 20 tagged conversations). `tags tidy` applies
the same rules to what is already written: merges, one-off tags trimmed (a conversation keeps one,
an imported day none), at most four tags per conversation. R5 merges, a narrower tag into the broad
one beside it, are applied only when named (`--only R5`): `home-assistant` is not `home`. Only the `tags:` line of an episode
changes; merged names become aliases of the tag kept; each tidy is recorded under `tags/_tidy/`, which
is what `undo` reads — refusing, whole, a record that names anything but this vault's conversations and tags. The dashboard's Memory page offers the same as a card, and the graph has
**Merge into…** on a tag.

`archive` conversations, which an import before 0.8.0 made from another memory tool's day summaries, are
read like any other. `backfill`, which filed the transcripts a 0.5 or 0.6 install captured, is gone in
0.8.0: `nouride memory backfill` is an action `memory` does not have, exit 2. Run it on 0.7.28 before
updating if those transcripts are still to be imported.

`episodes` and `show` print every chat's conversations, the operator's view. They refuse when run
from inside an agent's turn and point at the `memory_search` tool, which answers only what that chat
may see. `forget` needs an admin; `tags tidy --apply`, `tags merge` and `tags undo` an operator,
and they wait their turn: a tidy is refused while the nightly pass, a reindex or a forget is running.

### `nouride mcp`

The install's MCP servers — the other direction from `nouride mcp-server`. Since 0.7.19 a server is added once, to
the library (`agents/mcp.toml`), and switched on for the agents that use it, as skills are; Configure → Connectors in the
dashboard is the same list.

```bash
nouride mcp                                                     # the library: each server, the agents it is on for, their tools
nouride mcp add --name github --command github-mcp-server --arg stdio --agent nouva --agent nox   # on for both
printf %s "$TOKEN" | nouride mcp add --name deploy \
  --url https://deploy.example.com/mcp --stdin                  # in the library, on for nobody yet
nouride mcp enable deploy --agent nouva                         # switched on for one agent
nouride mcp disable deploy --agent nouva                        # off for it; the library keeps it
printf %s "$GH_TOKEN" | nouride secret set github_token --stdin   # a stdio server's token: stored once…
nouride mcp add --name gh --command github-mcp-server --arg stdio \
  --env-secret GITHUB_TOKEN=github_token             # …and named as the variable it reads
nouride mcp enable gh --agent nox --env-secret GITHUB_TOKEN=nox_github_token   # nox brings its own
nouride mcp enable gh --agent nox --library-credential                         # …and back to the shared one
nouride mcp rm deploy                                # out of the library and every agent; its logins go too
nouride mcp search github                            # Nouverse's MCP catalog (the official registry, ranked), best first
nouride mcp add --from io.github.github/github-mcp-server --agent nouva \
  --env-secret GITHUB_PERSONAL_ACCESS_TOKEN=github_token   # filled in from the registry, version pinned
nouride mcp add --name notion --url https://mcp.notion.com/mcp --agent nouva --agent nox   # no token: it asks for a login
nouride mcp login --server notion                    # one login, for every agent with none of its own
nouride mcp enable notion --agent nox --own-login    # nox logs in as somebody else…
nouride mcp login --server notion --agent nox        # …here
nouride mcp logout --server notion                   # its tokens deleted; it waits for a login again
```

`--command` means stdio and `--url` means HTTP; a token arrives on stdin and is stored as a secret
(`mcp-lib-<server>`, or `mcp-<agent>-<server>` for an agent's own), which the file names. A stdio server's token goes in
its environment through `--env-secret VAR=secret`, repeated per variable: the secret must already be set, and only its
name reaches the file (`env_secrets`). `--per-agent` marks a server whose credential is never shared: each agent it is
switched on for brings its own.

Where each agent is its own user (`docs/DEPLOY.md` § Each agent its own user), a stdio server runs as the agent it
serves (0.8.1): with that agent's HOME and installs, started in the agent's own folder — so a `--cwd` has to be a
folder that agent's user may enter. A server that kept its sign-in or settings in the daemon's HOME no longer finds
them, since the agent's user cannot read that folder: sign it in again for each agent, give it its token through
`--env-secret` where it reads one, or copy what it saved into the agent's own folder (`workspace/private/<id>/`, the
agent's HOME). In a container, on macOS or without the helper, it runs as the daemon's user, as before.

Every change reloads the agents it reaches, which connects or closes the server — nothing restarts. A pack's own
`[[mcp_servers]]`, from before the library, is refused since 0.8.0: that agent does not load until the server is added
here and the block removed. A server's own tools that change while it runs are taken up without a reload, when it declared `tools.listChanged`
and says so: listed again for the agent's next turn, with what came and went in the log (since 0.7.13).

A remote server with no credential of its own that answers 401 is listed as **needs login** (since 0.7.19).
`nouride mcp login` logs it in through its OAuth flow — the library's login without `--agent`, the agent's own with it: it prints the address to open, and asks for the one the browser
lands on afterwards — the page there may not load, as over SSH; its address is what carries the answer. `--client-id <id>`
is for an authorization server that registers no clients itself (GitHub's); the client's secret is asked for at the
prompt, never taken on the command line. The tokens go to the secret store and renew by themselves; a login the server
stops taking is said once through `[alerts]` and the server is listed as needing one again. Admin only, and an agent
running `login` or `logout` through its `nouride` tool or `exec` is asked about it every time.

The list says what each server's tools add to every request that agent makes — their definitions, in bytes, which
the built-ins' budget never covered (since 0.7.10). Past 16KB a server is said at warn when it connects and by
`nouride doctor`. A server's name is its tools' prefix (`<name>__<tool>`), so a second server of one name, or a name
that holds `__` or ends in `_`, is refused when the library loads, naming the entries.

### `nouride mcp-server`

Nouride as an MCP server, for other tools: Claude Code, Cursor, an editor. They reach this install's
memory and personas at `POST /mcp`, with a token. Not `nouride mcp`, which is the other direction:
the MCP servers an agent here uses.

```
nouride mcp-server                               # on or off, and the tokens
nouride mcp-server on                            # serve /mcp, to tokens only
nouride mcp-server token create --person alex --agents nouva,nero --label claude_code
nouride mcp-server token create --person alex --agents nouva --label zed --scopes personas
nouride mcp-server token create --person alex --agents nouva --label cursor --ttl 30   # 0 never expires
nouride mcp-server token list                    # or: revoke <id>
```

A token stops working after `--ttl` days, 90 when not given (since 0.7.10); `--ttl 0` is one that never
expires, asked for by name. A token made before 0.7.10 has no end and keeps working — revoke it and make
another to give it one. The list says when each expires, or that it has.

A token belongs to a person (their `[[people]] key`): memory is what they would see talking to the
agents it names. Its scopes say what of those agents it reaches: `memory` (search, read, count),
`memory:write` (save a conversation, condensed, as a transcript filed tonight), `personas` (who each agent is). Without `--scopes` a
token reads memory and personas and writes nothing. Its value is printed once. All of it is an
admin's.

What a client is offered — each tool's name, description and parameters, for each scope — is a contract
with the tools that call it, pinned in [contracts/mcp-surface.json](./contracts/mcp-surface.json): it
changes only on purpose, and the diff of that file is the change.

It speaks MCP 2025-06-18, 2025-03-26 and 2024-11-05, answering `initialize` in the one the client asks for, or
in 2025-06-18 when the client asks for another; a request whose `MCP-Protocol-Version` names a version it does
not speak is refused with 400 (since 0.7.13).

### `nouride sessions`

```bash
nouride sessions                   # stored conversations, newest first
nouride sessions 100
```

One line each: agent, gateway instance, chat, and the context's approximate size.
They are kept for `[retention] session_days`.

### `nouride turns`

```bash
nouride turns                      # the newest 20 turns: id, agent, status, calls, cost, the question
nouride turns --agent nouva --limit 50
nouride turns show turn_8f3a1c0b2d4e6f708192
nouride turns show turn_8f3a1c     # a shortened id works when it names one turn
```

`show` prints one turn whole: the question and how it ended; every model call with its tokens, cost,
latency and attempts — and, when a gateway such as Nougate said who answered it, `via <provider>` with the
model it served when that is not the one asked for (since 0.7.4, `069_baseline.sql`), and why it ended as the
provider said — `stop`, `tool_calls`, `max_tokens` (cut at the output limit) or `error`, nothing when it gave no
reason (since 0.7.26, `069_baseline.sql`) — a helper's and a peer's calls under the turn that asked, with
their agent named;
the calls added up, with how many were unpriced and how often a provider made the turn ask again; the
steps; what each model request carried, under `requests` (since 0.7.26) — `#2 ~148,200 tokens · 2 results cleared ·
summary`, with the file each newly cleared result was kept at, a helper's or a peer's named; the audit log's rows for
its tool calls; the answer. Everything is joined by the turn's id, which
`llm_usage` and `audit_log` carry from 0.7.3 on — a turn from before that shows its steps and nothing
it cost. A turn that answered a person's edit is marked `edited ·` before its question in the list, and
`show` says which message it was.

Work a turn handed to the background — a helper started with `delegate` and `background: true` or moved there after
the minute it was waited for, an agent asked with `ask_agent` once its turn moved there — is a turn of its own (since 0.7.26): `show` of the turn that started it lists
each under `handed off`; `show` of one prints its steps, each nudge it read, and the report it handed back as its
answer, with the job it ran as and the turn that asked — whose `model calls` and `audit` hold its calls. In the list it
says `↳ delegate for <turn>` where a turn says its calls and cost. Its job's log names it on its first line.

### `nouride events`

```bash
nouride events                                    # the newest rows
nouride events --turn turn_8f3a1c0b2d4e6f708192   # what that turn did, as it was written down
nouride events --gateway telegram:main --chat 814 # one conversation's
nouride events --kinds tool,tool_done,usage       # some kinds only, anywhere
nouride events -f                                 # follow everything written from now on
nouride events -f --since 4810                    # follow from a cursor: what came after it, then onwards
nouride events --since 4810 --limit 500           # the page after a cursor
```

What turns do, as one stream since 0.7.4 (`069_baseline.sql`): a turn starting and ending, each step,
the answer as it grows (`reply` — only the new text each time), each tool call as the audit log keeps
it (`audit`), each model call as it is metered (`usage`), and a step taken back (`unstep`). Since 0.7.6
a model call asked again is a `retry` row and the conversation made to fit a `compact` row, and a
call's `tool`, `audit` and `tool_done` rows carry the same `callId` — the line prints it — with the
last two written in one transaction. Every row has a `seq`, one cursor for all of them: a page ends
with the `--since` to ask from next, and `-f` picks up from the last one it printed when the
connection drops — a restart is often exactly what is being watched; a stream silent for 45 seconds,
keep-alives included, is treated as dropped. Since 0.7.10 `-f` follows from now unless given `--since`
(it used to replay every row first), says when the daemon speaks another major version of the stream,
when rows were too many to replay — with the `--since` to page them from — or are gone with their
turns, and when the database went back to an older state; and a stream the daemon refuses ends it,
with why, instead of a retry every three seconds. Kept as long as the turns, `[retention] session_days`.
A row that carries a person's edit (`editOf` — a turn answering one, a message edited while a turn worked)
ends `(edited)`, and the `✎` the stream keeps for readers that know no `editOf` is left off.
`--json` prints a page as `{version, oldest, latest, events, next}`; it is refused with `-f`, which
never answers once.

What each kind carries, what a reader can rely on and how the stream may change is its contract,
[EVENTS.md](./EVENTS.md) — protocol 1.1, which `version`, `/health`'s `eventProtocol` and the
`x-event-protocol` header name.

The same stream is `GET /api/control/events` (a page) and `GET /api/control/events/stream`
(`text/event-stream`: the rows after `since` — or after the browser's `Last-Event-ID` on a reconnect —
then each as it is written; `tail=1` starts at the newest). The dashboard's conversation view follows
it and polls the moment something is written, instead of every half second. Since 0.7.6 it is where a
turn's steps are kept, and since 0.7.10 the only place: the steps of turns recorded before 0.7.4 were
copied into it, at their own times, and the old `turn_steps` table dropped.

### `nouride db`

The database's backups, and the way back from a bad day. Local, so they work with the daemon down.

```bash
nouride db backup                  # a snapshot now, verified before it is kept
nouride db list                    # snapshots, newest first
nouride db verify                  # integrity-check the live database; or name a snapshot
nouride db restore nouride-2026-10-12-03-00-00.db   # put one back — the daemon must be stopped
nouride db adopt                   # accept this build's schema as correct for this database
```

The daemon snapshots `data/nouride.db` itself, weekly and at boot — unless the newest is under a week old, so a crash loop writes one copy rather than five, and a box restarting nightly none — keeping `[daemon] backup_keep` (four), into `data/backups/db/`, or into `db/` under `[daemon] backup_dir` when one is set. `list` and `restore` look in both.
Before a migration it takes one more, `nouride-<time>-before-<version>.db`, which the rotation leaves alone; restoring that one is how an upgrade is undone.
`restore` puts back the database alone, and refuses while a daemon runs on this data directory: the running process would write its own state back over the file.
A snapshot from before 0.8.0 (schema below 69) is refused too, exit 1 and nothing changed (since 0.8.1; below 68 since 0.8.0): this version does not start on it. 0.8.0's `nouride db restore` puts it back, and starting 0.8.0 once brings it forward.
`adopt` is for a database whose schema fingerprint does not match this build's — `DEPLOY.md` covers when a boot refuses over the schema, and what to do.
A bare `nouride db` is its help: these lines, exit 0, and `{ help }` under `--json` (since 0.7.11).
`db restore` with no file is asking wrongly, exit 2, and names the newest snapshots.

### `nouride users reset`

The way back from a lost first password (since 0.7.11); `DEPLOY.md` § Lost the first password has the steps, Docker's included.

```bash
nouride users reset                # every dashboard account and sign-in removed — the daemon must be stopped
```

It empties the account table, so the daemon's next start creates the first admin again and prints its password, as a first start does — or takes `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` from the install's `.env` when both are set.
Local, like `db restore`: it refuses while a daemon runs on this data directory, which also keeps it from an agent, whose commands run only while the daemon does.
It snapshots the database first, records a `users_reset` audit row, and names the snapshot, which `nouride db restore` puts back, and each account it removed with its role and `web:<id>` — a People entry that named one needs that line changed, because the new admin is a new id.
With no account there is nothing to do, and it says so; with no database it fails, since the first start has not run.
A bare `nouride users` is its help.

### `nouride logs`

```bash
nouride logs                       # the last 50 lines, from the daemon
nouride logs -n 500 --level warn
nouride logs --component gateway.telegram -f
```

The daemon's recent lines, from the daemon itself rather than the platform, so it works under Docker, launchd or an LXC without a journal, and from another machine.
The full history is still the platform's log (`journalctl -u nouride`, `docker logs`), and the dashboard's System Logs reads the daemon's own log table.

### `nouride service`

Keeps the daemon alive across crashes and reboots — systemd on Linux, launchd on macOS.

```bash
nouride service status                                   # which supervisor, and will exiting respawn?
nouride service install --user nouride --dir /srv/nouride  # writes the unit, prints how to enable it
nouride service uninstall                                # prints how to remove it
nouride service diff                                     # the installed unit against this version's
```

`diff` compares `/etc/systemd/system/nouride.service` with the unit this version would write for the
same user, directory and measured sizes, directive by directive. Updates replace the binary, never the
unit: re-run `install.sh` to rewrite it, and `nouride doctor` says when that is due. A privileged
install running as root rewrites its own unit once an update has confirmed itself, and reloads systemd;
it applies from the next start.

`install` **writes** the unit next to your data directory and prints the two or three privileged
commands that activate it. It does not run them: enabling a system service changes the host, and a
CLI you cannot safely run to see what it would do is one you end up not running at all.
`--kind systemd|launchd|procd` picks the supervisor, and `--exec` the command it starts. `procd` is
OpenWrt's: it writes `nouride.init` for `/etc/init.d/nouride`, needs `--privileged` because procd runs it
as root, and runs the update guard before every start as the systemd unit's `ExecStartPre` does. It is
picked by itself where `/sbin/procd` exists.

It refuses `--user root` unless `--privileged`, which also drops the systemd sandbox so the agent can
manage the host — for a machine dedicated to it. Otherwise this daemon runs model-chosen commands
reachable from a chat app, and every other boundary in it — exec policy, workspace sandbox, `0600`
file modes — assumes an unprivileged account.

Full walkthrough in `docs/DEPLOY.md`.

`nouride restart` depends on this. With no supervisor it **refuses** rather than exiting: a "restart"
that actually means "stop until you notice" is the worst kind of wrong. Nouride's own image restarts
the daemon from its entrypoint, so there it works; inside any other container it says to use
`docker restart`, because the restart policy lives outside the container and exiting is only a
restart if you configured one.

### `nouride stop`

```bash
nouride stop
```

**The one command that does not use the control token**, because the situation it exists for is the one
where the token is the problem. `restart` goes over HTTP and authenticates; when a daemon from another
install holds the port, every authenticated call is a 401.

It signals **the PID in this install's own lock file** and nothing else. It cannot be aimed at an
arbitrary process, and it cannot reach another install's daemon — for that, run it from that install's
directory.

| Situation | What happens |
|---|---|
| Daemon running | SIGTERM, then waits for the lock file to disappear — which is the daemon's own shutdown path finishing, not just the port closing |
| Shutdown stuck past `shutdown_timeout_ms` | Reports it and stops. **No SIGKILL** — a shutdown killed mid-checkpoint is how the database gets damaged |
| No lock file | "no daemon is running", exit 0. Not an error |
| Lock names a dead PID | Removes the stale lock |
| Lock names a PID that is now something else | Refuses and names the process. PIDs are recycled, and signalling a recorded PID without checking is a rare event with an unbounded blast radius |
| Lock file with no PID in it | Left in place — removing a live daemon's lock would let a second one start on the same data directory |

### When two installs fight over the port

`dashboard.port` defaults to `18254` for every install, so the first daemon started on a machine owns
it and the others refuse to boot (`Port 18254 is already in use`). The **CLI** of a second install would
then reach the *first* install's daemon, send its own token, and get a 401.

`/health` reports an `install` field — a hash of the data directory, so nothing about the filesystem
is exposed on an endpoint that needs no token — and the CLI compares it before blaming the token:

```
✗ The daemon at http://localhost:18254 belongs to a different Nouride install.
  It is not the daemon for /tmp/other/data, so its token is not the one here. Every install
  uses the same default port, so the first one started wins it. Stop that daemon, or set PORT
  for this one.
```

Running more than one install at once needs `PORT` set for all but one.

### `nouride audit [limit]`

Recent audited actions, newest first: tool executions with their arguments, approval answers
and who gave them, agent and skill creation, gateway restarts, config changes.

```
02:14:07 approval_resolved  nouva · alex    {"approval":"apr_9f2c…","status":"approved"}
02:14:01 tool_exec          nouva · dev     {"tool":"agent_create","args":{…},"ms":12}
```

### `nouride restart`

```bash
nouride restart                    # once nothing is running
nouride restart --now              # whatever is running
nouride restart --then "check every gateway reconnected and report anything that did not"
nouride restart --wait             # …and return once it is back: exit 0, or 1 saying why not
```

Asks the daemon to exit through its graceful shutdown sequence, expecting a supervisor
(`docker compose`, systemd) to bring it back. Without one, it refuses rather than stopping; `--force`
stops it anyway.

It waits the way `update --start` does: until no turn is running or queued and no approval is pending,
for ten minutes at most, and until no background job is working, however long that takes. A turn still
running at ten minutes is closed with everything it did and taken up again once the daemon is back; a
build or a coding agent's run is never cut in half, and the note names what it waits for — "restarting
once the background job `make build` (12m) finishes, however long that takes". `--now` does not wait,
and stops the jobs.

An agent must pass `--then` (or `--no-then`): the command ends the conversation it was run from, so
the turn that reports whether it worked is written *before* anything goes down, and armed as the
process ends — `--in` (default 10 seconds) counts from the restart, not from the command. A person
needs neither. The dashboard's **Restart** on Overview and `/daemon-restart` in a chat take the same
path.

`--wait` returns once the new process answers `/health`, saying each step it sees — still finishing what runs,
stopped, starting and on which step of boot, back — and exits 1 if it is not back within twelve minutes. A
restart still waiting on a background job then says that, rather than that it failed: the job has no time limit.

### `nouride update`

```bash
nouride update --check                         # which build this is, and whether one is newer
nouride update                                 # same thing — reporting is the default
nouride update --start                         # take it, and restart once nothing is running — you watch
nouride update --start --now                   # …and restart at once, whatever is running
nouride update --start --then "<what to check after>"   # an agent: take it, and come back
nouride update --start --wait                  # take it, and return once the new version answers
nouride update --rollback                      # the version before this one: what going back would do
nouride update --rollback --apply              # …and do it, with the daemon stopped
```

Prints the version **and the edition** — `basic`, `router`, `pro` — because the
two together are what "what is deployed here" means, and the edition decides which tarball an update
would fetch.

With `--start` it downloads that tarball, verifies it against the release's checksum file (`CHECKSUMS`; `SHA256SUMS` up to 0.7.x), swaps
the files (keeping the previous version in `.nouride-previous/`) and exits for its supervisor. It
needs no root: the install directory belongs to the service user.

The exit waits for the daemon to go idle: nothing running, nothing queued and no approval pending, for
up to ten minutes, and no background job still working, however long that takes — so an update never
cuts a build or a coding agent's run in half, and the note says which job it is waiting for. A
`service` job (a dev server, a tunnel) is not waited for: it serves until stopped. `--now` exits at
once; a turn cut off by it is closed with everything it did and its person told so, like any turn a
restart interrupts, and a job it kills is reported as interrupted. A conversation's turn cut off by a
restart is taken up again by itself, once, when the daemon is back within 15 minutes.

`--then` is required of an agent, for the same reason `nouride restart` requires it — the command
ends the conversation it was run from, so the turn that reports whether it worked is created
*before* anything is touched. A person at a terminal is watching it themselves, so for them
`--start` alone is the command: the CLI tells the two apart by `NOURIDE_AGENT_ID`, which an agent's
`exec` and `nouride` tool always carry. `--no-then` still says the same thing explicitly.

**Below a release's upgrade floor it offers the stepping stone.** A release can need a newer version than this one to
have run first — 0.8.0 upgrades only from the last 0.7.x (DEPLOY.md § The upgrade floor). Then the version offered is
the newest release this one may take, and the report says why under it:

```
↑ 0.7.11 → v0.7.14
  update to 0.7.14 first; 0.8.0 needs it
```

`--start` takes the stone, never the release that needs it; once it has started, `nouride update` offers the newer
one. When nothing on the channel's list reaches the floor, it prints the line instead of "up to date" — install that
version by hand, start it once, then update. The install itself refuses a release whose signed checksum file needs a
newer version first.

A public release is verified against a signature over its checksum file when it carries one — from
0.7.4 on, each does — and installs unsigned when it does not, as every release before did. A private
edition needs the signature either way.

**The new version is on probation until it proves itself**: past boot, a chat gateway connected (when
there are any), and a message handled — or five minutes up on an install with nothing to handle. Until
then the unit's update guard counts its starts, and on the fourth it puts `.nouride-previous` back. A
provider having a bad hour is not held against it: the build that reached the provider works. On a
paired box the proof is a sync the service answered instead.

**`--rollback` is for a version that starts and is wrong**, which the guard cannot see. It runs without
the daemon, like `db restore`, and on its own says what it would do:

```
v0.7.5 → v0.7.4 kept since 2026-10-20 03:12
  files     nouride, dashboard, skills, swapped with this build's — which is kept, so this goes forward again
  database  nouride-2026-10-20-03-12-40-before-050.db, taken before the update migrated it
  what happened since 2026-10-20 03:12 is lost: conversations, turns, memory changes, jobs
```

The database goes back only when the update migrated it — then the older binary would refuse the newer
schema — and to the snapshot that migration took, never one taken by hand or by an older update. The
database it replaces is set aside whole, beside it, so a rollback can itself be undone. `--apply` does
it: the database first, so a snapshot that does not check out changes nothing, then the files. The
version left is not taken again by an automatic update, and the same command on the version you went
back to goes forward again.

Back to a build before 0.8.19 (or one whose version it cannot read), the secrets go with it as that build reads them:
`secrets.json`, at 0600, written after the database and before the files, the encrypted store left where it is, and
said in the preview as `secrets   written as secrets.json…`. 0.8.19 coming forward reads the newer `secrets.json`, with
whatever the older build changed, and encrypts it again. That opens the store, in the preview too: without its key the
command says so and changes nothing. On a Linux install run it as root, `sudo nouride update --rollback --apply`: the
key is root's file, and the launcher hands it to the CLI it runs as the service account.

Both `nouride update --start` and, since 0.7.4, `install.sh` keep the build they replace in
`.nouride-previous/`, with a note of which version put it there. A build that was put aside by another
version is refused — this one came some other way (a copied binary, an older `install.sh`), and the
build before it was not kept — and so is a kept build of this same version. A reinstall of the same
build leaves the kept one alone, and so does another build of the version it was put aside for: the way
back is still the version before.

An install that cannot update itself says why and prints what does work instead: a container is
replaced from outside by pulling its image again, a Pro edition installs only a signed release and a
channel that publishes no signature cannot give it one, and an unsupervised daemon would be stopped
rather than restarted. A newer release the channel has no build of for this install is still named,
rather than reported as "up to date": a Pro build off a Box is pointed at that release's tarball in the
internal repository and `install.sh --tarball … --variant pro`, and a macOS install at the command that
builds one.

**`nouride update --start` is on the fixed list (`replace`); the bare command and `--check` are not.** So an agent
reaching this through `exec` or the `nouride` tool is asked every time under `careful` and can never hold a
standing grant for it — while staying free to answer "are we current?" unprompted. The `update` tool draws the same line for the agent's own path.

### `nouride version` · `nouride help`

`help` is one screen, grouped the way the commands are reached for, and `nouride <command> --help` prints that command's lines from it.

---

## The single binary

```bash
bun run build:binary                        # this machine
bun run build:binary --target linux-x64     # cross-compiled, → dist/nouride-linux-x64.tar.gz
bun run build:release                       # every Linux target, for a GitHub release
./dist/nouride doctor
```

One command, everything in it. It builds the dashboard, then compiles the binary — the CLI *and* the
engine, so the same binary serves `nouride start` and `nouride chat` — with the WhatsApp bridge compiled
in: every edition carries it, in-process, with no second executable. It needs no Bun on the target.
`dist/` is gitignored.

The tarball holds what an install needs beside the binary, and the build prints which:

```
✓ linux-x64: dist/nouride-linux-x64/ and .tar.gz
    binary + dashboard + skills + pkg + config.example.toml
```

`skills/` are the built-in skills, `pkg/` is the `nouride-pkg` root service `install.sh --allow-packages`
installs, and the router editions add `frontend/`, the bundled LLM gateway's UI. `install.sh` unpacks
them all.

---

## Recipes

**First run, no bot token:**

```bash
nouride setup                      # provider, key, first agent
nouride start &                    # or: docker compose up -d
nouride doctor
nouride chat
```

**A turn is not answering:** `nouride status` for queue depth, `nouride approvals` for a
blocked tool call, `nouride audit` for what it last did.

**An agent behaves strangely:** ask it `/prompt` in a DM. That returns the system prompt it is
running with — your own files in full, Nouride's harness elided — usually faster than reasoning
about it from the outside.

**Driving it from a script:**

```bash
TOKEN=$(cat .nouride/data/.control-token)
curl -s localhost:18254/api/control/message \
  -H "x-nouride-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"hello","chatId":"c1"}'
```

Reusing `chatId` continues one conversation; omitting it starts a fresh one each call.

**Adding Family Members or Granted Users (Access + Identity + Memory):**

To give a family member or new person access to your agents and ensure the agent recognizes them by name and retains their facts permanently across `/new` resets and restarts:

1. **Security Access (Allow them to talk to the daemon)**:
   - *Via Pairing*: Have them message the bot, get the code, then run:
     ```bash
     nouride access approve <code> --new "Kak Sam"
     ```
   - *Before they ever write*: allow them on the connection they will use — it shows under Approved, where it can be revoked or blocked:
     ```bash
     nouride access allow whatsapp:main:628111000001@s.whatsapp.net --name "Kak Sam"
     ```
     (`[security.access] allowlist` in `config.toml` does the same for an install set up from files — `[security] sender_allowlist`, its old name, is refused since 0.8.0 — and the dashboard shows it but cannot revoke it.)

2. **Identity Mapping (`[[people]]` in `config.toml`)**:
   One entry per person, found by its `key`, listing every `<platform>:<senderId>` they use — the account, whichever of our bots or numbers it writes to — so the prompt identifies them when they speak. (Access stays per connection: the allow above names `whatsapp:main`.)
   ```toml
   [[people]]
   key   = "sam"
   name  = "Kak Sam"
   ids   = ["whatsapp:628111000001@s.whatsapp.net", "whatsapp:100000000000002@lid"]
   notes = "Sam, Alex's partner."
   ```

3. **Durable Context & Memory**:
   - Their notes in People: markdown, read by every agent whenever they are the one speaking — what to call them, who they are to whom. (`USER.md` did this until 0.7.0, for everyone at once; it is no longer read.)
   - Their memory profile, `people/sam.md` in the vault: with `[memory] facts = "auto"` (or `facts = "auto"` on their entry) the nightly pass keeps what they tell the agents there, and an agent keeps a fact at once with `memory_write` (`about = "person"`). Both survive `/new` and restarts, and are read only where they were said (`SPEC.md` §12).
