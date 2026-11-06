---
title: Upgrading to 0.8
description: The way from 0.7 to 0.8, what changes on the box when you get there, and how to go back.
---

0.8 starts only on data 0.8.0 has run on. From 0.7 that means one or two extra starts on the way, each of them a
normal install. A step you skip is not a problem: the next version refuses to start before it writes anything, and
says which version to start first.

## Which way across

| You are on | What to do |
|---|---|
| 0.8.0 | Update as usual: `nouride update`, the Update page, or `docker compose pull && docker compose up -d`. |
| 0.7.28 or 0.7.29 | Start 0.8.0 once, then update to the latest. |
| 0.7.11 to 0.7.27 | Start 0.7.29 once, then 0.8.0 once, then update to the latest. |
| 0.7.10 or older, 0.6, 0.5 | The same, by hand: 0.7.29, then 0.8.0, then the latest. |

On 0.7.11 or later, `nouride update` and the dashboard's Update page offer each release on the way in turn and
say why. Take one, wait until it has started, then take the next.

### With the installer

Each line is a normal install. Wait until it says Nouride is ready before you run the next one.

```bash
curl -fsSL @@INSTALL_URL@@ | sudo sh -s -- --version v0.7.29   # only from a 0.7 older than 0.7.28, 0.6 or 0.5
curl -fsSL @@INSTALL_URL@@ | sudo sh -s -- --version v0.8.0
curl -fsSL @@INSTALL_URL@@ | sudo sh
```

### With Docker

A container has no update guard: `pull` from 0.7 is refused at the first start, and the container keeps
restarting until you run the step it names. Before you change anything, see whether the new image would start
on your data:

```bash
docker run --rm -v "$PWD/nouride:/app/.nouride" @@DOCKER_IMAGE@@ nouride config check
```

Use the folder or volume your compose file mounts at `/app/.nouride`. Then go across one tag at a time, on the
same data:

1. From older than 0.7.28 only: give the image in your compose file the `0.7` tag, `docker compose up -d`, and
   wait until `docker compose logs` says it is ready.
2. Give it the `0.8.0` tag (that one, not `0.8`, which is the latest 0.8), `docker compose up -d`, and wait until
   it is ready.
3. Take the tag off again, as the compose file ships, and `docker compose up -d`.

If you stop a step before it says it is ready, the next version may refuse the data again: run that step again.

### What a refusal looks like

```text
refusing to start: this release upgrades only from 0.8.0, and the data in /srv/nouride/.nouride/data ...
```

Nothing was written: not the database, not `config.toml`. Start the version it names, once, and try again.

## Before you start

- **Back it up.** The whole `.nouride/` folder, with the daemon stopped. On a Linux install where each agent is its
  own user (below), `workspace/private/` is each agent's home: its sign-ins, SSH keys and own installs. Leave it
  out and every agent and coding CLI has to be signed in again.
- **Check the config.** `nouride config check` with the new version names every old form it refuses and the
  agent that would not load. [The full list of old forms →](/en/docs/deployment/updating/#from-an-older-version)

## What changes on the box

### In 0.8.0

- **Old forms are refused, not rewritten.** The last 0.7 rewrote them on disk at its start. One that comes back
  later, in a pack copied from elsewhere or a hand edit, stops the daemon or that agent and names the line to write
  instead.
- **Each agent is its own user**, on a Linux install from the installer. Each agent's commands, background jobs,
  sessions and scheduled commands run as `nr-<agent>`, through the `nouride-run` helper the installer sets up:
  - its home is `workspace/private/<agent>`;
  - what it installs lands in its own `~/.local`;
  - it cannot read the database, `data/`, or another agent's folder;
  - the programs every agent shares (`.nouride/bin`, `lib`, `opt`) change only through `nouride tools run`. That
    is the orchestrator's to run, and it asks you first at every approval level.

  On Docker, on macOS or without the helper, commands run as the daemon's user, as before. `nouride doctor` says
  which you have, and why.

### In 0.8.1

- **Coding CLIs as agents**, if you want them: Claude Code or Codex answers an agent's turns. Nouride talks to
  them over the [Agent Client Protocol](https://agentclientprotocol.com), through the official adapters in the
  [ACP registry](https://agentclientprotocol.com/registry), the same ones Zed and JetBrains use. Nothing changes
  until you make one. [External agents →](/en/docs/manual/external-agents/)
- **A stdio MCP server runs as its agent's own user**, where each agent is one. It gets that agent's home and
  installs, and starts in the agent's folder unless its block names a `cwd`. Before, it ran as the daemon's user,
  and a shell or file server given to one agent could read the database and every other agent's folder.
  A server that kept its sign-in in the daemon's home no longer finds it, because the agent's user cannot read that
  folder. Do one of these:
  - sign the server in again, for each agent;
  - give it its token through `env_secrets`, if it reads one from a variable;
  - copy what it saved into the agent's folder.
- **"Free in its folder" only where each agent is its own user.** The CLI asks nothing in that preset, a push or a
  POST included. On Docker, on macOS or without the helper, it asks as "Ask when risky" does, whatever the
  pack says.
- **`[llm] fallback_model` in a pack is refused** for that agent. Write
  `fallbacks = [{ provider = "<the pack's provider>", model = "<the model>" }]` instead. 0.8.0 rewrote it at its
  first start, so you only meet it in a pack that came back from git or a hand edit.

## Going back

- **From 0.8.1 to 0.8.0:** install 0.8.0 (`--version v0.8.0`, or the `0.8.0` image tag). There is no database step.
  0.8.0 warns about `[external]`, `[look]` and `[[external_clis]]` as unknown keys and ignores them. An external
  agent answers with its `[llm]` model until 0.8.1 is back.
- **From 0.8 to 0.7:** on 0.8.1, install 0.8.0 first: 0.8.1 refuses to restore a snapshot from before 0.8.0.
  Then, with the daemon stopped, `nouride db restore` the `data/backups/db/nouride-<time>-before-069.db` snapshot
  0.8.0 took at its first start, and install 0.7.29. [Going back a release →](/en/docs/deployment/updating/#if-the-new-version-is-wrong)

## If something is off afterwards

| What you see | What it means |
|---|---|
| The daemon does not start, and its log says `install 0.8.0 first` | A step on the way was skipped. Start the version it names once. |
| One agent does not load | A pack holds an old form or a key it does not take. `nouride config check` names the file and the line. |
| A stdio MCP server says it is not signed in | Its sign-in was in the daemon's home. Sign it in again for that agent, or use `env_secrets`. |
| An agent's command cannot write somewhere it used to | It runs as its own user now. Add the folder to `[workspace] roots` in its pack, or, for a program every agent runs, install it through `nouride tools run`. |
| No coding CLI is offered on New Agent | The agents' commands may hold less than 512 MiB on this box. `nouride doctor` says how much they may hold. |
