# Adding an agent

When somebody asks for a new agent ("add an agent", "tambahin agent baru dong", "I want one for my repo"), it is a
short conversation, then `agent_create`. They should not need to know what a pack, a profile or a provider is: you
ask, you suggest, they answer.

## Ask, one thing at a time

One question a message, each with your suggestion, in their language. Never send a form to fill in. Skip what they
already said.

1. **What is it for?** Their answer becomes its headline: one line, at most 150 characters, that other agents read
   when they decide whom to ask.
2. **Internal or external.** Say the difference in a sentence:
   - *Internal*: Nouride runs it on a model, with its own memory, persona and tools. Right for nearly everything:
     research, writing, reminders, a person's errands.
   - *External*: a coding CLI on this machine answers it (Claude Code, Codex, or one added in
     `config.toml`), working in a folder or a repository. Right for coding work.

   Before you offer external, run `nouride agents scan` (the `nouride` tool, `["agents", "scan"]`) and offer only the
   CLIs it says are installed. One that is not installed cannot be used yet; the scan prints the command that installs
   it. If you are the orchestrator, you install the programs every agent runs: offer to install it yourself, and on a
   yes run that command through `nouride tools run`, as `["tools", "run", "--", "npm", "i", "-g", "<package>"]`, the
   package-manager line where the scan gives more than one (never `curl … | sh`). Install what the scan names and
   nothing beside it. Codex's package carries Codex itself. A person is always asked before an install for every
   agent runs, at every approval level. Then `["agents", "scan"]` again, which looks again each time: what it says then
   is how it stands. The two built in install with npm, and Claude Code's needs Node 22 or later; a container's image
   has neither: `["pkg", "install", "nodejs", "npm"]` adds them, a person approving it, and a recreate keeps them;
   or the image is built with them (`EXTRA_PACKAGES="nodejs npm"`). If you are not the orchestrator, the
   scan names an install no package manager runs, or `npm` is not on this machine, say the command, and that the
   orchestrator or whoever runs this machine runs it; carry on when it is done.
3. **Its name**, and an emoji if they like. Suggest the id from the name: lowercase, letters, digits and dashes.
4. **Its persona**, for either kind. Propose a short SOUL from what they told you (its tone, what it does, what it
   never does) and let them change it. An external agent's CLI reads it too: Nouride writes its persona files into the
   CLI's own instruction file. **For an internal agent, the model:** the install's default unless they ask for another.
   **For an external agent, the account** (`external.profile`): `default`, unless they want another account than an
   agent already on that CLI. **Its model** is the CLI's, as the CLI names it: `external.model`, not `model`, which is
   Nouride's own model for it, the one that answers when its CLI cannot; leave that to the default. Without one the CLI
   uses its own default; its Brain tab lists what the CLI offers once it is signed in.
5. **Its look**, if they want one: its cat in the Office. Offer to leave it to its id, or to pick a few parts: fur,
   pattern, outfit, outfit colour, hat, accessory, eyes.

## Say it back, then create it

Put everything in one message (name, what it is for, internal or the CLI and account, the persona in a line or two,
the look if any) and ask whether to create it. Only on their yes, call `agent_create` with the same values
(`external: { cli, profile, model }` for an external agent, `look` by part, each part one of the words it lists). Where your approval level asks, the prompt that
follows is theirs to answer; it is not a second question from you.

Ask whether it should start working now; `enable` only if they say so.

## An agent that exists, answered by a coding CLI

When they want an agent they already have ("make Nix Claude Code") to be answered by a CLI instead of its model,
say what changes first: the CLI answers it from now on, on an account it signs in to; its persona files stay, and the
CLI reads them; its memory and notes stay, reached through the tools Nouride lends the CLI; its skills go with it, to
Claude Code and to Codex alike, except one that needs a Nouride tool the CLI cannot call. On their yes:
`["agent", "external", "<id>", "<cli>"]`, with `"--profile", "<name>"` for another sign-in than `default`. Back to its
model: `["agent", "internal", "<id>"]`. The orchestrator stays a Nouride agent: Nouride's approval level, fixed list and
tool switches do not reach a CLI's own commands, and the orchestrator is the agent anyone in a room reaches.

**Never read or change another agent's files any other way.** `nouride tools run` installs programs for every agent and
does nothing else; another agent's pack and its folder are not yours to open.

## After

- **Internal:** say it is there, and how to reach it: by name in a room, or from the dashboard's chat.
- **External:** it answers nothing until its CLI is signed in. `agent_create` gives the link to its Brain tab: send it,
  and say the sign-in happens there: Sign in, open the link it shows, and finish on that tab (Claude Code: an account
  is signed in once, on Models → Coding CLIs, for every agent on it). Until that tab says signed in, it is not ready:
  do not tell them it is. **Never ask for the code in a chat**: it is a credential, and a chat keeps it.

**Signing a CLI in is never yours to do.** Never run a CLI's login yourself (`codex login`, `claude auth login`, any
other), not to help, and not before the agent is made: it signs in *your own* folder, not the new agent's, and leaves
the person's account with you while the agent still cannot answer. And never offer an API key for one: these CLIs sign
in with the person's own account, in the CLI, on the agent's Brain tab. This is about an agent a CLI answers; a CLI you
run yourself as a worker, by the `coding-agents` skill, signs in to your own folder for your own runs, and never makes
an agent ready.

If `agent_create` refuses, say what it said in plain words (an id that is taken, a CLI that is not installed) and
ask what to change. Do not try again with a guess.
