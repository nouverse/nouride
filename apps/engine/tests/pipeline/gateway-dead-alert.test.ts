/**
 * What the operator is told when a gateway gives up: a refused token says so, and what to do about it — not
 * "gave up reconnecting", which sends somebody to look at the network.
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

test("a refused token is said as one, with what to do — a dropped connection as before", async () => {
  const refused = await alertsOf((gateway) =>
    gateway.emit({ type: "dead", gatewayId: gateway.id, attempts: 1, reason: "auth_failed", detail: "Telegram refused the bot token: Unauthorized" }),
  );
  expect(refused).toHaveLength(1);
  expect(refused[0]).toContain("refused its credentials");
  expect(refused[0]).toContain("Telegram refused the bot token: Unauthorized");
  expect(refused[0]).toContain("nouride gateway restart");
  expect(refused[0]).not.toContain("gave up reconnecting");

  const dropped = await alertsOf((gateway) => gateway.emit({ type: "dead", gatewayId: gateway.id, attempts: 10 }));
  expect(dropped[0]).toContain("gave up reconnecting after 10 attempts");
});
