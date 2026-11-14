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
📝 Draft msn_3f2a91 · nix: Revise the RFC to the owner's answers

5 checks · signed off by: you · brief: on the mission's page

Start it: /mission accept msn_3f2a91 · drop it: /mission stop msn_3f2a91
[Start it] [Drop it]
```

- **Its brief** is `BRIEF.md` in the mission's folder: what the work is, why, what to read, what done means. It is on
  the mission's page, and each turn of the mission starts from it.
- **Change it first** if it is not right: tell the agent ("the checks only grep, add one that runs the tests") and it
  sends the draft again with the change named; or change it on the mission's page in the dashboard. Once it runs, its
  goal and checks stay as they are.
- **Start it** with the button, `/mission accept <id>`, the dashboard's Start it, or by telling the agent to go: it
  passes your words on, and they are kept with the start. **Drop it** removes it, with its folder.
- **Who signs it off** is in the draft: you, once its checks pass, unless the agent chose a reviewer for it. Started at
  once because you are away ("do it now, I'm off to sleep"), the checks and a reviewer. You can change it in the draft.
- A draft nobody starts stays, listed under needs you, until someone starts or drops it.

Said "do it now, I'm off to sleep"? Then the agent starts it at once, without a draft, and its *started* notice quotes
your words. What it had written down about the task, and its plan, go with it; the chat keeps one line,
`→ mission msn_3f2a91, running`, which becomes the outcome when it ends.

To start one yourself:

```
/mission check the 52 linked documents in KK 1.1, mark each, and copy the workbook back
```

or **Missions → New mission** in the dashboard. The agent you address runs it, as you, and it reports to the chat you
started it in.

`/goal`, as other tools name it, starts one too. A mission is a goal someone else signs off: it ends when its checks
pass and a reviewer agrees, not when the agent says it is done.

Work nobody asked for (an idea an agent had after a job finished) never starts by itself either. It is a draft, and
waits for your yes.

## What you hear

The chat stays quiet. A mission says:

- that it **started**, with its whole goal and how to stop it;
- that it **needs you** (an approval, a question, a limit reached, a result to accept), with buttons for what you can
  say to it: Accept, Continue, Stop, or one per option of a question;
- that it **paused** because its model could not answer, and tries again by itself;
- that it is **done**, with its result in two or three sentences; then its whole **report** as `report.md`, and the
  files it made for you: a document, an image, a spreadsheet. Code it changed in a repository stays on its branch,
  which the notice names, and is not sent;
- or that it **ended**, with why, and its report as `report.md` if it wrote one.

The result and the report are in your language, written formally, as a document is. A result that waits for your yes
comes with its `report.md`, so you read it before you decide, and it is not sent again when you accept. Nothing you
wrote is cut on the way: the goal, what you told it while it worked, what it reports.

*Started*, *needs you* and *done* end with the mission's page, as a link, where the chat gets one:
[Links from a chat](/en/docs/manual/dashboard/#links-from-a-chat).

Between those, a progress line written from its checklist ("3 of 8 steps done"), at most every half hour, and only
when a step finished. A wait on you is named again once, after four hours.

## Watching it

**Missions** in the dashboard lists what needs you first, then what is working, then what finished, each with its
checklist's progress. It has a tab for each, a search over the goals, reports and ids, a filter by agent, and a choice
of how far back the finished ones go: the last 3, 7, 14 or 30 days (3 unless you choose, never further). One still open is listed however old. A mission's page shows its steps, turns, hours and tokens against their limits, the step it is
on while it runs, its checklist with each step's note, the calls parked for you (answered right there), its questions,
its report and files across the top once it has them, and every turn it took as a timeline, newest first, each marked
by what started it (the next step, another agent's answer, a job's end, an approval, a retry) and by how it went, with
the wait before it and the same failure in a row shown once. Stop, Continue, Accept and Answer appear where they apply,
and **Accept as it is** on one waiting for anything else. While it is open, **Tell it** takes words for it, and lists what
it was told with whether it has read each.

**A mission is a person's** (0.8.35): whoever started it, from a chat or from this page, and a mission an automation
starts is its automation's owner's. The page shows your own, and only its owner or an admin tells it something, stops
it, continues it, accepts it, answers it or deletes it. One an agent proposed on its own is answered by whoever may open
the chat it was proposed in, and becomes theirs. You also see a mission of someone else's that reports to a chat of
yours: it says whose it is, and you read it without changing it. An operator or a viewer sees no one else's otherwise,
not in the list and not by its link. An admin picks whose in the dropdown beside the search, as on
[Automations](/en/docs/manual/schedule/#whose-an-automation-is): Mine, Everyone set apart by person, one person, or
Nobody's.

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

A usage limit, a rate limit, a provider that is down: the mission **pauses** and tries again by itself: after 2, 10
and 30 minutes, then every hour, for about a day. You are told once when it pauses and once when it goes on; the time
it waits is not counted against its hours. **Retry now** tries at once, **Stop** ends it. After a day of it, the mission
asks you.

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
| `/mission <goal>` | start one for the agent you address |
| `/mission` | what runs and waits here, needs-you first |
| `/mission stop <id>` | end it |
| `/mission continue <id> [note]` | go on past a limit, out of being stuck, or with what an accept found missing |
| `/mission accept <id>` | accept a result, or a proposal, which starts it; on one waiting for anything else, accept it as it stands |
| `/mission accept <id> --outside "<where>"` | close it as done another way, its checks not run |
| `/mission answer <id> <answer>` | answer its question |
| `/mission tell <id> <words>` | tell it something while it works; it is read before its next step and followed, never a new goal |

An id is the short one a notice shows, `msn_3f2a91`. In a group, the person who started a mission or an admin acts on
it. From a shell: `nouride mission [list|show|stop|continue|accept|answer|tell]`.
