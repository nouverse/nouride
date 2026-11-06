/**
 * An external agent's profiles on its Brain tab (0.8.1): each a sign-in of its CLI kept in its folder, listed with whether
 * it is signed in — asked of the CLI, by a session it opens or refuses, so the tab knows after a restart too. On the
 * live box the tab showed only "Sign in" for an agent nobody could tell was signed in, and a model field with nothing
 * in it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { externalModelsState } from "@/commons/daemon-state.ts";
import { stateRows } from "../helpers.ts";
import { eventually } from "../wait.ts";
import { stderrSaid } from "./fixtures/stderr.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Status words as Claude Code's are: exit 0 only where the profile holds a sign-in. */
const STATUS = ["-e", "process.exit(require('node:fs').existsSync(process.env.FAKE_HOME + '/signed-in') ? 0 : 1)"];

function setup(mode = "", status?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "external-profiles-"));
  dirs.push(dir);
  const folder = privateWorkspace(dir, "coder");
  mkdirSync(folder, { recursive: true });
  const row: CliRow = { id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "it is a test", versionArgs: ["--version"], profileEnv: "FAKE_HOME", env: { FAKE_MODE: mode }, instructionFile: "AGENTS.md", ...(status ? { status } : {}) };
  const service = new ExternalAgents({ rows: () => [row], workspaceDir: () => dir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} }, models: externalModelsState(stateRows()) });
  services.push(service);
  const agent = { config: { id: "coder", displayName: "Coder", external: { cli: "fake" } }, persona: { identity: "" }, dir } as unknown as LoadedAgent;
  // How many sessions its own CLI opened, at least `want`: the fake says each one's folder on stderr.
  const opened = async (want = 1) => (await stderrSaid(await service.connection(agent), (line) => line.startsWith("cwd:"), want)).length;
  return { service, agent, folder, opened };
}

describe("an external agent's profiles", () => {
  test("the one in use is checked by a session its CLI opens — signed in, its models kept — and the answer stands until asked fresh", async () => {
    const { service, agent, opened } = setup();
    expect(await service.profiles(agent)).toEqual([{ name: "default", inUse: true, signedIn: true, reason: null }]);
    expect(service.models.of("coder")).toEqual([{ value: "small", current: "small" }, { value: "big" }]);
    expect(await opened()).toBe(1);
    await service.profiles(agent);
    expect(await opened()).toBe(1);
    await service.profiles(agent, true);
    expect(await opened(2)).toBe(2);
  });

  test("a check's session is let go in the CLI rather than left open there (0.8.1)", async () => {
    // Every Brain-tab check opened a session in the agent's live CLI and closed none: each holds memory there.
    const { service, agent } = setup();
    await service.profiles(agent);
    const connection = await service.connection(agent);
    await eventually(() => connection.stderrTail.includes("closed:s1"), 4_000, "the check's session closed");
  });

  test("two fresh asks at once share one check, not a CLI session each (0.8.1)", async () => {
    const { service, agent, opened } = setup();
    await Promise.all([service.profiles(agent, true), service.profiles(agent, true)]);
    expect(await opened()).toBe(1);
  });

  test("one its CLI refuses is not signed in, in the words the agent's status uses, and the agent cannot answer", async () => {
    const { service, agent } = setup("auth");
    expect(await service.profiles(agent)).toEqual([{ name: "default", inUse: true, signedIn: false, reason: "Fake CLI is not signed in. Sign in on the agent's Brain tab" }]);
    expect(service.unavailable("coder")).toBe("Fake CLI is not signed in. Sign in on the agent's Brain tab");
  });

  test("every profile folder is listed after the one in use, each checked on its own, without touching the agent's status", async () => {
    const { service, agent, folder } = setup();
    for (const name of ["work", "Not A Profile"]) mkdirSync(join(folder, ".cli", "fake", name), { recursive: true });
    writeFileSync(join(folder, ".cli", "fake", "work", "signed-out"), "");
    expect(await service.profiles(agent)).toEqual([
      { name: "default", inUse: true, signedIn: true, reason: null },
      { name: "work", inUse: false, signedIn: false, reason: "Fake CLI is not signed in. Sign in on the agent's Brain tab" },
    ]);
    expect(service.unavailable("coder")).toBeNull();
  });

  test("a turn that finds the CLI signed out is newer than a check: the next asks again", async () => {
    const { service, agent, opened } = setup();
    await service.profiles(agent);
    service.setUnavailable("coder", "Fake CLI is not signed in. Sign in on the agent's Brain tab");
    await service.profiles(agent);
    expect(await opened(2)).toBe(2);
    expect(service.unavailable("coder")).toBeNull();
  });

  test("a CLI with status words is asked with them: one that opens a session signed out is still not signed in", async () => {
    // Claude Code's adapter opened a session on Nox's profile, which had never been signed in; its status said so.
    const { service, agent, folder, opened } = setup("", STATUS);
    mkdirSync(join(folder, ".cli", "fake", "work"), { recursive: true });
    expect(await service.profiles(agent)).toEqual([
      { name: "default", inUse: true, signedIn: false, reason: "Fake CLI is not signed in. Sign in on the agent's Brain tab" },
      { name: "work", inUse: false, signedIn: false, reason: "Fake CLI is not signed in. Sign in on the agent's Brain tab" },
    ]);
    expect(service.unavailable("coder")).toBe("Fake CLI is not signed in. Sign in on the agent's Brain tab");
    expect(service.models.of("coder")).toEqual([]);
    for (const name of ["default", "work"]) writeFileSync(join(folder, ".cli", "fake", name, "signed-in"), "");
    expect((await service.profiles(agent, true)).map((profile) => profile.signedIn)).toEqual([true, true]);
    // Signed in, the profile in use still opens a session for its models; the other starts nothing more.
    expect(service.models.of("coder")).toEqual([{ value: "small", current: "small" }, { value: "big" }]);
    expect(await opened()).toBe(1);
    expect(service.unavailable("coder")).toBeNull();
  });
});
