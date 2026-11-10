#!/usr/bin/env bun
/**
 * Every command the CLI dispatches is a command `nouride help` describes.
 *
 * ## Why this is a lint and not a docs chore
 *
 * The agent has no other way to find out. It reaches the daemon through the `nouride` tool, and the
 * prompt deliberately does **not** list the verbs — that list used to be there, cost ~1,500 tokens on
 * every request, and went stale within a day of a verb being added. What replaced it is one line:
 * *"run `help` first when you need a command you do not already know — it comes from the daemon, so
 * it is never stale."*
 *
 * That promise is only true if `help` is complete. A command missing from it does not exist as far
 * as an agent is concerned, however well it works.
 *
 * And the gap was real: `setup` and `service` — the two commands that *create* an install — were
 * dispatched and undocumented. An agent asked to set Nouride up could not have found either, which
 * is the one task where finding them matters most.
 *
 * ## What this does not check
 *
 * That the description is any good. A help line describing `nouride cron` as "Cron" would pass. The config half
 * of the same problem is already held much harder — `config-schema.test.ts` asserts every leaf of
 * the real config is described, that every description resolves to a real key, and that no prose
 * outlives its key — and this is the cheap equivalent for verbs, not a replacement for it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/**
 * Flags, not commands — `nouride --version` is dispatched from the same switch and has no place in a
 * list of verbs. Named rather than pattern-matched on the leading dash, so adding one is deliberate.
 */
const NOT_COMMANDS = new Set(["-h", "--help", "--version"]);

/**
 * Plurals that dispatch to the same handler as their singular, documented under one spelling.
 *
 * Listed rather than derived by stripping an `s`: `access` would lose its `s`, and a rule that
 * guesses is a rule that hides the one case it guesses wrong.
 */
const ALIASES: Record<string, string> = {
  providers: "provider",
  secrets: "secret",
  webhooks: "webhook",
  agents: "agent",
};

function dispatched(): string[] {
  const source = read("apps/cli/src/run.ts");
  return [...source.matchAll(/^\s*case "([a-z][a-z-]*)":/gm)].map((m) => m[1] as string);
}

function documented(): Set<string> {
  // The word after `nouride ` in the help text, which is how a reader finds a command in it.
  const source = read("packages/cli-kit/src/usage.ts");
  return new Set([...source.matchAll(/\bnouride ([a-z][a-z-]*)/g)].map((m) => m[1] as string));
}

const help = documented();
const missing = dispatched()
  .filter((cmd) => !NOT_COMMANDS.has(cmd))
  .filter((cmd) => !help.has(cmd) && !help.has(ALIASES[cmd] ?? cmd));

if (missing.length > 0) {
  console.error(`✗ ${missing.length} command(s) dispatched but absent from \`nouride help\`:\n`);
  for (const cmd of [...new Set(missing)].sort()) {
    console.error(`  nouride ${cmd}`);
  }
  console.error(
    `\nAdd a line to packages/cli-kit/src/usage.ts. An agent finds commands by running \`help\` and` +
      `\nnothing else — the system prompt does not list them, on purpose — so a command that is not` +
      `\nthere is a command it cannot use.`,
  );
  process.exit(1);
}

/**
 * The reverse direction, which is the one prose gets wrong on its own.
 *
 * A renamed or deleted command leaves its line behind, and nothing fails — the agent reads it, runs
 * it, and gets "unknown command" from a daemon that just told it otherwise.
 */
const known = new Set([...dispatched(), ...Object.keys(ALIASES)]);
const stale = [...help].filter((cmd) => !known.has(cmd));
if (stale.length > 0) {
  console.error(`✗ ${stale.length} command(s) described in \`nouride help\` that do not exist:\n`);
  for (const cmd of stale.sort()) console.error(`  nouride ${cmd}`);
  process.exit(1);
}

/**
 * ── Flags ───────────────────────────────────────────────────────────────────
 *
 * Every `--flag` in the help text is one the code actually reads.
 *
 * Added after the check shipped, because the first three lines written *under* it were wrong and it
 * passed all three. The worst was `--api-key`, which does not exist and deliberately does not:
 * `setup.ts` refuses to take a credential as an argument, since one lands in shell history, in `ps`
 * output, and in any CI log that echoes its commands. Help invented it anyway. `--now` was invented
 * too, read off `service.ts` by a grep that could not tell a flag the command parses from a word it
 * is about to print inside `systemctl enable --now nouride`.
 *
 * That distinction is the whole trick here: a flag is counted only where it appears in a
 * *flag-reading* position. A string being printed matches none of these patterns.
 *
 * Global rather than per command: a flag documented on the wrong command still passes. Mapping help
 * lines to handlers is guesswork over a text file, and a check that guesses is one that fails on a
 * reformat. Catching the invented flag is most of the value and all of the certainty.
 */
const FLAG_IS_READ = [
  /args\.(?:includes|indexOf)\(\s*"--([a-z][a-z-]*)"/g,
  /flagValue\(\s*args\s*,\s*"-{0,2}([a-z][a-z-]*)"/g,
  /\b(?:flag|has|opt|value|take|every)\(\s*(?:args\s*,\s*)?"-{0,2}([a-z][a-z-]*)"/g,
  // `cli-kit`'s argument readers, which take a flag's other names after it — each of them is read.
  /\b(?:hasFlag|flagValue|takeFlag)\(\s*(?:args|argv)\s*,((?:\s*"-{1,2}[a-z][a-z-]*"\s*,?)+)/g,
];

/** Where a command's code is: the commands themselves, and what every one of them speaks through. */
const CLI_DIRS = ["apps/cli/src", "apps/engine/src/cli", "packages/cli-kit/src"];

function cliSource(): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts")) out.push(readFileSync(p, "utf8"));
    }
  };
  for (const dir of CLI_DIRS) walk(join(ROOT, dir));
  return out.join("\n");
}

const source = cliSource();
const readFlags = new Set(
  FLAG_IS_READ.flatMap((re) =>
    [...source.matchAll(re)].flatMap((m) => {
      const read = m[1] as string;
      // The multi-name readers capture the whole list of quoted names; each one counts.
      return read.includes('"') ? [...read.matchAll(/"-{1,2}([a-z][a-z-]*)"/g)].map((name) => name[1] as string) : [read];
    }),
  ),
);
const helpText = read("packages/cli-kit/src/usage.ts");
const invented = [...new Set([...helpText.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1] as string))]
  .filter((flag) => !readFlags.has(flag))
  .sort();

if (invented.length > 0) {
  console.error(`✗ ${invented.length} flag(s) in \`nouride help\` that no command reads:\n`);
  for (const flag of invented) console.error(`  --${flag}`);
  console.error(
    `\nEither the flag was renamed, or it never existed. Check the command's own usage line — that is` +
      `\nthe one source that cannot be wrong — rather than grepping its source for \`--\`, which also` +
      `\nfinds flags it is about to print.`,
  );
  process.exit(1);
}

/**
 * ── What each command takes (`cli/grammar.ts`) ──────────────────────────────
 *
 * The dispatch (`run.ts`) refuses a flag the grammar does not give a command, before the command runs — so the grammar has to be
 * the truth in both directions, and `help` has to show it:
 *
 * - every dispatched command has a grammar, or a flag given to it would go unchecked;
 * - every flag a command's own files read is declared for it, or a flag that works would be refused;
 * - every flag declared for it is read by them, or one that does nothing would be let through — the bug the
 *   grammar exists for, at the size of a whole command;
 * - every action and flag it declares is in its lines of `nouride help` (`docs-cli-help-incomplete`): an agent
 *   finds `access mode` or `cron add --message` there or nowhere. A second name for an action, kept on purpose, is
 *   `untaught`, and need not be.
 *
 * Per command, not per action: which branch reads a flag is control flow, and a reading of it would be guesswork.
 * The grammar says per action, by hand, where a reviewer reads it.
 */
const { GRAMMAR, COMMAND_ALIASES, VERBATIM, flagName } = await import("../apps/cli/src/grammar.ts");
const { usageFor } = await import("../packages/cli-kit/src/usage.ts");

/** A command's file, by its name under the CLI's folder or — a command that works on the install itself — the engine's. */
function commandFile(file: string): string {
  const client = join(ROOT, "apps/cli/src", file);
  return existsSync(client) ? client : join(ROOT, "apps/engine/src/cli", file);
}

/** The files whose flag reads are a command's, where the command is not named by one file of its own. */
const FILES: Record<string, string[]> = {
  agent: ["commands/agents.ts", "commands/agent-cli.ts", "commands/agent-skill-root.ts"],
  agents: ["commands/agents.ts", "commands/external-clis.ts", "commands/agents-update.ts"],
  gateway: ["commands/gateway.ts", "commands/gateway-rename.ts", "wake-up.ts"],
  memory: ["commands/memory.ts", "commands/memory-tags.ts"],
  secret: ["commands/secret.ts", "commands/secret-unseal.ts", "commands/secret-decrypt.ts", "commands/secret-restore.ts"],
  doctor: ["commands/doctor.ts", "commands/doctor-checks.ts", "commands/doctor-toolchain.ts"],
  update: ["commands/update.ts", "commands/rollback.ts"],
  restart: ["run.ts", "wake-up.ts"],
  setup: ["setup.ts"],
  config: ["commands/config.ts"],
};
/** Read by the dispatch (`run.ts`) for every command, not by `restart`: answered before a command runs. */
const MAIN_ONLY = new Set(["help", "h", "json", "rollback", "follow", "f"]);
/** Commands with nothing to read, or answered entirely in the dispatch (`run.ts`). */
const NO_FILES = new Set(["help", "version", "start", "stop"]);

const flagsReadIn = (text: string): Set<string> =>
  new Set(
    FLAG_IS_READ.flatMap((re) =>
      [...text.matchAll(re)].flatMap((m) => {
        const read = m[1] as string;
        return read.includes('"') ? [...read.matchAll(/"-{1,2}([a-z][a-z-]*)"/g)].map((name) => name[1] as string) : [read];
      }),
    ),
  );

const problems: string[] = [];
for (const command of new Set(dispatched())) {
  if (NOT_COMMANDS.has(command)) continue;
  if (!GRAMMAR[COMMAND_ALIASES[command] ?? command]) problems.push(`nouride ${command}: no grammar in cli/grammar.ts — a flag given to it goes unchecked`);
}

for (const [command, grammar] of Object.entries(GRAMMAR)) {
  const untaught = new Set(grammar.untaught ?? []);
  const helpText = (usageFor(command) ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const declared = new Set<string>();
  for (const [form, specs] of Object.entries(grammar.forms)) {
    for (const word of form.split(" ").filter((w) => w && w !== "*")) {
      if (!untaught.has(word) && !new RegExp(`(^|[\\s|<(\\[])${word}([\\s|>)\\]]|$)`, "m").test(helpText)) {
        problems.push(`nouride ${command} ${form}: the action is not in \`nouride help\``);
      }
    }
    for (const spec of specs) {
      if (spec === VERBATIM) continue;
      const name = flagName(spec);
      declared.add(name.replace(/^-+/, ""));
      if (!untaught.has(name) && !new RegExp(`${name}(?![a-z-])`).test(helpText)) {
        problems.push(`nouride ${command} ${form || ""}${form ? " " : ""}${name}: declared, and not in its lines of \`nouride help\``);
      }
    }
  }
  if (NO_FILES.has(command)) continue;
  const files = FILES[command] ?? [`commands/${command}.ts`];
  const reads = new Set(files.flatMap((file) => [...flagsReadIn(readFileSync(commandFile(file), "utf8"))]));
  if (command === "restart") for (const name of MAIN_ONLY) reads.delete(name);
  // `update --rollback` is dispatched to `rollback.ts` by `run.ts`, which reads the flag to choose it.
  if (command === "update") reads.add("rollback");
  for (const name of reads) {
    if (!declared.has(name)) problems.push(`nouride ${command}: reads --${name} (${files.join(", ")}), which its grammar does not declare — it would be refused`);
  }
  for (const name of declared) {
    if (!reads.has(name)) problems.push(`nouride ${command}: declares --${name}, which ${files.join(", ")} never reads`);
  }
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} problem(s) with what the commands take:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\nThe grammar is apps/cli/src/grammar.ts; the help is packages/cli-kit/src/usage.ts.`);
  process.exit(1);
}

/**
 * ── What a command exits with (`scripts/cli-exits.ts`) ──────────────────────
 *
 * No command prints its usage as the whole answer, or a ✗ line, and exits 0 — the shape of about twenty paths 0.7.10
 * found, which the `nouride` tool read as successes.
 */
const { checkCliExits, MIN_SAYS } = await import("./cli-exits.ts");
const exits = checkCliExits(ROOT);
if (exits.says < MIN_SAYS) {
  console.error(`✗ read only ${exits.says} \`say\` calls in the CLI, expected at least ${MIN_SAYS} — the parser in scripts/cli-exits.ts is broken, not the CLI.`);
  process.exit(1);
}
if (exits.findings.length > 0) {
  console.error(`✗ ${exits.findings.length} place(s) where a command says it failed, or how to call it, and exits 0:\n`);
  for (const finding of exits.findings) console.error(`  ${finding.file}:${finding.line}\n    ${finding.detail}\n`);
  console.error("The `nouride` tool and every script read the exit code, not the text — see the header of scripts/cli-exits.ts.");
  process.exit(1);
}

console.log(
  `✓ every CLI command is in \`nouride help\` (${new Set(dispatched()).size} dispatched), ` +
    `every flag in it is read (${readFlags.size} known), every action and flag a command takes is in its help, ` +
    `and none of ${exits.says} lines a command says is usage or a ✗ followed by exit 0`,
);
