/**
 * Default content for a new agent's core files.
 *
 * Every persona file an agent reads — IDENTITY.md, SOUL.md, AGENTS.md, MEMORY.md — is scaffolded
 * when an agent is created, whether by the setup wizard, the CLI, or the `agent_create` tool. An empty
 * slot is indistinguishable from a slot that does not exist, so the operator who creates an agent and
 * then wonders why `AGENTS.md` is not being read has no way to discover it without reading the source.
 * Writing a file with real starting content removes that mystery.
 *
 * There is no `USER.md` since 0.7.0. One file describing "the user", read on every turn whoever was
 * speaking, greeted a household's second person by the first one's name. Who somebody is lives in
 * People, with the operator's notes about them, and reaches the prompt only when they are speaking.
 */

/**
 * Standing procedure. Deliberately short: this section is essential in the prompt and is never
 * trimmed, so it is paid for on every single turn.
 *
 * The last two rules were added after auditing the operator's own six-agent install, where every pack
 * had drifted the same way. `AGENTS.md` had grown to 2,200 tokens carried on every turn, most of it
 * either a copy of what the harness already says or a section that mattered to one agent and had been
 * pasted into all six. And every `MEMORY.md` ended with the household's phone numbers and WhatsApp
 * ids — in a git repository, in files that each opened by forbidding exactly that. Those ids did
 * nothing there: `[[people]]` is what identifies a sender. A starter file is the only chance to say so
 * before a pack has grown around the mistake.
 */
export const STARTER_AGENTS = `# AGENTS

How you operate. \`SOUL.md\` is who you are; this is the standing procedure, and it applies whatever
the conversation is about.

This section is never trimmed from your prompt, so everything here is carried on every turn. Keep it
short: a rule that only matters inside one kind of work belongs in a skill, and anything the harness
already tells you does not need saying twice.

## Doing the work

What you were asked to do, do without asking again. Whenever you already know the next commands (for
any kind of work, not only code), run them as one chained command (\`a && b && c\`) or one short
script in a single \`exec\` call, not one step per turn. Split only when you must see one output before
choosing the next command. Ask first only for what is destructive, irreversible, or outside what was
asked: a migration, an infrastructure or deployment change, deleting data. The daemon's approval gate
is where a person says no; do not ask twice.

## Safety

- Never send private data anywhere it was not asked for.
- Never run a destructive command without asking first.
- Prefer recoverable: \`trash\` over \`rm\` where it exists.
- When in doubt, ask. A question costs a message; a wrong action costs more.
- Never write credentials into this pack. Secrets reach a command through the environment; you never
  see the value.
- Phone numbers and messaging ids belong in the daemon's \`[[people]]\` config, not in these files.
  They do nothing here anyway: the daemon is what recognises a sender, and it tells you who is
  speaking at the top of the turn.

## Free versus ask-first

Read, explore and search freely. Ask first for what is named above and for anything that leaves the
machine: mail, posts, messages to people who did not ask you.

## Write it down

\`MEMORY.md\` is your own notes: how you work, your conventions, what you are in the middle of. A fact
about the person you are talking to goes to \`memory_write\` with about=person; who someone is goes to
\`person_record\`. Conversations are filed for you each night. A lesson for one kind of work belongs in
a skill.
`;

/** A place to write to, and the rule for what belongs in it. */
export const STARTER_MEMORY = `# MEMORY

Your own working notes, durable facts only: how you work, your conventions, what you are in the middle
of. Not facts about people (\`memory_write\` with about=person keeps those), and nothing from a single
conversation.

No credentials here, ever. This pack may be tracked in git.
`;

/**
 * Operator-facing orientation, written beside the pack and never read by the daemon.
 *
 * The persona loader reads exactly four filenames; a `README.md` sitting next to them costs nothing —
 * not a token in the prompt, not a byte of context. That is what makes it the right place for
 * everything an operator needs and an agent does not: which file is for what, what each one costs,
 * and the four ways every pack on the operator's own install had already gone wrong by the time
 * anyone looked. Putting that guidance in `AGENTS.md`, where it would be read by the model on every
 * turn forever, would be committing the exact mistake it warns about.
 */
export const STARTER_README = `# This agent's pack

Four files are loaded into the agent's prompt. Everything else in this directory, including this
file, is ignored by the daemon.

| File | What belongs in it | What it costs |
|---|---|---|
| \`IDENTITY.md\` | Name, role, one-line bio. The only file that must not be empty. | every turn |
| \`SOUL.md\` | Voice and character: how it talks, what it is like to work with. | every turn |
| \`AGENTS.md\` | Standing procedure: what to confirm, what is off limits, how to behave in a group. | every turn |
| \`MEMORY.md\` | The agent's own working notes. It writes here itself. | dropped after dynamic context and recall when the prompt is over budget |

Who the agent is talking to is not a file here. The daemon names the speaker every turn from People
in the dashboard (\`[[people]]\` in its \`config.toml\`), with what you wrote about them there.

\`config.toml\` beside them is the wiring: model, tools, workspace roots. Skills are not configured
there: every skill in \`agents/skills/\` is on for every agent, and \`skills.toml\` beside this file
lists only the ones this agent has switched **off**.

## The four ways a pack goes wrong

**Everything ends up in \`AGENTS.md\`.** The first three files are never trimmed, so every line is paid
on every turn of every conversation. A rule that applies to one kind of work belongs in a skill
(\`agents/skills/<name>/SKILL.md\`), which is loaded only when the agent reaches for it, and is
shared with every other agent.

**The same paragraph in three files.** Say it once. If \`SOUL.md\` describes the voice, \`MEMORY.md\`
does not need a summary of it.

**Repeating what the daemon already says.** The prompt already tells the agent its tools, its
approval rules, its file roots, its own CLI, and who else is in the conversation. Send \`/prompt\` in a
direct message to see exactly what it receives, before writing a rule it already has.

**People in the pack.** Who somebody is (their ids, what to call them, what to know about them) goes
in People, not here. That is what identifies a sender and is said only when they are the one speaking;
ids written here do nothing, and this directory is usually a git repository.

## After you edit

\`nouride agent reload <id>\`: hot, no restart, no dropped conversation.
`;
