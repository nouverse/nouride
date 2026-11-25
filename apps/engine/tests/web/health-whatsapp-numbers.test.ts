/**
 * `/health` with two WhatsApp numbers: each is named by its own connection, and one in trouble is the one said.
 *
 * A daemon holds a connection for each number. A probe, `nouride status` and the dashboard's strip all read this
 * report, so which number is logged out or cut off must be in it by name, and the number that still works must not
 * be painted with the other's trouble.
 */

import { describe, expect, test } from "bun:test";
import type { DaemonContext } from "@/commons/context.ts";
import { buildHealth } from "@/modules/web/health.ts";

type Number = { status: string; waiting?: { reason: string; since: number } };

function ctx(numbers: Record<string, Number>): DaemonContext {
  return {
    gateways: new Map(Object.entries(numbers)),
    db: { walSizeBytes: () => 0 },
    config: { daemon: { dataDir: "/tmp/nr-health" } },
    providerErrors: new Map(),
    status: "running",
    startedAt: Date.now(),
    agentCount: 2,
  } as unknown as DaemonContext;
}

describe("/health with a number for each of two agents", () => {
  test("both linked: each named as connected, nothing to say", () => {
    const health = buildHealth(ctx({ "whatsapp:home": { status: "connected" }, "whatsapp:shop": { status: "connected" } }));
    expect(health.payload.gateways).toEqual({ "whatsapp:home": "connected", "whatsapp:shop": "connected" });
    expect(health.payload.issues).toBeUndefined();
    expect(health.payload.status).toBe("ok");
  });

  test("one logged out from its phone: it is the one named, and the other is still said to be connected", () => {
    const health = buildHealth(ctx({ "whatsapp:home": { status: "connected" }, "whatsapp:shop": { status: "dead" } }));
    expect(health.payload.gateways).toEqual({ "whatsapp:home": "connected", "whatsapp:shop": "dead" });
    expect(health.payload.issues).toEqual(["whatsapp:shop: dead"]);
    expect(health.payload.status).toBe("degraded");
  });

  test("one cut off and trying again, with what it waits on; one waiting for its scan: each by name, and the daemon is not degraded for either", () => {
    const waits = { reason: "WhatsApp has not answered: it tries again in 30 s.", since: Date.now() };
    const cut = buildHealth(ctx({ "whatsapp:home": { status: "connected" }, "whatsapp:shop": { status: "reconnecting", waiting: waits } }));
    expect(cut.payload.issues).toEqual(["whatsapp:shop: reconnecting. WhatsApp has not answered: it tries again in 30 s."]);
    expect([cut.payload.gateways?.["whatsapp:home"], cut.payload.status]).toEqual(["connected", "ok"]);

    const scan = { reason: "Waiting for its code to be scanned.", since: Date.now() };
    const pairing = buildHealth(ctx({ "whatsapp:home": { status: "connected" }, "whatsapp:shop": { status: "connecting", waiting: scan } }));
    expect(pairing.payload.issues).toEqual(["whatsapp:shop: connecting, waiting. Waiting for its code to be scanned."]);
    expect(pairing.payload.status).toBe("ok");
  });
});
