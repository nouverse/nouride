/**
 * A CLI's new version is checked before its agent takes work (0.8.1, EXTERNAL_AGENTS §5.3), against a CLI started as a
 * real process: its handshake read for what Nouride uses (0.8.24, `handshake.ts`) — steering where its row relies on it,
 * the modes its presets set — in a session opened and let go, no prompt. A version that has them is kept and not asked
 * again; one that lacks one makes the agent unavailable, naming the version and the one to go back to; a CLI that is
 * not signed in is no verdict on its version.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { stderrSaid } from "./fixtures/stderr.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(mode: string, kept: Record<string, string> = {}, relies: Partial<CliRow> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "external-version-"));
  dirs.push(dir);
  mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
  let versions = { ...kept };
  const row: CliRow = { id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "it is a test", versionArgs: ["--version"], env: { FAKE_MODE: mode }, instructionFile: "AGENTS.md", ...relies };
  const service = new ExternalAgents({
    rows: () => [row],
    workspaceDir: () => dir,
    secretsFor: () => ({}),
    sessions: { load: () => ({}), save: () => {} },
    versions: { load: () => versions, save: (next) => void (versions = next) },
  });
  services.push(service);
  const agent = { config: { id: "coder", external: { cli: "fake" } }, dir } as unknown as LoadedAgent;
  return { service, agent, versions: () => versions };
}

describe("a CLI's new version", () => {
  test("that answers the check is kept, and the next start asks nothing", async () => {
    const { service, agent, versions } = setup("");
    const connection = await service.connection(agent);
    expect(versions()).toEqual({ fake: "9.9.9" });
    // Asked once: the check's session is the only one this CLI opened.
    expect(await stderrSaid(connection, (line) => line.startsWith("cwd:"), 1)).toHaveLength(1);
    await service.stopAll();
    const again = await service.connection(agent);
    expect(again.stderrTail.filter((line) => line.startsWith("cwd:"))).toEqual([]);
  });

  test("that no longer offers the steering its row relies on makes the agent unavailable, naming the version, and is not kept", async () => {
    const { service, agent, versions } = setup("", {}, { steering: true });
    const expected = "Fake CLI 9.9.9 did not pass Nouride's check: it no longer offers steering, which a message sent while it works goes through. Go back to the version before, or update Nouride";
    await expect(service.connection(agent)).rejects.toThrow(expected);
    expect(service.unavailable("coder")).toBe(expected);
    expect(versions()).toEqual({});
  });

  test("whose sessions lack a preset's mode fails too, naming the version that passed before to go back to", async () => {
    const { service, agent, versions } = setup("steer", { fake: "9.9.8" }, { steering: true, modes: { folder: "yolo", risky: "acceptEdits" } });
    await expect(service.connection(agent)).rejects.toThrow("Fake CLI 9.9.9 did not pass Nouride's check: its sessions no longer offer the modes Nouride's presets set (acceptEdits). Go back to 9.9.8 (`nouride agents update fake 9.9.8`), or update Nouride");
    expect(service.updates.wayBack("fake")).toBe("9.9.8");
    expect(versions()).toEqual({ fake: "9.9.8" });
  });

  test("held for an update, no new turn starts in it until it is let go", async () => {
    const { service, agent } = setup("");
    expect(await service.updates.hold("fake")).toBe(0);
    await expect(service.connection(agent)).rejects.toThrow("Fake CLI is being updated: its agents answer again once that is done, in a minute or two");
    service.updates.release("fake");
    expect((await service.connection(agent)).closed).toBeNull();
  });

  test("that offers what its row relies on passes", async () => {
    const { service, agent, versions } = setup("steer", {}, { steering: true, modes: { folder: "yolo", all: "default" } });
    await service.connection(agent);
    expect(versions()).toEqual({ fake: "9.9.9" });
  });

  test("that is not signed in is no verdict: nothing kept, nothing said about the version", async () => {
    const { service, agent, versions } = setup("auth");
    await service.connection(agent);
    expect(versions()).toEqual({});
    expect(service.unavailable("coder")).toBeNull();
  });
});
