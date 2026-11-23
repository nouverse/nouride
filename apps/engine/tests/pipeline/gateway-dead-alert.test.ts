/**
 * What the operator is told when a gateway is down for longer than its fast tries. A refused token says so, and what
 * to do about it: it stays down until it has one that works. One that cannot be reached is not dead: it goes on
 * trying by itself, the message says how often, and a second message says when it is back.
 */

import { afterEach, expect, test } from "bun:test";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { sleep } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

async function alertsOf(emit: (gateway: Bench["gateway"]) => void): Promise<string[]> {
  const alerts: string[] = [];
  const bench = await pipelineBench({
    deps: { notifier: { alert: async (_key: string, text: string) => (alerts.push(text), true), toChat: async () => true } as never },
  });
  benches.push(bench);
  const { pipeline, gateway } = bench;
  pipeline.attach();
  emit(gateway);
  await sleep(10);
  return alerts;
}

test("a refused token is said as one, with what to do; one that cannot be reached is said to go on trying, and to be back", async () => {
  const refused = await alertsOf((gateway) =>
    gateway.emit({ type: "dead", gatewayId: gateway.id, attempts: 1, reason: "auth_failed", detail: "Telegram refused the bot token: Unauthorized" }),
  );
  expect(refused).toHaveLength(1);
  expect(refused[0]).toContain("refused its credentials");
  expect(refused[0]).toContain("Telegram refused the bot token: Unauthorized");
  expect(refused[0]).toContain("nouride gateway restart");
  expect(refused[0]).not.toContain("gave up reconnecting");

  const dropped = await alertsOf((gateway) => gateway.emit({ type: "unreachable", gatewayId: gateway.id, attempts: 10, retryEveryMs: 600_000 }));
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toContain("could not reconnect after 10 attempts");
  expect(dropped[0]).toContain("Messages there are not being delivered.");
  expect(dropped[0]).toContain("It goes on trying by itself every 10 minutes");
  expect(dropped[0]).toContain("nouride gateway restart");
  expect(dropped[0]).not.toContain("gave up");
  expect(dropped[0]).not.toContain("refused its credentials");

  const back = await alertsOf((gateway) => gateway.emit({ type: "back", gatewayId: gateway.id }));
  expect(back).toEqual([expect.stringContaining("is connected again.")]);
});
