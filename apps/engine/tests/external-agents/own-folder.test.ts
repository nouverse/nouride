/**
 * A new external agent's CLI, before its first turn has made its folder (0.8.24, found on the e2e VM): the Brain tab's
 * sign-in check ran the CLI's status words in that folder, and a start for the check started the CLI there, and both
 * failed as a missing program — "Claude Code is not installed here" on a box where it was. The folder is made first,
 * where agents are not their own users, as a turn makes it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(row: Partial<CliRow> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "external-own-folder-"));
  dirs.push(dir);
  const statusRuns: string[] = [];
  const service = new ExternalAgents({
    rows: () => [{ id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "it is a test", versionArgs: ["--version"], instructionFile: "AGENTS.md", ...row }],
    workspaceDir: () => dir,
    secretsFor: () => ({}),
    sessions: { load: () => ({}), save: () => {} },
    // As a spawn does: a folder that is not there is an ENOENT, read as a missing program.
    run: async (cmd, options) => {
      if (!existsSync(options.cwd)) throw Object.assign(new Error("ENOENT: no such file or directory, posix_spawn '/usr/bin/setsid'"), { code: "ENOENT" });
      statusRuns.push(cmd.join(" "));
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false } as never;
    },
  });
  services.push(service);
  const agent = { config: { id: "coder", external: { cli: "fake" } }, dir } as unknown as LoadedAgent;
  return { service, agent, folder: privateWorkspace(dir, "coder"), statusRuns };
}

describe("a new external agent's folder, before its first turn", () => {
  test("its CLI starts there: the folder is made, not read as the CLI missing", async () => {
    const { service, agent, folder } = setup();
    expect(existsSync(folder)).toBe(false);
    expect((await service.connection(agent)).closed).toBeNull();
    expect(existsSync(folder)).toBe(true);
    expect(service.unavailable("coder")).toBeNull();
  });

  test("the sign-in check's status words run there and say signed in", async () => {
    const { service, agent, statusRuns } = setup({ status: ["--status"] });
    const [profile] = await service.profiles(agent, true);
    expect(profile).toMatchObject({ inUse: true, signedIn: true, reason: null });
    expect(statusRuns).toHaveLength(1);
  });
});
