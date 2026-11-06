/**
 * An agent is told when the kernel stopped its commands for memory (0.7.19).
 *
 * Found on the live box: an agent ran `head -c 1700M /dev/zero | tail -c 1600M | wc -c`, the kernel killed `tail` at
 * the commands' cap, `wc` counted what it was given and exited 0 — and the agent reported "exit 0, output 0" as the
 * command having worked. The cgroup's kill count says what the exit cannot. Against a cgroup of plain files: the command
 * raises the count the way the kernel would.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetCommandIsolation, isolateCommands } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";
import { createExecTool } from "@/modules/tools/builtins/exec.ts";
import { openAndMigrate } from "@/db/index.ts";
import { JobStore, type JobCompletion } from "@/modules/jobs/jobs.store.ts";
import { jobWakeMessage } from "@/modules/jobs/wake-text.ts";
import { childEnvOf } from "../helpers.ts";
import { eventually } from "../wait.ts";

let dir: string;
let events: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-exec-oom-"));
  const cgroup = join(dir, "cgroup/system.slice/nouride.service");
  mkdirSync(cgroup, { recursive: true });
  for (const [name, text] of Object.entries({ "cgroup.controllers": "memory\n", "cgroup.subtree_control": "", "cgroup.procs": "", "memory.high": "max\n", "memory.max": "max\n" })) {
    writeFileSync(join(cgroup, name), text);
  }
  writeFileSync(join(dir, "self"), "0::/system.slice/nouride.service\n");
  writeFileSync(join(dir, "meminfo"), "MemTotal: 2097152 kB\n");
  isolateCommands({ env: { NOURIDE_SERVICE_KIND: "systemd", NOURIDE_CGROUP: "delegated" }, root: join(dir, "cgroup"), self: join(dir, "self"), meminfo: join(dir, "meminfo") });
  events = join(cgroup, "commands/memory.events");
  writeFileSync(events, "oom 0\noom_kill 0\n");
});
afterEach(() => {
  forgetCommandIsolation();
  rmSync(dir, { recursive: true, force: true });
});

const tool = () =>
  createExecTool({
    timeoutMs: 20_000,
    maxOutputBytes: 1024 * 1024,
    blocked: [],
    policy: { mode: "full", ask: "off", askFallback: "deny", sensitivePaths: "ask", allowlist: [], blocked: [] },
    childEnv: childEnvOf({}),
  } as Parameters<typeof createExecTool>[0]);

const ctx = (): ToolContext => ({
  agentId: "nouva",
  sessionId: "ses_1",
  chatId: "chat-1",
  gateway: "web",
  gatewayId: "web:dashboard",
  senderId: "dev",
  chatType: "dm",
  workspaceDir: dir,
  agentDir: dir,
  workspaceRoots: [dir],
  signal: new AbortController().signal,
});

describe("a command the kernel cut into for memory", () => {
  test("is a failure that says why, whatever its exit code", async () => {
    const result = await tool().execute({ command: `printf 'oom 1\\noom_kill 1\\n' > ${events}; echo 0` }, ctx());
    expect(result.content).toContain("0");
    expect(result.content).toContain("the kernel stopped a process of the agents' commands for memory");
    expect(result.content).toContain("Treat the output as cut short whatever the exit code says");
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ exitCode: 0, oomKills: 1 });
  });

  test("a command nothing happened to is as it was", async () => {
    const result = await tool().execute({ command: "echo fine" }, ctx());
    expect(result.content).toBe("fine");
    expect(result.isError).toBe(false);
    expect(result.metadata).not.toHaveProperty("oomKills");
  });

  test("a background job carries the count to its completion, though it exited 0", async () => {
    const db = await openAndMigrate(join(dir, "jobs.db"));
    const completions: JobCompletion[] = [];
    const jobs = new JobStore({ db, logDir: join(dir, "logs"), maxConcurrentPerAgent: 2, onComplete: (completion) => void completions.push(completion) });
    jobs.start({
      agentId: "nouva",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      argv: ["sh", "-c", `printf 'oom 2\noom_kill 2\n' > ${events}; echo built`],
      sandbox: { cwd: dir, env: { PATH: process.env.PATH ?? "" } },
    });
    await eventually(() => completions.length > 0, 5_000, "the job's completion");
    expect(completions[0]).toMatchObject({ job: { status: "succeeded", exitCode: 0 }, oomKills: 2 });
    db.close();
  });

  test("a background job's wake says so too, though it exited 0", () => {
    const completion = {
      job: { id: "job_1", agentId: "nouva", gatewayId: "telegram:bot", chatId: "1", command: "bash -lc 'make'", cwd: "/w", status: "succeeded", pid: null, exitCode: 0, logPath: "/w/job_1.log", startedAt: 0, endedAt: 1_000 },
      tail: "built",
      oomKills: 3,
    } as unknown as JobCompletion;
    const text = jobWakeMessage(completion);
    expect(text).toContain("the kernel stopped 3 processes of the agents' commands for memory");
    expect(jobWakeMessage({ ...completion, oomKills: undefined } as unknown as JobCompletion)).not.toContain("the kernel stopped");
  });
});
