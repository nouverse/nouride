/**
 * `_session/steering` (0.8.10): an extension both installed adapters offer — claude-agent-acp 0.95 and codex-acp 2.3 —
 * said in their handshake as `_meta.steering.supported`. Words for a prompt that is running; with `idleBehavior:
 * "promptRequired"` an agent with no prompt running starts nothing and hands the words back, as Claude's does.
 */

import { describe, expect, test } from "bun:test";
import { AcpClient } from "../src/client.ts";
import { AcpPeer } from "../src/peer.ts";
import { ACP_PROTOCOL_VERSION, steerOutcomeOf, steeringOffered } from "../src/protocol.ts";

const later = (fn: () => void) => void setTimeout(fn, 0);

describe("steering a running prompt", () => {
  test("offered only where the handshake says so", () => {
    expect(steeringOffered({ _meta: { steering: { supported: true } } })).toBe(true);
    expect(steeringOffered({ _meta: { steering: { supported: "yes" } } })).toBe(false);
    expect(steeringOffered({ _meta: { steering: true } })).toBe(false);
    expect(steeringOffered({ _meta: {} })).toBe(false);
    expect(steeringOffered({})).toBe(false);
    expect(steeringOffered(null)).toBe(false);
  });

  test("its answer read as one of the four, anything else a failure", () => {
    for (const outcome of ["injected", "promptRequired", "startedNewTurn"] as const) expect(steerOutcomeOf({ outcome })).toBe(outcome);
    expect(steerOutcomeOf({ outcome: "failed" })).toBe("failed");
    expect(steerOutcomeOf({ outcome: "queued" })).toBe("failed");
    expect(steerOutcomeOf(null)).toBe("failed");
  });

  test("asked with the words and promptRequired for an idle session; a refusal is `failed`, never thrown", async () => {
    let client!: AcpClient;
    const asked: unknown[] = [];
    let refuse = false;
    const agent = new AcpPeer(
      { send: (line) => later(() => client.receive(line)) },
      {
        request: async (method, params) => {
          if (method === "initialize") return { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {}, _meta: { steering: { supported: true } } };
          asked.push({ method, params });
          if (refuse) throw new Error("no such session");
          return { outcome: "injected" };
        },
      },
    );
    client = new AcpClient({ transport: { send: (line) => later(() => agent.receive(line)) }, permission: async () => ({ outcome: "cancelled" }) });
    const info = await client.initialize();
    expect(steeringOffered(info)).toBe(true);
    expect(await client.steer("s1", [{ type: "text", text: "use the second tab" }])).toBe("injected");
    expect(asked).toEqual([
      { method: "_session/steering", params: { sessionId: "s1", prompt: [{ type: "text", text: "use the second tab" }], _meta: { steering: { idleBehavior: "promptRequired" } } } },
    ]);
    refuse = true;
    expect(await client.steer("s1", [{ type: "text", text: "again" }])).toBe("failed");
  });
});
