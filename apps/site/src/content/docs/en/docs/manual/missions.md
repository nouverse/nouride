---
title: Missions
description: "Long work an agent finishes on its own: how it starts, how it stays on track, when it is done, and what it asks you."
---

A **mission** is work an agent carries on alone: you give it a goal, walk away, and come back to work that is done, or
to one clear question. It runs turn after turn, through a restart, and is finished only when it has been checked.

## Starting one

Mostly, you do not. When something you ask for is long work, more than about an hour, that goes on with little from you
(long development, a deep analysis, a long scan, research across many sources, a migration, a wait on CI, work that
has to go on while you are away), the agent **drafts** a mission and says what it will do and how it will be judged
done. What takes a few minutes it does in the chat; what takes longer but less than an hour goes to a helper or
another agent in the background, and the chat stays free for you. The hour is the one a reply has: work that may run
past it is a mission's, whose turns survive a restart and keep going on their own.

A draft runs nothing until you start it:

```text
📝 Draft msn_3f2a91 · nix: Revise the RFC

Revise the RFC to the owner's answers of today, section by section, and say what changed in each.

5 checks · signed off by: you · brief: on the mission's page

Start it: /mission accept msn_3f2a91 · drop it: /mission stop msn_3f2a91
[Start it] [Drop it]
```

- **Its name** is the few words after the agent's (0.8.39), and the goal is whole under it. A mission is called by
  its name from then on: in its notices, in the list, on the cards of what waits for you. An agent names every mission
  it drafts or starts. One you start yourself takes the **Name** you give it on the dashboard's form, or is named from
  the first sentence of its goal. The missions made before 0.8.39 were named that way when it was installed.
- **Its brief** is `BRIEF.md` in the mission's folder: what the work is, why, what to read, what done means. It is on
  the mission's page, and each turn of the mission starts from it.
- **Change it first** if it is not right: tell the agent ("the checks only grep, add one that runs the tests") and it
  sends the draft again with the change named; or change it on the mission's page in the dashboard. Once it runs, its
  goal and checks stay as they are.
- **Start it** with the button, `/mission accept <id>`, the dashboard's Start it, or by telling the agent to go: it
  passes your words on, and they are kept with the start. **Drop it** removes it, with its folder, and so does
  **Delete** on its page: a draft goes at once, since nothing of it has run.
- **Who signs it off** is in the draft: you, once its checks pass, unless the agent chose a reviewer for it, as it does
  when you are away ("do it, I'm off to sleep"). You can change it in the draft.
- A draft nobody starts stays in the board's Backlog until someone starts or drops it, however long that is: a draft
  never expires. It is not counted among what needs you, and you are not reminded of it.
- **A draft's notice is one message.** When the agent changes the draft, that message is rewritten where it stands,
  its buttons kept, in a chat app that can rewrite one (Telegram, Discord). Elsewhere one line says what changed.
  It used to be sent whole again at each change.

Said "do it now, I'm off to sleep"? Every mission an agent starts is a draft first (0.8.40): it drafts it and says so,
and you start it, or tell it to go and it starts its draft on your word. What it had written down about the task, and
its plan, go with it; the chat keeps one line, `→ mission msn_3f2a91, running`, which becomes the outcome when it ends.
`/mission <goal>` asks the agent you address for a draft of that goal: it reads what it needs, writes the brief and
checks, or asks you first when the goal is unclear. `/goal` is the same command. A mission you write on the dashboard's
form, and an automation's mission step, still start at once: you wrote the first, and nobody is there to press Start
for the second.

To start one yourself:

```
/mission check the 52 linked documents in KK 1.1, mark each, and copy the workbook back
```

or **Missions → New mission** in the dashboard, where **Save to backlog** keeps it as a draft until you start it and
**Start now** starts it at once. The agent you address runs it, as you, and it reports to the chat you started it in.

`/goal`, as other tools name it, starts one too. A mission is a goal someone else signs off: it ends when its checks
pass and a reviewer agrees, not when the agent says it is done.

Work nobody asked for (an idea an agent had after a job finished) never starts by itself either. It is a draft, and
waits for your yes.

## What you hear

The chat stays quiet. A mission says:

- that it **started**, with its whole goal and how to stop it;
- that it **needs you** (an approval, a question, a limit reached, a result to accept), with buttons for what you can
  say to it: Accept, Continue, Stop, or one per option of a question. A question is sent the moment it is asked
  (0.8.39), not at the end of the turn it was asked in;
- that it **asks, and works on meanwhile** (0.8.39): a question whose answer the rest of the work does not wait for.
  The mission goes on, and your answer is handed to the work in progress. If the turn ends with the question still
  open, you are told once that it has done what it could and waits for the answer now. A mission that finishes
  everything else while its question is still open does not go on to its checks, and you are not asked to accept
  anything yet (0.8.41): it tells you once that the rest is finished and waits for your answer, since the answer may
  change the work. With the answer it does what the answer changes and says it is done again. Accepting it as it
  stands still closes it. One question is open at a time;
- that it is **held up** because its model could not answer, and tries again by itself;
- that it is **paused** (0.8.41), by whom, with Resume and Stop;
- that it is **done**, with its result in two or three sentences; then its whole **report** as `report.md`, and the
  files it made for you: a document, an image, a spreadsheet. Code it changed in a repository stays on its branch,
  which the notice names, and is not sent;
- or that it **ended**, with why, and its report as `report.md` if it wrote one.

The result and the report are in your language, written formally, as a document is. A result that waits for your yes
comes with its `report.md`, so you read it before you decide, and it is not sent again when you accept. Nothing you
wrote is cut on the way: the goal, what you told it while it worked, what it reports.

A report is not only text (0.8.40). Where the work has a shape, the agent draws it, hands the picture back among the
files, so the chat receives it as a picture, and names it in the report; the mission's page draws it there, in place.
A list of things with their state is a table.

*Started*, *needs you* and *done* end with the mission's page, as a link, where the chat gets one:
[Links from a chat](/en/docs/manual/dashboard/#links-from-a-chat).

Between those, a progress line written from its checklist ("3 of 8 steps done"), at most every half hour, and only
when a step finished. A wait on you is named again once, after four hours; never a draft, and never a mission
you paused.

## Watching it

**Missions** in the dashboard is a board (0.8.40). Three columns hold what is still open: **Backlog**, the drafts;
**Working**, what is queued, running or being checked; **Needs you**, a question, approvals, a limit or a result to
accept. Under them **Finished** lists what is done, failed or stopped, a row each. Each card has its name, a bar of its
checklist's progress, the line that matters (when a draft is done, the step it is on, what it asks), the agent's cat
and when; a finished row says why it failed or who stopped it. Hover a time, or reach it with the keyboard, for the day
and the minute it was made, started and ended. **Start** on a draft and **Answer** on a question work from the card.

Every column shows its newest five, with **Show more** under them. Finished goes back the last 7, 14, 21 or 30 days (7
unless you choose), with Done, Failed and Stopped to narrow it; what is open is listed however old. With nothing open,
the three columns are one thin line and Finished has the page. A search and a filter by agent narrow every column. On a
phone the board is four tabs with their counts, Finished the fourth, opening on Needs you when anything is there, and
the day stands beside each time.

An agent can be asked the same in its chat: "what is in your backlog?" It answers for its own missions, the ones it
works and the ones it drafted for another agent: every one still open however old, a draft named as a draft that has
not started, and the last twenty that ended.

A mission's own page starts with what it does now and how far it is, then its brief and its result once it has one,
each across the page, and its checklist over its turns, with its folder, what decides it is done and the box to tell it
something beside them. A long checklist shows the five steps around the one at work, and the turns their newest five,
with the rest a press away.
A draft's page has only what you can change before it starts.

**What waits for you says what it waits for** (0.8.39), on Home, on Work and in the list: a question with the question,
a result to accept, a limit reached. A mission that asked and works on meanwhile is among
them, marked **Working · asked a question**, and its page has the question and the box to answer it.

**A mission at work shows it is alive** (0.8.39). A mission a coding CLI works on (Claude Code, Codex) is often one turn
of hours. Its card says when its last step was ("last step 7 min ago"), and what the turn at work has spent so far
is counted in, as an estimate, on its page and in `nouride mission show`. The notice at 80% of a limit comes during
such a turn too.

A mission's page shows its steps, turns, hours and tokens against their limits, the step it is
on while it runs, its checklist with each step's note, the calls parked for you (answered right there), its questions,
its report and files across the top once it has them, and every turn it took as a timeline, newest first, each marked
by what started it (the next step, another agent's answer, a job's end, an approval, a retry) and by how it went, with
the wait before it and the same failure in a row shown once. Stop, Continue, Accept and Answer appear where they apply,
and **Accept as it is** on one waiting for anything else. While it is open, **Tell it** takes words for it, and lists what
it was told with whether it has read each.

**A mission waits for a job that ends, never for a server** (0.8.38). A build or a test run it left in the background
wakes it when it ends. A server it started to look at its work (a preview, a static server) runs beside it and holds
nothing: the mission goes on to its next step, and the server is stopped when the mission ends. Where a mission has
waited an hour for a job, it is told which one, once, in case that job is one that never ends.

**A mission is a person's** (0.8.35): whoever started it, from a chat or from this page, and a mission an automation
starts is its automation's owner's. The page shows your own, and only its owner or an admin tells it something, stops
it, continues it, accepts it, answers it or deletes it. One an agent proposed on its own is answered by whoever may open
the chat it was proposed in, and becomes theirs. You also see a mission of someone else's that reports to a chat of
yours: it says whose it is, and you read it without changing it. An operator or a viewer sees no one else's otherwise,
not in the list and not by its link. An admin picks whose in the dropdown beside the search, as on
[Automations](/en/docs/manual/schedule/#whose-an-automation-is): Mine, Everyone set apart by person, one person, or
Nobody's.

**A stopped mission keeps what its last turn spent** (0.8.39): one stopped in the middle of a turn has that turn, its
tokens and its helpers' counted. Its notice names the work in its folder that nobody committed, with the branch.

From 0.8.13, an ended mission can be deleted (**Delete** on its page, or `nouride mission delete <id>`), with its
conversation, its checklist and the folder Nouride made for it; a folder you named and its branch stay. One still open
has to be stopped first: there is no Delete on it until then. Work in its folder nobody committed stops the delete and
is named; deleting anyway loses it.

## Telling it something while it works

From 0.8.10, `/mission tell <id> <words>` (or **Tell it** on its page, or `nouride mission tell`) gives a running
mission something to know: "use the second tab", "the client wants PDF", "stop after step three and report". The agent
follows it: your later word wins over the details of the goal. The goal itself, its checks and its limits stay as they
were: the checks still decide when it is done, and if your words would fail them, or ask for different work
altogether, the agent asks you. To change the goal, stop it and start another.

- **Working:** read before its next step. A mission an agent answered by Claude Code or Codex works on takes it into the
  prompt it is in; while a command of its runs, your words wait for that command to end, five minutes at most.
- **Waiting or queued:** kept for its next turn, and the answer says what moves it: your answer, continue, accept. A tell
  never answers a question and never lets a waiting mission go on by itself.
- **Being checked:** if the checks fail, its next turn reads it. If they pass, a mission you accept waits for you with
  your words shown beside its result; one that would end by itself goes one more turn to read them, and is checked again.

Each tell is kept on the mission with the turn that read it, and is on every page after, so its later turns, and the
reviewer, know what you said. An agent can pass your words on from your chat ("tell the report mission to use PDF")
when you started the mission or are an admin; it cannot tell a mission anything of its own.

## How it stays on track

Every turn of a mission starts from its **page** (the goal, how it will be checked, its checklist and notes, its
folder, the last check that failed, the questions it asked and your answers), never from the turns before it. A
mission of fifty turns carries fifty pages, not one conversation that grows until the agent loses its place.

## Done means checked

When the agent says it is done:

1. **Its checks run.** The commands it named when it started (`bun test`, a script that reads the workbook back over
   ssh, `test -s summary.txt`) run in its folder, as the agent's own commands run. One that fails is its next turn,
   with the output. A check runs with nobody to ask and without the credentials bound to its program, so it reads what
   is on disk: a file, a local branch, tests in the worktree. One that would need your approval is refused when the
   mission starts, so the agent writes another then.
2. **A reviewer looks.** A second reader with a fresh context and no part in the work, on the agent's `high` model,
   holding only tools that read, checks the result against the goal. The agent's report is what it is checking, not
   evidence. Its fail is the next turn too. Each look has ten minutes: one that runs out of time has judged nothing,
   so it is never a fail. The next look goes on from its notes, three in all, and then you decide, with what it
   checked. A mission started with `review = false` skips it.
3. **You accept,** where no command can tell (a summary, a draft), or when it was started asking for that:
   `/mission accept <id>`, or `/mission continue <id> <what is missing>`.

The same failure three times in a row stops the mission and asks you, rather than spending turns on a loop, and so
does the reviewer failing it three times in a row, whatever it found each time.

**You can accept any mission that waits on you as it stands** (a question, a check it cannot pass, a limit):
`/mission accept <id>` closes it as done, and its notice says its checks did not pass. Work that landed another way
closes with a note: `/mission accept <id> --outside "<where>"`.

## When its model cannot answer

A usage limit, a rate limit, a provider that is down: the mission is **held up** and tries again by itself: after 2, 10
and 30 minutes, then every hour, for about a day. You are told once when it is held up and once when it goes on; the time
it waits is not counted against its hours. **Retry now** tries at once, **Stop** ends it. After a day of it, the mission
asks you.

Nothing is asked of you while it is held up, so it is not under Needs you: on the board it stays in **Working** under
a **Held up** tag, and its card and its page say when the next try is ("It tries again by itself in 43 min"). A mission
that worked on after a try and is then held up again, as one on a plan with a limit every few hours is, tells you
again and starts from the 2 minutes.

## Pausing one

A mission that is running or waiting in the queue can be paused (0.8.41): **Pause** on its page, `/mission pause <id>`
in its chat, or `nouride mission pause <id>`. Its turn at work is cut and its background jobs are ended, as at a limit.
Nothing of it is lost: its checklist, its folder and its work so far are kept, and its agent is free for other work.
A mission paused in a repository keeps that repository, so another mission there waits until it goes on or is stopped.

It stays paused as long as you like. The time it is paused counts against none of its limits and you are not
reminded of it. **Resume** on its page or on its card under Needs you, the **Resume** button under its notice, or
`/mission continue <id>`, lets it go on from its checklist; one paused while it was queued takes its place in the
queue again. **Stop** ends it.

Whoever may stop a mission may pause it. The orchestrator can pause any agent's mission when you ask it to, and can
go on only with one it paused itself: a mission you paused is yours to resume. A mission being checked, one that
already waits for you, and a draft cannot be paused, since nothing of theirs is running.

## Its questions

A mission asks through its own question, never through a message it sends. A question reaches the chat the mission
reports to, with a button for each option, and is answered there in your own words, with a button, with
`/mission answer <id> <answer>`, on the mission's page, or by telling the agent.

A message a mission sends by itself is a message, and an answer to it does not come back to the mission. So the chat
the mission reports to is the first in the list an agent sends from, and marked as the mission's (0.8.39), and the
conversation a mission keeps for its own work is not a chat anything is sent to.

## Approvals

A mission does not stop at a question. A call that needs your approval is **parked**: the prompt comes to your chat,
the mission goes on with whatever does not depend on it, and your answer (any time within a day) is its next turn.
It waits for you once a turn finishes no step (checking on the approval is not progress), and a mission that ends
withdraws what it parked. It runs at your approval level, as you.

## Limits

| | Default | What it bounds |
|---|---|---|
| `per_agent` | 1 | missions working at once for one agent. One being checked does not count, since its reviewer is not the agent. An agent may have its own, 1 to 4 |
| `max_running` | what the machine has room for, 1 to 4 | missions running at once on the box |
| `limit_hours` | 8 | hours of work; time waiting for you is not counted |
| `limit_turns` | 100 | turns (each up to `max_tool_iterations` steps), the reviewer's and failed checks' included |
| `limit_tokens` | 100,000,000 | input and output tokens, the reviewer's included |

They are `[missions]` in `config.toml`, also under **Limits** on the dashboard's Missions page, with no restart. A mission takes them when it starts. One
waiting for you holds no slot; the next waits in the queue and says what for.

**One agent's own number of missions at once** is on its Settings page, **Missions at once**, or `[missions] per_agent`
in its own `config.toml`: three for an agent that does long work, one for the rest. The box's `max_running` still
holds them all, so raise it too. Two missions in one repository take turns, whatever the numbers are: they would write
over each other's files.

`max_running` left unset follows the machine: one for each core but one and one for each GiB of memory the agents'
commands may use, whichever is lower, at least 1 and at most 4, and never more than its agents could run at once. A
4-core 2 GB box runs 1, a 4-core 4 GB box 2, a 6-core 8 GB box 4. Set it yourself to go higher, as far as every agent at once.
On the Limits form an empty field is its default, shown in grey; **Back to defaults** empties them all.

Reaching a limit stops the mission's jobs and asks you: `/mission continue <id>` raises the limit it reached by its
setting, counted from where it stands (`limit_tokens` more tokens after its token limit), and leaves the others as
they were; `/mission stop <id>` ends it. Unanswered for a week, it ends.

## After a restart

A running mission carries on from its page. If a restart cut a call off mid-way, the mission is told which: one that
only read runs again if needed; one that may have changed something is checked before it is redone; one the approvals
ask about (a delete, a send) is not repeated, and the mission waits for you. A mission that keeps dying across
restarts with no step finished stops.

## Its folder, its files, its memory

Each mission gets a folder under its agent's private one, removed a week after it ends. Started with a `workdir` (an
existing folder or repository), it works there instead, or in a git repository in a worktree of its own (below), and
the folder it was given is never removed. A mission's own folder that holds work nobody committed is kept, and named
in the log. One whose mission is no longer on record at all goes once it has been a week untouched (0.8.36), under
the same rule about work nobody committed. When it ends, it is filed once in its agent's memory, from its report.

A mission has a conversation of its own, not yours: `/new`, `/reset` or deleting the chat it started in leaves it
running and reporting there. That conversation is on the mission's page, not in the Chat list. Once it has ended, a
mission is kept as long as conversations are, `[retention] session_days` (30 days), then removed; one still open is
never removed, however long it runs.

Everything a mission tells its chat is sent under its agent's name: that it is queued or started, how far it is,
that it nears a limit, what it needs from you, that it goes on, that it is done, with its result. The agent in that
chat reads the same notices with your next message there (0.8.42), once, as you read them: whatever was said since it
last answered you there. Before, it knew only that it had started a mission, and could answer that a finished one was
still at work. Of a mission's progress lines it reads the newest. After `/new` it starts from nothing, as with
everything else, and can look its missions up.

When a mission ends, what it was running ends with it: its background jobs, and (0.8.42) whatever one of its commands
started and did not wait for, a build's workers left behind, say. Each is asked to end and, after a moment, made to,
and the chat is told what was ended. A program that sets itself apart keeps running: a process manager, a container,
a system service. That is how to keep something up past a mission.

An agent on a coding CLI runs its commands from the CLI's own shell, where Nouride holds none of them. Since 0.8.43
what such a mission started is still followed: the process that serves the mission's session is kept in a group of
its own, and when the mission ends and its session is closed, whatever a command of it started and did not wait for
is ended with the rest, in the same notice. What set itself apart, a build's own daemon that goes on for the next
build, is left running, and the notice names it, since nothing else would say it is still there. This needs an
install whose service hands its control group over, which a systemd install does; in a container, and anywhere
else, a coding CLI's commands are not followed, and what they leave is left. A CLI that serves all its sessions
from one process is not followed either: nothing there is one mission's.

Inside a mission, an agent can hand a separate piece to another agent as a mission of its own (one level, no deeper)
and is told how it ended.

## In a repository

A mission whose `workdir` is in a git repository works, on a box with room for it, in a worktree of its own:
`workspace/private/<agent>/missions/<id>/worktree`, on the branch `mission/<id>`, made from the repository's last
commit. Room means 512 MiB for the agents' commands, as an external agent needs, and free disk of twice the size of
the repository's checked-out files. What is not committed is neither taken nor touched, so commit what the mission
should start from. Two missions in one repository then work side by side.

The notice that asks for your yes, the done notice and the mission's page name the branch. Merging it, or pushing it,
is the agent's call, through the approval gate like any push. A week after the mission ends, its folder goes with the
worktree in it, unless a worktree there holds work nobody committed: then it is kept, and the log says so. The branch
stays in the repository either way.

Below that room, the mission works in the folder it was given, and one repository is worked on by one mission at a
time: the next waits in the queue and says which mission it waits for. A mission waiting for you still holds its
repository.

In a mission that works in a worktree, `delegate` with `isolated` gives each helper a worktree of the mission's, on a
branch of its own, `mission/<id>-helper-<n>`; the result names the branches, for the mission to merge. Anywhere else,
`isolated` is refused.

## Commands

| In a chat | |
|---|---|
| `/mission <goal>` | the agent you address drafts one from your goal; it runs once you start it |
| `/mission` | what runs and waits here, needs-you first |
| `/mission stop <id>` | end it |
| `/mission pause <id>` | hold it where it is: its turn cut, its jobs ended, its work kept |
| `/mission continue <id> [note]` | go on past a limit, out of being stuck, after a pause, or with what an accept found missing |
| `/mission accept <id>` | accept a result, or a proposal, which starts it; on one waiting for anything else, accept it as it stands |
| `/mission accept <id> --outside "<where>"` | close it as done another way, its checks not run |
| `/mission answer <id> <answer>` | answer its question |
| `/mission tell <id> <words>` | tell it something while it works; it is read before its next step and followed, never a new goal |

An id is the short one a notice shows, `msn_3f2a91`. In a group, the person who started a mission or an admin acts on
it. From a shell: `nouride mission [list|show|stop|continue|accept|answer|tell]`.
