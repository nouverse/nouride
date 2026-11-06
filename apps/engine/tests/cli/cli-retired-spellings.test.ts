/**
 * The CLI's old spellings, refused by name (`cli/retired.ts`).
 *
 * 0.7.x read `--isolated`, `--token-stdin`, `--key-stdin`, `--value-stdin`, `approvals approve` and `people forget`
 * beside what replaced them; 0.8.0 reads none. A script written against 0.7.x meets exit 2 and the spelling to write
 * instead — not "does not take --isolated", which leaves its author to find out what it became, and never the old
 * form quietly done. Spawned for real against an install whose daemon is not running: exit 2 rather than 1 is what
 * says the refusal came before anything was asked of it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli-harness.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-retired-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", ".control-token"), "token\n", { mode: 0o640 });
  writeFileSync(join(dir, "config.toml"), `[daemon]\ndata_dir = "${join(dir, "data")}"\n\n[dashboard]\nport = 9\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cli = (args: string[]) => runCli(args, { cwd: dir, config: join(dir, "config.toml") });

const READ_UNTIL = "Read through 0.7.x; 0.8.0 takes only the new spelling.";

describe("an old flag", () => {
  test.each([
    [["cron", "add", "--name", "n", "--every", "1h", "--text", "hi", "--isolated"], "`nouride cron add` no longer takes --isolated: write --session isolated instead."],
    [["webhook", "add", "--name", "n", "--agent", "a", "--isolated"], "`nouride webhook add` no longer takes --isolated: write --session isolated instead."],
    [["gateway", "add", "--platform", "telegram", "--name", "n", "--token-stdin"], "`nouride gateway add` no longer takes --token-stdin: write --stdin instead."],
    [["gateway", "set", "--platform", "telegram", "--name", "n", "--token-stdin"], "`nouride gateway set` no longer takes --token-stdin: write --stdin instead."],
    [["mcp", "add", "--name", "n", "--url", "https://mcp.invalid", "--token-stdin"], "`nouride mcp add` no longer takes --token-stdin: write --stdin instead."],
    [["mcp", "enable", "n", "--agent", "a", "--token-stdin"], "`nouride mcp enable` no longer takes --token-stdin: write --stdin instead."],
    [["provider", "add", "p", "--kind", "openai", "--url", "https://llm.invalid", "--key-stdin"], "`nouride provider add` no longer takes --key-stdin: write --stdin instead."],
    [["secret", "set", "s", "--value-stdin"], "`nouride secret set` no longer takes --value-stdin: write --stdin instead."],
    // The plural reaches the same command, and its old spelling is named the same way.
    [["secrets", "set", "s", "--value-stdin"], "`nouride secrets set` no longer takes --value-stdin: write --stdin instead."],
  ])("%p is refused with exit 2, naming what to write", async (args, message) => {
    const { code, err, out } = await cli(args);
    expect({ code, first: err.split("\n")[0] }).toEqual({ code: 2, first: `✗ ${message}` });
    expect(err).toContain(READ_UNTIL);
    expect(out).toBe("");
  }, 30_000);

  test("where the form never read it, it is a flag that form does not take — not a replacement it would not take either", async () => {
    // `cron update` reads no `--session`: "write --session isolated" would send the author to a second refusal.
    const update = await cli(["cron", "update", "job_1", "--name", "n", "--isolated"]);
    expect(update.code).toBe(2);
    expect(update.err).toContain("`nouride cron update` does not take --isolated");
    expect(update.err).not.toContain("--session isolated");
    const list = await cli(["secret", "list", "--value-stdin"]);
    expect(list.code).toBe(2);
    expect(list.err).toContain("`nouride secret list` does not take --value-stdin");
  }, 30_000);

  test("under --json, one envelope with the refusal and why", async () => {
    const { code, out } = await cli(["--json", "secret", "set", "s", "--value-stdin"]);
    expect(code).toBe(2);
    expect(JSON.parse(out)).toEqual({
      ok: false,
      data: null,
      error: "`nouride secret set` no longer takes --value-stdin: write --stdin instead.",
      hint: READ_UNTIL,
    });
  }, 30_000);
});

describe("an old action", () => {
  test("`approvals approve` names allow-once, the answer it was read as", async () => {
    const { code, err } = await cli(["approvals", "approve", "apr_1"]);
    expect(code).toBe(2);
    expect(err.split("\n")[0]).toBe("✗ `nouride approvals approve` is gone: write `nouride approvals allow-once` instead.");
    expect(err).toContain(READ_UNTIL);
  }, 30_000);

  test("`people forget` names remove, and says what it never did", async () => {
    const { code, err } = await cli(["people", "forget", "sam"]);
    expect(code).toBe(2);
    expect(err.split("\n")[0]).toBe("✗ `nouride people forget` is gone: write `nouride people remove` instead.");
    expect(err).toContain("what memory keeps about them stays until `nouride memory forget <key>`");
  }, 30_000);

  test("a word no command ever had is still the command's own refusal", async () => {
    const { code, err } = await cli(["approvals", "approved"]);
    expect(code).toBe(2);
    expect(err).toContain('`nouride approvals` has no "approved"');
  }, 30_000);
});
