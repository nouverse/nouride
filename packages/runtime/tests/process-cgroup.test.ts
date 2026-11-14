/**
 * The daemon's cgroup, split so what agents run cannot take the daemon down with it (0.7.19, `process-cgroup.ts`).
 *
 * Against a cgroup filesystem of plain files in a temp directory, shaped as systemd leaves a unit's: what is decided —
 * whether to split, the share, every process moved, the limits written — is read back from the files. That the kernel
 * then enforces them is shown on a real systemd box, a command eating memory while `/health` is timed, not here. The
 * commands are spawned for real, and move themselves into the file the split made.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandsMemory, forgetCommandIsolation, inCommandsCgroup, isolateCommands } from "../src/process-cgroup.ts";
import { runCommand, spawnLongLived } from "../src/process.ts";
import { startBackgroundCommand } from "../src/process-background.ts";

const made: string[] = [];
afterEach(() => {
  forgetCommandIsolation();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DELEGATED = { NOURIDE_SERVICE_KIND: "systemd", NOURIDE_CGROUP: "delegated" };

/** A unit's cgroup as systemd leaves it, under `<tmp>/system.slice/nouride.service`, and the files read beside it. */
function unit(over: { controllers?: string; high?: string; max?: string; pids?: string; procs?: string[]; memTotalKb?: number; self?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nouride-cgroup-"));
  made.push(root);
  const cgroup = join(root, "system.slice/nouride.service");
  mkdirSync(cgroup, { recursive: true });
  const files: Record<string, string> = {
    "cgroup.controllers": over.controllers ?? "cpu memory pids\n",
    "cgroup.subtree_control": "",
    "cgroup.procs": `${(over.procs ?? ["4242"]).join("\n")}\n`,
    "memory.high": over.high ?? "1717986918\n",
    "memory.max": over.max ?? "max\n",
    "pids.max": over.pids ?? "76278\n",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cgroup, name), text);
  const self = join(root, "self-cgroup");
  writeFileSync(self, over.self ?? "0::/system.slice/nouride.service\n");
  const meminfo = join(root, "meminfo");
  writeFileSync(meminfo, `MemTotal:        ${over.memTotalKb ?? 2_097_152} kB\nMemFree:          500000 kB\n`);
  const at = (name: string) => (existsSync(join(cgroup, name)) ? readFileSync(join(cgroup, name), "utf8") : null);
  return { root, cgroup, self, meminfo, at, options: { env: DELEGATED, root, self, meminfo } };
}

const MiB = 1024 * 1024;

describe("splitting the cgroup", () => {
  test("moves every process into daemon/, turns the controllers on for both halves, and caps commands/ below the unit's ceiling", () => {
    const box = unit({ procs: ["4242", "4243"] });
    const report = isolateCommands(box.options);
    // The 2 GB box of the field report: MemoryHigh 1.6 GiB, a fifth of it the daemon's.
    expect(report).toEqual({ isolated: true, systemd: true, commandsMaxBytes: 1310 * MiB, daemonMinBytes: 328 * MiB, cpu: true });
    expect(box.at("daemon/cgroup.procs")).toBe("42424243");
    expect(box.at("cgroup.subtree_control")).toBe("+memory+cpu+pids");
    expect(box.at("commands/memory.max")).toBe(String(1310 * MiB));
    expect(box.at("daemon/memory.min")).toBe(String(328 * MiB));
    expect(box.at("daemon/cpu.weight")).toBe("1000");
    // The daemon keeps 256 threads' worth of the unit's task limit, however many processes the commands start.
    expect(box.at("commands/pids.max")).toBe("76022");
  });

  test("what the commands hold together is read from their own group, with its ceiling; with no group there is nothing to say", () => {
    expect(commandsMemory()).toBeNull();
    const box = unit({});
    expect(isolateCommands(box.options).isolated).toBe(true);
    // The kernel writes the count; here the test does, as it would stand with a build running.
    expect(commandsMemory()).toBeNull();
    writeFileSync(join(box.cgroup, "commands", "memory.current"), `${412 * MiB}\n`);
    expect(commandsMemory()).toEqual({ usedBytes: 412 * MiB, maxBytes: 1310 * MiB });
    writeFileSync(join(box.cgroup, "commands", "memory.max"), "max\n");
    expect(commandsMemory()).toEqual({ usedBytes: 412 * MiB, maxBytes: null });
    forgetCommandIsolation();
    expect(commandsMemory()).toBeNull();
  });

  test("the share is a fifth of the least of the unit's limits and the machine, between 256 and 512 MiB, and never more than half", () => {
    // MemoryMax under MemoryHigh: the lower line is the ceiling.
    expect(isolateCommands(unit({ max: `${1024 * MiB}\n` }).options)).toMatchObject({ commandsMaxBytes: 768 * MiB, daemonMinBytes: 256 * MiB });
    forgetCommandIsolation();
    // No limit on the unit at all: the machine's memory is the ceiling — a 32 GiB one keeps 512 MiB.
    expect(isolateCommands(unit({ high: "max\n", memTotalKb: 32 * 1024 * 1024 }).options)).toMatchObject({
      commandsMaxBytes: 32 * 1024 * MiB - 512 * MiB,
      daemonMinBytes: 512 * MiB,
    });
    forgetCommandIsolation();
    // A 512 MiB Pi: 256 MiB for the daemon would leave the commands less than half, so they get half.
    expect(isolateCommands(unit({ high: `${410 * MiB}\n` }).options)).toMatchObject({ commandsMaxBytes: 205 * MiB, daemonMinBytes: 205 * MiB });
  });

  test("a unit given no CPU controller still splits its memory, and says the CPU is shared", () => {
    const box = unit({ controllers: "memory pids\n", pids: "max\n" });
    expect(isolateCommands(box.options)).toMatchObject({ isolated: true, cpu: false });
    expect(box.at("cgroup.subtree_control")).toBe("+memory+pids");
    expect(box.at("daemon/cpu.weight")).toBeNull();
    // No task limit on the unit: none on the commands either.
    expect(box.at("commands/pids.max")).toBeNull();
  });

  test("inside a cgroup namespace its cgroup is the root of the mount; a daemon already in daemon/ splits the cgroup above it", () => {
    const box = unit({ self: "0::/\n" });
    // The namespace's root is the unit's cgroup: `ProtectControlGroups=private` mounts it at the top.
    writeFileSync(join(box.root, "cgroup.controllers"), "memory\n");
    writeFileSync(join(box.root, "cgroup.subtree_control"), "");
    writeFileSync(join(box.root, "cgroup.procs"), "77\n");
    writeFileSync(join(box.root, "memory.high"), `${1024 * MiB}\n`);
    expect(isolateCommands(box.options).isolated).toBe(true);
    expect(readFileSync(join(box.root, "daemon/cgroup.procs"), "utf8")).toBe("77");

    forgetCommandIsolation();
    const again = unit({ self: "0::/system.slice/nouride.service/daemon\n" });
    mkdirSync(join(again.cgroup, "commands"));
    mkdirSync(join(again.cgroup, "daemon"));
    expect(isolateCommands(again.options).isolated).toBe(true);
    expect(existsSync(join(again.cgroup, "daemon/daemon"))).toBe(false);
  });
});

describe("where it does not split, it says why and moves nothing", () => {
  test("a unit that does not hand its cgroup over is one written before 0.7.19 — under systemd, a thing to fix", () => {
    const box = unit();
    expect(isolateCommands({ ...box.options, env: { NOURIDE_SERVICE_KIND: "systemd" } })).toEqual({
      isolated: false,
      systemd: true,
      reason: "the service unit does not hand its cgroup over: it was written before 0.7.19",
    });
    expect(isolateCommands({ ...box.options, env: {} })).toEqual({ isolated: false, systemd: false, reason: "not started by a service unit that hands its cgroup over" });
    expect(existsSync(join(box.cgroup, "daemon"))).toBe(false);
  });

  test("no cgroup v2, no filesystem for it, a cgroup it may not write, or no memory controller", () => {
    expect(isolateCommands({ ...unit({ self: "1:name=systemd:/system.slice/nouride.service\n" }).options }).reason).toBe("no cgroup v2 here");
    const unmounted = unit();
    rmSync(join(unmounted.cgroup, "cgroup.controllers"));
    expect(isolateCommands(unmounted.options).reason).toBe(`no cgroup v2 filesystem at ${unmounted.root}`);
    expect(isolateCommands(unit({ controllers: "cpu pids\n" }).options).reason).toBe("the unit was not handed the memory controller");
    const readOnly = unit();
    chmodSync(readOnly.cgroup, 0o555);
    const refused = isolateCommands(readOnly.options);
    chmodSync(readOnly.cgroup, 0o755);
    if (process.getuid?.() !== 0) {
      expect(refused.reason).toBe("its cgroup is not writable: the unit needs Delegate=yes, and no ProtectControlGroups=true");
      expect(existsSync(join(readOnly.cgroup, "daemon"))).toBe(false);
    }
    // None of them left a command anywhere but beside the daemon.
    expect(inCommandsCgroup(["true"])).toEqual(["true"]);
  });

  test("a split that fails halfway is said, and commands stay beside the daemon", () => {
    const box = unit();
    // A file where the half the commands go into would be made.
    writeFileSync(join(box.cgroup, "commands"), "");
    const report = isolateCommands(box.options);
    expect(report.isolated).toBe(false);
    expect(report.reason).toStartWith("could not split its cgroup:");
    expect(inCommandsCgroup(["true"])).toEqual(["true"]);
  });
});

describe("a command", () => {
  const options = { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 10_000, maxOutputBytes: 10_000 };

  test("moves itself into commands/ before it runs — an exec, a background job's path and an MCP server alike", async () => {
    const box = unit();
    isolateCommands(box.options);
    const ran = await runCommand(["sh", "-c", "echo ran as $$"], options);
    expect(ran.stdout.trim()).toMatch(/^ran as \d+$/);
    // The shell that moved it wrote its own pid, and `exec` kept the pid: the command is what moved.
    expect(box.at("commands/cgroup.procs")?.trim()).toBe(ran.stdout.trim().replace("ran as ", ""));

    writeFileSync(join(box.cgroup, "commands/cgroup.procs"), "");
    const server = spawnLongLived(["sh", "-c", "echo $$"], options);
    const line = await server.lines().next();
    await server.exited;
    expect(box.at("commands/cgroup.procs")?.trim()).toBe(String(line.value).trim());
  });

  test("runs where it is when the move fails, and says nothing of it", async () => {
    const box = unit();
    isolateCommands(box.options);
    rmSync(join(box.cgroup, "commands"), { recursive: true });
    const ran = await runCommand(["sh", "-c", "echo still ran"], options);
    expect(ran.stdout.trim()).toBe("still ran");
    expect(ran.stderr).toBe("");
  });

  test("says when the kernel stopped processes for memory while it ran — what a pipeline's exit cannot", async () => {
    const box = unit();
    isolateCommands(box.options);
    const events = join(box.cgroup, "commands/memory.events");
    writeFileSync(events, "low 0\nhigh 0\nmax 3\noom 1\noom_kill 4\n");
    // The command stands in for the kernel: two more of the agents' commands killed while it ran.
    const bump = `printf 'oom 3\\noom_kill 6\\n' > ${events}; echo 0`;
    expect((await runCommand(["sh", "-c", bump], options)).oomKills).toBe(2);
    expect(await runCommand(["sh", "-c", "echo calm"], options)).not.toHaveProperty("oomKills");

    writeFileSync(events, "oom_kill 6\n");
    const job = startBackgroundCommand(["sh", "-c", bump.replace("6", "7")], { cwd: tmpdir(), env: options.env, logPath: join(box.root, "job.log") });
    expect(await job.exited).toMatchObject({ exitCode: 0, oomKills: 1 });
  });

  test("is left as it is where nothing was split", () => {
    expect(inCommandsCgroup(["sh", "-c", "true"])).toEqual(["sh", "-c", "true"]);
  });
});
