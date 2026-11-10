/**
 * One rule for every command: a flag it does not read is refused, exit 2, naming it (`cli/grammar.ts`).
 *
 * Found in 0.7.9's e2e: `nouride memory pass --dry-run` (exit 2 now) ran a real pass, because `pass` reads no flag and nothing
 * said so. A fix to `pass` would leave the next command the same, so this walks the dispatch table: every `case` in
 * `main.ts` is a command with a grammar, every one of its forms refuses a flag it was not given, and every command,
 * spawned for real against a daemon that is not there, refuses one before it tries to reach it.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_ALIASES, flagName, GRAMMAR, unreadFlag, unreadWord, VERBATIM } from "../../../cli/src/grammar.ts";
import { runCli } from "../cli-harness.ts";

const MAIN = join(import.meta.dir, "../../../cli/src/run.ts");
/** Flags, not commands — answered before dispatch. */
const NOT_COMMANDS = new Set(["-h", "--help", "--version"]);
const BOGUS = "--no-such-flag";

/** The dispatch table, as `main.ts` writes it: one `case` per command. */
const dispatched = [...new Set([...readFileSync(MAIN, "utf8").matchAll(/^\s*case "([a-z-][a-z-]*)":/gm)].map((m) => m[1]!))].filter(
  (command) => !NOT_COMMANDS.has(command),
);

/** A word that stands for a form: its own words, or one that is not an action for `*`. */
const wordsOf = (form: string): string[] => (form === "" ? [] : form === "*" ? ["nouva"] : form.split(" "));

describe("the dispatch table", () => {
  test("is read: the commands main.ts dispatches are found", () => {
    expect(dispatched).toEqual(expect.arrayContaining(["memory", "cron", "restart", "update", "gateway", "chat"]));
  });

  test("every command it dispatches has a grammar — a command without one would take any flag", () => {
    expect(dispatched.filter((command) => !GRAMMAR[COMMAND_ALIASES[command] ?? command])).toEqual([]);
  });

  test("every form of every command refuses a flag it does not read, and takes each one it does", () => {
    const misses: string[] = [];
    for (const [command, grammar] of Object.entries(GRAMMAR)) {
      for (const [form, specs] of Object.entries(grammar.forms)) {
        const words = wordsOf(form);
        if (specs.includes(VERBATIM)) {
          // `policy check rm -rf /tmp/x`: the words are the checked command's own, flags and all.
          if (unreadFlag(command, [...words, "rm", "-rf", "/tmp/x"]) !== null) misses.push(`${command} ${form}: read a verbatim word as a flag`);
          continue;
        }
        if (unreadFlag(command, [...words, BOGUS]) !== BOGUS) misses.push(`${command} ${form}: took ${BOGUS}`);
        for (const spec of specs) {
          const given = spec.includes(" ") ? [flagName(spec), "-value-that-starts-with-a-dash"] : [flagName(spec)];
          if (unreadFlag(command, [...words, ...given]) !== null) misses.push(`${command} ${form}: refused ${spec}`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  test("an action that reads a flag does not lend it to one that does not", () => {
    expect(unreadFlag("memory", ["pass", "--dry-run"])).toBe("--dry-run");
    expect(unreadFlag("memory", ["forget", "sam", "--anonymize"])).toBeNull();
    expect(unreadFlag("memory", ["tags", "tidy", "--into", "x"])).toBe("--into");
    expect(unreadFlag("memory", ["tags", "merge", "a", "--into", "b"])).toBeNull();
    expect(unreadFlag("cron", ["update", "job_1", "--command", "ls"])).toBe("--command");
  });

  test("after a bare --, nothing is a flag; a lone - and a negative number are words", () => {
    expect(unreadFlag("memory", ["pass", "--", "--dry-run"])).toBeNull();
    expect(unreadFlag("memory", ["set", "facts", "-"])).toBeNull();
    expect(unreadFlag("tool-budget", ["-1"])).toBeNull();
  });

  test("a word that is no action of a command that takes none of its own is not read either", () => {
    // 0.7.7 → 0.7.10's upgrade run: `nouride agents reload` (exit 2 now) listed the agents and dropped `reload`.
    expect(unreadWord("agents", ["reload"])).toBe("reload");
    expect(unreadWord("status", ["now"])).toBe("now");
    // A word where the command takes one, an action and what follows it, and nothing at all, are read.
    expect(unreadWord("agents", [])).toBeNull();
    expect(unreadWord("chat", ["nouva"])).toBeNull();
    expect(unreadWord("agent", ["reload", "e2e"])).toBeNull();
    expect(unreadWord("memory", ["tags", "tidy", "--apply"])).toBeNull();
    expect(unreadWord("help", ["cron"])).toBeNull();
    // After a bare --, the words are the command's own.
    expect(unreadWord("policy", ["check", "--", "rm", "-rf"])).toBeNull();
  });
});

describe("every command, run for real", () => {
  /** An install whose daemon is not running: a command that got as far as asking it would exit 1, not 2. */
  function install(): string {
    const dir = mkdtempSync(join(tmpdir(), "nouride-grammar-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", ".control-token"), "token\n", { mode: 0o640 });
    writeFileSync(join(dir, "config.toml"), `[daemon]\ndata_dir = "${join(dir, "data")}"\n\n[dashboard]\nport = 9\n`);
    return dir;
  }

  test("refuses a flag it does not read with exit 2, naming it, before it tries to reach the daemon", async () => {
    const dir = install();
    try {
      const run = async (command: string): Promise<{ command: string; code: number; err: string }> => {
        const { code, err } = await runCli([command, BOGUS], { cwd: dir, config: join(dir, "config.toml") });
        return { command, code, err };
      };
      // `help` and `version` answer whatever follows them: they take nothing, and do nothing with it.
      const runs = await Promise.all(dispatched.filter((command) => command !== "help" && command !== "version").map(run));
      expect(runs.filter((r) => r.code !== 2 || !r.err.includes(`does not take ${BOGUS}`)).map((r) => `${r.command}: exit ${r.code} ${r.err.split("\n")[0]}`)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("and a word it does not read the same way: exit 2, naming it, before anything is asked or run", async () => {
    const dir = install();
    try {
      // Every command that takes no word of its own, given one that is none of its actions.
      const wordless = dispatched.filter((command) => !GRAMMAR[COMMAND_ALIASES[command] ?? command]!.forms["*"]);
      const runs = await Promise.all(
        wordless.map(async (command) => ({ command, ...(await runCli([command, "no-such-word"], { cwd: dir, config: join(dir, "config.toml") })) })),
      );
      expect(runs.filter((r) => r.code !== 2 || !r.err.includes(`\`nouride ${r.command}\` has no "no-such-word"`)).map((r) => `${r.command}: exit ${r.code} ${r.err.split("\n")[0]}`)).toEqual([]);
      // And the one the upgrade run typed is pointed at the command that takes it.
      const agents = await runCli(["agents", "reload"], { cwd: dir, config: join(dir, "config.toml") });
      expect(agents.code).toBe(2);
      expect(agents.err).toContain("`nouride agent reload` is the one that takes it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
