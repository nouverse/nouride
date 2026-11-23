/**
 * `GET /live-edits/:id`: a change an agent wrote to what a person has open on a page, fetched by that page.
 *
 * It is the person's who asked for it. What a draft holds is what its page showed them, and an id is no secret: it
 * rides on a row of the stream. So another account that knows the id is answered as if there were no such change.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { LiveEdits } from "@/modules/live-edit/index.ts";
import { registerLiveEditRoutes } from "@/modules/web/control/routes/live-edits.ts";

type Principal = { kind: "token" | "user"; actor: string; role: "viewer" | "operator" | "admin"; user?: { id: string } };

function mount(principal: Principal, liveEdits: LiveEdits | undefined) {
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  registerLiveEditRoutes(app as never, { pipeline: { liveEdits: () => liveEdits } } as never);
  return async (id: string) => {
    const res = await app.request(`/live-edits/${id}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
}

const edits = () => {
  const held = new LiveEdits({ automation: { tool: "schedule", noun: "automation", said: () => ({}), how: "" } }, () => 7_000);
  const id = held.propose({ kind: "automation", target: "cron_1", value: { name: "Morning mail" }, by: "nouva", gatewayId: "web:dashboard", chatId: "web-1", senderId: "usr_gading" });
  return { held, id };
};
const GONE = { error: "no such change", plain: "That change is no longer here. Ask the agent for it again." };

describe("a change held for its page", () => {
  test("is handed to the person who asked for it: which thing, by whom, when, and the thing with the change made", async () => {
    const { held, id } = edits();
    const get = mount({ kind: "user", actor: "gading", role: "operator", user: { id: "usr_gading" } }, held);
    expect(await get(id)).toEqual({ status: 200, body: { offer: { id, kind: "automation", target: "cron_1", value: { name: "Morning mail" }, by: "nouva", at: 7_000 } } });
  });

  test("an admin reads any, and so does a caller with the daemon's own token, which is no account", async () => {
    const { held, id } = edits();
    expect((await mount({ kind: "user", actor: "boss", role: "admin", user: { id: "usr_boss" } }, held)(id)).status).toBe(200);
    expect((await mount({ kind: "token", actor: "cli", role: "admin" }, held)(id)).status).toBe(200);
  });

  test("another account is answered as for a change that is not there: whether an id is somebody's is not theirs to learn", async () => {
    const { held, id } = edits();
    const other = mount({ kind: "user", actor: "rina", role: "operator", user: { id: "usr_rina" } }, held);
    // A viewer too: reading is not the same as it being theirs.
    expect((await mount({ kind: "user", actor: "tamu", role: "viewer", user: { id: "usr_tamu" } }, held)(id)).status).toBe(404);
    expect(await other(id)).toEqual({ status: 404, body: GONE });
    expect(await other("edit_nobody")).toEqual({ status: 404, body: GONE });
    // And who asked is never in an answer.
    const mine = await mount({ kind: "user", actor: "gading", role: "operator", user: { id: "usr_gading" } }, held)(id);
    expect(JSON.stringify(mine.body)).not.toContain("usr_gading");
    expect(JSON.stringify(mine.body)).not.toContain("web-1");
  });

  test("a daemon that holds none answers the same", async () => {
    expect(await mount({ kind: "token", actor: "cli", role: "admin" }, undefined)("edit_1")).toEqual({ status: 404, body: GONE });
  });
});
