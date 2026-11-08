/**
 * This daemon's own CLI, as an agent reaches it: which `nouride` verbs are on the fixed list, and which entry.
 *
 * ## Why an agent's `nouride` is not the operator's
 *
 * Checked rather than assumed: the `nouride` tool runs the CLI as the daemon's user, from the install, and the CLI
 * reads the control token by itself, which gives it the role the operator has. So an agent holding the tool reaches
 * every control route. The operator's own terminal never passes through here; only the agent's calls do, which is why
 * a row here costs the operator nothing.
 *
 * ## One row per verb that acts
 *
 * Every other verb stays ordinary. Classifying the whole CLI would put `nouride status` in front of a human, and a gate
 * that fires on reading the daemon's own health is one an operator switches off. So each row names the verb that
 * *acts*, and the bare verb that lists stays off the list: `nouride approvals` shows what is pending,
 * `nouride approvals allow-always` answers it. Every form the CLI has is either here or named ordinary in
 * `apps/engine/tests/contracts/own-cli-verbs.test.ts`, so a new verb is a decision, not an omission.
 */

import type { HardlineClass } from "@nouride/shared";
import type { HardlineVerdict } from "./hardline.ts";

/**
 * The answers `nouride approvals` takes — the CLI's own list, in `cli/commands/approvals.ts`. A copy, held to it by
 * `own-cli-verbs.test.ts`, as `ACCESS_CHANGES` below is. And `approve`, which this CLI and the route refuse since
 * 0.8.0: a `nouride` from 0.7.10 to 0.7.28 on the PATH maps it to `allow-once` itself before it asks the route.
 */
const APPROVAL_ANSWERS = new Set(["approve", "allow-once", "allow-always", "always", "deny"]);

/**
 * Every `nouride access` verb that changes somebody's standing — `ACCESS_CHANGES` in `cli/commands/access.ts`.
 *
 * The tightening ones too. Blocking the operator's own account is a lockout a prompt can ask for, and
 * "who may talk to the agents here" is one boundary whichever way it moves.
 */
const ACCESS_CHANGES = new Set(["approve", "allow", "deny", "block", "revoke", "reset", "unblock"]);

interface Row {
  verb: string;
  /** The words after the verb that act. */
  acts: (rest: readonly string[]) => boolean;
  class: HardlineClass;
  reason: string;
}

const actions = (...names: string[]) => (rest: readonly string[]) => names.includes(rest[0] ?? "");

/**
 * The words `db` and `users` take their action from — `bareArgs` in `cli/args.ts`: before `--` those not starting with
 * a dash, after it every one. So `db -- restore x.db` restores, and read at `rest[0]` it was `--`, on no list.
 */
function bare(rest: readonly string[]): readonly string[] {
  const end = rest.indexOf("--");
  const head = end === -1 ? rest : rest.slice(0, end);
  return [...head.filter((word) => !word.startsWith("-")), ...rest.slice(head.length + 1)];
}

const ROWS: readonly Row[] = [
  // 1. A config.toml changed. A pack's `skills.toml` and `mcp.toml` are not: `skills on|off` and `mcp …` stay off.
  { verb: "gateway", acts: (rest) => ["add", "set", "rm", "delete"].includes(rest[0] ?? "") || (rest[0] === "rename" && rest.includes("--apply")), class: "config", reason: "changes the daemon's config.toml: which chats it answers in, and with which token" },
  { verb: "provider", acts: actions("add", "set", "rm", "delete"), class: "config", reason: "changes the daemon's config.toml: which model provider is called, with which key" },
  { verb: "agent", acts: actions("enable", "disable"), class: "config", reason: "changes the daemon's config.toml: which agents run" },
  // Whether a coding CLI answers an agent (0.8.1): its own config.toml, and who it then is.
  { verb: "agent", acts: actions("external", "internal"), class: "config", reason: "changes an agent's config.toml: whether a coding CLI answers it instead of a model" },
  // A skill root (0.8.24): a folder whose skills become an agent's instructions, asked as `skill_root` is — at every
  // level, of an admin. The CLI reads the control token, so through the `nouride` tool it was the same change unasked.
  { verb: "agent", acts: actions("skill-root"), class: "persona", reason: "adds or removes a folder whose skills become an agent's instructions, which an admin alone answers" },
  // A program every agent runs, installed as the daemon's user (0.8.1): asked under trusted too (`shared-tools`).
  { verb: "tools", acts: actions("run"), class: "shared-tools", reason: "installs or updates a program every agent runs, as the daemon's user, and its install scripts run as the user that owns every pack and the secret store" },
  // A coding CLI updated (0.8.24): installed as `tools run` installs, for every agent on it.
  { verb: "agents", acts: actions("update"), class: "shared-tools", reason: "installs another version of a coding CLI every agent on it runs, as the daemon's user, and its install scripts run as the user that owns every pack and the secret store" },
  // This machine's packages, as root, through nouride-pkg (0.8.15): `check`, `status` and `refresh` change nothing.
  { verb: "pkg", acts: actions("install", "remove", "upgrade"), class: "system-packages", reason: "changes this machine's installed packages, as root, through nouride-pkg" },
  // Asleep (0.8.0) is a person's to set: an agent does not silence another, nor wake one a person put to sleep.
  { verb: "agent", acts: actions("sleep", "wake", "pause", "resume"), class: "access", reason: "puts an agent to sleep or wakes it: a person's decision, not another agent's" },
  { verb: "memory", acts: actions("set"), class: "config", reason: "changes the daemon's config.toml: how memory is kept" },
  { verb: "setup", acts: () => true, class: "config", reason: "writes the daemon's config.toml" },

  // 2. Someone given access, or answered for.
  /**
   * Answering an approval — the question that was put to a person. With no id, `approvals allow-always` answers
   * whatever is first in the queue, and that can be the agent's own request: `delegate` runs helpers in parallel, so
   * one can ask while another answers. `deny` as well: refusing on somebody's behalf is still answering for them.
   */
  { verb: "approvals", acts: (rest) => APPROVAL_ANSWERS.has(rest[0] ?? ""), class: "access", reason: "answers an approval request: a decision that was put to a person, not to an agent" },
  // A standing permission a person granted, taken back. Rarely harmful, and still theirs to take.
  { verb: "grants", acts: actions("revoke"), class: "access", reason: "revokes standing permissions a person granted" },
  /**
   * Who People says a person is (0.8.9): an admin is a person there holding an admin's dashboard account, so a chat id
   * linked to their entry answers what only an admin may. `access approve --as <key>` and `--me` link the sender to a
   * person, and `--new` makes one for them — taking their id off whoever held it, an admin too (`linkIdentity`); `people
   * set` renames one or makes one of an account, and `people remove` takes an admin's chats away. Above the `access` row,
   * which would take them otherwise. A plain `access approve` names nobody, and stays there.
   */
  { verb: "access", acts: (rest) => rest[0] === "approve" && ["--as", "--me", "--new"].some((flag) => rest.includes(flag)), class: "people", reason: "links whoever sent this code to a person in People; linked to an admin, that chat answers what only an admin may" },
  { verb: "people", acts: actions("set", "remove"), class: "people", reason: "changes who the agents know a person to be, and an admin is one" },
  // `access mode` alone reports the mode; with a value it changes it.
  { verb: "access", acts: (rest) => ACCESS_CHANGES.has(rest[0] ?? "") || (rest[0] === "mode" && rest[1] !== undefined), class: "access", reason: "changes who may talk to the agents on this daemon" },
  { verb: "users", acts: (rest) => bare(rest)[0] === "reset", class: "access", reason: "resets a dashboard login" },
  // A bearer token for this daemon's MCP server is a credential for memory and personas that outlives the turn.
  { verb: "mcp-server", acts: (rest) => rest[0] === "on" || rest[0] === "off" || (rest[0] === "token" && (rest[1] === "create" || rest[1] === "revoke")), class: "access", reason: "changes who can reach this daemon's MCP server" },
  // A login is the person's to give: it is their account at Notion or Linear the agent then acts as.
  { verb: "mcp", acts: actions("login", "logout"), class: "access", reason: "logs an MCP server in or out on a person's account: theirs to do, not an agent's" },

  // 3. The daemon stopped, or — `careful` only — replaced.
  { verb: "stop", acts: () => true, class: "stop", reason: "stops this daemon" },
  { verb: "service", acts: actions("install", "uninstall"), class: "stop", reason: "rewrites or removes the service that keeps this daemon running" },
  /**
   * Replacing this daemon's own binary: it downloads an executable and puts it where this process is started from
   * next. Gated on `--start`, not on the absence of `--check`: the bare command reports, and reading a version number
   * is never gated — an agent that has to interrupt somebody to answer "are we current?" is one nobody asks.
   */
  { verb: "update", acts: (rest) => rest.includes("--start"), class: "replace", reason: "replaces this daemon's own binary with one downloaded from the release channel, and restarts it" },

  // 4. A stored secret replaced or deleted. The CLI cannot tell a new name from a kept one, so `set` is asked.
  { verb: "secret", acts: actions("set", "rm", "delete"), class: "secret", reason: "changes a credential this daemon resolves its keys from" },

  // 5. The database, written.
  { verb: "db", acts: (rest) => ["restore", "adopt"].includes(bare(rest)[0] ?? ""), class: "database", reason: "replaces the daemon's database, which holds every agent's conversations" },

  // 9. Work that later runs with nobody asked.
  { verb: "cron", acts: actions("add", "update", "enable"), class: "unattended", reason: "schedules work that runs later with nobody asked" },
  { verb: "webhook", acts: actions("add", "rotate"), class: "unattended", reason: "lets a request from outside start a turn with nobody asked" },
];

/** The plurals the CLI dispatches to the same command — `COMMAND_ALIASES` in `cli/grammar.ts`, held to it by the test. */
const ALIASES: Readonly<Record<string, string>> = { providers: "provider", secrets: "secret", webhooks: "webhook" };

/**
 * `args` as the CLI dispatches them — `dispatchedArgv` in `cli/args.ts`, held to it by `own-cli-verbs.test.ts`:
 * `--flag=value` split into two words, then every `--json` before `--` taken off, since it is every command's. Read
 * as given, `["--json", "approvals", "allow-always"]` had `--json` for its verb and was on no list, so `balanced`
 * answered it itself — and the CLI answered the approval.
 */
function asDispatched(args: readonly string[]): string[] {
  const end = args.indexOf("--");
  const head = end === -1 ? args : args.slice(0, end);
  const words = [
    ...head.flatMap((arg) => {
      const pair = /^(--[a-z][a-z0-9-]*)=([\s\S]*)$/.exec(arg);
      return pair ? [pair[1]!, pair[2]!] : [arg];
    }),
    ...args.slice(head.length),
  ];
  // Split first, then up to the first `--` of what was split: the order the CLI does it in.
  const options = words.indexOf("--");
  return words.filter((word, at) => word !== "--json" || (options !== -1 && at > options));
}

/** `args` is the argv after `nouride`. Null when the command only reads, or acts on nothing on the list. */
export function classifyOwnCli(args: readonly string[]): HardlineVerdict | null {
  const [said, ...rest] = asDispatched(args);
  const verb = ALIASES[said ?? ""] ?? said;
  const row = ROWS.find((candidate) => candidate.verb === verb && candidate.acts(rest));
  return row ? { class: row.class, reason: row.reason } : null;
}

/**
 * A command this CLI runs for the agent, to classify as itself: `tools run -- <command>`, which runs it as the daemon's
 * user (`asDaemon`, so the daemon's own state is in reach), and `cron add|update --command <shell>`, which runs it
 * later with no model and no gate — so a command that would ask now asks when it is put in a job.
 */
export function ownCliInner(given: readonly string[]): { argv: string[]; how: string; asDaemon: boolean } | null {
  const args = asDispatched(given);
  const [verb, action] = args;
  if (verb === "tools" && action === "run") {
    const at = args.indexOf("--");
    return at < 0 ? null : { argv: args.slice(at + 1), how: "as the daemon's user, through `nouride tools run`", asDaemon: true };
  }
  if (verb === "cron" && (action === "add" || action === "update")) {
    const at = args.indexOf("--command");
    const shell = at < 0 ? undefined : args[at + 1];
    return shell ? { argv: ["sh", "-c", shell], how: "scheduled, to run with no model and no gate", asDaemon: true } : null;
  }
  return null;
}
