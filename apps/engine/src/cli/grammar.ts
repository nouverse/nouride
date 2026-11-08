/**
 * What each command takes: its actions, and the flags each one reads.
 *
 * Checked in `main.ts` before a command runs, so a flag a command does not read is refused with exit 2, naming it —
 * found in 0.7.9's e2e, where `nouride memory pass --dry-run` (exit 2 now) ran a real pass: `pass` reads no flag, so the one that
 * meant "change nothing" was dropped without a word. Every command read its flags for itself, ad hoc, so nothing
 * could say a flag was not read; this list can. It is one rule for every command, before anything is sent or
 * written, and it is what a person or an agent is told when they ask for something that is not there.
 *
 * The list is held to the code and the help by `scripts/check-cli-help.ts`: every flag a command's source reads is
 * declared for it here, and every action and flag declared here is in its lines of `nouride help` — except what is
 * `untaught`: a second name for an action, kept on purpose. The old spellings 0.7.x read beside today's are not here;
 * 0.8.0 refuses them by name (`retired.ts`).
 *
 * A form is keyed by the action words it starts with: `""` is the command with none, `"*"` the command given a word
 * that is not an action (an agent id, a count), `"tags tidy"` two words deep. A flag written `--name <value>` takes
 * a value, which is skipped rather than read as a flag, so `--arg -y` passes `-y` to a server.
 */

import { usageError, plain } from "@/cli/ui.ts";
import { refuseRetired } from "@/cli/retired.ts";

/** The words after the action are another command's own, flags included: `policy check rm -rf /tmp/x`. */
export const VERBATIM = "<command…>";

export interface CommandGrammar {
  forms: Readonly<Record<string, readonly string[]>>;
  /** Actions and flags `nouride help` need not show: a second name for one it does, such as `rm`'s `delete`. */
  untaught?: readonly string[];
}

/** `--then` and where to come back to — every command that ends the conversation it was run from. */
const WAKE = ["--then <follow-up>", "--in <seconds>", "--gateway <id>", "--chat <id>", "--agent <id>", "--no-then"];
const NONE: readonly string[] = [];

export const GRAMMAR: Readonly<Record<string, CommandGrammar>> = {
  // `nouride help cron`: these two answer whatever word follows them, as they always did.
  help: { forms: { "": NONE, "*": NONE } },
  version: { forms: { "": NONE, "*": NONE } },
  start: { forms: { "": NONE } },
  stop: { forms: { "": NONE } },
  setup: {
    forms: { "": ["--config <file>", "--yes", "--provider <kind>", "--base-url <url>", "--api-key-from-env <var>", "--agent <id>", "--name <name>", "--model <model>", "--prompt <text>", "--headline <text>"] },
  },
  service: {
    forms: {
      "": NONE,
      status: NONE,
      diff: NONE,
      install: ["--kind <kind>", "--dir <path>", "--user <user>", "--exec <path>", "--privileged"],
      uninstall: ["--kind <kind>"],
    },
  },
  doctor: { forms: { "": ["--fix"] } },
  pkg: { forms: { "": NONE, status: NONE, refresh: NONE, check: NONE, install: NONE, remove: NONE, upgrade: NONE } },
  tools: { forms: { "": NONE, run: NONE } },
  chat: { forms: { "": NONE, "*": NONE } },
  status: { forms: { "": NONE } },
  agents: { forms: { "": NONE, scan: NONE, login: NONE } },
  acp: { forms: { "": ["--agent <id>"] } },
  // `pause` and `resume`, what asleep was called before 0.8.0: kept, untaught.
  agent: { forms: { "": NONE, sleep: NONE, wake: NONE, pause: NONE, resume: NONE, reload: NONE, enable: NONE, disable: NONE, external: ["--profile <name>"], internal: NONE }, untaught: ["pause", "resume"] },
  gateway: {
    forms: {
      "": NONE,
      list: NONE,
      status: NONE,
      restart: WAKE,
      add: ["--platform <platform>", "--name <name>", "--agent <id>", "--stdin", "--token <value>", "--token-secret <name>", "--session-dir <path>", "--disabled"],
      set: ["--platform <platform>", "--name <name>", "--agent <id>", "--stdin", "--token <value>", "--token-secret <name>", "--session-dir <path>", "--disabled"],
      rm: NONE,
      delete: NONE,
      rename: ["--apply"],
    },
    untaught: ["status", "set", "delete"],
  },
  db: { forms: { "": NONE, backup: NONE, list: NONE, verify: NONE, restore: NONE, adopt: NONE } },
  users: { forms: { "": NONE, reset: NONE } },
  provider: {
    forms: {
      "": NONE,
      list: NONE,
      add: ["--kind <kind>", "--url <url>", "--stdin", "--key <value>", "--no-probe"],
      set: ["--kind <kind>", "--url <url>", "--stdin", "--key <value>", "--no-probe"],
      rm: NONE,
      delete: NONE,
    },
    untaught: ["set", "delete"],
  },
  secret: {
    forms: {
      "": NONE,
      list: NONE,
      set: ["--stdin", "--value <value>", "--field <name=text>"],
      field: ["--remove <name>"],
      fields: ["--remove <name>"],
      rm: NONE,
      delete: NONE,
      seal: ["--stdin", "--off"],
      unseal: ["--stdin", "--out <path>"],
      decrypt: ["--out <path>"],
      restore: ["--stdin"],
    },
    untaught: ["delete", "fields"],
  },
  approvals: {
    forms: { "": ["--all"], list: ["--all"], show: NONE, "allow-once": NONE, "allow-always": NONE, always: NONE, deny: NONE },
    untaught: ["always"],
  },
  grants: { forms: { "": ["--all"], list: ["--all"], revoke: ["--all", "--agent <id>"] } },
  people: {
    forms: { "": NONE, list: NONE, set: ["--name <name>", "--note <note>", "--reattach"], remove: NONE },
  },
  memory: {
    forms: {
      "": NONE,
      settings: NONE,
      set: NONE,
      episodes: ["--agent <id>", "--person <key>", "--tag <tag>", "--since <day>", "--until <day>", "--status <status>", "--limit <n>"],
      show: NONE,
      pass: NONE,
      proposals: NONE,
      approve: NONE,
      deny: NONE,
      changes: ["--person <key>"],
      failed: NONE,
      retry: NONE,
      undo: NONE,
      forget: ["--anonymize"],
      reindex: NONE,
      embed: NONE,
      tags: NONE,
      "tags tidy": ["--apply", "--only <kinds>"],
      "tags suggest": NONE,
      "tags merge": ["--into <tag>"],
      "tags undo": NONE,
    },
  },
  access: {
    forms: {
      "": NONE,
      list: NONE,
      pending: NONE,
      approved: NONE,
      denied: NONE,
      blocked: NONE,
      approve: ["--me", "--as <key>", "--new <name>"],
      mode: NONE,
      allow: ["--name <name>"],
      deny: NONE,
      block: NONE,
      revoke: NONE,
      reset: NONE,
      unblock: NONE,
    },
  },
  jobs: { forms: { "": ["--all"], list: ["--all"], log: NONE, kill: NONE } },
  mission: { forms: { "": ["--all"], list: ["--all"], show: NONE, stop: NONE, continue: NONE, accept: NONE, answer: NONE, tell: NONE, delete: ["--force"] } },
  cron: {
    forms: {
      "": ["--all"],
      list: ["--all"],
      add: [
        "--name <name>", "--at <when>", "--every <interval>", "--cron <expression>", "--tz <zone>", "--gateway <id>", "--chat <id>",
        "--agent <id>", "--text <message>", "--message <prompt>", "--command <shell>", "--then <agent>", "--cwd <dir>",
        "--mission <goal>", "--check <command>", "--no-review", "--session <mode>", "--quiet", "--keep",
      ],
      update: ["--name <name>", "--at <when>", "--every <interval>", "--cron <expression>", "--tz <zone>", "--text <message>", "--message <prompt>", "--agent <id>"],
      rm: NONE,
      remove: NONE,
      enable: NONE,
      disable: NONE,
      run: NONE,
      runs: NONE,
    },
    untaught: ["list", "remove"],
  },
  webhook: {
    forms: {
      "": NONE,
      ls: NONE,
      list: NONE,
      add: ["--name <name>", "--agent <id>", "--gateway <id>", "--chat <id>", "--message <prompt>", "--text <message>", "--session <mode>", "--quiet"],
      rotate: NONE,
      test: NONE,
    },
    untaught: ["ls", "list"],
  },
  skills: {
    forms: {
      "": ["-v", "--all"],
      "*": ["-v", "--all"],
      on: NONE,
      off: NONE,
      drafts: NONE,
      draft: NONE,
      approve: NONE,
      deny: NONE,
      search: ["--source <hubs>"],
      install: NONE,
    },
  },
  policy: { forms: { "": NONE, check: [VERBATIM] } },
  audit: { forms: { "": NONE, "*": NONE } },
  logs: { forms: { "": ["-n <count>", "--lines <count>", "-f", "--follow", "--level <level>", "--component <name>"] } },
  mcp: {
    forms: {
      "": NONE,
      ls: NONE,
      list: NONE,
      add: ["--agent <id>", "--name <name>", "--command <exe>", "--url <url>", "--arg <value>", "--cwd <dir>", "--sse", "--stdin", "--token <value>", "--header <name>", "--env-secret <VAR=secret>", "--env <VAR=value>", "--per-agent", "--from <registry-name>"],
      enable: ["--agent <id>", "--name <name>", "--own-login", "--env-secret <VAR=secret>", "--stdin", "--token <value>", "--library-credential"],
      disable: ["--agent <id>", "--name <name>"],
      search: NONE,
      rm: ["--agent <id>", "--name <name>"],
      remove: ["--agent <id>", "--name <name>"],
      login: ["--agent <id>", "--server <name>", "--client-id <id>"],
      logout: ["--agent <id>", "--server <name>"],
      tools: ["--agent <id>", "--name <name>", "--only <tools>", "--all"],
    },
    untaught: ["ls", "list", "remove"],
  },
  "mcp-server": {
    forms: {
      "": NONE,
      on: NONE,
      off: NONE,
      token: NONE,
      "token create": ["--person <key>", "--agents <ids>", "--label <client>", "--scopes <scopes>", "--ttl <days>"],
      "token list": NONE,
      "token revoke": NONE,
    },
  },
  sessions: { forms: { "": NONE, "*": NONE } },
  turns: { forms: { "": ["--limit <n>", "--agent <id>"], list: ["--limit <n>", "--agent <id>"], show: NONE }, untaught: ["list"] },
  knowledge: {
    forms: { "": NONE, list: NONE, search: ["--in <collection>"], add: ["--to <collection>", "--name <file name>"], reindex: NONE, archive: NONE, unarchive: NONE, title: NONE, rm: NONE },
    untaught: ["list"],
  },
  events: { forms: { "": ["--turn <id>", "--gateway <id>", "--chat <id>", "--kinds <kinds>", "--since <seq>", "--limit <n>", "-f", "--follow"] } },
  config: { forms: { "": NONE, check: NONE, schema: NONE, explain: NONE } },
  "tool-budget": { forms: { "": ["--agent <id>"], "*": ["--agent <id>"] } },
  "turn-budget": { forms: { "": ["--agent <id>"], "*": ["--agent <id>"] } },
  update: { forms: { "": ["--check", "--start", "--now", "--wait", "--rollback", "--apply", "--track <latest|lts>", ...WAKE] } },
  restart: { forms: { "": [...WAKE, "--now", "--force", "--wait"] } },
};

/** The plurals main.ts dispatches to the same command. */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = { providers: "provider", secrets: "secret", webhooks: "webhook" };

/** A flag's name: `--name <value>` → `--name`. */
export const flagName = (spec: string): string => spec.split(" ")[0]!;

const isFlag = (token: string): boolean => /^--?[a-zA-Z]/.test(token);

/** The form `args` asks for, and how many of its leading words name it — or null where no form matches. */
function formOf(grammar: CommandGrammar, args: readonly string[]): { key: string; words: number } | null {
  const words: string[] = [];
  for (const token of args) {
    if (token === "--" || isFlag(token)) break;
    words.push(token);
  }
  for (let depth = Math.min(words.length, 2); depth > 0; depth -= 1) {
    const key = words.slice(0, depth).join(" ");
    if (grammar.forms[key]) return { key, words: depth };
  }
  if (words.length === 0) return grammar.forms[""] ? { key: "", words: 0 } : null;
  return grammar.forms["*"] ? { key: "*", words: 0 } : null;
}

/**
 * The first flag in `args` that `command`'s form does not read, or null. A command or action not in the grammar is
 * the command's own to refuse — it says which actions it has — so it is passed on unchecked.
 */
export function unreadFlag(command: string, args: readonly string[]): string | null {
  const grammar = GRAMMAR[COMMAND_ALIASES[command] ?? command];
  if (!grammar) return null;
  const form = formOf(grammar, args);
  if (!form) return null;
  const specs = grammar.forms[form.key]!;
  if (specs.includes(VERBATIM)) return null;
  const takes = new Map(specs.map((spec) => [flagName(spec), spec.includes(" ")]));
  for (let at = form.words; at < args.length; at += 1) {
    const token = args[at]!;
    if (token === "--") return null;
    if (!isFlag(token)) continue;
    if (!takes.has(token)) return token;
    if (takes.get(token)) at += 1;
  }
  return null;
}

/**
 * The first word `args` gives `command` that is none of its actions, where it takes no word of its own (no `"*"` form)
 * — or null. Found in 0.7.7 → 0.7.10's upgrade run: `nouride agents reload` (exit 2 now) listed the agents and dropped `reload`, as
 * `--dry-run` was dropped before a flag was checked. A command not in the grammar is its own to refuse, and passes.
 */
export function unreadWord(command: string, args: readonly string[]): string | null {
  const grammar = GRAMMAR[COMMAND_ALIASES[command] ?? command];
  if (!grammar || formOf(grammar, args)) return null;
  return args.find((token) => !isFlag(token)) ?? null;
}

/** The command a word was meant for, when this one's name is a letter from it: `agents reload` is `agent reload`. */
function meantFor(command: string, word: string): string | null {
  for (const other of [command.replace(/s$/, ""), `${command}s`]) {
    if (other !== command && GRAMMAR[other]?.forms[word]) return other;
  }
  return null;
}

/**
 * Exit 2 when `args` gives `command` a word or a flag it does not read — before anything is asked of the daemon or
 * written. A word is said as an unknown action is (`unknownAction`), with the command's lines of help.
 */
export function refuseUnread(command: string, args: readonly string[], help: string | null): void {
  const word = unreadWord(command, args);
  if (word !== null) {
    refuseRetired(COMMAND_ALIASES[command] ?? command, { action: word });
    const other = meantFor(command, word);
    usageError(
      `\`nouride ${command}\` has no "${word}".`,
      [plain(help ?? "Run `nouride help`."), ...(other ? [`\`nouride ${other} ${word}\` is the one that takes it.`] : [])].join("\n"),
    );
  }
  const flag = unreadFlag(command, args);
  if (!flag) return;
  const grammar = GRAMMAR[COMMAND_ALIASES[command] ?? command]!;
  const form = formOf(grammar, args)!;
  const what = form.key === "" || form.key === "*" ? `nouride ${command}` : `nouride ${command} ${form.key}`;
  refuseRetired(COMMAND_ALIASES[command] ?? command, { flag, what, reads: grammar.forms[form.key]!.map(flagName) });
  const reads = grammar.forms[form.key]!.map(flagName).filter((name) => !grammar.untaught?.includes(name));
  usageError(
    `\`${what}\` does not take ${flag}${reads.length ? `: it reads ${reads.join(", ")}` : ": it takes no flags"}.`,
    plain(help ?? "Run `nouride help`."),
  );
}
