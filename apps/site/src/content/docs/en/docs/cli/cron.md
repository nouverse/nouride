---
title: Cron & webhooks
description: The scheduler from the command line, creating jobs, reading their history, and the guardrails.
---

The conceptual side of this is in the [manual](/en/docs/manual/schedule/). This page is the commands.

## Listing

```bash
nouride cron                     # scheduled and enabled
nouride cron --all               # including disabled
nouride cron runs <id>           # this job's history
```

## Creating

```bash
nouride cron add --name <name> \
  (--at 2h | --every 15m | --cron "0 9 * * *") \
  --gateway <id> --chat <id> --agent <id> \
  [--message <prompt> | --text <message> | --command <shell> | --mission <goal>] \
  [--then agent] [--session fresh|isolated|chat] [--tz <zone>] [--quiet] [--keep]
```

| | |
|---|---|
| `--at 2h` / `--at "2026-11-02 09:00"` | once, after a duration or at a time |
| `--every 15m` | an interval: `30s`, `15m`, `6h`, `1d` |
| `--cron "0 9 * * *"` | a crontab expression |
| `--tz <zone>` | which clock a `--cron` expression or an `--at` time is read in. Defaults to `[daemon] timezone` |
| `--gateway <id> --chat <id>` | where the result goes |
| `--agent <id>` | which agent runs it |
| `--message <prompt>` | wake the agent with this. One turn, with tools |
| `--text <message>` | plain text, no model call, no cost |
| `--command <shell>` | run a shell line, no model call |
| `--then agent` | …and wake the agent with what it printed. A run that prints nothing wakes nobody and sends nothing |
| `--mission <goal>` | run each time as a mission; `--check <command>` for one check, `--no-review` for no reviewer |
| `--session` | `fresh` (default, no history), `isolated` (its own thread), `chat` (the target chat's) |
| `--quiet` | record the run, deliver nothing, not even a failure alert |
| `--keep` | keep a one-shot after it fires: switched off, and listed as `fired` |

From a terminal, `--gateway`, `--chat` and `--agent` are required. An agent running this through the
`nouride` tool can leave them out: they default to the conversation it is in. With none of
`--message`, `--text` or `--command`, the job sends its own name.

`--command` is run through `sh -lc`, because an operator typing it means a shell line rather than an
argv. From an agent, a `--command` job always asks first: it runs later with no model and no gate.

### Examples

```bash
# A reminder. Costs nothing: no model is called.
nouride cron add --name standup --cron "0 9 * * 1-5" --tz Asia/Jakarta \
  --gateway telegram:nouva --chat 123456789 --agent nouva \
  --text "Standup in 15 minutes."

# A check with judgement attached.
nouride cron add --name disk --every 6h \
  --gateway telegram:nouva --chat 123456789 --agent nox \
  --command "df -h /" --then agent

# A job that remembers its own past runs, and nothing else.
nouride cron add --name inbox --cron "0 8 * * *" \
  --gateway telegram:nouva --chat 123456789 --agent nouva \
  --session isolated \
  --message "Check what came in overnight and tell me what needs me."
```

## Changing and running

```bash
nouride cron update <id> [--name …] [--at|--every|--cron …] [--tz <zone>] [--text|--message …] [--agent <id>]
nouride cron run <id>            # fire it now, and print the outcome
nouride cron enable <id>         # also clears a job disabled by its failure streak
nouride cron disable <id>
nouride cron rm <id>
```

`update` sends only the fields you name, so a new schedule keeps the name and the message.

## Webhooks

An endpoint that runs a job when something calls it.

```bash
nouride webhook                  # what exists, with URLs
nouride webhook add --name <name> --agent <id> --gateway <id> --chat <id> \
  [--message <prompt> | --text <message>] [--session fresh|isolated|chat] [--quiet]
nouride webhook rotate <id>      # issue a new URL; the old one stops working
nouride webhook test <id>        # whether a call from the internet arrives; the job is not run
```

A `POST` to the URL runs the job; add `?wait=1` to get the outcome back instead of a `202`. While the
job's last call is still running, another answers `409` and is not run. The
request body reaches the agent after `--message`, marked as untrusted data, so say in the message
what to do with it. Behind a proxy or a container port map, set `[dashboard] public_url`, or the
printed URL is the daemon's own address and reaches nobody from outside.

Use `nouride cron` for `rm`, `enable`, `disable`, `run` and `runs`: they are the same jobs.

**There is no `--command` for a webhook.** A webhook is reachable by anything that learns its URL, and
an endpoint that runs argv on the host is a remote shell with a long password.

## The guardrails

```toml
[cron]
enabled = true
min_interval_ms = 60000        # floor on a recurring schedule
max_jobs = 100                 # across every agent
fail_streak_limit = 10         # consecutive failures before a job disables itself
catchup_window_ms = 3600000    # how late an overdue job may still fire
run_retention_days = 3
command_timeout_ms = 600000
unattended_approval = "auto"   # auto | deny
```

`min_interval_ms` is not a performance guard. It is the difference between an agent scheduling a
check and an agent scheduling a loop of provider calls.

`catchup_window_ms` is why a daemon down for three days does not come back with three days of
reminders: outside the window a recurring job moves to its next occurrence and a one-shot is recorded
as missed.

`unattended_approval` decides what happens when a scheduled turn needs an approval nobody is there to
give. [Approvals →](/en/docs/manual/approvals/#when-nobody-is-watching)

## Background jobs are not scheduled jobs

`nouride jobs` lists work an agent started *during* a turn, a long build, a slow script.

```bash
nouride jobs
nouride jobs log <id>
nouride jobs kill <id>
```

`kill` stops the job and everything it started: SIGTERM to its process group, then SIGKILL after five
seconds, so a dev server started through `sh -c` stops with the shell instead of outliving it.

When one finishes it wakes the agent that started it, and `[agents] job_wake_max_chain` bounds how
many times that can happen with no human in between. One that prints nothing for
`[jobs] quiet_after_minutes` (5) wakes its agent to tell the chat it is still running, then again at
10, 20, 40 minutes and so on. Nothing is stopped for being quiet. `[security] job_max_ms`, off by
default, stops one still running after that long, as `kill` does, and tells its agent it did not
finish; a service is exempt.
