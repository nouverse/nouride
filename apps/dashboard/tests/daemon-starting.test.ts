/**
 * A daemon that answers from its first second of boot (D1 in the engine): `/health` says "starting", and every other
 * route is a 503 until boot is done. The dashboard used to see nothing at all in that window; now it sees an answer,
 * and has to read it as "not yet" — never as "back", and never as data.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, request } from "@/commons/lib/api.client";
import { readRestart } from "@/commons/lib/restart-watch";
import type { HealthPayload } from "@nouride/wire";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const health = (status: HealthPayload["status"], uptime: number): HealthPayload => ({
  status,
  uptime,
  version: "0.7.3",
  agents: 1,
  gateways: {},
});

describe("following a restart", () => {
  test("a daemon still starting is not back — even one already answering with a fresh uptime", () => {
    expect(readRestart(health("starting", 1), 3_600, true)).toBe("away");
    expect(readRestart(health("starting", 1), 3_600, false)).toBe("away");
  });

  test("back once it is done: after a silence, or with an uptime smaller than before", () => {
    expect(readRestart(health("ok", 2), 3_600, true)).toBe("back");
    expect(readRestart(health("degraded", 2), 3_600, false)).toBe("back");
  });

  test("the process that was asked to restart, still running its work, is neither", () => {
    expect(readRestart(health("ok", 3_700), 3_600, false)).toBe("same");
    expect(readRestart(null, 3_600, false)).toBe("away");
    expect(readRestart(health("shutting_down", 3_700), 3_600, false)).toBe("away");
  });
});

describe("a 503", () => {
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  };

  test("from /health is the payload to show — degraded, or starting", async () => {
    answer(503, { ...health("starting", 3), phase: "loading agents" });

    expect(await request<HealthPayload>("/api/health")).toMatchObject({ status: "starting", phase: "loading agents" });
  });

  test("from anything else is the refusal it says it is, not a body of the wrong shape", async () => {
    answer(503, { error: "nouride is starting: loading agents", note: "It answers once it is ready; try again in a few seconds." });

    const refused = await request("/api/control/status").catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(503);
    expect((refused as ApiError).message).toBe("nouride is starting: loading agents");
  });
});
