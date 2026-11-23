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

![The Automations page: each automation with what starts it, its steps and how its last run went](/media/dashboard-automations.png)

The dashboard's **Automations** page (Work → Automations) lists them all, whatever starts them, with one
dropdown to see only the scheduled ones, the webhooks or the ones started by hand. It is where you make, change, run,
pause and delete them. Or just ask an agent: "remind me to check the deploy in two hours". It
[proposes](#asked-of-an-agent) the automation, and you turn it on.

The list is across every agent rather than per agent, because you usually want to see everything of yours that runs on
its own at once.

### Whose an automation is

**An automation is a person's** (0.8.35). Make one on the dashboard and it is yours. Say yes to one an agent proposed
and it is yours, whoever asked for it. The page shows your own, and only its owner or an admin changes it: edits it,
runs it, pauses it, deletes it, answers a step that waits.

You also see an automation of someone else's that reports to a chat of yours, since what writes to your chat is yours
to read. Its row says whose it is, it opens, and you read its steps and its runs, but nothing on it changes anything.
A webhook's address is shown only to whoever may change it.

An operator or a viewer never sees anyone else's otherwise: not in the list, and not by its link, which answers as if
the automation were not there. An admin picks whose in the dropdown beside the search: **Mine** (where it starts),
**Everyone**, which sets the list apart by person, one person (type part of their name), or **Nobody's**. Nobody's are
the ones made from the command line and the ones from before 0.8.35 whose maker Nouride could not tell. On an
automation's own page an admin hands it to a person, or to nobody: the menu at the head of the page, **Whose it is**.

Your own is yours to hand to somebody else there too (0.8.44), never to nobody. You are asked first: it is then the
other person's to change and no longer yours, and you still see it only if it reports to a chat of yours.

A change an agent proposes to an automation that is already there is its owner's to turn on, or an admin's: seeing its
card in a chat is not enough to rewrite somebody else's.

An automation made before 0.8.35 belongs to the account that made it or turned it on. One an agent proposed in a chat
belongs to whoever said yes there.

**This is about the pages, not about what an agent knows.** An agent works for everyone who talks to it: asked in a
chat what is scheduled, it answers from every automation it has, whoever made them, and its memory and its files hold
what it did for each of you. Two people who must not learn of each other's work want two agents.

## Steps

An automation does one thing, or several in a fixed order. Each one is a step:

| A step | What it does | Does it call a model |
|---|---|---|
| **Send a message** | sends text as written to the automation's chat | no |
| **Ask an agent** | one turn of the automation's agent, or of another agent you pick | yes, one turn |
| **Run a script** | runs a small program in the agent's workspace: [a script](#a-script) the automation keeps, or one line | no |
| **Start a mission** | long work that is checked; the run waits for it | yes, as a [mission](/en/docs/manual/missions/) does |
| **Wait for your OK** | asks a person, and goes on when they say so | no |
| **Several at the same time** | starts two to five agents' turns or scripts together, and joins what each said | yes, one turn for each agent in it |

Nouride runs the steps in that order, every time. Each step is handed what the one before it said, and an agent does
only the step it is given: it does not skip ahead, reorder the list or decide what comes next. That is the
difference from a [mission](/en/docs/manual/missions/), where the agent plans the work itself. The words of the last
step are what the automation sends to its chat.

The automation's page draws it as a canvas (0.8.44): a box for how it starts, a box for each step in the order
they run, and a box for where its results go. Press a box and its fields open beside the canvas on a wide window, or
in the box itself on a narrower one and on a phone; with nothing pressed, the last runs are there. **Add a step** is under the last step,
a plus shows on the line between two boxes, and a box is dragged to move it. Nothing changes until you press
**Save**.

What you have not saved is kept in the browser you made it in (0.8.45), so a page you left opens on your changes
again, and says so. On the Automations list, one you were making and never saved is a row of its own, with
**Continue** and **Discard**, and an automation with changes waiting on its page is marked **Unsaved changes**.
**Save** and **Cancel** (or **Discard changes**) are what end it. It stays in that browser: it is not on your phone,
and nobody else sees it. If the automation was changed by someone else while your changes waited, the page shows it
as it is saved now and offers yours beside it.

The bar that saves says what is still missing, one thing at a time. Press that line and you are taken to it: the
name's field, or the box that holds it, opened.

![One automation's page: a box for how it starts, a box for each step with what happens if it fails, and its recent runs](/media/dashboard-automation-steps.png)

### Where a run goes next

A step that is done goes on to the next one. What happens when it **fails** is asked on the step itself, with four
answers (0.8.44):

| If it fails | |
|---|---|
| **Stop and tell me** | the run ends as failed, and its chat is told why. What a step does unless you pick another |
| **Go on anyway** | the run goes on to the next step, which is handed what the failed step had been given. An agent's step is also told what failed, and why |
| **Ask me first** | you are asked, with why it failed. Yes goes on, no stops there |
| **Do something else** | other steps run in its place. They are drawn beside the step (under it, set in, where there is no room beside), and end one of two ways: back into the steps below, or with a stop |

Every step's box says what a failure does (0.8.45): a step left at "Stop and tell me" says so under its words, with
a stop's mark, and "Go on anyway" and "Ask me first" are said there too, with the question and where each answer
leads. A wait's **no** is asked the same way: stop there, go on anyway, or do something else.

The steps that run in a step's place answer for themselves as well (0.8.45): each can stop, which is what it does
unless you pick otherwise, or go on anyway. A question or steps of their own belong to a step of the main line.
Where those steps end is said under them, and that mark is pressed to change it: **back** to the step the line goes
on with, named by its number, or **stop**. The same is in the fields of each of those steps.

A step with **nothing to say** (a script that printed nothing, an agent with nothing to report) ends the run quietly,
so a check that finds nothing wakes nobody. Under **More about this step** it can go on anyway, or do something else.

A run only ever goes forward, so it always ends. An automation written at the command line or by an agent can hold a
path the page has no drawing for, such as a jump from one step to a later one: it is shown as a small label under the
step with a line to where it lands, and stays as it is until you pick another answer.

A shop check, for example:

1. **Run a script** that asks the shop whether it answers: it prints nothing while it does, and fails when it does
   not. If it fails, **Do something else**:
   - **Ask an agent**: "The shop is down: find out why."
   - **Wait for your OK**: "Restart the shop?"
   - **Start a mission**: "Restart the shop and confirm it answers."

While the shop answers, the run ends at step 1 and no model is called. When it does not, the agent looks into it,
you are asked, and only with your yes is anything restarted.

### A script

**Run a script** runs a small program with no model (0.8.44): a few lines of shell, Python or JavaScript that fetch a
page, compare a number, call a service or put something in another shape, the same way every run. The automation
keeps the script itself. So what runs is what you read before you turned it on, and a change to it is a change to the
automation like any other: one an agent suggests waits as **Suggested**, with the script's text to read as it runs now
and as it would be.

- It **reads** what the step before said (for a first step, what a webhook was sent), and what it **prints** goes to
  the next step.
- Printing nothing is "nothing to say". Ending with an error is a failure, with what it wrote as the reason. So a
  check that has nothing to report yet ends without an error: in a shell script, `if [ -f done ]; then cat done; fi`,
  not `test -f done && cat done`, which ends in an error for as long as the file is not there.
- It runs in the agent's workspace, as that agent's commands do, with no model and without asking first. It is handed
  the saved keys you name on it, among those that agent's commands may already use; the script reads each by its name
  in capitals, `notes_key` as `NOTES_KEY`.
- What it is written in is checked when you save: a program that is not on the machine is said then, not at 07:00.

On the page a script is read in words first: what it does, who wrote it, what it is written in and how long it is,
and the keys it uses. **Show the script** opens its text, to read or to change. **Try it** runs it once on what the
step before said in the last run, or on what you type, and shows what it printed, for up to a minute. That is a real
run: a script that sends or saves something does so. The button beside them asks the orchestrator to write the script
or change it, with the step and the automation named in the request.

You do not have to write one. Ask an agent for the automation, and where the work is the same every run it writes the
script, tries it, and [proposes](#asked-of-an-agent) it: the card says what the script does, what runs it, how long
it is and the keys it is handed, and shows its text. The page of one that is not turned on yet shows the same, under
**Show the script**.

An automation from before 0.8.44 holds a one-line command where a script would be. It runs as it always did, and is
not handed what the step before said. Its step offers **Write it as a script instead**.

### Several at the same time

A step can start several things at once (0.8.38): two to five, each what to ask an agent or a command to run. They
start together, each handed what the step before said, and the step is done when the last of them is. What they said
goes on as one text, each under its name (the name you gave it, the agent, or the command), with no model between.
As the last step, that text is what the automation sends.

A morning round, for example:

1. **Several at the same time**: Nix reads the news, Nox reads the calendar, and `gh issue list` runs.
2. **Ask an agent**: "Write the morning note from what they said."

- **One that failed** makes the step's failed path. Left as it is, the run ends as failed and says which one failed;
  what the others said is kept on the run's page. Sent on to another step, that step is handed what the others said
  with which failed and why.
- **An agent that is asleep or busy** is that one's failure, where a step alone would have ended the run as skipped:
  the others' work stands.
- **With nothing to say from any of them**, the step takes its quiet path. One with nothing to say among others is
  left out of the text.
- **An agent takes one of them.** Two turns of one agent at once are two steps, one after the other. A mission and a
  wait for a person are steps of their own too.
- Each agent's turn costs what a turn costs, and they run at once: three agents are three turns at the same time.

A run's page says how each of them went, under the step.

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
| `--script <file> --about <words>` | run [a script](#a-script) the automation keeps: the file's text, and a line of what it does. No model call |
| `--run <program>` | …what runs it: `sh` unless said, `python3`, `bun` |
| `--secrets <name,name>` | …the agent's secrets it is handed, by name |
| `--then agent` | …and wake the agent with what it printed, when it printed something |
| `--mission <goal>` | run each time as a mission. With `--check <command>` for one check, `--no-review` for no reviewer; more checks from the dashboard |
| `--steps <file.json>` | several of these in a fixed order: the list, as JSON (below) |
| `--session <fresh\|isolated\|chat>` | what history the turn sees |
| `--once` | tell once, then turn itself off ([Watching something](#watching-something)) |
| `--for <6h>` | stop by itself after that long, and say so where it reports |
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

The other kinds are `systemEvent` (a message, with `text`) and `parallel` (several at the same time, 0.8.38): its
`steps` are two to five of `agentTurn` and `command`, written as those steps are. `agentTurn` and `mission` take an
`agentId` for another agent, and `approval` a `timeoutMs`. Nouride reads the file and refuses a step it cannot run,
naming it.

A `command` step that keeps a script (0.8.44) names the program alone in `argv` and holds the text beside it:

```json
{ "name": "Save it", "kind": "command", "argv": ["python3"],
  "script": { "about": "Saves the summary as today's page.", "text": "import sys\nprint(len(sys.stdin.read()))\n", "secrets": ["notes_key"] } }
```

```json
{ "kind": "parallel", "whenFailed": "next", "steps": [
  { "name": "News", "kind": "agentTurn", "message": "Read today's news and say what matters.", "agentId": "nix" },
  { "kind": "command", "argv": ["sh", "-lc", "gh issue list --limit 5"] }
] }
```

`nouride cron runs <id>` lists each of them under the step, with how it went.

### Four kinds of job, and the cost of each

**`--text`** is a plain reminder. Nothing calls a model, so it costs nothing. Reach for it whenever
the message is the whole point.

**`--command`** runs a shell line and delivers the output. Also no model call. `--then agent` adds
one: the agent reads the output and reports on it, which is the difference between "here is the disk
usage" and "the disk is filling up, here is what is eating it". A run that prints nothing sends nothing,
and with `--then agent` wakes nobody: a check that prints only when something is wrong costs nothing
while all is well. A command that fails still says so in the chat.

**`--script`** is a command of more than a line, kept in the automation (0.8.44): `nouride cron add --name
"backup-watch" --every 30m --script check.sh --about "Says once the backup is done." --once --for 6h …`. It costs what
a command costs, nothing. See [A script](#a-script) for what it reads and prints.

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

Where the work is the same every run (fetch a page, compare a number, call a service) the agent writes it as
[a script](#a-script), tries it once, and proposes that (0.8.44): no model is called when it runs. The card says what
the script does, what runs it, how long it is and the keys it is handed, and shows its text; one too long for a
message says so, and is read on the automation's page before you turn it on. Work that needs reading, judging or
writing stays an agent's turn.

Nothing runs until someone answers. **Turn on** starts the schedule, and its missions run as the
person who pressed it. **Discard** throws the proposal away. In a one-to-one chat the person in it
answers; in a group, the person who asked or an admin. Where a chat has no buttons, as on WhatsApp,
the card names the commands: `/schedule on <id>` and `/schedule discard <id>`. The Automations page
lists proposals with the same two buttons, and a card answered there says so in the chat.

Results come to the chat you asked in. Ask for them somewhere else ("and send it to my WhatsApp", "to the
family group") and the agent names that chat in what it proposes. The card then says where each run's
result is sent, `Results: sent to the whatsapp one-to-one with Gading, not here`, and so does the
automation's page. Turning it on is your yes to that, and to whatever else its steps send: a run is not
held to ask again.

The agent never turns a job on itself, widens one or edits one that runs. A change is a new proposal
that names the job it replaces; turned on, that job takes the new shape and keeps its id, its runs
and its webhook URL. On the automation's page the change waits as **Suggested**, with what it adds, changes and
removes, and **Accept** and **Discard**. An agent that runs `nouride cron add`, `update` or `enable`, or `webhook add` or
`rotate`, is refused and pointed back at `schedule`. At most ten proposals of one agent wait at once, counted by the
agent that proposed them.

Only a person answers a proposal, never an agent. Some are an admin's to turn on, whoever asked: a change to another
agent's job, a change to a job that reports to another chat, and a webhook, as making one is. What the old job was
allowed always does not carry over to its new shape: it asks again.

## Watching something

"Tell me when the disk is nearly full" is a check on a clock. Left as it is, it tells you every time it runs, for as
long as the disk stays full, and at three in the morning. Three marks make it a watch (0.8.35), and a fourth ends one
whose moment never comes (0.8.44).

**A step that goes on only when something changed.** Mark a step (a command, an agent's turn or a mission) with
**Go on only when this changes**. What it said is compared with what it said the last time the automation ran to its
end. The same again, and the run ends there quietly, as when a step has nothing to say: no agent is woken, and nothing
is sent. The first run has nothing to compare with, and goes on. A step that failed is not compared. Nouride keeps
a fingerprint of what the step said, not the words.

A mission is the one exception to "nothing is sent": it tells its chat how it ended by itself, every time. On a
mission the mark decides only whether the run goes on to the steps after it.

So a check every ten minutes tells you once when the disk passes 90%, once more when it passes 95%, and once when it
is back under: each time what the check printed changed.

**An automation that tells you once.** Turn on **Tell me once, then turn off** where it says where it reports. After
the first run on its own time that tells you something, the automation turns itself off, and its page says so. Turn it
on again to be told once more. A run you start by hand does not count: you are trying it out. "Tell me when the build
is done" is this mark, on a check marked to go on only when it changes. A mission's own word to its chat counts as
telling, so an automation with a mission in it turns off after the first run that reaches the mission.

**An automation that stops by itself.** A watch for something that never happens would check for good. **Stop by
itself after** (0.8.44), where it says where it reports, gives it a length of time: an hour, six hours, a day, a week
or thirty days, counted from when it is turned on. When the time is up it turns itself off and says so in its chat,
with that what it watched for did not happen, and its page says it too. Turn it on again to give it that time again.
Only an automation that runs again and again on a clock can have one, and it must be long enough for a run to fit.

**Ask an agent for one.** "Kabari aku kalau disk lewat 90%" in a chat: the agent proposes a check on a clock with
these marks, as a script where it can be one, its card says them in words, and you turn it on. A watch an agent
proposes to tell once always says how long it lasts, so none is left checking for good.

### Quiet hours

One setting for the whole install, on the Automations page: two times of the day, in the server's time zone, between
which what automations would say to a chat is kept. The automations still run, so what changed in the night is known
in the morning. When the hours end, each chat gets one message: every automation that had something to say, by its
name, with what it said and when, the ones that failed first. A question a step waits on is asked then too, and its
time to answer counts from then; it is under **Waiting for you** on the dashboard meanwhile. While something is kept,
the Automations page says how many messages of your automations are, beside the hours.

Three things are said whatever the hour: an automation with **Tell me at once, even in quiet hours** turned on, for
what cannot wait for the morning (a camera at the door); a run you start by hand, since you are there; and what an
automation sends to a URL instead of a chat. A mission tells its chat how it went by itself, and is not held.

An admin sets the hours. Leave both times empty for none, which is how it starts. In `config.toml` it is
`[cron] quiet_hours = "22:00-07:00"`.

## Webhooks

An endpoint that runs a job when something calls it.

![An automation a webhook starts: its address, how to call it, and the steps it runs](/media/dashboard-webhooks.png)

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

### A script in front of a webhook

When the first step of a webhook's automation is a command, the command is handed what the caller sent on its
standard input, and never in its arguments or its environment. What it prints is what the next step is handed. Print
nothing, and the run ends there: a script decides which calls are worth an agent's turn, and what of each call the
agent reads.

```sh
# Step 1, a command: only a person at the door goes on. Everything else ends here, and costs no model.
jq -r 'select(.event == "person") | "Somebody is at the \(.camera) camera."'
```

The agent's step after it is handed that line, and is told it came from outside. It does not see the caller's body
any more, so print what it should read. Up to 0.8.35 a command ignored the body and the first agent's step read it.

Such an automation is made by an admin from the dashboard: a call from outside that runs a command with no model
between is not something an agent proposes.

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
