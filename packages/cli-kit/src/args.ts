/**
 * Reading flags and arguments out of an argv tail.
 *
 * Still not an option parser with a spec per command: a command asks for what it reads, as it always did. What
 * lives here are the three things every command got wrong by asking `args.indexOf(flag) + 1` for itself:
 *
 * - **`--flag=value`**, which `normalizeArgv` makes `--flag value` once, before any command sees its arguments.
 * - **`--`**, after which nothing is a flag. `nouride policy check -- ls --help` asks about `ls --help` instead of
 *   showing help, and a value of a flag can start with a dash when written `--flag=-x`.
 * - **One name for "read it from stdin"**, `--stdin`. The names each command had before it (`--token-stdin`,
 *   `--key-stdin`, `--value-stdin`) were read beside it until 0.8.0, which refuses them by name (`retired.ts`).
 */

/** What comes before a bare `--` — the part of an argv where flags are read. */
function options(args: readonly string[]): readonly string[] {
  const end = args.indexOf("--");
  return end === -1 ? args : args.slice(0, end);
}

/** `--flag=value` as `--flag value`, up to `--`; everything from `--` on exactly as given. */
export function normalizeArgv(argv: readonly string[]): string[] {
  const head = options(argv);
  const split = head.flatMap((arg) => {
    const pair = /^(--[a-z][a-z0-9-]*)=([\s\S]*)$/.exec(arg);
    return pair ? [pair[1]!, pair[2]!] : [arg];
  });
  return [...split, ...argv.slice(head.length)];
}

/**
 * The argv a command is dispatched on — `--flag=value` split, and `--json`, everybody's, taken off wherever it stands
 * before `--` — and whether `--json` was there. One function for `main.ts` and for the `nouride` tool, which
 * decides on the words the CLI will run: read at fixed positions, `["--json", "tools", "run", …]` had `--json` for
 * its verb and passed the tool's refusals, while the CLI ran `tools run`. `@nouride/policy` keeps a copy
 * (`own-cli.ts`), held to this one by `own-cli-verbs.test.ts`.
 */
export function dispatchedArgv(raw: readonly string[]): { argv: string[]; json: boolean } {
  const argv = normalizeArgv(raw);
  const json = takeFlag(argv, "--json");
  return { argv, json };
}

/** The value given after `flag`, or after any of its other names — read only before `--`. */
export function flagValue(args: readonly string[], flag: string, ...aliases: string[]): string | undefined {
  const head = options(args);
  for (const name of [flag, ...aliases]) {
    const at = head.indexOf(name);
    if (at >= 0) return head[at + 1];
  }
  return undefined;
}

/** Whether `flag`, or any of its other names, was given — before `--`. */
export function hasFlag(args: readonly string[], flag: string, ...aliases: string[]): boolean {
  const head = options(args);
  return [flag, ...aliases].some((name) => head.includes(name));
}

/** Takes `flag` out of `args` wherever it stands before `--`, and says whether it was there — for a flag every command shares. */
export function takeFlag(args: string[], flag: string): boolean {
  let found = false;
  for (let at = options(args).lastIndexOf(flag); at >= 0; at = options(args).lastIndexOf(flag)) {
    args.splice(at, 1);
    found = true;
  }
  return found;
}

/**
 * The arguments that are not flags, for a command whose flags take no values: before `--`, those not starting with a
 * dash; after it, every one. `db` dropped every argument starting with `--` instead, `--` included.
 */
export function bareArgs(args: readonly string[]): string[] {
  const head = options(args);
  return [...head.filter((arg) => !arg.startsWith("-")), ...args.slice(head.length + 1)];
}

/** Everything after `--` — the words of a command that is an argument, such as `policy check`'s. */
export function afterOptions(args: readonly string[]): string[] | null {
  const end = args.indexOf("--");
  return end === -1 ? null : args.slice(end + 1);
}

/**
 * `--session fresh|isolated|chat`. The bare `--isolated` it replaced is refused by name since 0.8.0 (`retired.ts`).
 *
 * Nothing given means nothing sent: the daemon's default (`fresh`) applies, and it stays the one
 * place that decides. Returning `"chat"` here on an absent flag is what the two `add` commands used
 * to do, and it made every job created from the CLI append to the human's conversation whether the
 * operator had thought about it or not.
 */
export function sessionMode(given: string | undefined): "fresh" | "isolated" | "chat" | undefined {
  const value = given?.trim().toLowerCase();
  return value === "fresh" || value === "isolated" || value === "chat" ? value : undefined;
}
