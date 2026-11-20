/**
 * The door, for somebody let in ahead by the id a person knows them by (a list of usernames, or of phone numbers):
 * their message carries the platform's own id, and the id on the list beside it (`MessageEnvelope.senderAlso`). The
 * door asked about the first alone, and such a list let nobody in. Through the real pipeline, in `pair` mode.
 */

import { afterEach, expect, test } from "bun:test";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

let bench: Bench | undefined;
afterEach(() => {
  bench?.dispose();
  bench = undefined;
});

test("a message with a listed id beside its own is answered; one whose other id is not on the list is given a code", async () => {
  const gateway = new FakeGateway();
  bench = await pipelineBench({ turns: [{ text: "Halo." }], agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["plan"]\n', gateways: [gateway], config: { security: { access: { mode: "pair" } } } });
  bench.pipeline.setTools(createBuiltinTools({ security: bench.config.security }));
  bench.pipeline.attach();
  bench.access.allowMany("telegram:main", [{ senderId: "@sam_lee" }], "gading");

  gateway.receive(envelope({ id: "m-stranger", timestamp: Date.now(), chatId: "700700701", senderId: "700700701", senderAlso: ["@somebody_else"], text: "halo" }));
  await eventually(() => bench!.access.get("telegram:main", "700700701")?.status === "pending", 5_000, "the stranger's request");
  expect(bench.requests).toHaveLength(0);

  gateway.receive(envelope({ id: "m-known", timestamp: Date.now(), chatId: "700700700", senderId: "700700700", senderAlso: ["@sam_lee"], text: "halo" }));
  await eventually(() => bench!.requests.length === 1, 5_000, "the turn of the one let in");
  await eventually(() => gateway.sent.some((message) => message.text === "Halo."), 5_000, "its answer");
  // No request was made of them: they were let in, not asked to pair.
  expect(bench.access.get("telegram:main", "700700700")).toBeNull();
});
