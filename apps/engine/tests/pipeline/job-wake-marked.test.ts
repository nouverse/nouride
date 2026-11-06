/**
 * A finished job's wake-up is recorded as taken the moment the queue hands it on (`jobs.woke_at`).
 *
 * The other half of `tests/storage/job-wakes.test.ts`: boot reports a job with no `woke_at`, so a wake-up
 * that did reach its agent has to say so, or every restart would report it again.
 */

import { afterEach, expect, test } from "bun:test";
import type { Gateway } from "@nouride/shared";
import type { JobRecord } from "@/modules/jobs/jobs.store.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

test("a job's wake-up taken from the queue marks the job woken, once", async () => {
  const gateway = {
    id: "telegram:main",
    platform: "telegram",
    status: "connected",
    send: async () => ["1"],
    setTyping: async () => {},
  } as unknown as Gateway;

  const marked: string[] = [];
  // One attempt: nothing answers the turn the wake-up starts, and the real backoff is half a minute.
  bench = await pipelineBench({ maxAttempts: 1, gateways: [gateway], deps: { jobWakes: { markWoken: (id) => void marked.push(id) } } });
  const { pipeline } = bench;

  const job = {
    id: "job_1",
    agentId: "nouva",
    gatewayId: "telegram:main",
    chatId: "42",
    command: "make",
    cwd: "/tmp",
    status: "succeeded",
    pid: null,
    exitCode: 0,
    logPath: "/tmp/job_1.log",
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    onComplete: null,
  } as JobRecord;
  pipeline.wakeForJob({ job, tail: "ok" });
  await pipeline.idle();

  expect(marked).toEqual(["job_1"]);
});
