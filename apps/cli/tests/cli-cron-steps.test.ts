/**
 * `nouride cron` for a job of several steps: the list read from a file and sent as it is, a start by hand, how a
 * run's steps went, and an answer to a step that waits for a person. The daemon reads and refuses a step, so what is
 * held here is that the CLI sends the file's list whole, and says what the daemon answered.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@nouride/cli-kit";
import { cron } from "../src/commands/cron.ts";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-cli-steps-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A client that records what it is sent and answers with `answers`, by path. */
function client(answers: Record<string, unknown> = {}) {
  const posts: { path: string; body: unknown }[] = [];
  const made = {
    get: async <T>(path: string) => (answers[path] ?? {}) as T,
    post: async <T>(path: string, body?: unknown) => {
      posts.push({ path, body });
      return (answers[path] ?? { job: { id: "cron_1", name: "weekly" } }) as T;
    },
  } as unknown as Client;
  return { made, posts };
}

async function said(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
  try {
    await run();
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

/** What a command that ends the process said, and the code it ended with. */
async function refused(run: () => Promise<void>): Promise<{ code: number | undefined; text: string }> {
  const lines: string[] = [];
  const err = spyOn(console, "error").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
  const log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
  let code: number | undefined;
  const exit = spyOn(process, "exit").mockImplementation(((given?: number) => {
    code = given;
    throw new Error("exit");
  }) as never);
  try {
    await run();
  } catch {
    // The command ended the process, which the double turns into a throw.
  } finally {
    exit.mockRestore();
    err.mockRestore();
    log.mockRestore();
  }
  return { code, text: lines.join("\n") };
}

test("`add --steps` sends the file's list whole, and `--manual` makes it one that a person starts", async () => {
  const steps = [
    { kind: "command", argv: ["sh", "-lc", "curl -sf https://shop.example.com/health"], then: "end", whenFailed: "next" },
    { kind: "agentTurn", message: "The shop is down: find out why.", agentId: "nix" },
  ];
  const file = join(dir, "steps.json");
  writeFileSync(file, JSON.stringify(steps));
  const { made, posts } = client();

  await said(() => cron(made, ["add", "--name", "shop", "--manual", "--steps", file, "--agent", "nouva", "--gateway", "telegram:main", "--chat", "1"]));

  expect(posts).toHaveLength(1);
  expect(posts[0]!.path).toBe("/cron");
  expect(posts[0]!.body).toMatchObject({ name: "shop", manual: true, agentId: "nouva", payload: { kind: "steps", steps } });
  // No time was given, and none is sent.
  expect(Object.keys(posts[0]!.body as object)).not.toContain("every");
});

test("the list may be the array, or a job's own `{ steps }`; `update --steps` changes a job's list", async () => {
  const file = join(dir, "payload.json");
  writeFileSync(file, JSON.stringify({ kind: "steps", steps: [{ kind: "systemEvent", text: "hello" }] }));
  const { made, posts } = client({ "/cron/cron_9": { job: { id: "cron_9", name: "weekly" } } });

  await said(() => cron(made, ["update", "cron_9", "--steps", file]));

  expect(posts[0]).toEqual({ path: "/cron/cron_9", body: { payload: { kind: "steps", steps: [{ kind: "systemEvent", text: "hello" }] } } });
});

test("a file that is missing, not JSON or not a list is refused before anything is sent, as misuse", async () => {
  const { made, posts } = client();
  const add = (file: string) => refused(() => cron(made, ["add", "--name", "x", "--manual", "--steps", file]));

  expect(await add(join(dir, "nowhere.json"))).toMatchObject({ code: 2 });
  writeFileSync(join(dir, "bad.json"), "{ not json");
  const bad = await add(join(dir, "bad.json"));
  expect(bad.code).toBe(2);
  expect(bad.text).toContain("is not JSON");
  writeFileSync(join(dir, "object.json"), JSON.stringify({ kind: "command" }));
  const none = await add(join(dir, "object.json"));
  expect(none.code).toBe(2);
  expect(none.text).toContain("holds no list of steps");
  expect(posts).toEqual([]);
});

test("`runs` says how each step of a run went, and names a run that waits so it can be answered", async () => {
  const { made } = client({
    "/cron/cron_1": {
      job: { id: "cron_1", name: "shop", describes: "when somebody starts it" },
      runs: [
        {
          id: "run_wait1",
          jobId: "cron_1",
          startedAt: 1_000,
          status: "waiting",
          result: "waiting at step 3 of 3, the wait for a person: for a person's answer",
          steps: [
            { id: "check", kind: "command", status: "failed", said: "exit 22\ncurl: (22) 503", startedAt: 1_000, ms: 420 },
            { id: "look", kind: "agentTurn", status: "done", said: "The database is not answering.", startedAt: 1_500, ms: 12_340 },
            { id: "ok", kind: "approval", status: "waiting", said: "Restart it?", startedAt: 14_000 },
          ],
        },
        { id: "run_old", jobId: "cron_1", startedAt: 0, finishedAt: 2_000, status: "success", result: "ok" },
      ],
    },
  });

  const out = await said(() => cron(made, ["runs", "cron_1"]));

  expect(out).toContain("⏸ 1970-01-01T00:00:01.000Z waiting · run_wait1");
  expect(out).toContain("✗ 1. check failed 0.4s  exit 22");
  expect(out).toContain("✓ 2. look done 12.3s  The database is not answering.");
  expect(out).toContain("⏸ 3. ok waiting  Restart it?");
  expect(out).toContain("✓ 1970-01-01T00:00:00.000Z 2s");
});

test("`continue` and `stop` answer the run that waits; without its id it is misuse", async () => {
  const { made, posts } = client({ "/automations/runs/run_wait1/answer": { ok: true } });

  expect(await said(() => cron(made, ["continue", "run_wait1"]))).toContain("it goes on from the step that waited");
  expect(await said(() => cron(made, ["stop", "run_wait1"]))).toContain("stopped at the step that waited");
  expect(posts).toEqual([
    { path: "/automations/runs/run_wait1/answer", body: { go: true } },
    { path: "/automations/runs/run_wait1/answer", body: { go: false } },
  ]);
  expect(await refused(() => cron(made, ["continue"]))).toMatchObject({ code: 2 });
});

test("the list says a job's steps and that one started by hand has no next time", async () => {
  const { made } = client({
    "/cron": {
      timezone: "UTC",
      jobs: [
        {
          id: "cron_1", name: "shop", enabled: true, agentId: "nouva", describes: "when somebody starts it", trigger: { kind: "manual" }, session: "fresh", runCount: 2, failCount: 0,
          target: { gatewayId: "telegram:main", chatId: "1" },
          payload: { kind: "steps", steps: [{ id: "a", kind: "systemEvent", text: "x" }, { id: "b", kind: "systemEvent", text: "y" }] },
        },
      ],
    },
  });
  const out = await said(() => cron(made, []));
  expect(out).toContain("when somebody starts it · next when started");
  expect(out).toContain("fresh · 2 steps · 2 runs");
});
