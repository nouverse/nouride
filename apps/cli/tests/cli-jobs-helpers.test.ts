/**
 * `nouride jobs` with a helper among the jobs (0.7.15): listed by its goal, and said to be a helper at work — not a
 * process that exited, which is what a row with no pid read as.
 */

import { expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { jobs } from "../src/commands/jobs.ts";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

test("a helper is listed by its goal, as a helper — running, and once it has reported", async () => {
  const rows = [
    { id: "job_h1", agentId: "nouva", command: "helper: Find every broken link on the docs site", status: "running", kind: "helper", pid: null, exitCode: null, startedAt: Date.now() - 60_000, endedAt: null, processAlive: true, logBytes: 120, logUpdatedAt: null },
    { id: "job_h2", agentId: "nouva", command: "helper: Check the API pages", status: "succeeded", kind: "helper", pid: null, exitCode: null, startedAt: 0, endedAt: 4_000, processAlive: null, logBytes: 80, logUpdatedAt: null },
    { id: "job_c1", agentId: "nouva", command: "bun test", status: "running", kind: "command", pid: 42, exitCode: null, startedAt: Date.now(), endedAt: null, processAlive: false, logBytes: 0, logUpdatedAt: null },
  ];
  const client = { get: async <T>() => ({ jobs: rows }) as T } as unknown as Client;
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(plain(String(line ?? ""))));
  try {
    await jobs(client, []);
  } finally {
    log.mockRestore();
  }
  const out = lines.join("\n");
  expect(out).toContain("helper: Find every broken link on the docs site");
  expect(out).toMatch(/job_h1 · nouva · running · \d+s so far · helper at work/);
  expect(out).toContain("job_h2 · nouva · succeeded · 4s · helper");
  // A command still reads as one.
  expect(out).toMatch(/job_c1 · nouva · running · \d+s so far · process exited/);
});

test("an ask that moved to the background (0.7.19) is listed by who was asked and what, as an ask at work — not a process", async () => {
  const rows = [
    { id: "job_a1", agentId: "nouva", command: "ask nox: Deploy v2 to staging", status: "running", kind: "ask", pid: null, exitCode: null, startedAt: Date.now() - 90_000, endedAt: null, processAlive: true, logBytes: 64, logUpdatedAt: null },
    { id: "job_a2", agentId: "nouva", command: "ask nera: Rotate the logs", status: "interrupted", kind: "ask", pid: null, exitCode: null, startedAt: 0, endedAt: 2_000, processAlive: null, logBytes: 0, logUpdatedAt: null },
  ];
  const client = { get: async <T>() => ({ jobs: rows }) as T } as unknown as Client;
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(plain(String(line ?? ""))));
  try {
    await jobs(client, []);
  } finally {
    log.mockRestore();
  }
  const out = lines.join("\n");
  expect(out).toContain("ask nox: Deploy v2 to staging");
  expect(out).toMatch(/job_a1 · nouva · running · \d+s so far · ask at work/);
  expect(out).toContain("job_a2 · nouva · interrupted · 2s · ask");
  expect(out).not.toContain("process exited");
});
