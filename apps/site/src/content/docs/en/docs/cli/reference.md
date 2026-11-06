---
title: Command reference
description: Every nouride command, grouped the way they are reached for.
---

```bash
nouride help              # the same list, from the binary itself
nouride <command> --help  # only that command's lines
nouride version
```

Two kinds of command, and the split matters:

- **`nouride start`** boots the daemon in this process.
- **Everything else** talks to a *running* daemon over the control API.

A CLI that booted its own daemon to answer `nouride status` would report on a process nobody is
using, and `nouride chat` would talk to a second copy with its own gateway connections, two Telegram
bots polling one token.

A handful of commands need no daemon at all: `help`, `version`, `setup`, `doctor`, `service`,
`policy`, `config`, `stop`, `db`, `users reset`, `pkg`, `tools run`, and `gateway rename`.

## Exit codes, `--json` and flags

| Exit code | |
|---|---|
| 0 | done |
| 1 | it failed: the daemon refused or could not be reached, or `doctor` found a problem |
| 2 | it was asked wrongly: an unknown command or action, a flag or a word the command does not take, a missing or malformed argument |

Any command takes `--json` and prints one object on stdout instead of lines,
`{"ok": …, "data": …, "error": …, "hint": …}`, where `data` is what the command answered with. `chat`,
`start`, `setup` and `logs -f` keep the terminal rather than answering once, and refuse it.

A flag's value goes after it or after `=`: `--limit 5` is `--limit=5`. After a bare `--` nothing is a flag,
so `nouride policy check -- ls --help` asks about `ls --help`. A secret is read from stdin with `--stdin`.

The old spellings 0.7.x still read are refused since 0.8.0, exit 2, naming what to write instead:
`--value-stdin`, `--key-stdin` and `--token-stdin` are `--stdin`; `--isolated` is `--session isolated`;
`approvals approve` is `approvals allow-once`; `people forget` is `people remove`.

A flag a command does not read is refused, exit 2, and since 0.7.11 so is a word it does not read:
`reload` after `nouride agents` used to be dropped, and the agents listed; now it is refused before anything is
asked of the daemon, and pointed at `nouride agent reload`, the command that takes it.

:::note[How an agent reaches the CLI]
An agent that holds the `nouride` tool can run these commands through it, and only through it: `exec`
refuses this install's own binary. The tool always runs this install's binary from the install
directory, so the agent never reads the control token, and every call goes through the same gate as
`exec`: approvals, grants and the fixed list still apply. An agent can be given the daemon's
control surface without being given a general shell.
:::

## Where it looks

The CLI finds the install the way the daemon does: `$NOURIDE_CONFIG`, then `$NOURIDE_HOME`, then the
working directory, then the directory the binary is installed in. So an installed `nouride` works
from any directory, and a directory with its own `.nouride/` or `config.toml` wins over it. It reads
`data/.control-token` from that install for auth. Two environment variables point it somewhere else
entirely:

```bash
export NOURIDE_URL=https://nouride.example.com
export NOURIDE_TOKEN=<contents of that box's data/.control-token>
```

---

## Running the daemon

```bash
nouride start                     # run the engine in this process
nouride stop                      # stop this install's daemon (no token needed)
nouride restart                   # restart once nothing is running; --now does not wait
nouride restart --wait            # and return once it is back; exit 1, saying why, if it is not
```

`stop` is the one command that reaches the daemon without the control API: it reads the lock file and
sends a signal, which is the path that still works when the HTTP server is what has wedged.

`restart` waits the way `update --start` does: until no turn is running or queued and no approval is
pending, for ten minutes at most, and until no background job is working, however long that takes.
It names the jobs it is waiting for. `--now` restarts at once and stops them. The dashboard's
**Restart** on Overview and `/daemon-restart` in a chat do the same.

An agent must pass `--then "<follow-up>"` (or `--no-then`). The command ends the conversation it was
run from, so the follow-up turn is created *before* the service goes down, and a restart that goes
wrong is still met by whoever asked for it. The follow-up fires `--in` seconds (default 10) after the
restart itself, not after the command. Run by an agent, it comes back to the same conversation; from a
terminal, name it with `--gateway`, `--chat` and `--agent`. A person at a terminal needs neither flag.

With nothing supervising the daemon, `restart` refuses rather than silently stopping you. `--force`
stops it anyway.

`--wait` follows the restart through `/health`: still finishing what runs, stopped, starting and on which step,
back. It gives up after twelve minutes, and says so differently when the old process is still finishing a
background job, which has no time limit, than when the new one did not come back.

## Setting up

```bash
nouride setup                     # interactive
nouride setup --yes --provider anthropic --api-key-from-env ANTHROPIC_API_KEY --agent nouva
```

Flags: `--provider`, `--base-url`, `--api-key-from-env`, `--agent`, `--name`, `--model`, `--prompt`,
`--headline`, `--config`, `--yes`. There is deliberately no `--api-key`.
[First run →](/en/docs/start/first-run/#doing-it-over-ssh-instead)

## Looking at it

```bash
nouride status                    # one screen: agents, gateways, queue
nouride doctor [--fix]            # diagnose a setup that is not working; --fix narrows a secret's file mode
nouride logs [-n N] [-f] [--level <level>] [--component <name>]   # the daemon's own log: works with no journal, and remotely
nouride audit [limit]             # recent audited actions
nouride sessions [limit]          # stored conversations
nouride turns [--agent <id>] [--limit N]   # the newest turns, with what each cost
nouride turns show <id>           # one turn whole: every model call (tokens, cost, latency, retries), steps, tool calls
nouride events [--turn <id>] [-f] # what turns do as it is written: steps, the answer, tool calls, model calls
nouride jobs                      # what runs, and the last five ended
nouride jobs --all                # every job kept
nouride jobs log <id>
nouride jobs kill <id>
nouride mission                   # missions: needs you first, then what runs, then the last five ended
nouride mission show <id>         # one in full: goal, checks, checklist, limits, report
nouride mission stop|continue|accept <id> [text]
nouride mission answer <id> <answer>
nouride mission tell <id> <words> # words for it while it works: read before its next step
nouride mission delete <id>       # an ended one gone: its conversation, checklist and own folder (--force: work nobody committed too)
```

## Talking to it

```bash
nouride chat [agent]              # interactive chat, no bot token needed
```

## Agents

```bash
nouride agents                    # list: waiting for you, working, asleep or idle
nouride agents scan               # the coding CLIs this box has for external agents, with their versions
nouride agents login <id>         # sign an external agent's CLI in: run on the box, answered here
nouride agent sleep <id>          # takes no work until wake, through a restart too (pause works too)
nouride agent wake  <id>          # (resume works too)
nouride agent reload <id>
nouride agent enable  <id>        # written to config.toml, so it survives a restart
nouride agent disable <id>
nouride agent external <id> <cli> [--profile <name>]   # a coding CLI answers it instead of its model
nouride agent internal <id>       # its model answers it again
nouride acp [--agent <id>]        # an agent in Zed or another ACP editor; the editor runs this
```

`agents scan` looks again each time, and prints each CLI with the command Nouride starts and that command's version:
the ACP adapter's (`claude-agent-acp 0.97.0`), not the CLI's own. `agents login` runs the CLI's sign-in on the box, in
that agent's own profile, and shows here what it prints; a line you type is its next input, and Ctrl-D stops it.
`agent external` and `agent internal` are an admin's, as signing in is. `acp` is started by an editor, not typed: it
speaks the Agent Client Protocol on stdin and stdout, and without `--agent` the orchestrator answers.
[External agents →](/en/docs/manual/external-agents/)

## Gateways

```bash
nouride gateway [list]
nouride gateway restart <id> --then "<follow-up>"   # or --no-then, watching it yourself
nouride gateway add --platform <p> --name <n> --agent <id> --stdin
nouride gateway rm <id>
nouride gateway rename <old> <new> [--apply]     # daemon must be STOPPED
```

`gateway restart` follows the same rule as `nouride restart`: restarting the gateway a conversation
arrived on ends it, so the follow-up is created first. `gateway add` with no flags prints the rest
(`--token-secret`, `--session-dir`, `--disabled`); the new gateway connects on the next restart.

`rename` rewrites both the config and the database the daemon has open, which is why it refuses to
run while the daemon is up, and why it is the one gateway command that does not go through the
control API. Without `--apply` it only reports what it would change.

## Database snapshots

```bash
nouride db backup                # take one now, verified before it is kept
nouride db list                  # newest first
nouride db verify [file]         # check a snapshot, or the live database
nouride db restore <file>        # daemon must be STOPPED
nouride db adopt                 # accept this build's schema for this database; daemon STOPPED
```

A bare `nouride db` prints these lines and exits 0, as a bare `nouride config` does (since 0.7.11).

The daemon takes one weekly, and at boot unless the newest is under a week old, keeping
`backup_keep` of them under `data/backups/db/`, or under `[daemon] backup_dir`, which `list` and
`restore` read as well.
These are local rather than API calls, and grouped on purpose: `restore` replaces the file a running
daemon holds open, so it cannot go through the control API, and splitting the group would mean the
one command that matters at three in the morning behaved unlike the ones beside it.

A snapshot is a single ordinary SQLite file, so recovery does not need this command at all. What
`restore` adds is refusing to run while the daemon is up, and moving the database it replaces to
`nouride.db.replaced-<timestamp>` so the wrong choice is undoable. A snapshot from an older version
belongs to that version: install it before starting, or this build upgrades the database again.
One from before 0.8.0 is refused, with nothing changed (since 0.8.1): this version does not start on it.
0.8.0's `restore` puts it back, and starting 0.8.0 once brings it forward.

`adopt` answers one boot refusal: the migrations applied to the database are not the ones in this
build. Run it only when this build is the right one, after a squash for example; the refusal names
the other ways out.

## A lost first password

```bash
nouride users reset              # every dashboard account removed; daemon must be STOPPED
```

Since 0.7.11. It snapshots the database, empties the account table and records the reset in the audit
log, then names the snapshot (`nouride db restore` puts it back) and each account it removed. The next
start creates the first admin again and prints its password, or takes `INITIAL_ADMIN_USERNAME` and
`INITIAL_ADMIN_PASSWORD` from the install's `.env` when both are set. Like `db restore`, it refuses while
a daemon runs on this data directory.
[FAQ: I missed the first-run password →](/en/docs/reference/faq/)

## Providers and secrets

```bash
nouride provider [list]
nouride provider add <name> --kind openai|anthropic --url <base> --stdin
nouride provider rm <name>

nouride secret [list]             # names and what each is for: values are never printed
nouride secret set <name> --stdin [--field name=text]
nouride secret field <name> name=text [--remove name]
nouride secret rm <name>
nouride secret seal --stdin       # the backup passphrase: config snapshots hold the secrets, sealed to it
nouride secret seal --off         # keep the secrets out of the snapshots
nouride secret unseal <file> --stdin --out <path>
nouride secret restore [<file>] --stdin    # the secrets back from a sealed copy: a lost key, a moved install
nouride secret decrypt --out <path>        # the store as a version before 0.8.19 reads it, for the way back
```

`provider add` checks the key against the endpoint before saving; `--no-probe` skips that. With no key
it uses one already stored as `<name>_api_key`. `secret rm` deletes a secret everywhere: it goes from
every agent's `exec_secrets` too, unless the environment still sets it.

`--value <v>` exists, and so do `--key` and `--token`, and the CLI says what they cost: the value ends
up in your shell history and in the audit log.

`--field` and `secret field` (0.8.19) say what a secret is for: its site, the username or email it goes with, what
uses it, under names of your own. `--field` repeats, one per field; `secret field` sets several at once and `--remove`
takes one off, the value left as it is. What they say is not secret: `nouride secret`, the dashboard and the agents
show it beside the name, and a text shaped like a key or a password is refused.

`secret seal` (0.8.18) reads a passphrase of twelve characters or more on stdin and keeps only what seals to it, then
takes a config snapshot at once so you can check that it opens; the dashboard's Secrets page sets the same backup
password. Keep the passphrase somewhere other than the box: nothing on it can open the snapshots. `secret unseal` opens
a snapshot's `secrets.sealed` into a file at 0600. It needs no daemon, never prints a value, and never writes over a
file that is there.

`secret restore` (0.8.19) puts the secrets back from a copy sealed to that passphrase, `data/secrets.sealed` unless you
name a snapshot's, encrypted under this install's key: for a lost key, or an install moved without it. Run it with
Nouride stopped; a store it could not open is kept aside, never written over. `secret decrypt` (0.8.19) writes the
store as a version before 0.8.19 reads it, for the way back to one. Both run on the machine with no daemon. On Linux
run them as root (`sudo nouride …`): the store's key is root's file, and the launcher hands it to the CLI.
[Backup →](/en/docs/manual/maintenance/#backup)

## Approvals, grants and policy

```bash
nouride approvals                              # what is waiting
nouride approvals allow-once   [id]
nouride approvals allow-always [id]
nouride approvals deny         [id]

nouride grants [--all]                         # standing command permissions; --all adds revoked ones
nouride grants revoke <id|--all> [--agent <id>]

nouride policy                                 # what always asks, and what never does
nouride policy check <command…>                # would this be gated? Answers without running it
```

`policy check` works while the daemon is down, which is exactly when somebody is debugging a
refusal.

## Access and people

```bash
nouride access [pending|approved|denied|blocked]  # who may talk to the agents
nouride access approve <code> [--me | --as <key> | --new "<name>"]
nouride access allow <gateway:sender> [--name "<name>"]  # in before they ask, under Approved
nouride access deny|block <gateway:sender>       # no for a day · no until unblocked
nouride access revoke|reset|unblock <gateway:sender>
nouride access mode [open|allowlist|pair]      # show or switch, no restart

nouride people
nouride people set <key|platform:account> --name <name> [--note <note>]
nouride people remove <key|platform:account>
```

`approve` can also say who the sender is, so every agent knows them by name: you (`--me`), somebody
already known (`--as <person key>`), or someone new (`--new "<name>"`).

`deny` ignores them for a day (`[security.access] deny_cooldown_ms`), then a message from them is a
new request; `reset` ends that wait now. `block` lasts until `unblock`. Each answers only its own
state (`deny` a pending request, `revoke` an approval, `reset` a denial, `unblock` a block), so
`revoke` or `deny` on a blocked sender is refused rather than lifting or softening the block.

## Scheduling

```bash
nouride cron [--all]
nouride cron add --name <n> (--at 2h | --every 15m | --cron "0 9 * * *") \
  --gateway <id> --chat <id> --agent <id> [--message <prompt> | --text <msg> | --command <sh> | --mission <goal>] \
  [--then agent] [--session fresh|isolated|chat] [--tz <zone>] [--quiet] [--keep]
nouride cron update <id> [--name …] [--at|--every|--cron …] [--tz <zone>] [--text|--message …] [--agent <id>]
nouride cron run|runs|enable|disable|rm <id>

nouride webhook
nouride webhook add --name <n> --agent <id> --gateway <id> --chat <id> --message <prompt>
nouride webhook rotate <id>                    # new URL; the old one stops working
nouride webhook test <id>                      # whether a call from the internet arrives
```

Webhooks are the same jobs, use `nouride cron` for `rm`, `enable`, `disable`, `run` and `runs`.
[Cron & webhooks →](/en/docs/cli/cron/)

## Skills

```bash
nouride skills [agent] [-v]       # what an agent is offered, and when each was last read
nouride skills --all              # the whole pool: who has it on, and missing software
nouride skills on|off <skill> <agent>
nouride skills search <query>     # skills.sh, ClawHub and well-known indexes
nouride skills install <source>   # owner/repo, a URL, clawhub:slug… - arrives as a draft
nouride skills drafts             # what the agents have proposed
nouride skills draft <id>         # one draft in full, with the turn it came from
nouride skills approve|deny <id>
```

## Memory

```bash
nouride memory                                 # the nightly pass, facts, search: current settings
nouride memory set <key> <value>               # pass | pass_at | pass_per_night | pass_model | facts | …
nouride memory episodes [words] [--agent <id>] [--person <key>] [--tag <tag>] \
  [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--status raw|summarized|compacted] [--limit N]
nouride memory show <episode>                  # one conversation, whole
nouride memory pass                            # run the nightly pass now
nouride memory proposals                       # what the pass proposed and waits for you
nouride memory approve|deny <id>
nouride memory changes [--person <key>]        # what memory changed, and why
nouride memory failed                          # conversations the pass could not file
nouride memory retry [<episode>]               # try those again on the next pass
nouride memory undo <person|shared>            # put a profile back one version
nouride memory forget <person> [--anonymize]   # remove a person for good, or only hide their name
nouride memory tags                            # tags by use, and how many are on one conversation only
nouride memory tags tidy [--apply] [--only merge,trim,cap,R5]   # preview the tidy; --apply does it (R5 only when named)
nouride memory tags suggest                    # the model's view of tags that mean one subject, not applied
nouride memory tags merge <tag…> --into <tag>  # a hand merge, recorded like a tidy
nouride memory tags undo                       # put the newest tidy back
nouride memory reindex                         # rebuild the index from the vault
nouride memory embed                           # vectors for semantic search
```

`pass_model` takes `<provider>/<model>`, and `-` puts it back on each agent's own. It also summarizes long
conversations unless `[llm.context] summary_model` is set; `nouride doctor` says when it failed.
[Memory →](/en/docs/architecture/memory/)

## Budgets

```bash
nouride tool-budget                            # tool round-trips one reply may spend
nouride tool-budget <n>                        # the daemon default
nouride tool-budget --agent <id> <n|follow>
nouride turn-budget                            # seconds one reply may take
nouride turn-budget <seconds>
nouride turn-budget --agent <id> <seconds|follow>
```

## MCP

```bash
nouride mcp                                    # the library, the agents each server is on for, their tools
nouride mcp add --name <name> (--command <exe> | --url <url>) [--stdin] [--agent <id> …]
nouride mcp enable|disable <name> --agent <id> # one agent's switch; --env-secret, --stdin or --own-login give it its own credential
nouride mcp tools <name> --agent <id> [--only <tool,…> | --all]   # which of its tools that agent gets
nouride mcp rm <name> [--agent <id>]           # out of the library, or with --agent only off for that agent
nouride mcp login|logout --server <name> [--agent <id>]
```

A server is added once, to the install's library, and switched on per agent (since 0.7.19); each change reloads the
agents it reaches, so nothing restarts. `mcp add` with no flags prints the rest: `--arg` (once per argument), `--cwd`,
`--sse`, `--header`, `--env-secret`, `--per-agent` and `--from`.

Nouride can also be an MCP server for other tools (Claude Code, Cursor), serving memory as a person:

```bash
nouride mcp-server                             # on/off, and the tokens issued
nouride mcp-server on|off
nouride mcp-server token create --person <key> --agents <id,id> --label <client> \
  [--scopes memory,memory:write,personas] [--ttl <days>]
nouride mcp-server token list|revoke <id>
```

A token stops working after `--ttl` days, 90 unless you say otherwise; `--ttl 0` never expires. One made
before 0.7.10 has no end: revoke it and make another to give it one.

## Configuration

```bash
nouride config check [file]       # would this configuration start? Nothing is launched
nouride config schema [section]   # every valid key, as JSON Schema
nouride config explain <path>     # e.g. nouride config explain security.web.search_endpoint
```

`check` exits 1 when an enabled agent pack will not load (since 0.7.11): the daemon would start, but
without that agent, so each one is named with why. A disabled pack that would not load is said and
fails nothing.

## Updating

```bash
nouride update [--check]                       # this version and edition, and whether a newer one exists
nouride update --track latest|lts              # which releases this install is offered, then a check
nouride update --start                         # download, verify, swap, restart
nouride update --start --now                   # the same, restarting at once
nouride update --start --then "<what to check after>"   # the same, from an agent
nouride update --start --wait                  # and return once the new version answers
nouride update --rollback [--apply]            # the version before this one, back (daemon stopped)
```

Reporting is the default and touches nothing. `--start` restarts once nothing is running, waiting
the way `restart` does: ten minutes at most for a turn or an approval, a background job until it
finishes. `--now` does not wait. From an agent, `--start` always asks first and needs `--then`.

`--rollback` says which build it would put back and whether the database goes back with it, to the
snapshot the update took before migrating, and what that loses. `--apply` does it, and is refused
while the daemon runs. [Updating](/en/docs/deployment/updating/#if-the-new-version-is-wrong) has the rest.

## System packages

```bash
nouride pkg                                    # on or off, and which package manager
nouride pkg check <install|remove|upgrade> <name…>   # what it would change, changing nothing
nouride pkg install|remove <name…>             # from this host's repositories
nouride pkg upgrade [name…]                    # no names: everything with an update
nouride pkg refresh                            # the package lists
```

Through the root service `nouride-pkg`: on a host set up with `install.sh --allow-packages` and off otherwise, in
Nouride's Docker image on unless `NOURIDE_SYSTEM_PACKAGES=off`. It refuses anything outside its rules. For an agent,
`install`, `remove` and `upgrade` ask every time, unless its approval level is `trusted`. See [System packages](/en/docs/deployment/system-packages/).

## Programs every agent runs

```bash
nouride tools run -- <installer…>              # e.g. sudo nouride tools run -- npm i -g @agentclientprotocol/codex-acp
```

Runs an installer as the daemon's user, with no daemon needed, pointed at `.nouride/bin`, `lib` and `opt`, then makes
what it installed every agent's to run. It runs an installer and nothing else (`npm` or `bun` with `-g`, `pipx`,
`uv tool`, `pip`, `cargo`, `go install`, `rustup`, `claude update`) and refuses a flag that would put the program
somewhere else, or a path in any word. Where [each agent is its own user](/en/docs/architecture/overview/#each-agent-its-own-user),
this is the one way the shared programs change: what an agent installs itself lands in its own HOME. An agent reaches
it only as the orchestrator, through the `nouride` tool, and it asks a person every time, at every approval level.

## The service unit

```bash
nouride service status                         # which supervisor this process runs under
nouride service install --user <u> [--dir <path>] [--kind systemd|launchd|procd] [--exec <path>] [--privileged]
nouride service uninstall [--kind systemd|launchd|procd]   # prints how to remove it
nouride service diff                           # the installed unit against the one this version writes
```

`install` **writes** the unit file next to your install and prints the commands to activate it. It
does not install or enable anything itself: enabling a system service is a privileged, host-changing
action, and a CLI you cannot safely run to see what it would do is a CLI you end up not running.
`install.sh` writes its unit with this same command. `--kind procd` is OpenWrt's: it writes
`nouride.init` for `/etc/init.d/nouride`, needs `--privileged` because procd runs it as root, and is
picked by itself where `/sbin/procd` exists.

`diff` compares the installed systemd unit with the one this version would write, directive by
directive. An update replaces the binary, never the unit: re-run `install.sh` to rewrite it, and
`nouride doctor` says when that is due.

It refuses to generate a unit that runs as **root**, unless you pass `--privileged`: that drops the
systemd sandbox so the agent can manage this host, and is meant for a machine dedicated to it.
