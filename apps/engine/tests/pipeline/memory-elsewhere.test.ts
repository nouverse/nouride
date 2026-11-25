/**
 * What a person said in a group earlier today, in the prompt of their direct chat with the same agent, before any cut:
 * through the pipeline, on an install's defaults (no nightly pass, no facts kept, no notes on the person), where the
 * memory block's other parts are empty.
 *
 * Asked in a direct chat what was decided in a group an hour before, an agent said it could not see the group. And
 * with nothing else to recall, the block that would have named the group's talk was dropped from the prompt whole.
 */

import { afterEach, expect, test } from "bun:test";
import { bootMemory, checkMemoryVault } from "@/boot/memory.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import type { Memory } from "@/modules/memory/index.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope as envelopeAt, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const benches: Bench[] = [];
afterEach(async () => {
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

const OWNER = "814";
const GROUP = "-100777";

test("the group's talk is named in the direct chat's prompt, by its first line, with the id that opens it", async () => {
  let memory!: Memory;
  const bot = new FakeGateway("telegram:nouva", "telegram");
  const bench = await pipelineBench({
    turns: [{ text: "Dalang: it has a CLI." }, { text: "From the group: Dalang." }],
    agents: [{ id: "nouva", configToml: '[agent]\ndisplay_name = "Nouva"\n\n[llm]\nprovider = "test"\n' }],
    config: {
      daemon: { orchestrator: "nouva" },
      people: [{ ids: [`telegram:${OWNER}`], name: "Gading", key: "gading" }],
      security: { access: { mode: "pair", allowlist: [OWNER] } },
      gateways: { telegram: { nouva: { enabled: true, token: "t1", agent: "nouva" } } },
    },
    configure: (config) => {
      config.queue.steerReply = false;
    },
    gateway: bot,
    deps: async ({ config, db, turns, providers }) => {
      const roomMessages = new RoomMessageStore(db);
      memory = await bootMemory(config, db, { turns, roomMessages, providers, vaultFormat: await checkMemoryVault(config) });
      return { roomMessages, memory };
    },
  });
  benches.push(bench);
  bench.pipeline.setTools(createBuiltinTools({ security: bench.config.security, memory }));
  bench.pipeline.attach();

  bot.receive(envelopeAt({ id: "g1", timestamp: Date.now() - 60_000, gatewayId: "telegram:nouva", chatType: "group", chatId: GROUP, senderId: OWNER, senderName: "Gading", text: "nouva, which provider for the client pods? dalang or sumopod?", mentionsSelf: true }));
  await bench.pipeline.idle();
  bot.receive(envelopeAt({ id: "d1", timestamp: Date.now(), gatewayId: "telegram:nouva", chatType: "dm", chatId: OWNER, senderId: OWNER, senderName: "Gading", text: "what did we decide in the group?" }));
  await bench.pipeline.idle();

  expect(bench.requests).toHaveLength(2);
  const asked = JSON.stringify((bench.requests[1] as { messages: unknown[] }).messages);
  expect(asked).toContain("Conversations since the last nightly pass, not summarized yet");
  expect(asked).toContain("nouva, which provider for the client pods? dalang or sumopod?");
  expect(asked).toMatch(/⟨live-[a-z0-9-]+⟩/);
});
