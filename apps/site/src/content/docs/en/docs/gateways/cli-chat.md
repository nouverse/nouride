---
title: Terminal chat
description: Talking to an agent with no bot token, through a real in-process gateway.
---

```bash
nouride chat            # the orchestrator
nouride chat nouva      # address one by name
```

Nothing reaches an agent unless a gateway delivers it, so a fresh daemon with no Discord or Telegram
token is unreachable from a chat app. This and the dashboard's chat are the ways in.

![A terminal chat session](/media/cli-chat.png)

## It is a real gateway, not a shortcut

Messages travel through the in-process `local` gateway, so routing, hooks, the queue, the tool loop
and session persistence all run exactly as they would for a chat platform. That is what makes it a
genuine end-to-end test rather than a debug console.

It is on by default. `chat = false` under `[control]` turns it off.

## What works here

- **Slash commands.** All of them, `/new`, `/model`, `/approvals`, `/drafts`.
- **Files.** `/attach <path> [text]` sends a file, the way a platform would.
- **Approvals inline.** A request appears mid-turn and a one-letter answer settles it: `y`, `a` for "always" (when the request can be granted for good), or `N`.
- **Live progress.** Tool steps as they happen, rather than a pause and then a wall of text.
- **Sessions.** The conversation is `cli-<pid>`, so each run of the command is its own thread.

## Non-interactive

Piped stdin is **detected**, not assumed:

```bash
echo "what is the disk usage on this box?" | nouride chat nouva
```

Approvals are printed rather than prompted for, with the `nouride approvals` command that answers
them, and the command does not try to read from a stream that has ended. A script driving this is a
first-class use, it is how an end-to-end test talks to the daemon, and trying to prompt anyway used
to crash at EOF.

## Against a remote daemon

Most commands, `chat` among them, talk to a running daemon over the control API, so this works over the
network too:

```bash
export NOURIDE_URL=https://nouride.example.com
export NOURIDE_TOKEN=<contents of its data/.control-token>
nouride chat
```

Locally it reads `data/.control-token` itself, which is why no token is needed on the box.

## Why it does not start its own daemon

A CLI that booted one to answer a question would report on a process nobody is using, and
`nouride chat` would talk to a second copy with its own gateway connections. Two Telegram bots
polling one token get half the messages each.

So this needs a daemon running. If there is none, start the service (`sudo systemctl start nouride`),
or run one in the foreground:

```bash
nouride start
```

## Leaving

`/quit` (or `/exit`), or Ctrl-D.
