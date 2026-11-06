---
name: nouride
description: "Operate the Nouride daemon you are running inside: upgrade it, restart it without losing the conversation, add a connection, a provider or a new agent (internal, or a coding CLI like Claude Code) end to end, and work out why one is down. Use when asked to update, restart, reconfigure or diagnose this daemon, to add or create an agent, or when you need a command and are not sure the one you have in mind exists."
needs_tools: nouride
author: Nouride
---

# Operating this daemon

You run inside Nouride. The `nouride` tool is the daemon's own control surface: its status, logs and
audit trail, its connections, providers and agents, its scheduled jobs, grants and config.

**Every command written in this file is an argument list for that tool, not a shell command line.**
`update --help` means calling the tool with `["update", "--help"]`: no leading `nouride`, no shell
syntax, no pipes. Reaching the same CLI through a shell instead is a worse way to the same place: it
resolves the name through `PATH`, which on a machine running two installs is somebody else's daemon;
it cannot pass a credential anywhere but the argument list, where it is kept permanently; and it
does not tell the daemon which agent and chat is asking, which the commands that schedule their own
way back need.

This file is the **procedures**: the sequences that span several commands, where doing them in the
wrong order costs a conversation or a release. It is not a command reference and must not become
one.

## This machine

Nothing here runs a program of its own: it is the daemon's own tools and its CLI, so it works wherever Nouride runs.

## Where each answer lives

Three places hold what you need to know about Nouride, and they are current in different ways.
Reach for them in this order:

1. **Your system prompt.** Everything that has to be known *before* a command runs: which tools are
   gated, that `restart` refuses without `--then`, that a credential goes in `stdin` and never in
   `args`. It is rebuilt every turn, so it describes the daemon you are actually in.
2. **This skill, and the files beside it.** Procedures that span commands, and the failure each one
   was written after.
3. **`help` and `<command> --help`.** The commands and their flags. This is generated from the
   running binary: it is the only one of the three that cannot be out of date, and it is where the
   exact spelling of a flag comes from.

Never copy (3) into (1) or (2). A written-down flag list is correct until the release that changes
it, and this daemon upgrades itself.

## Scope, and what my silence means

This skill is a short operating guide, not the whole truth about Nouride. If a command, flag or
setting is not mentioned here, **that is not evidence it does not exist**. This file is deliberately
much smaller than the product. Before telling anyone that Nouride cannot do something, check
`help`, `<command> --help`, and `config explain <path>` for a setting. "I could not find it" and "it
is not there" are different answers and only one of them is usually true.

## Upgrading

The daemon can replace its own binary, and the turn asking for it does not survive the restart. Do it
with the `update` tool, not with the `nouride` tool's `update`: the tool schedules your way back before
the restart, in the chat you are in.

1. **Check first.** `update` with action `check` reports what is available and changes nothing. Read
   what it says (the version it would move to, and anything it warns about) and say it out loud
   before going further.
2. **Apply deliberately.** Action `apply` is the one that replaces the binary, and a person is asked
   first. Nothing about an upgrade should happen as a side effect of looking.
3. **Come back.** The upgrade restarts the daemon, which ends the conversation you are in. `apply`
   needs `then`, what you will check when you are back. It runs as a fresh turn in this chat once the
   daemon is up again, and the call is refused without it.
4. **Verify what actually happened.** The `then` turn fires whether the upgrade worked or not.
   Check the version and that the connections came back before reporting success. A daemon that
   failed to start does not answer, and a daemon that started on the old binary answers happily.

Without the `update` tool, `update --help` through the `nouride` tool says how this install is
updated.

## Restarting without stranding anyone

`restart` and `gateway restart` tear down the socket your reply would have gone out on, so both
refuse without `--then`. That is a mechanism, not a preference (see the system prompt). Use it
rather than asking a person to restart for you; and use `gateway restart` when only one connection
is sick, so the others keep answering.

## Setting something up, end to end

You can finish what you start: store a credential, create a provider profile, create a connection,
create an agent. A new agent is a conversation before it is a call (what it is for, internal or a coding CLI, its
name and persona): `references/adding-an-agent.md`. Two rules make the difference between helping and helping yourself:

- **Credentials go through `stdin`,** never in `args`. Arguments are kept in the exec grant, the
  audit log and the log table, permanently. Ask the person for the value in chat and store it
  yourself; never invent one.
- **Say what you are about to create, before you create it.** These verbs change what the daemon
  *is*, not what it is doing. The approval prompt asks "allow this?", which does not convey that the
  decision was the operator's to make.

## When something is down

`references/diagnosing.md` is the order to check things in, and why that order. In short: ask the
daemon before you ask the operating system, and read the audit trail before you form a theory.

## What not to do

- Do not read the database directly, and do not reach for OS-level tools, to answer something the
  CLI answers. The CLI's answer is the daemon's own view; a query against its files is a guess about
  its internals.
- Do not go looking for a control token. The tool authenticates by itself, and the token's path is a
  credential path; trying to read it stops the turn to ask a human for nothing.
- Do not describe a webhook URL you have not created. The token is random and the address depends on
  config you cannot see.
