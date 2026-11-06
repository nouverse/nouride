# Working out why something is down

The order matters more than the commands. Every step below exists because the step after it was
tried first, once, and produced a confident wrong answer.

## 1. Ask the daemon how it is

Start with its own status. It reports the version, how long it has been up, and every connection
with its state. Most investigations end here: a connection that says it is reconnecting is not a
mystery, it is a connection that is reconnecting.

What this rules out in one call: the daemon being down (it answered), the wrong binary running
(it says which), and "all the gateways are broken" when one is.

## 2. Read what it logged, then what it was asked to allow

The log is the daemon's own account of what happened, in order. Read it before forming a theory;
a theory formed first turns the log into somewhere to look for confirmation.

The audit trail is the other half and is easy to forget: it records what was *asked for* and what
was decided. A command that never ran because nobody approved it leaves no trace in the log and an
obvious one here. "It did nothing and logged nothing" is usually this.

## 3. Only then, the host

A daemon that answers its own status is not a host problem. Reach for the operating system when the
daemon cannot tell you something about itself: it is not running at all, the process died, the disk
is full, the port is taken.

When you do get here, remember that the question has changed: you are no longer asking Nouride
anything, so nothing you find is Nouride's account of itself. Say which of the two you are quoting.

## The failures that look like each other

**A connection that is down, and a connection that is refusing one sender.** The first shows in
status. The second does not; the connection is healthy and the message is being dropped on purpose
by the access rules. If one person's messages vanish and everyone else's arrive, it is the second,
and the access and allowlist settings are where to look.

**A provider that is unauthorised, and a model that does not exist.** Both come back as a failed
turn. The daemon classifies them differently and says so; read the classification rather than the
status code. One needs a credential, the other needs a different model name, and trying the fix for
one against the other wastes a restart.

**A change that has not taken effect, and a change that was rejected.** After editing config, run
the config check *before* anything restarts: it runs the same checks the daemon runs at boot,
without starting anything. A config that fails there would have failed at boot too; the difference
is that here you are still in the conversation and can fix it.

**A setting that is right and a companion setting that is missing.** Some fields do nothing until a
second one is set. `config explain <path>` names the companion; a working example copied from
somewhere else does not.

**An external agent that answers, and its CLI that does not.** When an agent's coding CLI cannot answer, its own
model answers that message instead, and the reply opens by saying so. `nouride agents` gives its status, and
an unavailable one says why: its CLI is not installed, it is not signed in, or a new version of the CLI failed its
one-line check, named. `nouride agents scan` says which CLIs this machine has, at which version, and how to install
the rest. Not installed is the orchestrator's to install, on a yes. Signed out is the person's to fix, on the agent's
Brain tab: never run a CLI's login yourself. A version that failed its check is the person's to update again or roll
back.

**An MCP server that lost its sign-in, and one that is down.** One that is down does not connect, and its status
says so. Since 0.8.1, where each agent is its own user, an agent's stdio MCP server runs as that agent, with that
agent's HOME: one that kept its sign-in or settings in the daemon's HOME still connects, but answers as if never
signed in or set up, from the upgrade on. The way back is the person's: sign it in again for each agent, give it its
token through `env_secrets` where it reads one, or copy what it saved into the agent's own folder. Do not read
another agent's folder or the daemon's HOME to look.

## Before you say it is broken

Say what you checked and what each check answered. "The Discord connection reports connected, the
log has no errors since the restart, and the audit trail shows no refused calls" is a report
somebody can act on. "It seems fine on my end" is not, and it is the same investigation.
