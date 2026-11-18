/**
 * The dashboard's way to `[queue] steer_reply` and `steer_ack`: what it reads, what it may send, and who may send it.
 * The settings service is a recorder here: what it does with the values is `steering-settings.test`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { registerSteeringRoutes } from "@/modules/web/control/routes/steering.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

let app: Hono;
let role: "admin" | "operator" | "viewer";
let saved: Record<string, unknown>[];

beforeEach(() => {
  role = "admin";
  saved = [];
  const config = structuredClone(DEFAULT_CONFIG);
  const settings = {
    setSteering: async (args: { reply?: boolean; ack?: boolean }) => {
      saved.push(args);
      if (args.reply !== undefined) config.queue.steerReply = args.reply;
      if (args.ack !== undefined) config.queue.steerAck = args.ack;
      return { ok: true, restartRequired: false };
    },
  };
  const deps = { ctx: { config }, settings } as unknown as ControlDeps;
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, { kind: "session", role, actor: "rina", user: { id: "u2", username: "rina", role } } as never);
    await next();
  });
  registerSteeringRoutes(app as never, deps);
});

const read = async () => (await (await app.request("/policy/steering")).json()) as Record<string, unknown>;
const send = (body: unknown) => app.request("/policy/steering", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("what a person is told while the agent works", () => {
  test("both read as they are in force", async () => {
    expect(await read()).toEqual({ reply: true, ack: true, editable: true });
  });

  test("steer_ack alone is sent on to the service, and the answer is what is in force after it", async () => {
    const answer = await send({ ack: false });
    expect(await answer.json()).toEqual({ ok: true, reply: true, ack: false });
    expect(saved).toEqual([{ ack: false, actor: "rina" }]);
  });

  test("anything but true or false is refused before the service sees it", async () => {
    for (const body of [{ ack: "off" }, { reply: 0 }]) expect((await send(body)).status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("anyone signed in reads them; only an admin changes them", async () => {
    for (const who of ["operator", "viewer"] as const) {
      role = who;
      expect((await read()).ack).toBe(true);
      expect((await send({ ack: false })).status).toBe(403);
    }
    expect(saved).toHaveLength(0);
  });
});
