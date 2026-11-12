---
title: Automations
description: Work that runs without anyone typing, on a schedule, when a webhook is called or when you start it, as one thing or as steps in a fixed order.
---

An automation is work that runs when nobody is talking to an agent. It has a **start**, which says when it runs,
and its **steps**, which say what it does.

| It starts | |
|---|---|
| **On a schedule** | a crontab expression (`0 9 * * *`), an interval (`15m`, `2h`), or once, at a time |
| **When called** | a webhook: when its URL is called, rather than on a clock |
| **By hand** | when you press **Run now** |

![The Schedule page](/media/dashboard-schedule.png)

The dashboard's **Automations** page (Work → Automations) lists them all, whatever starts them, with one
dropdown to see only the scheduled ones, the webhooks or the ones started by hand. It is where you make, change, run,
pause and delete them. Or just ask an agent: "remind me to check the deploy in two hours". It
[proposes](#asked-of-an-agent) the automation, and you turn it on.

The list is for the whole install rather than per agent, even though every automation has an owner, because you
usually want to see everything that runs on its own at once.

## Steps

An automation does one thing, or several in a fixed order. Each one is a step:

| A step | What it does | Does it call a model |
|---|---|---|
| **Send a message** | sends text as written to the automation's chat | no |
| **Ask an agent** | one turn of the automation's agent, or of another agent you pick | yes, one turn |
| **Run a command** | runs a shell line in the agent's workspace | no |
| **Start a mission** | long work that is checked; the run waits for it | yes, as a [mission](/en/docs/manual/missions/) does |
| **Wait for your OK** | asks a person, and goes on when they say so | no |

Nouride runs the steps in that order, every time. Each step is handed what the one before it said, and an agent does
only the step it is given: it does not skip ahead, reorder the list or decide what comes next. That is the
difference from a [mission](/en/docs/manual/missions/), where the agent plans the work itself. The words of the last
step are what the automation sends to its chat.

On the automation's page the steps are cards in the order they run. Press a card to change it, press the plus
between two cards to add a step, and drag a card to move it. Nothing changes until you press **Save**.

### Where a run goes next

Each step can say where the run goes when it is done, when it failed, and when it had nothing to say: on to the next
step, to the end, or to a later step. A run only ever goes forward, so it always ends.

Left as they are, a step that is done goes on to the next one, a step that failed ends the run as failed and says so
in the chat, and a step with nothing to say (a command that printed nothing, an agent with nothing to report) ends the
run quietly. So a check that finds nothing wakes nobody.

A shop check, for example:

1. **Run a command**: `curl -sf https://shop.example.com/health`. Once done: end here. If it fails: go on.
2. **Ask an agent**: "The shop is down: find out why."
3. **Wait for your OK**: "Restart the shop?"
4. **Start a mission**: "Restart the shop and confirm it answers."

While the shop answers, the run ends at step 1 and no model is called. When it does not, the agent looks into it,
you are asked, and only with your yes is anything restarted.

### A mission in the middle

A mission can be any step. The run waits for it to end, however long that takes and across a restart of Nouride, and
hands its result to the next step. A mission that failed or was stopped is a failed step, so the automation can
go on to a step that tells you about it.

### A step that waits for you

The automation's chat gets a card with the question, what the step before said, and two buttons, **Continue** and
**Stop**. The same question is on the dashboard, under **Waiting for you** and on the automation's own page. Continue
hands what the step before said to the next step. Stop, or no answer in the time the step allows (a day unless you
set another, from five minutes to seven days), ends the run there: nothing after it runs, and it is not reported as
a failure. In a one-to-one chat the person in it answers; in a group, whoever turned the automation on, or an admin.
No model is called while it waits, and the wait survives a restart.

Where a chat has no buttons, as on WhatsApp, the card says to answer on the dashboard.

### One run at a time

While a run waits, for a mission or for you, the automation starts no other run: its next time is counted from when
that run ends, and **Run now** says what it is waiting for.

## From the CLI

```bash
nouride cron                     # what is scheduled and enabled
nouride cron --all               # including disabled ones
nouride cron run <id>            # fire it now
nouride cron runs <id>           # its history, with how each step went
nouride cron continue <run id>   # say yes to a run whose step waits for a person
nouride cron stop <run id>       # or stop it there
nouride cron enable|disable <id>
nouride cron rm <id>
```

### Creating one

```bash
nouride cron add --name "morning-brief" \
  --cron "0 9 * * *" --tz Asia/Jakarta \
  --agent nouva \
  --gateway telegram:nouva --chat 123456789 \
  --message "Summarise anything that changed overnight and anything waiting on me."
```

| Flag | |
|---|---|
| `--name` | what it is called |
| `--cron "0 9 * * *"` / `--every 15m` / `--at 2h` / `--manual` | pick exactly one. `--manual` has no time: it runs when somebody starts it |
| `--tz <zone>` | which clock the schedule is read against |
| `--agent <id>` | which agent owns it. From an agent's own call, that agent |
| `--gateway <id> --chat <id>` | where the result goes. Needed from a terminal; from an agent's own call, its conversation |
| `--message <prompt>` | wake the agent with this |
| `--text <message>` | deliver plain text instead. No model call, no cost |
| `--command <shell>` | run a command. No model call |
| `--then agent` | …and wake the agent with what it printed, when it printed something |
| `--mission <goal>` | run each time as a mission. With `--check <command>` for one check, `--no-review` for no reviewer; more checks from the dashboard |
| `--steps <file.json>` | several of these in a fixed order: the list, as JSON (below) |
| `--session <fresh\|isolated\|chat>` | what history the turn sees |
| `--quiet` | deliver nothing, failures included; the result stays in `nouride cron runs` |
| `--keep` | keep a one-shot after it fires: switched off, and listed as `fired` |

`nouride cron update <id>` takes `--name`, the schedule flags, `--tz`, `--text`, `--message`, `--steps` and
`--agent`.

A list of steps is written in a file, since it does not fit a command line. Each step has a `kind` and what that kind
needs, and may say where the run goes from it (`then`, `whenFailed`, `whenEmpty`: `"next"`, `"end"`, or the number of a
later step). The shop check above:

```json
[
  { "name": "Check the shop", "kind": "command", "argv": ["sh", "-lc", "curl -sf https://shop.example.com/health"], "then": "end", "whenFailed": "next" },
  { "kind": "agentTurn", "message": "The shop is down: find out why." },
  { "kind": "approval", "ask": "Restart the shop?" },
  { "kind": "mission", "goal": "Restart the shop and confirm it answers." }
]
```

```bash
nouride cron add --name "shop-check" --every 10m --steps shop-check.json \
  --agent nouva --gateway telegram:nouva --chat 123456789
```

The other kinds are `systemEvent` (a message, with `text`). `agentTurn` and `mission` take an `agentId` for another
agent, and `approval` a `timeoutMs`. Nouride reads the file and refuses a step it cannot run, naming it.

### Four kinds of job, and the cost of each

**`--text`** is a plain reminder. Nothing calls a model, so it costs nothing. Reach for it whenever
the message is the whole point.

**`--command`** runs a shell line and delivers the output. Also no model call. `--then agent` adds
one: the agent reads the output and reports on it, which is the difference between "here is the disk
usage" and "the disk is filling up, here is what is eating it". A run that prints nothing sends nothing,
and with `--then agent` wakes nobody: a check that prints only when something is wrong costs nothing
while all is well. A command that fails still says so in the chat.

**`--message`** wakes the agent with a prompt. One turn, with tools, at the usual cost.

**`--mission`** starts a [mission](/en/docs/manual/missions/) every time it fires: long work that
outlasts a turn. It survives a restart, asks in the job's chat when it needs someone, and counts as
done once its checks pass and the reviewer agrees. Nobody accepts each run, since whoever made the job
accepted the work then. One runs at a time: a run due while the last one still works is recorded as
skipped. The reviewer costs about a turn a run, so a job whose checks are the whole answer can do
without it. A webhook's body reaches the run's page as data, never as an instruction. Its chat hears
when a run is done, needs someone or ends, not that it started on schedule.

### What history the turn sees

`--session` is the setting people most often want and least often find.

| | |
|---|---|
| `fresh` (default) | no history. The agent starts clean every time |
| `isolated` | a private, persistent thread for this job, it remembers its own past runs, and nothing else |
| `chat` | the target chat's own conversation, as if you had typed the prompt there |

## Asked of an agent

Ask in a chat ("every Monday at 9, sum up the customer mail for the team") and the agent
**proposes** the automation with its `schedule` tool: one thing, or a list of steps with where each sends the run. It
writes the whole of it, keeps it switched off, and posts a card in the chat, each step on a line of its own:

```
📋 nouva proposes a scheduled job: Customer mail
When: cron `0 9 * * 1` (Asia/Jakarta)
Does: a mission for nouva: "Sum up last week's customer mail for the team.", then a reviewer agrees
Results: here
It stays off until somebody turns it on.          [Turn on] [Discard]
```

Nothing runs until someone answers. **Turn on** starts the schedule, and its missions run as the
person who pressed it. **Discard** throws the proposal away. In a one-to-one chat the person in it
answers; in a group, the person who asked or an admin. Where a chat has no buttons, as on WhatsApp,
the card names the commands: `/schedule on <id>` and `/schedule discard <id>`. The Automations page
lists proposals with the same two buttons, and a card answered there says so in the chat.

The agent never turns a job on itself, widens one or edits one that runs. A change is a new proposal
that names the job it replaces; turned on, that job takes the new shape and keeps its id, its runs
and its webhook URL. On the automation's page the change waits as **Suggested**, with what it adds, changes and
removes, and **Accept** and **Discard**. An agent that runs `nouride cron add`, `update` or `enable`, or `webhook add` or
`rotate`, is refused and pointed back at `schedule`. At most ten proposals of one agent wait at once, counted by the
agent that proposed them.

Only a person answers a proposal, never an agent. Some are an admin's to turn on, whoever asked: a change to another
agent's job, a change to a job that reports to another chat, and a webhook, as making one is. What the old job was
allowed always does not carry over to its new shape: it asks again.

## Webhooks

An endpoint that runs a job when something calls it.

![A webhook: its URL, how to call it, what it runs and where the reply goes](/media/dashboard-webhooks.png)

```bash
nouride webhook                  # what exists, and its URL
nouride webhook add --name "deploy-finished" \
  --agent nouva \
  --gateway telegram:nouva --chat 123456789 \
  --message "A deploy just finished. Check the health endpoint and report."
nouride webhook rotate <id>      # issue a new URL; the old one stops working
```

Use `nouride cron` for `rm`, `enable`, `disable`, `run` and `runs`: they are the same jobs.

There is deliberately **no `--command` for a webhook**. A webhook is reachable by anything that
learns its URL; an endpoint that runs argv on the host is a remote shell with a long password.

Each call is counted on its card as a delivery, and a hook whose calls fail `fail_streak_limit` times
in a row pauses itself, as a scheduled job does. **Run now** runs the job by hand, without a body: it
is not counted as a delivery.

### Reaching a webhook from the internet

GitHub, Stripe and the like call a webhook from the internet. Most boxes sit behind a home router, where
that call never arrives unless something lets it in. A webhook's own page says which case it is
in:

| | |
|---|---|
| **Local network only** | No public address is set (`[dashboard] public_url`), or the one set is on this network: a `192.168.…` address, a `.local` or `.lan` name, a name with no dot. Only devices on this network can call it |
| **Reachable from the internet** | A test sent through the public address reached the daemon |
| **Reach unknown** | A public address is set, and no test through it has arrived: none was sent, or the last one did not arrive |

**Send a test** (`nouride webhook test <id>`) posts to the hook through its public address, marked as
a test. The daemon counts it when it arrives and does not run the job. The card then says how long it
took, or what happened instead: the name does not resolve, the connection was refused, or something
else answered at that address.

To give the box a public address, either:

- run a **tunnel**, such as Cloudflare Tunnel or Tailscale Funnel. The box connects out, so nothing
  changes on the router. Set `public_url` to the address the tunnel gives you; or
- **forward a port** on the router to the box's port (18254), preferably through a reverse proxy
  that serves HTTPS.

A test through a forwarded port can fail from the box itself while calls from outside arrive: many
routers do not send a request from inside back in through their own public address. A call from
outside settles it. A tunnel does not have this problem.

A name that does not resolve from the box is a different matter: the internet most likely cannot find it either. A name
only the router's DNS or Tailscale's knows works at home and nowhere else. Give it a public DNS record, or use the
tunnel's address.

A chat already reaches the box from anywhere, since Telegram, Discord and WhatsApp are connections the
box makes outwards. Anything that can post to one of them can start an agent without a webhook.

## The morning line

Once work runs on its own, there needs to be a way to know what happened without opening the
dashboard. A **morning line** is one message a day, at a time a person sets, to their own chat:

```
☀ Since yesterday morning

Needs you · 1
• nox asks to run exec

Scheduled runs failed · 1
• Customer mail (the provider was down)

Missions done · 2
• Sum up the mail
• Check the backups

Spent in the last day · $1.20
• nouva on gpt-5: $0.80
• nox on qwen3: $0.40
```

It is off for everyone until it is turned on: the People page has a switch per person, which starts at
07:00 and takes any time, in `[daemon] timezone`. In their file, `people/<key>.toml`, it is `morning = "07:00"`.
The daemon writes it from what it keeps, so it costs no tokens. It covers scheduled runs that failed,
approvals and missions waiting on that person, and missions that finished or ended, all from the last
day. Each person hears about their own chats, the jobs they turned on and the missions they started;
an admin hears about all of it, and what was spent. **A quiet morning sends nothing**, so silence
means everything ran. It goes where the person picks beside the time on the People page: one of their
Telegram, Discord or WhatsApp accounts (`morning_to = "telegram:555"`), or, until they pick, to the
account they last wrote from; if that connection is down, to the next of theirs that is up. A line due
while the daemon was down comes within the hour after its time, or not that day.

## Guardrails

These exist because a model that can create jobs can create them in a loop. All are under `[cron]`,
except `job_wake_max_chain`, under `[agents]`.

| | |
|---|---|
| `min_interval_ms` (60s) | the floor on a recurring schedule. The difference between an agent scheduling a check and an agent scheduling a loop of provider calls |
| `max_jobs` (100) | across every agent |
| `fail_streak_limit` (10) | consecutive failures before a job disables itself and says why. `nouride cron enable <id>` clears it |
| `catchup_window_ms` (1h) | how late an overdue job may be and still fire when the daemon comes back. Outside it, a recurring job moves to its next occurrence and a one-shot is recorded as missed, a daemon down for three days should not open with three days of reminders |
| `run_retention_days` (3) | how long run history is kept |
| `command_timeout_ms` (10m) | wall-clock ceiling on a `--command` payload |
| `job_wake_max_chain` (100) | how many times a finished background job may wake an agent with nobody having said anything in between |

**Two runs that are not failures.** A job working in the chat's own conversation (`--session chat`)
and delivering quietly or to a webhook is not started over a person's turn there: the run is recorded
`skipped` (`agent busy: …`) and the next occurrence comes as usual. One that announces in the chat is
sent as a message instead, and waits behind the turn. A run a restart cut off is recorded `interrupted`. Neither is reported into the chat or
counts toward `fail_streak_limit`. An agent turn also waits for a slot under `[queue] max_concurrent_turns`,
as a chat turn does, rather than running beside the ceiling. A run due while its agent is asleep is recorded `skipped`
too (`agent asleep: …`), whatever the job runs, a command included.

That last one is worth a sentence. A job finishing wakes its agent, that turn often starts the next
step, and its completion wakes it again, a chain with no human in it, each hop a provider call. It
is set high on purpose: a nine-step install is nine jobs, and that chain is legitimate. At the limit
the wake-up is still delivered and the agent is told to report and start nothing further; suppressing
it would hide exactly the failures this guards against. Any message from a person resets the count.

A run a restart cut off is marked interrupted in its history. A recurring job carries on at its next
time. A one-shot may have partly run, so it is paused rather than fired again by itself;
`nouride cron run <id>` retries it.

## Approvals at 3am

A scheduled turn has nobody to ask, so `[cron] unattended_approval` decides for it. At the default,
`auto`, the run is treated as `balanced`: ordinary calls go ahead, because a job that stops at a prompt
nobody will see has not run at all. `deny` treats it as `careful` and refuses anything that would have
asked, so the job fails honestly instead.

Either way, what `balanced` never answers, deletes, services taken down, infrastructure, credential
paths, an interactive session, is refused on the spot rather than left waiting for an answer that
cannot come, and the agent says what it could not do. [Approvals →](/en/docs/manual/approvals/)

## Background jobs are a different thing

`nouride jobs` lists work an agent started *during* a turn, a long build, a slow script, or a
server it started with `exec`'s `service` option (a dev server, a tunnel), not anything scheduled.

```bash
nouride jobs
nouride jobs log <id>
nouride jobs kill <id>
```

Starting a background job ordinarily ends the agent's turn, and the job wakes it with the result
when it finishes, which is the chain `job_wake_max_chain` bounds. With `keep_working` the agent
carries on with other work that does not need the result, fixing an unrelated file while a build runs,
and hears the result after that turn. When the next step needs the result, it still waits.

A job that prints nothing for a while is not stopped. After `[jobs] quiet_after_minutes` (5) its
agent tells the person it is still running, then again at double the wait. It is set on
**Agents → Settings**, and per agent on its own *Settings* tab.

A job that runs too long can be. `[security] job_max_ms` (off unless set) stops a job still running
after that many milliseconds, and its agent tells the person it did not finish. A service is exempt.
