/**
 * `nouride jobs` as a list (0.8.0): what runs, then the last few ended, each command on one line.
 *
 * It printed every job the daemon kept with its whole command — an agent asked what was running read twenty finished
 * jobs, heredocs and all, 276 lines and ~10k tokens to learn that nothing was (2026-10-24).
 */

import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Client } from "@nouride/cli-kit";
import { jobs } from "../../../cli/src/commands/jobs.ts";
import { registerJobRoutes } from "@/modules/web/control/routes/jobs.ts";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

function job(n: number, status: string, command = `echo job ${n}`) {
  return { id: `job_${n}`, agentId: "nouva", command, status, kind: "command", pid: null, exitCode: status === "succeeded" ? 0 : null, startedAt: 0, endedAt: status === "running" ? null : 1_000, processAlive: status === "running" ? true : null, logBytes: 0, logUpdatedAt: null };
}

async function run(rows: unknown[], args: string[] = []): Promise<{ out: string; asked: string[] }> {
  const asked: string[] = [];
  const client = { get: async <T>(path: string) => (asked.push(path), { jobs: rows }) as T } as unknown as Client;
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(plain(String(line ?? ""))));
  try {
    await jobs(client, args);
  } finally {
    log.mockRestore();
  }
  return { out: lines.join("\n"), asked };
}

const heredoc = "bash -lc cat > notes.md <<'EOF'\n# Findings\n- Key attachment lookup on the gateway id\n- second line of the body\nEOF";
const long = `ssh -i $KEY user@10.0.0.6 'ffmpeg -y -i input.mp4 -vf "subtitles=${"x".repeat(200)}" out.mp4'`;

test("what runs first, then the last five ended; the rest is counted and one flag away", async () => {
  const rows = [job(0, "running"), ...Array.from({ length: 19 }, (_, i) => job(i + 1, i % 6 === 5 ? "failed" : "succeeded"))];
  const { out, asked } = await run(rows);
  expect(asked).toEqual(["/jobs"]);
  expect(out).toContain("echo job 0");
  expect(out).toMatch(/job_0 · nouva · running/);
  for (const n of [1, 2, 3, 4, 5]) expect(out).toContain(`job_${n} ·`);
  expect(out).not.toContain("job_6 ·");
  expect(out).toContain("14 older jobs not shown · nouride jobs --all");
  expect(out).not.toContain("nothing running");
});

test("a command is one line: a heredoc's body and a long command stay out of the list", async () => {
  const { out } = await run([job(1, "succeeded", heredoc), job(2, "succeeded", long)]);
  expect(out).toContain("bash -lc cat > notes.md <<'EOF' …");
  expect(out).not.toContain("Key attachment lookup");
  const line = out.split("\n").find((l) => l.includes("ffmpeg"));
  expect(line).toBeDefined();
  expect(line!.length).toBeLessThanOrEqual(104);
  expect(line!.endsWith("…")).toBe(true);
  expect(out).toContain("nouride jobs log <id> for the whole command");
});

test("nothing running is said first, not left to be inferred from a list of finished jobs", async () => {
  const { out } = await run([job(1, "succeeded"), job(2, "interrupted")]);
  expect(out.split("\n")[0]).toBe("nothing running");
  expect(out).not.toContain("older");
});

test("--all asks for every job the daemon keeps and lists every ended one", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => job(i + 1, "succeeded"));
  const { out, asked } = await run(rows, ["--all"]);
  expect(asked).toEqual(["/jobs?all=1"]);
  expect(out).toContain("job_30 ·");
  expect(out).not.toContain("not shown");
});

test("the route takes a limit for --all, and keeps the store's default without one", async () => {
  const asked: unknown[] = [];
  const app = new Hono();
  // The command line's token, as `nouride` asks: it reads every conversation (`whose.ts`).
  app.use("*", async (c, next) => {
    c.set("principal" as never, { kind: "token", actor: "cli", role: "admin" } as never);
    await next();
  });
  registerJobRoutes(app as never, { jobs: { listSnapshots: (options: unknown) => (asked.push(options), []) }, ctx: { config: { people: [] } } } as never);
  await app.request("/jobs?limit=100");
  await app.request("/jobs");
  await app.request("/jobs?limit=abc");
  await app.request("/jobs?all=1");
  expect(asked).toEqual([{ limit: 100 }, {}, {}, { all: true }]);
});
