/**
 * `/reset` and `/new` say how much they cleared — turns, messages and about how many tokens — instead of only
 * "Context cleared" (owner, 2026-10-21).
 */

import { afterEach, expect, test } from "bun:test";
import { envelope as envelopeAt } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const say = (text: string, id: string) => envelopeAt({ id, text, timestamp: Date.now() });

test("/reset says the turns, messages and tokens it cleared, and that an empty one was already empty", async () => {
  const b = await pipelineBench({ turns: [{ text: "hai juga" }, { text: "ok" }] });
  cleanup.push(b.dispose);
  b.pipeline.attach();

  b.gateway.receive(say("halo, apa kabar?", "m1"));
  await b.pipeline.idle();
  b.gateway.receive(say("/reset", "m2"));
  await b.pipeline.idle();
  expect(b.gateway.lastText()).toMatch(/^Reset\. Context cleared \(1 turn, 2 messages, ~\d+ tokens\), config reloaded\./);

  b.gateway.receive(say("/reset", "m3"));
  await b.pipeline.idle();
  expect(b.gateway.lastText()).toStartWith("Reset. Context was already empty, config reloaded.");
});

test("/new says the same", async () => {
  const b = await pipelineBench({ turns: [{ text: "hai juga" }, { text: "siap" }] });
  cleanup.push(b.dispose);
  b.pipeline.attach();

  b.gateway.receive(say("halo", "n1"));
  await b.pipeline.idle();
  b.gateway.receive(say("lanjut", "n2"));
  await b.pipeline.idle();
  b.gateway.receive(say("/new", "n3"));
  await b.pipeline.idle();
  expect(b.gateway.lastText()).toMatch(/^New conversation started\. Cleared 2 turns, 4 messages, ~\d+ tokens\./);
});
