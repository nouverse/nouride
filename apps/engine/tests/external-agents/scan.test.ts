/**
 * Which coding CLIs a box has (0.8.1, `nouride agents scan`): a CLI that runs is installed, with the version it
 * printed; one the box cannot find is not, and says how to install it.
 */

import { describe, expect, test } from "bun:test";
import type { CliRow } from "@nouride/acp";
import type { runCommand } from "@nouride/runtime";
import { scanCli } from "@/modules/external-agents/scan.ts";

const row: CliRow = { id: "fake", name: "Fake CLI", command: process.execPath, args: [], install: "npm i -g fake", versionArgs: ["--version"], instructionFile: "AGENTS.md", login: ["login"] };
const ran = (exitCode: number, stdout: string, stderr = "") => (async () => ({ exitCode, stdout, stderr })) as unknown as typeof runCommand;

describe("a scan of the CLIs", () => {
  test("a CLI that runs is installed, at the version it printed", async () => {
    expect(await scanCli(row, ran(0, "fake-cli 2.1.3 (build 7)\n"))).toEqual({ id: "fake", name: "Fake CLI", command: process.execPath, install: "npm i -g fake", login: true, installed: true, version: "2.1.3" });
    expect((await scanCli(row, ran(0, "no version here"))).version).toBeUndefined();
  });

  test("one the box cannot find is not installed — by its shell's word, and for real", async () => {
    expect((await scanCli(row, ran(127, "", "sh: fake: command not found"))).installed).toBe(false);
    expect(await scanCli({ ...row, command: "no-such-cli-anywhere-0" })).toMatchObject({ installed: false, install: "npm i -g fake" });
    // A real one, run for real: this test's own runtime.
    expect(await scanCli(row)).toMatchObject({ installed: true, version: process.versions.bun });
  });
});
