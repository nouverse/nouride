/**
 * What a coding CLI runs on, read from the files installed beside its connector: the CLI the connector
 * carries, the connector, the Node it asks for, its other dependencies. The dashboard read the connector's version
 * alone and called it Claude Code's (seen on a live box).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { underMinimum, type CliPart, type CliRow } from "@nouride/acp";
import type { runCommand } from "@nouride/runtime";
import type { LoadedAgent } from "@nouride/shared";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { readParts } from "@/modules/external-agents/parts.ts";
import { scanCli } from "@/modules/external-agents/scan.ts";

const root = mkdtempSync(join(tmpdir(), "nouride-parts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(file: string, json: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json));
}

/**
 * An install as npm lays it out, the shape of the box's: `bin/<command>` a link into the connector's `dist`, the SDK
 * nested in the connector's own `node_modules`, another dependency hoisted beside the connector.
 */
function install(name: string, connector: Record<string, unknown>, nested: Record<string, unknown>, hoisted: Record<string, unknown> = {}): { bin: string; lib: string } {
  const lib = join(root, name, "lib", "node_modules");
  const home = join(lib, "@fake", "acp");
  write(join(home, "package.json"), connector);
  write(join(home, "dist", "index.js"), "#!/usr/bin/env node\n");
  // npm marks a package's `bin` file as a program; a file that is not one is not found on the PATH.
  chmodSync(join(home, "dist", "index.js"), 0o755);
  for (const [dep, json] of Object.entries(nested)) write(join(home, "node_modules", dep, "package.json"), json);
  for (const [dep, json] of Object.entries(hoisted)) write(join(lib, dep, "package.json"), json);
  const bin = join(root, name, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(home, "dist", "index.js"), join(bin, "fake-acp"));
  return { bin, lib };
}

const row: CliRow = {
  id: "fake",
  name: "Fake Code",
  command: "fake-acp",
  args: [],
  install: "npm i -g @fake/acp",
  package: "@fake/acp",
  carries: { name: "Fake Code", package: "@fake/sdk", field: "fakeCodeVersion" },
  versionArgs: ["--version"],
  instructionFile: "AGENTS.md",
};

/** Node answers `node --version`; anything else is the connector's own version. */
const ran = (node: string | null) =>
  (async (argv: string[]) => (argv[0] === "node" ? (node === null ? { exitCode: 127, stdout: "", stderr: "node: not found" } : { exitCode: 0, stdout: `${node}\n`, stderr: "" }) : { exitCode: 0, stdout: "0.107.0\n", stderr: "" })) as unknown as typeof runCommand;

const connector = { name: "@fake/acp", version: "0.107.0", engines: { node: ">=22" }, dependencies: { zod: "4.6.7", "@fake/sdk": "0.3.323", "@fake/protocol": "2.6.0" } };

describe("what a coding CLI runs on", () => {
  test("the CLI the connector carries is read from the field its row names, not from the connector's version", async () => {
    const { bin } = install("whole", connector, { "@fake/sdk": { name: "@fake/sdk", version: "0.3.323", fakeCodeVersion: "2.1.323" }, zod: { name: "zod", version: "4.6.7" } }, { "@fake/protocol": { name: "@fake/protocol", version: "2.6.0" } });
    expect(await readParts(row, { PATH: bin }, ran("v24.15.0"))).toEqual([
      { kind: "cli", name: "Fake Code", package: "@fake/sdk", version: "2.1.323" },
      { kind: "connector", name: "@fake/acp", package: "@fake/acp", version: "0.107.0" },
      { kind: "runtime", name: "Node.js", version: "24.15.0", needs: ">=22", tooOld: false },
      // Its other dependencies, by name: one hoisted beside the connector is found as Node finds it.
      { kind: "dependency", name: "@fake/protocol", package: "@fake/protocol", version: "2.6.0" },
      { kind: "dependency", name: "zod", package: "zod", version: "4.6.7" },
    ]);
  });

  test("what cannot be read is left without a version, never given the connector's or a guess", async () => {
    // The SDK installed without the field, one dependency not installed, another's file not JSON.
    const { bin } = install("holes", connector, { "@fake/sdk": { name: "@fake/sdk", version: "0.3.323" }, zod: "{ not json" });
    const parts = await readParts(row, { PATH: bin }, ran(null));
    expect(parts.find((part) => part.kind === "cli")).toEqual({ kind: "cli", name: "Fake Code", package: "@fake/sdk" });
    expect(parts.filter((part) => part.kind === "dependency")).toEqual([
      { kind: "dependency", name: "@fake/protocol", package: "@fake/protocol" },
      { kind: "dependency", name: "zod", package: "zod" },
    ]);
    // No Node answered: what the connector asks for is still said, and nothing of whether it is met.
    expect(parts.find((part) => part.kind === "runtime")).toEqual({ kind: "runtime", name: "Node.js", needs: ">=22" });
  });

  test("a Node under what the connector asks for is said", async () => {
    const { bin } = install("old-node", connector, {});
    expect((await readParts(row, { PATH: bin }, ran("v20.11.1"))).find((part) => part.kind === "runtime")).toEqual({ kind: "runtime", name: "Node.js", version: "20.11.1", needs: ">=22", tooOld: true });
  });

  test("a connector that asks for no Node lists none, and a row with no package lists nothing", async () => {
    const { bin } = install("no-engines", { name: "@fake/acp", version: "0.107.0" }, {});
    expect((await readParts({ ...row, carries: undefined } as unknown as CliRow, { PATH: bin }, ran("v24.0.0"))).map((part) => part.kind)).toEqual(["connector"]);
    const { package: _package, carries: _carries, ...own } = row;
    expect(await readParts(own, { PATH: bin }, ran("v24.0.0"))).toEqual([]);
  });

  test("a package further up the folders that is not the connector's is not taken for it", async () => {
    // The command is a file of some other package: its `package.json` is found first, and is not the row's.
    const other = join(root, "other");
    write(join(other, "package.json"), { name: "something-else", version: "9.9.9" });
    write(join(other, "bin", "fake-acp"), "#!/bin/sh\n");
    chmodSync(join(other, "bin", "fake-acp"), 0o755);
    expect(await readParts(row, { PATH: join(other, "bin") }, ran("v24.0.0"))).toEqual([]);
  });

  test("the scan carries the parts beside the connector's version", async () => {
    const { bin } = install("scan", connector, { "@fake/sdk": { name: "@fake/sdk", version: "0.3.323", fakeCodeVersion: "2.1.323" } });
    const scanned = await scanCli(row, ran("v24.15.0"), { PATH: bin });
    expect(scanned.version).toBe("0.107.0");
    expect(scanned.parts?.[0]).toEqual({ kind: "cli", name: "Fake Code", package: "@fake/sdk", version: "2.1.323" });
  });
});

describe("under the lowest version a range allows", () => {
  test("a plain lower bound is read, by each number in turn", () => {
    expect(underMinimum("20.11.1", ">=22")).toBe(true);
    expect(underMinimum("22.0.0", ">=22")).toBe(false);
    expect(underMinimum("v24.15.0", ">= 22.3.1")).toBe(false);
    expect(underMinimum("22.3.0", ">=22.3.1")).toBe(true);
    expect(underMinimum("22.2.9", ">=22.3")).toBe(true);
  });

  test("a range of another shape is no verdict", () => {
    expect(underMinimum("20.0.0", "^20 || >=22")).toBeNull();
    expect(underMinimum("20.0.0", "20.x")).toBeNull();
    expect(underMinimum("not a version", ">=22")).toBeNull();
  });
});

describe("what `/status` is told of the CLI's own version", () => {
  const agent = { config: { id: "coder", displayName: "Coder", external: { cli: "fake" } } } as unknown as LoadedAgent;
  const service = (parts: CliPart[] | undefined) =>
    new ExternalAgents({
      rows: () => [row],
      workspaceDir: () => root,
      secretsFor: () => ({}),
      sessions: { load: () => ({}), save: () => {} },
      scan: async (scanned) => ({ id: scanned.id, name: scanned.name, command: scanned.command, install: scanned.install, login: false, installed: true, version: "0.107.0", ...(parts ? { parts } : {}) }),
    });

  test("the CLI's, as the last scan read it, never the connector's", async () => {
    const agents = service([
      { kind: "cli", name: "Fake Code", package: "@fake/sdk", version: "2.1.323" },
      { kind: "connector", name: "@fake/acp", package: "@fake/acp", version: "0.107.0" },
    ]);
    // Before a scan nothing was read, and nothing is said.
    expect(agents.answering(agent, "telegram:coder", "1")).toEqual({ cli: "Fake Code", running: null, model: null, context: null });
    await agents.scan();
    expect(agents.answering(agent, "telegram:coder", "1")?.version).toBe("2.1.323");
  });

  test("nothing where the scan read no part that is the CLI", async () => {
    const agents = service([{ kind: "connector", name: "@fake/acp", package: "@fake/acp", version: "0.107.0" }]);
    await agents.scan();
    expect(agents.answering(agent, "telegram:coder", "1")?.version).toBeUndefined();
  });
});
