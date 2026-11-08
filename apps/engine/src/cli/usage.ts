/**
 * `nouride help`.
 *
 * One screen, grouped the way the commands are actually reached for rather than alphabetically.
 */

import { BOLD, DIM, RESET, emit, plain, say, usageError } from "@/cli/ui.ts";
import { VERSION } from "@/cli/version.ts";

/**
 * `nouride <command> <action>` with an action the command does not have: exit 2, with the command's own lines of
 * help. It used to fall through to the command's listing, which answered a typo with a success.
 */
export function unknownAction(command: string, action: string): never {
  return usageError(`\`nouride ${command}\` has no "${action}".`, plain(usageFor(command) ?? "Run `nouride help`."));
}

/** Exit 2 unless `action` is one of `actions` — or absent, or a flag standing where an action would. */
export function knownAction(command: string, action: string | undefined, actions: readonly string[]): void {
  if (action !== undefined && !action.startsWith("-") && !actions.includes(action)) unknownAction(command, action);
}

/** A positional that has to be a whole number, or exit 2 saying so. */
export function wholeNumber(command: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) usageError(`\`nouride ${command}\` takes a count here, not "${value}".`, plain(usageFor(command) ?? ""));
  return n;
}

export function usage(): void {
  const text = usageText();
  emit({ help: plain(text) });
  say(text);
}

/**
 * A command's lines of `nouride help`, as its answer — for a bare command whose answer is what it can do: `nouride db`,
 * `nouride config`. Said as help, which is what `--json` answers with (`{ help }`), and exit 0, as `--help` is. Not for
 * a call missing what it needs, which is asking wrongly: `usageLines`, exit 2 (`lint:cli` tells the two apart).
 */
export function helpFor(command: string): void {
  const lines = usageFor(command) ?? "Run `nouride help`.";
  emit({ help: plain(lines) });
  say(lines);
}

/**
 * The lines of `nouride help` about one command, with their continuation lines — or null if none.
 *
 * `nouride secret --help` used to reach the command itself, which either failed on the flag or ignored
 * it and ran: an agent exploring the CLI through the `nouride` tool got an error six times in two
 * weeks for asking the question a person would ask first. The help text is the one list of what each
 * command takes, so this reads it rather than keeping a second copy per command.
 */
export function usageFor(command: string): string | null {
  const lines = usageText().split("\n");
  const picked: string[] = [];
  let inside = false;
  for (const line of lines) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    if (/^\s{2}nouride\s/.test(plain)) inside = plain.trimStart().split(/\s+/)[1] === command;
    else if (!/^\s{4,}\S/.test(plain)) inside = false;
    if (inside) picked.push(line);
  }
  return picked.length > 0 ? picked.join("\n") : null;
}

function usageText(): string {
  return `${BOLD}nouride${RESET} ${DIM}v${VERSION}${RESET}: multi-agent AI engine

${BOLD}Setting one up${RESET} ${DIM}(a first run, or another machine, not this daemon)${RESET}
  nouride setup                    Turn an EMPTY directory into a working install. Refuses
                                   if one is already here. --api-key-from-env VAR names the
                                   variable holding the key. A key is never taken as an
                                   argument, where it would land in shell history and ps.
                                   --model picks the first provider's model. Unattended, with --yes:
                                   --provider anthropic|openai --base-url <url> --agent <id>
                                   --name <name> --prompt "<one line>" --headline "<one line>"
                                   --config <file>
  nouride service status           Which supervisor is keeping a daemon alive, if any
  nouride service install --user u Writes a unit file and PRINTS the privileged commands
                                   that activate it, and never runs them itself
  nouride service uninstall        Prints the commands that remove it
  nouride service diff             What the installed systemd unit lacks of this version's
                                   both take [--dir path] [--kind systemd|launchd|procd]
                                   install also takes [--exec path] and [--privileged],
                                   which drops the systemd sandbox so the agent can
                                   manage this host (for a machine dedicated to it)

${BOLD}Running the daemon${RESET}
  nouride start                    Run the engine in this process
  nouride stop                     Stop this install's daemon (no token needed)

${BOLD}Without a running daemon${RESET} ${DIM}(these read the install's own files, so they answer when it is down)${RESET}
  nouride doctor [--fix]           Diagnose a setup that is not working: config, disk, the database's
                                   own check, file modes, then whatever the daemon reports if it is up.
                                   --fix narrows a secret's file mode the daemon would have set anyway
  nouride db backup                Snapshot the database now, verified before it is kept
  nouride db list                  Snapshots, newest first
  nouride db verify [file]         Integrity-check a snapshot, or the live database
  nouride db restore <file>        Put one back. Daemon must be stopped.
  nouride db adopt                 Accept this build's schema for this database. Daemon must be stopped.
  nouride users reset              Remove every dashboard account, so the next start creates a new admin
                                   and prints its password (for a lost first password). Snapshots the database
                                   first. Daemon must be stopped.
  nouride gateway rename <old> <new> [--apply]   Rename an instance. Daemon must be stopped.
  nouride config check [file]      Validate a config without starting anything
  nouride config schema [section]  Every valid config key, as JSON Schema
  nouride config explain <path>    What one config key is, and what it needs
  nouride policy                   What always asks, and what never does
  nouride policy check <command…>  Would this command be gated? Answers without running it.
                                   After --, the words are the command's own: policy check -- ls --help
  nouride pkg [status]             System packages: whether this box can install them, and with what
  nouride pkg check <install|remove|upgrade> <name…>   What it would change, changing nothing
  nouride pkg install|remove <name…>   From this host's repositories; protected packages are refused
  nouride pkg upgrade [name…]      No names: everything with an update
  nouride pkg refresh              Read the package lists again
  nouride tools run -- <command…>  Install or update a program every agent runs, as the daemon's user: the
                                   orchestrator's job; an agent's own installs stay in its HOME. An installer only:
                                   npm or bun with -g, pipx, uv tool, pip, cargo, go install, rustup, claude update
  nouride update --rollback [--apply]
                                   The version before this one, back. Says what it would do: which build,
                                   and whether the database goes back to the snapshot taken before the
                                   update migrated it, and what that loses; --apply does it, daemon stopped
  nouride version

${BOLD}Talking to a running daemon${RESET}
  nouride chat [agent]             Interactive chat, no bot token needed
  nouride status                   One-screen summary
  nouride agents                   List agents and their state
  nouride agents scan              The coding CLIs this box has for external agents, and their versions
  nouride agents login <id>        Sign an external agent's CLI in: run on the box, answered here a line at a time
  nouride agents update <cli> [<version>]   A coding CLI to the newest version this Nouride was tested with, or to
                                   <version>; installed as tools run installs, then checked before its agents work
  nouride acp [--agent <id>]       An agent in Zed or another ACP editor: the editor runs this, on this machine
  nouride agent <sleep|wake|reload> <id>    asleep, it takes no work until wake, a restart included
  nouride agent <enable|disable> <id>       written to config.toml, so it survives one
  nouride agent external <id> <cli> [--profile <name>]   a coding CLI answers it instead of its model
  nouride agent internal <id>               its model answers it again
  nouride agent skill-root <add|rm> <id> <path>   a folder whose .agents/skills it takes as its own skills
  nouride gateway [list]           Gateway connection status
  nouride gateway add --platform <p> --name <n> --agent <id> --stdin
                                   --token <value> inline instead (kept forever in the grant and the
                                   audit log), --token-secret <name> for one already stored,
                                   --session-dir <path> for WhatsApp, --disabled to write it unconnected
  nouride gateway rm <id>
  nouride gateway restart <id> --then "<follow-up>" [--in <seconds>] [--gateway <id> --chat <id> --agent <id>]
                                   --then is how an agent comes back to check; --no-then for a person watching

  nouride provider [list]          Model provider profiles
  nouride provider add <name> --kind openai|anthropic --url <base> --stdin [--no-probe]
                                   --key <value> inline instead, kept forever in the grant and the audit log
  nouride provider rm <name>

  nouride secret [list]            Stored credential NAMES (values are never printed)
  nouride secret set <name> --stdin   (--value <value> inline, kept forever in the audit log)
                                   --field name=text, repeated: what it is, its site, its account (never secret)
  nouride secret field <name> name=text… [--remove name]…
                                   Change what is said about a secret; its value stays as it is
  nouride secret rm <name>
  nouride secret seal --stdin      The backup passphrase: config snapshots then hold the secrets, sealed to it
                                   (--off keeps them out). Only the passphrase opens them; it is not kept
  nouride secret unseal <file> --stdin --out <path>
                                   A snapshot's secrets.sealed, opened into a file at 0600 (no daemon needed)
  nouride secret restore [<file>] --stdin
                                   The secrets back from a copy sealed to the backup passphrase, under this
                                   install's key: for a lost key or a moved install (Nouride stopped)
  nouride secret decrypt --out <path>
                                   The store as a version before 0.8.19 reads it (secrets.json), for the way
                                   back; run as the user who can read the key (root, with install.sh)
  nouride approvals [list] [--all] Pending tool approvals; --all adds the answered ones
  nouride approvals show <id>      One approval, pending or answered
  nouride approvals <allow-once|allow-always|deny> [id]
  nouride grants [list] [--all]    Standing command permissions; --all with the revoked ones
  nouride grants revoke <id|--all> [--agent <id>]
  nouride jobs [list] [--all]      Background jobs: what runs, and the last five ended; --all for the rest
  nouride jobs log|kill <id>
  nouride mission [list] [--all]   Missions: what needs you first, then what runs, then the last five ended
  nouride mission show <id>        One mission: its goal, checks, checklist, limits and report
  nouride mission stop|continue|accept <id> [text]
  nouride mission answer <id> <answer>
  nouride mission tell <id> <words> Tell a mission something while it works: read before its next step
  nouride mission delete <id> [--force]
                                   Delete an ended mission: its conversation, checklist and own folder;
                                   --force also loses work nobody committed in that folder
  nouride cron [--all]             Scheduled jobs
  nouride cron add --name … (--at 2h|--every 15m|--cron "0 9 * * *") --gateway <id> --chat <id>
                                   --text <message> a plain reminder, no model call; --message <prompt>
                                   wakes the agent; --command <shell> runs a command (--cwd <dir>, and
                                   --then agent to wake the agent with what it printed; a run that
                                   prints nothing sends nothing); --mission <goal>
                                   runs each time as a mission (--check <command>, --no-review).
                                   --agent <id>, --tz <zone>, --session fresh|isolated|chat, --quiet, --keep
  nouride cron update <id> [--name …] [--at|--every|--cron …] [--tz <zone>] [--text <message> | --message <prompt>] [--agent <id>]
  nouride cron run|runs|enable|disable|rm <id>
  nouride webhook                  Endpoints that run a job when called, not on a clock
  nouride webhook add --name … --agent <id> --gateway <id> --chat <id> --message <prompt>
                                   --text <message> instead, no model call; --session fresh|isolated|chat; --quiet
  nouride webhook rotate <id>      Issue a new URL; the old one stops working
  nouride webhook test <id>        Whether a call from the internet arrives (the job is not run)
                                  Use 'nouride cron' for rm/enable/disable/run/runs: they are the same jobs.
  nouride skills [agent] [-v]      Skills an agent is offered, and when each was last read
  nouride skills --all             Every skill in the pool, who has it on, and missing software
  nouride skills on|off <s> <a>    Switch one skill on or off for one agent
  nouride skills drafts            Skills the agents have proposed, waiting on you
  nouride skills draft <id>        One draft in full, with the turn it came from
  nouride skills approve|deny <id> Put a draft in the pool, or discard it
  nouride skills review            Review the library now: tighten, merge, archive. Proposals wait in drafts
  nouride skills search <query> [--source skills.sh,clawhub,well-known]   Find skills on the public hubs
  nouride skills install <source>  Fetch one (owner/repo, URL, clawhub:slug…) as a draft to approve
  nouride tool-budget              Tool round-trips one reply may spend, per daemon and per agent
  nouride tool-budget <n>          Set the daemon default
  nouride tool-budget --agent <id> <n|follow>
  nouride turn-budget              Seconds one reply may take, per daemon and per agent
  nouride turn-budget <seconds>    Set the daemon default
  nouride turn-budget --agent <id> <seconds|follow>
  nouride access [list|pending|approved|denied|blocked]   Who may talk to the agents
  nouride access mode [open|allowlist|pair]   What happens to somebody new; no word says which is in force
  nouride access approve <code> [--me | --as <person key> | --new "<name>"]
                                   Approve a pairing request, and say who they are
  nouride access allow <gateway:sender> [--name <name>]   Let somebody in before they ask
  nouride access deny|block <gateway:sender>
  nouride access revoke|reset|unblock <gateway:sender>
  nouride people [list]            Who the agents know, from config and from conversations
  nouride people set <key|platform:account> --name <name> [--note <note>] [--reattach]
  nouride people remove <key|platform:account>   Take them out of People; their memory stays (nouride memory forget)
  nouride memory [settings]        What the agents remember: the nightly pass, facts, search
  nouride memory set <key> <value> pass | pass_at | facts | propose_shared | recall | prompt_recent | transcript_days | …
  nouride memory episodes [words] [--agent <id>] [--person <key>] [--tag <tag>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--status raw|summarized|compacted] [--limit N]
  nouride memory show <episode>    One conversation, whole
  nouride memory pass              Run the nightly pass now: cut today's conversations and file them
  nouride memory proposals         What the nightly pass proposed and waits for you
  nouride memory approve|deny <id>
  nouride memory changes [--person <key>]   What memory changed, and why, newest first
  nouride memory failed            Conversations the pass could not file
  nouride memory retry [<episode>] Try those again on the next pass
  nouride memory undo <person|shared>   Put a profile back one version
  nouride memory forget <person> [--anonymize]   Remove a person for good (or only hide their name)
  nouride memory tags              Tags by use, and how many are on one conversation only
  nouride memory tags tidy [--apply] [--only merge,trim,cap,R5]   What the rules would merge and trim; --apply does it (vault backed up first; R5 only when named)
  nouride memory tags suggest      The model's view of tags that mean one subject (shown, never applied)
  nouride memory tags merge <tag…> --into <tag>   Merge tags by hand, recorded like a tidy
  nouride memory tags undo         Put the newest tidy back
  nouride memory reindex           Rebuild the memory index from the files
  nouride memory embed             Give every conversation and fact a vector (semantic search)
  nouride knowledge [list]         The knowledge base: its collections, who may be answered from each
  nouride knowledge search <words> [--in <collection>]   Sections of the documents that match, best first
  nouride knowledge add <file> --to <collection>   Add a file to a collection, and read it: text, PDF, Office
  nouride knowledge add - --name <file name> --to <collection>   The same, the file on stdin
  nouride knowledge reindex [collection]   Read again what changed in the knowledge folder
  nouride knowledge archive|unarchive <collection>   Keep a collection without searching it, or search it again
  nouride knowledge title <collection>/<file> <words>   The words search finds a document by, beside its file's name:
                                   in English, it is found in any language; "" takes them off
  nouride knowledge rm <collection>/<file>   Remove a document
  nouride audit [limit]            Recent audited actions
  nouride logs [-n N] [-f]         Recent daemon log (works without a journal, and remotely)
                                   --lines N is -n, --follow is -f; --level warn, --component <name>
  nouride mcp                      The install's MCP servers, which agents use each, and their tools
  nouride mcp search [words]       Servers in the MCP catalog (the official registry, ranked by Nouverse):
                                   who published each, how it runs; no words lists Nouverse's picks
  nouride mcp add --name <name> (--command <exe> | --url <url>) [--agent <id> …] [--stdin]
                                   Into the library (agents/mcp.toml); --agent switches it on for that agent.
                                   --arg <value> per argument and --cwd <dir> for a command; --sse for
                                   the legacy transport; --header <name> to send the token under;
                                   --token <value> inline, kept forever in the grant and the audit log;
                                   --env-secret VAR=<secret> per credential variable of a command, --env VAR=<value>
                                   for a plain one; --per-agent when each agent brings its own credential;
                                   --from <registry-name> fills the rest in from the registry
  nouride mcp enable|disable <name> --agent <id> [--own-login | --env-secret VAR=<secret> | --stdin | --library-credential]
                                   Switch it on or off for one agent, or give that agent its own credential
                                   (--library-credential goes back to the library's). The agent is reloaded at once.
  nouride mcp tools <name> --agent <id> [--only <tool,…> | --all]
                                   The server's tools for one agent, each with what it adds to every request;
                                   --only gives the agent just those (the rest are not sent, nor callable),
                                   --all gives it every one again
  nouride mcp rm <name> [--agent <id>]
                                   Take it out of the library and every agent or, with --agent, off for that one
  nouride mcp login --server <name> [--agent <id>] [--client-id <id>]
                                   Log a remote server in (OAuth): the library's login, or with --agent the one that
                                   agent uses. Prints the address to open, then takes the one the browser landed on,
                                   so it works over SSH. --client-id for a server that registers no clients itself; its
                                   secret is asked for, never typed inline
  nouride mcp logout --server <name> [--agent <id>]   Delete a login; the servers using it wait for one again
  nouride mcp-server               Nouride as an MCP server for other tools (Claude Code, Cursor): on/off, tokens
  nouride mcp-server on|off
  nouride mcp-server token create --person <key> --agents <id,id> --label <client> [--scopes memory,memory:write,personas] [--ttl <days>]
  nouride mcp-server token list|revoke <id>
  nouride sessions                 Stored conversations
  nouride turns [--agent <id>] [--limit N]   The newest turns, with what each cost
  nouride turns show <id>          One turn whole: every model call (tokens, cost, latency, retries),
                                   its steps and its tool calls. A shortened id works when it names one.
  nouride events [--turn <id>] [--gateway <id> --chat <id>] [--kinds a,b] [--since <seq>] [--limit N] [-f]
                                   What turns do as it is written down: steps, the answer, tool calls,
                                   model calls. -f (--follow) follows it, and picks up where it was after a drop
  nouride restart [--then "<what to check after>"] [--now] [--force] [--wait]
                                   [--in <seconds>] [--gateway <id> --chat <id> --agent <id>] [--no-then]
                                   Restart the daemon for its supervisor to start again.
                                   Waits until nothing is running (within ten minutes); --now at once.
                                   An agent must pass --then; a person needs nothing more.
                                   --wait returns once it is back, and fails if it is not.
  nouride update [--check]         Which version and edition this is, and whether a newer
                                   one exists. Reporting is the default; --check is the same
                                   thing said out loud, and neither touches anything.
  nouride update --track latest|lts
                                   Which releases this install is offered: latest, the newest; or lts,
                                   a long-term line (1.0 the first) it moves to and stays on. Then checks.
  nouride update --start [--then "<what to check after>"] [--now] [--wait]
                                   [--in <seconds>] [--gateway <id> --chat <id> --agent <id>] [--no-then]
                                   Take it: download, verify, swap, restart. Always asks.
                                   An agent must pass --then; a person needs nothing more.
                                   Restarts once nothing is running (within ten minutes); --now at once.
                                   --wait returns once the new version answers, and fails if it does not.

${DIM}--json on any command prints one object, {ok, data, error, hint}, instead of lines. Exit codes: 0 done,
1 failed, 2 asked wrongly (an unknown command or action, a flag the command does not take, a missing or
malformed argument).
A flag's value goes after it or after =, as --limit 5 or --limit=5; after a bare --, nothing is a flag.
A secret is read from stdin with --stdin.
Reads data/.control-token for auth. $NOURIDE_URL and $NOURIDE_TOKEN target a remote daemon.${RESET}`;
}
