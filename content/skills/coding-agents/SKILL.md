---
name: coding-agents
description: "Hand coding work to a coding agent CLI (OpenCode, Claude Code, Codex, Gemini CLI, pi, oh-my-pi or another) and drive it from the shell: install it, sign it in, give it a task in a repository, follow up in the same session, check what it changed and report. Use when asked to use one of these, or for coding work bigger than a few edits: a feature, a refactor, a failing test suite, a review."
requires: git
needs_tools: exec, read
author: Nouride
---

# Driving a coding agent

A coding agent CLI is a worker you run with `exec`. You give it one task; it edits files and runs
commands in a repository until it is done; you read what it did. You stay the one the person talks to,
and the one answerable for the result, so you check its work before you report it.

Small edits are faster with `edit`. Hand over work that is a loop of edit, run, fix: a feature, a
refactor, a failing test suite, a review of a branch.

**Long work is a mission.** Many files, many steps, anything that waits on CI or a long command, or work
that should go on while the person is away: draft it with `mission`, as your TOOLS say (the goal, a
brief, the checks that prove it done), and tell the person what it will do. They start it, and you drive
the CLI inside it, by the steps below. A hotfix, a question about the code or one change is done here,
in the chat.

## 0. Ask the agent that already is one

An agent on this install may already be answered by the CLI you would pick: `nouride` with `["agents"]` lists every
agent, and one answered by a coding CLI shows it where the others show their model (`Claude Code · …`). Then hand
the work to that agent with `ask_agent` (the repository, the task, what done looks like) and report what it says;
long work goes to it as a mission, with `agent` naming it.
Do not also run that CLI yourself: that is a second sign-in, a second session in the same account, and the same
subscription's limit spent twice. Run one yourself, as below, only when no agent is answered by it or the person
asks you to.

## 1. Pick one

1. The one the person named.
2. Otherwise one already here:
   `for c in opencode claude codex gemini pi omp command-code qwen kilo copilot goose crush aider amp; do command -v "$c"; done`
3. Otherwise OpenCode. It talks to any OpenAI-compatible endpoint, so it runs on the provider you
   already use and needs no new account.

Then read its page, in the `references/` folder beside this file: `opencode.md`, `claude-code.md`,
`codex.md`, `gemini-cli.md`, `pi.md` (pi and oh-my-pi), `command-code.md`, and `others.md` for Qwen
Code, Kilo, Copilot CLI, Goose, Crush, Aider, Cursor and Amp. It has the exact install, sign-in, run
and follow-up commands; this file has the method. For a CLI with no page, everything below still holds:
find its non-interactive mode, its output format and its resume flag in `--help`.

## 2. Install it, without root

Global installs already land in your bin directory, `$NOURIDE_BIN`, which is on your PATH and
survives restarts:

- An npm package: `npm i -g <package>`, with no `--prefix` and no `sudo`.
- An installer that drops it under your home: `~/.local/bin` is on your PATH already; for anywhere else
  (`~/.opencode/bin`), link it in with `ln -sf <where it landed> "$NOURIDE_BIN/"`. These download the
  CLI itself, often hundreds of MB, silently: run them in the background, never retry in the foreground.

Then `<cli> --version`, and read `<cli> --help` (and the help of its run subcommand, if it has one)
before the first real run. The flags in `references/` were right when written; `--help` is right now.
A flag it rejects means the CLI changed or is old: update it the way it was installed, never guess.

Each run is a process of a few hundred MB, plus whatever it builds. Check `free -m`; on a small machine
run one at a time. On a board of 1 GB or less, do not start one here: say this machine is too small for it, and offer
another of the person's machines. The `network-reach` skill reaches it, and the CLI runs there.

## 3. Sign it in

Best first:

1. **The provider you already run on**, for a CLI that takes an OpenAI-compatible endpoint. The
   `nouride` tool with `["provider"]` lists your provider profiles and their base URLs. The key is a
   secret the operator holds, and it reaches a command only when they bind it to that command in your
   `[security.exec_secrets]`. Then it is an environment variable, the name upper-cased. Ask them for
   that, by name and with the command, and never for the key itself.
2. **A token the person makes**, for a subscription. They create it on their own computer. Sent here,
   it reaches you as a `$TMP_SECRET_…` handle, never the value: keep it with `secret_save` under the
   name the CLI's page gives, and every command of yours gets it from then on, as it does after their
   own `/secret set <name> <value>` in the chat. Or they add it on the dashboard's Secrets page or with
   `nouride secret set <name> --stdin` on this machine, and bind `<name>` to the CLI's command in your
   `[security.exec_secrets]`. You never see the value.
3. **An interactive login**, with the `session` tool: start the CLI's login, send the person the URL
   it prints, type back the code they send you. It is saved in your home until it expires. The code
   is single-use but sits in the chat, so prefer 1 or 2.

This signs in a CLI you drive yourself, in your own home. An agent of this install that a CLI answers
is signed in by the person, on that agent's Brain tab in the dashboard, never by you; hand it the work
instead (step 0).

A key stays in its variable:

- Check that it is set with `[ -n "$NAME" ] && echo set`. Never print it, not even part of it.
- Point the CLI's config at the variable (`{env:NAME}` and the like), never at its value. Write that
  config with a quoted heredoc, `<<'EOF'`: unquoted, the shell expands `$NAME` into the file.
- Keep the config in your home. One inside the repository gets committed.

## 4. Where it works: a worktree per task

**In a mission, the mission's folder is the CLI's working directory**, its `cwd`. Its page names it
(`Folder: …`): in a git repository that is already a worktree on the mission's own branch, made by the
daemon from the repository's last commit and removed when the mission ends. Run the CLI there, make no
worktree of your own, and have the work committed on that branch before you call `mission` done:
your own commit after step 7, or the brief says to commit. The rest of this step is for work outside a
mission.

Every task gets a git worktree and a branch of its own, always, not only when someone else works in the
repository. Two tasks in one checkout write over each other, a person's uncommitted work is never yours
to change, and a branch per task is what you report and what they merge.

```sh
git -C <repo> worktree list                      # first: what is already there, and on which branch
git -C <repo> fetch origin && git -C <repo> worktree add -b agent/<topic> ../<repo>-<topic> origin/<base>
```

- **One task, one worktree.** A follow-up to the same task reuses its worktree and its session; a new task
  gets a new one. Never two coding agents in one worktree at once.
- **`<topic>` names the task** in a few words (`agent/fix-login-timeout`), so `git worktree list` reads as
  a list of what is under way.
- **Beside the repository, inside your workspace roots**, never inside the repository itself, where it
  shows up as untracked files, and never in Nouride's own directories: your config, your credentials and
  your memory live there.
- **Cleaned up when it is finished:** once the branch is merged, or the person says to drop it,
  `git -C <repo> worktree remove ../<repo>-<topic>` and `git -C <repo> worktree prune`. A worktree with
  changes nobody merged stays until the person decides. Say it is there in your report.

## 5. Give it the task: a brief in English

The coding agent sees nothing of your conversation: the brief is all it knows. **Write it in English,
always**, even when the person wrote to you in Indonesian or any other language. These agents and the
models behind them work best in English, and a brief half in one language and half in another is read
worse than either. Translate what the person asked faithfully; do not summarise it into something
vaguer. Keep exactly as they are: code, identifiers, file paths, commands, error messages and anything
the person quoted. You still answer the person in their own language.

Write it to a file in your scratchpad (`$TMPDIR`) and pass the file: a prompt inside a shell string
breaks on the first quote or newline, and a file inside the repository ends up in its diff. Every brief
has these sections:

```markdown
# Goal
One or two sentences: what must be true when this is done.

# Context
What the person asked, translated, with the details they gave. What you already found (files,
causes, earlier attempts), so it does not spend its first minutes rediscovering them.

# Scope
In: the directories and files it may change.
Out: what it must not touch (other modules, generated files, lockfiles unless the task is about
them, CI config, anything outside this worktree).

# Constraints
Do not commit or push unless this brief says to. No new dependencies unless named here. Never print,
log or write a credential. Ask (end with the question) rather than guess when something is unclear.

# Done when
The commands that prove it, exactly: `bun test path/to/test`, `bun run lint`. Which of them must pass.

# Handoff
End with a summary in this shape:
- Changed: each file, one line (what changed and why).
- Checked: the commands run and their result.
- Not done: what is left, what failed, what needs a decision.
- Session: the session id to resume.
```

A brief without a scope and a "done when" is not ready to send: with no edge, a coding agent widens the
task until it runs out of time; with no check, its "done" is only a claim. When a follow-up changes the
scope, say so in the resumed session, in English, the same way.

## 6. Run it

- **Headless and streaming.** Its non-interactive mode with JSON-lines output, piped through `tee`
  into your scratchpad and errors to a file of their own. A log that keeps growing means you are not
  woken to hear the job has gone quiet, and the events carry the answer and the session id.
- **Stdin never left open.** Feed it the task file, or `</dev/null`: several read stdin to the end,
  and an open one is a run that never starts.
- **With its own permissions on.** Headless, it has nobody to ask, so give it its auto-approve mode,
  scoped to the working directory where it has one. Its commands do not pass through your approval
  gate, which is why step 7 is not optional.
- **Long runs in the background.** Anything that may pass a couple of minutes: `exec` with
  `background: true`, and `on_complete` saying what to do next: "read its result, check the diff and
  the tests, report". Starting one ends your turn, so tell the person what you started, unless you
  have other work that does not need its result: then pass `keep_working: true` and do that meanwhile.
  You are woken when it exits, with the end of its log.
- **Short runs in the foreground.** A question about the code, a one-file fix: `timeout_ms` up to
  240000.

## 7. Check, then report

1. Its answer and session id: where they are differs per CLI, and its page in `references/` says.
2. What really changed: `git -C <dir> status --short && git -C <dir> diff --stat`, then run the tests
   yourself, and check no key landed in a file:
   `[ -n "$NAME" ] && grep -rlF --exclude-dir=.git -- "$NAME" <dir>` names any file that holds it.
3. Report what changed, whether the tests pass as you saw them, and what it could not do, against its
   handoff (step 5). Its summary is a claim; say what you checked. The report to the person is in their
   language, whatever language the brief was in.

The report is read on a phone. Write the change as the files it touched, one line each (what changed
in it and why), with the `diff --stat` totals. Paste a diff only when the person asks for one, or when
a change is a few lines they should see.

A non-zero exit, or no final event: read the end of the log for why (sign-in, a rejected flag, out of
memory) before you run it again.

## 8. Follow up in the same session

For changes, resume its session by id: it keeps everything it learned, and costs less than explaining
again. The same run rules apply. If it ended with a question, answer it from what the person already
said if you can; otherwise ask them, and resume with the answer.

## 9. When it was interrupted

A daemon restart kills a running job, and you are told it was interrupted. The worktree keeps what it
had changed: look at `git status`, then resume the session with "continue where you stopped", or start
again from a clean state.
