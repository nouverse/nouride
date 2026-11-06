/**
 * A config.toml the caller may not read, from every command that reads it.
 *
 * An agent's own user cannot read the service's config, and `nouride agents`, `jobs`, `mission list` and `status` from
 * its shell printed the read's EACCES stack trace and then the same error again after the ✗. One line instead: the
 * file, and where an agent sees its own work. `db`, `doctor` and `stop` read the config themselves rather than through
 * `connect()`, and printed the stack until 0.8.13. Spawned, as the stderr and the exit code are only real there. Not
 * as root, which reads a file whatever its mode — the line itself is checked without a file below.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreadableConfig } from "@/cli/load-config.ts";
import { runCli } from "../cli-harness.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-unreadable-config-"));
const config = join(dir, "config.toml");
writeFileSync(config, `[daemon]\ndata_dir = "${join(dir, "data")}"\n\n[dashboard]\nport = 9\n`);
chmodSync(config, 0o000);

afterAll(() => {
  chmodSync(config, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

const asRoot = process.getuid?.() === 0;
const said = `Cannot read ${config}: permission denied. An agent sees its own missions, jobs and approvals with its \`work\` tool.`;

/** Each command run at once against the unreadable file: exit 1, nothing on stdout, and the one line on stderr. */
async function expectOneLine(commands: string[][]): Promise<void> {
  const runs = await Promise.all(commands.map((args) => runCli(args, { cwd: dir, config })));
  for (const [i, run] of runs.entries()) {
    const lines = run.err.split("\n").filter((line) => line.trim());
    expect({ args: commands[i], code: run.code, out: run.out, lines }).toEqual({ args: commands[i], code: 1, out: "", lines: [`✗ ${said}`] });
  }
}

describe("an unreadable config.toml", () => {
  test.skipIf(asRoot)("is one line naming the file and the work tool, not a stack trace", async () => {
    await expectOneLine([["agents"], ["jobs"], ["mission", "list"], ["status"]]);
  });

  test.skipIf(asRoot)("is the same line from the commands that read it themselves", async () => {
    // None of these gets past the read, so none writes anything: `gateway rename` and `update --rollback` only report
    // without `--apply`, and `users reset`, `setup` and `stop` act on what the config names.
    await expectOneLine([
      ["db", "list"],
      ["doctor"],
      ["stop"],
      ["users", "reset"],
      ["gateway", "rename", "telegram:a", "telegram:b"],
      ["update", "--rollback"],
      ["setup", "--yes"],
      // Not "this configuration would NOT start": a file this user may not read is no verdict on it.
      ["config", "check"],
    ]);
  }, 30_000);

  test.skipIf(asRoot)("is said its own way by a command that asks softly, or goes on without it", async () => {
    // `acp` speaks the protocol on stdout, so its one line is on stderr in its own words; `service status` describes
    // this shell's process when the daemon cannot be asked.
    const [acp, service] = await Promise.all([runCli(["acp"], { cwd: dir, config }), runCli(["--json", "service", "status"], { cwd: dir, config })]);
    expect({ code: acp.code, out: acp.out, err: acp.err }).toEqual({ code: 1, out: "", err: `nouride acp: ${said}\n` });
    expect({ code: service.code, err: service.err, fromDaemon: (JSON.parse(service.out) as { data: { fromDaemon: boolean } }).data.fromDaemon }).toEqual({
      code: 0,
      err: "",
      fromDaemon: false,
    });
  }, 30_000);

  test.skipIf(asRoot)("under --json is the envelope's error, with exit 1 and nothing on stderr", async () => {
    const commands = [["db", "list"], ["doctor"], ["stop"]];
    const runs = await Promise.all(commands.map((args) => runCli(["--json", ...args], { cwd: dir, config })));
    for (const [i, run] of runs.entries()) {
      const lines = run.out.split("\n").filter((line) => line.trim());
      expect({ args: commands[i], code: run.code, err: run.err, answer: lines.map((line) => JSON.parse(line) as unknown) }).toEqual({
        args: commands[i],
        code: 1,
        err: "",
        answer: [{ ok: false, data: null, error: said, hint: null }],
      });
    }
  }, 30_000);
});

describe("unreadableConfig", () => {
  test("says the file the runtime refused for its permissions, and lets every other failure through", () => {
    // The runtime's own shape: `Bun.file(path).text()` on a file of mode 000.
    const refused = Object.assign(new Error(`EACCES: permission denied, open '${config}'`), { code: "EACCES", path: config, syscall: "open" });
    expect(unreadableConfig(refused)).toBe(said);
    expect(unreadableConfig(Object.assign(new Error("ENOENT"), { code: "ENOENT", path: config }))).toBeNull();
    expect(unreadableConfig(Object.assign(new Error("EACCES"), { code: "EACCES" }))).toBeNull();
    expect(unreadableConfig(new Error("config.toml [daemon] default_agent is gone"))).toBeNull();
    expect(unreadableConfig(undefined)).toBeNull();
  });
});
