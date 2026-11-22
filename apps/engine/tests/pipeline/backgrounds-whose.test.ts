/**
 * `/backgrounds` in a person's direct chat lists the command they had the agent leave running from a room.
 *
 * Found in a real Telegram group: a command left running from the group was listed there, and the same person's direct
 * chat with the agent listed only its own. A direct chat shows what the person started elsewhere, and a helper did
 * show: a helper's job kept who started it, a command's did not. The lists' own tests gave a command a sender, which
 * no command on the path that runs had, so here the command is started as an agent starts one: its model calls `exec`
 * with `background`, through the tool and the job store boot wires.
 */

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { JobStore, startJobFor } from "@/modules/jobs/jobs.store.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope, eventually, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const PACK = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["exec"]\napproval_required = []\n';

const benches: Bench[] = [];
const stores: JobStore[] = [];
afterEach(async () => {
  for (const jobs of stores.splice(0)) await jobs.killAll();
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

test("a command left running from a room: listed in that room, in its starter's direct chat as started elsewhere, and in nobody else's", async () => {
  const gateway = new FakeGateway();
  let jobs!: JobStore;
  const bench = await pipelineBench({
    gateway,
    agentToml: PACK,
    // The room's turn: the command left running, then what the agent says of it.
    turns: [{ toolCalls: [{ id: "e1", name: "exec", args: { command: "sleep 30", background: true } }] }, { text: "left running" }, { text: "left running" }],
    deps: ({ db, dataDir }) => {
      jobs = new JobStore({ db, logDir: join(dataDir, "jobs"), maxConcurrentPerAgent: 4 });
      return { jobs };
    },
  });
  benches.push(bench);
  stores.push(jobs);
  // As `boot/tools.ts` wires `exec`: its background jobs started through the store.
  bench.pipeline.setTools(createBuiltinTools({ security: bench.config.security, startJob: startJobFor(jobs) }));
  bench.pipeline.attach();

  const room = { chatId: "room-1", chatType: "group" as const, mentions: ["nouva"] };
  const said = async (more: NonNullable<Parameters<typeof envelope>[0]>) => {
    const before = gateway.sent.length;
    gateway.receive(envelope({ timestamp: Date.now(), ...more }));
    await eventually(() => gateway.sent.length > before, 4_000, `an answer to ${more.text}`);
    return gateway.sent.at(-1)!.text;
  };

  gateway.receive(envelope({ id: "m1", ...room, senderId: "user-1", text: "leave it running", timestamp: Date.now() }));
  await eventually(() => jobs.running("nouva").length === 1, 4_000, "the command left running");
  const [job] = jobs.running("nouva");
  expect([job!.kind, job!.chatId, job!.senderId]).toEqual(["command", "room-1", "user-1"]);
  await bench.pipeline.idle();

  const inRoom = await said({ id: "m2", ...room, senderId: "user-2", text: "/backgrounds" });
  expect(inRoom.split("\n").slice(0, 3)).toEqual(["**Running in the background for Nouva** (1)", "", expect.stringMatching(/^\*\*1\. A command\*\* · \d+s · no output yet$/)]);

  // Whoever started it, in their own chat with the agent: there, and said to be from elsewhere.
  const starters = await said({ id: "m3", chatId: "dm-1", senderId: "user-1", text: "/backgrounds" });
  expect(starters.split("\n").slice(0, 5)).toEqual([
    "**Running in the background for Nouva** (1)",
    "",
    expect.stringMatching(/^\*\*1\. A command\*\* · \d+s · no output yet · started in another chat$/),
    "`sleep 30`",
    `\`${job!.id}\``,
  ]);
  expect(await said({ id: "m4", chatId: "dm-1", senderId: "user-1", text: "/helpers" })).toBe("No helper is working for Nouva now.\n\n1 command runs in the background: /backgrounds");

  // Somebody else's chat with the agent: a command line can hold what another chat said.
  expect(await said({ id: "m5", chatId: "dm-2", senderId: "user-2", text: "/backgrounds" })).toBe("No command of Nouva's runs in the background now.");
});
