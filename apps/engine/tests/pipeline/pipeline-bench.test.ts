/**
 * The shared Pipeline bench is wired the way boot wires it — a turn through it lands where a real one does. A bench
 * that drifted from production would test a path nobody runs.
 */

import { afterEach, expect, test } from "bun:test";
import { messageText } from "@nouride/shared";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

test("a turn through the bench is recorded, evented, owed in the inbox until answered, and leaves no journal", async () => {
  bench = await pipelineBench({ turns: [{ text: "hello back" }] });
  bench.pipeline.attach();
  bench.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "hello", timestamp: Date.now() }));
  await bench.pipeline.idle();

  expect(bench.gateway.sent.map((m) => m.text)).toContain("hello back");
  const count = (sql: string) => bench!.db.prepare<{ n: number }>(sql).get()!.n;
  expect(count("SELECT COUNT(*) AS n FROM turn_records")).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM events")).toBeGreaterThan(0);
  expect(bench.db.prepare<{ status: string }>("SELECT status FROM inbox WHERE id = ?").get(`${bench.gateway.id}:chat-1:m1`)?.status).toBe("done");
  expect(bench.journal.count()).toBe(0);
});

test("the turn store and the durable stores' transaction are one event stream: its rows are told once committed", async () => {
  // Boot's wiring (`durableStores(db, events)`): a turn's settle is the stream's batch, so a follower is told of its
  // rows after the commit. A turn store on a stream of its own, or a settle that is a bare transaction, tells nobody
  // here — or tells them inside the transaction, of rows a rollback would take back.
  bench = await pipelineBench({ turns: [{ text: "hello back" }] });
  const told: { kind: string; inTransaction: boolean }[] = [];
  bench.events.subscribe({}, (row) => told.push({ kind: row.kind, inTransaction: bench!.db.inTransaction() }));
  bench.pipeline.attach();
  bench.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "hello", timestamp: Date.now() }));
  await bench.pipeline.idle();

  expect(told.map((row) => row.kind)).toContain("turn");
  expect(told.filter((row) => row.inTransaction)).toEqual([]);
});

test("several packs, the connections a test names, and config sections as an operator writes them", async () => {
  const local = new LocalGateway();
  bench = await pipelineBench({
    agents: ["nouva", { id: "nox", soul: "Be terse." }],
    gateways: [local],
    config: { agents: { mention_max_hops: 7 } },
  });

  expect(bench.registry.enabled().map((agent) => agent.config.id).sort()).toEqual(["nouva", "nox"]);
  expect([...bench.gateways.keys()]).toEqual([local.id]);
  expect(bench.config.agents.mentionMaxHops).toBe(7);
  // A section the test did not give is still the bench's — and access is open, since `[security.access]` was not given.
  expect(bench.config.llm.defaults.provider).toBe("test");
  expect(bench.config.security.access.mode).toBe("open");
});

test("the next process over the install has the first one's conversation and pauses, and everything else of its own", async () => {
  bench = await pipelineBench({ turns: [{ text: "first answer" }] });
  bench.pipeline.attach();
  bench.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "hello", timestamp: Date.now() }));
  await bench.pipeline.idle();
  bench.registry.pause("nouva");

  const next = await bench.reboot({ turns: [{ text: "second answer" }] });
  expect(next.pipeline).not.toBe(bench.pipeline);
  expect(next.gateway).not.toBe(bench.gateway);
  expect(next.db).toBe(bench.db);
  const kept = next.sessions.load({ agentId: "nouva", gatewayId: next.gateway.id, chatId: "chat-1" }).messages;
  expect(kept.map((message) => messageText(message.content))).toContain("first answer");
  // Kept beside the database, as `/stop` is across a restart.
  expect(next.registry.isPaused("nouva")).toBe(true);
});
