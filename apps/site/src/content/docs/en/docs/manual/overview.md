---
title: Day to day
description: What you actually do with Nouride once it is running, and where each thing lives.
---

The install is done and an agent answers. This is what the rest of the week looks like.

## Two interfaces, and they are for different things

**The dashboard is for anything an agent owns**: its personality, its model, its skills, who may
talk to it, what it has scheduled. It is a browser tab at `@@DASHBOARD_URL@@`.

**The CLI is for the daemon**: is it up, what is queued, what is in the audit log, restart this
gateway. It works over SSH and against a remote daemon.

Neither is a lesser copy of the other. The setup wizard and `nouride setup` drive the *same* code;
the skills page and `nouride skills` write the same file.

**Neither of them is how an agent works.** An agent acts through tools, each one typed, individually
gated, and audited by name. An agent that holds the `nouride` tool can run the same CLI you do (set a
reminder, check a gateway), but that tool only ever runs `nouride`, and every call goes through the same
gate and audit as `exec`. The agent never reads the control token itself.

## The things you will do

| | Where | Page |
|---|---|---|
| Talk to an agent | any chat app, the dashboard, or `nouride chat` | [Talking to an agent](/en/docs/manual/chatting/) |
| Answer "may I run this?" | the chat it asked in, or the dashboard | [Approvals](/en/docs/manual/approvals/) |
| Change how an agent behaves | dashboard → Agents → Files | [Persona packs](/en/docs/architecture/agents/) |
| Switch models | dashboard → Agents → Model | [Provider profiles](/en/docs/providers/configuration/) |
| Decide what it keeps learning | dashboard → Skills | [Skills & learning](/en/docs/manual/skills/) |
| See what it remembers | dashboard → Memory | [Memory](/en/docs/architecture/memory/) |
| Let someone in, or keep them out | dashboard → Settings → Access | [Who may talk to it](/en/docs/manual/access/) |
| Make something happen at 9am | dashboard → Work → Schedule, `nouride cron`, or just ask | [Scheduled work](/en/docs/manual/schedule/) |
| See what every agent is doing at a glance | dashboard → Agents → Office | [Office](/en/docs/manual/office/) |
| Have Claude Code or Codex answer an agent | dashboard → Agents → New Agent, or ask the orchestrator | [External agents](/en/docs/manual/external-agents/) |
| Check on it | `nouride status`, `nouride doctor` | [doctor](/en/docs/cli/doctor/) |
| Back it up, upgrade it | `nouride db backup`, `nouride update --start` | [Maintenance](/en/docs/manual/maintenance/) |

## The one directory

One install is one directory. This is the single most useful thing to know about operating it.

```
@@INSTALL_DIR@@/           (Linux)   ./nouride/   (Docker volume)
├── nouride                the binary
├── dashboard/             the web UI it serves
├── skills/                skills that ship with the daemon
├── .env                   credentials and per-host values (0600)
└── .nouride/
    ├── config.toml        everything structural
    ├── data/              SQLite, secrets, attachments, backups
    ├── agents/            personas and agent packs
    │   └── skills/        the skill pool - every agent draws from it
    ├── memory/            what the agents remember: conversations, people, shared facts
    ├── workspace/         what the agents produce
    │   └── private/<id>/  one agent's own folder: its HOME where it is its own user
    ├── home/              the daemon's HOME (ssh keys, CLI logins); the agents' too where they share its user
    ├── bin/               programs the agents install, first on their PATH
    └── lib/, opt/         what those programs need, and the Python env agents share
```

**Back up `.nouride/` and `.env`.** Everything else is a download. On a Linux service where
[each agent is its own user](/en/docs/architecture/overview/#each-agent-its-own-user), an agent's ssh keys, sign-ins
and own installs are in its `workspace/private/<id>/`, so `workspace/` there is more than output. On Docker, macOS or
without the helper they are in `home/`. The secret store's key stays out of both on purpose (0.8.19): keep a copy of
it apart, or set a backup password on the Secrets page. [Backup →](/en/docs/manual/maintenance/#backup)

## Five commands worth memorising

```bash
nouride status          # agents, gateways, queue: one screen
nouride doctor          # diagnose a setup that is not working
nouride logs -f         # live log; works with no journal, and against a remote daemon
nouride chat            # talk to an agent from the terminal, no bot token
nouride approvals       # what an agent is waiting on you for
```

They find their own install, so they work from any directory *on the install's machine*, see the
note about working directories in [troubleshooting](/en/docs/start/troubleshooting/#starting) if one of
them reports no daemon while one is running.

## Driving a remote daemon

Most commands talk to a running daemon over the control API. The few that do not, such as `setup`,
`doctor`, `policy` and `stop`, work on the install they are run in. Point the rest somewhere else with
two environment variables:

```bash
export NOURIDE_URL=https://nouride.example.com
export NOURIDE_TOKEN=<the contents of its data/.control-token>
nouride status
```

## What runs without you

Some things happen whether or not anyone is watching, and it is worth knowing which:

- **Scheduled jobs.** A job runs at the `balanced` approval level by default, so ordinary calls go
  ahead: a 3am job that stops at a prompt nobody will see has not run at all. Anything that deletes,
  takes something down, changes infrastructure or touches a credential is refused on the spot, and
  the agent says what it could not do.
- **Reconnects.** A gateway that drops backs off and retries. One that gives up entirely raises an
  alert, if you configured somewhere for alerts to go.
- **Catching up after a restart.** Messages that arrived while the daemon was down are answered if
  they were sent in the last 15 minutes, and a turn the restart cut off says what it had done.
- **Backups.** A snapshot of the database at boot and daily, and dated copies of the agent packs and
  the memory vault, all under `data/backups/`.
- **Retention sweeps.** Old conversations, audit rows, job runs and scratch files age out on the
  schedule in `[retention]`.
- **The nightly memory pass**, if you switched memory on.
- **Updates, on a Nouride Box.** It installs a new release by itself between 2 and 5 at night, while
  nobody is using it, unless you turn that off on **My Box**.
- **Nothing else.** An agent does not act unless a message, a job or a webhook wakes it.
