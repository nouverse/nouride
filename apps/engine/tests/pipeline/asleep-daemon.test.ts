/**
 * Asleep through the pipeline (0.8.0): a person's message to an asleep agent is answered with one line, what the daemon
 * sends it waits for it to wake, and a turn it is in stops at its next step — never mid-call.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { JobPayload, Tool } from "@nouride/shared";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { CronScheduler } from "@/modules/cron/scheduler.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

const PACK = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["nap", "read"]\napproval_required = []\n';

async function daemon(turns: Parameters<typeof pipelineBench>[0] extends infer O ? (O extends { turns?: infer T } ? T : never) : never, napTool?: Tool) {
  const gateway = new FakeGateway();
  const bench = await pipelineBench({ turns, gateway, agentToml: PACK });
  benches.push(bench);
  const tools = createBuiltinTools({ security: bench.config.security });
  if (napTool) tools.set("nap", napTool);
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  return { bench, gateway };
}

describe("an asleep agent, through the pipeline", () => {
  test("a person is told it is asleep, once; what the daemon sends it runs when it wakes", async () => {
    const d = await daemon([{ text: "the job finished fine" }]);
    d.bench.registry.pause("nouva");
    d.gateway.receive(envelope({ id: "m1", text: "halo", timestamp: Date.now() }));
    d.gateway.receive(envelope({ id: "m2", text: "halo lagi", timestamp: Date.now() }));
    await eventually(() => d.gateway.sent.length >= 1, 4_000, "the asleep notice");
    await d.bench.pipeline.idle();
    expect(d.gateway.sent.map((message) => message.text)).toEqual(["Nouva is asleep and takes no work until someone wakes it: /wake."]);

    d.bench.pipeline.queueTurn(envelope({ id: "wake-1", text: "[system] Background job job_1 finished.", senderId: SYSTEM_SENDER, mentions: ["nouva"], timestamp: Date.now() }));
    await d.bench.pipeline.idle();
    expect(d.bench.requests).toHaveLength(0);

    d.bench.registry.resume("nouva");
    await eventually(() => d.bench.requests.length === 1, 4_000, "the kept message's turn");
    expect(JSON.stringify(d.bench.requests[0].messages)).toContain("Background job job_1 finished.");
  });

  test("a job of its due while it is asleep is recorded as skipped, whatever it runs — nothing is said, or kept for its wake", async () => {
    // Only a job's own turn checked: a reminder and a command still ran, and a turn into its chat was held and replayed
    // at the wake, once per occurrence, each recorded as dispatched (0.8.1).
    const d = await daemon([{ text: "ping" }, { text: "ping" }]);
    const store = new CronStore({ db: d.bench.db, config: d.bench.config.cron, timezone: "UTC" });
    const scheduler = new CronScheduler({ store, config: d.bench.config.cron, executors: d.bench.pipeline.cronExecutors() });
    const job = (name: string, payload: JobPayload, chat = false) =>
      store.create({ agentId: "nouva", name, trigger: { kind: "every", everyMs: 60_000 }, payload, target: { gatewayId: d.gateway.id, chatId: "chat-1" }, ...(chat ? { session: "chat" as const, delivery: { mode: "announce" as const } } : {}), createdBy: "t" });
    const jobs = [
      job("into its chat", { kind: "agentTurn", message: "Say ping." }, true),
      job("reminder", { kind: "systemEvent", text: "Drink water." }),
      job("command", { kind: "command", argv: ["sh", "-c", "echo ran"], then: "deliver" }),
    ];
    d.bench.registry.pause("nouva");
    for (const one of jobs) expect(await scheduler.runNow(one.id, "t")).toEqual({ status: "skipped", result: "agent asleep: nouva" });
    await d.bench.pipeline.idle();

    d.bench.registry.resume("nouva");
    await d.bench.pipeline.idle();
    expect(d.gateway.sent).toEqual([]);
    expect(d.bench.requests).toHaveLength(0);
    expect(store.runs(jobs[0]!.id, 5).map((run) => run.status)).toEqual(["skipped"]);
  });

  test("a turn it is in when put to sleep stops at its next step: the call in hand finishes, no new one starts", async () => {
    let naps = 0;
    const nap: Tool = {
      requiresApproval: false,
      definition: { name: "nap", description: "Puts the agent to sleep, as a person would mid-turn.", parameters: { type: "object", properties: {} } },
      async execute() {
        naps += 1;
        d.bench.registry.pause("nouva");
        return { content: "done", isError: false };
      },
    };
    const d = await daemon(
      [
        { toolCalls: [{ id: "n1", name: "nap", args: {} }] },
        { toolCalls: [{ id: "n2", name: "nap", args: {} }] },
        { text: "never said" },
      ],
      nap,
    );
    d.gateway.receive(envelope({ id: "m1", text: "work", timestamp: Date.now() }));
    await eventually(() => d.bench.turns.forChat("telegram:main", "chat-1").some((turn) => turn.status !== "running"), 4_000, "the turn's end");
    expect(naps).toBe(1);
    expect(d.bench.requests).toHaveLength(1);
    const [turn] = d.bench.turns.forChat("telegram:main", "chat-1");
    expect({ status: turn?.status, error: turn?.error }).toEqual({ status: "cancelled", error: "the agent was put to sleep while this turn was running" });
  });
});
