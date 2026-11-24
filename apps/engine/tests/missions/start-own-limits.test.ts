/**
 * A mission made on the dashboard takes its own limits and its brief as it is made.
 *
 * The form had neither: a person who wanted one mission to work longer made it, opened the draft, pressed "Change the
 * draft" and typed the limit there, and one started at once could have none. A limit of a mission's own was a draft's
 * alone, a rule written for an agent's start that nobody says yes to; a person's own start is their yes.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ToolContext } from "@nouride/shared";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { missionsHarness, STARTERS_CTX } from "./harness.ts";

async function setup(options: Parameters<typeof missionsHarness>[0] = {}) {
  const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 }, ...options });
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role: "operator", user: { id: "usr_1", username: "gading" } });
    await next();
  });
  registerMissionRoutes(control as never, { ctx: STARTERS_CTX, missions: h.missions, notes: h.notes, approvals: { pending: () => [] }, audit: { record: () => {} } } as never);
  const make = async (body: Record<string, unknown>) => {
    const answer = await control.request("/missions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "nova", goal: "Upgrade the client", ...body }) });
    await h.settle();
    return { status: answer.status, body: (await answer.json()) as { mission?: { id: string; limits: { hours: number; turns: number; tokens: number } }; error?: string; plain?: string; note?: string; briefFailed?: string } };
  };
  return { h, make };
}

describe("a new mission's own limits, from the dashboard", () => {
  test("saved to the backlog with them, each left out the setting's, and its notice says them", async () => {
    const { h, make } = await setup();
    const { status, body } = await make({ draft: true, limits: { hours: 24, tokens: 400_000_000 } });
    expect(status).toBe(201);
    expect(body.mission!.limits).toEqual({ hours: 24, turns: 50, tokens: 400_000_000 });
    expect(h.store.get(body.mission!.id)!.limits).toEqual({ hours: 24, turns: 50, tokens: 400_000_000 });
    expect(h.told.at(-1)!.text).toContain("Its own limits before it asks you whether to go on: 24h of work (usually 8h) · 400M tokens (usually 50M)");
  });

  test("started at once with them: a person's own start is their yes", async () => {
    const { h, make } = await setup();
    const { status, body } = await make({ limits: { turns: 120 } });
    expect(status).toBe(201);
    expect(h.store.get(body.mission!.id)).toMatchObject({ status: "running", limits: { hours: 8, turns: 120, tokens: 50_000_000 } });
  });

  test("an agent's start that nobody says yes to still takes none", async () => {
    const { h } = await setup();
    const parent = await h.start("the whole report");
    const inside = { agentId: "nova", gatewayId: "web:mission", chatId: parent.id, chatType: "dm", senderId: "8142" } as ToolContext;
    const refused = await createMissionTools(h.missions).inside.execute({ action: "start", title: "A piece", goal: "a piece of it", agent: "nox", limit_turns: 900 }, inside);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("a mission's own limits are a draft's");
  });

  test("one out of its bounds, or not a number, is refused in the page's own words and nothing is made", async () => {
    const { h, make } = await setup();
    const over = await make({ draft: true, limits: { hours: 1000 } });
    expect(over.status).toBe(400);
    // The reason as the daemon says it, under the page's own everyday words.
    expect(over.body).toEqual({ error: "Its hours limit must be a number from 0.25 to 168, got 1000. It is in hours of work: 12, or 0.5 for half an hour.", plain: "The mission was not made. Check the limits you typed for it, and try again." });
    const words = await make({ limits: { turns: "many" } });
    expect(words.status).toBe(400);
    expect(words.body.error).toContain('Its turns limit must be a whole number from 1 to 1000, got "many".');
    expect(h.store.recent(5)).toHaveLength(0);
  });
});

describe("a new mission's brief, from the dashboard", () => {
  test("kept in its folder as it is saved, and not sent back to the person who wrote it", async () => {
    const { h, make } = await setup();
    const { body } = await make({ draft: true, brief: "  Mulai dari bagian 3, lalu cek tabelnya.  " });
    // A person's own words: theirs to write in their language, and kept as typed but for the space around them.
    expect(h.briefs.get(body.mission!.id)).toBe("Mulai dari bagian 3, lalu cek tabelnya.");
    expect(h.told.at(-1)!.text).toContain("brief: BRIEF.md, the file below");
    expect(h.briefsSent).toEqual([]);
  });

  test("started at once, it is in the folder before the first turn", async () => {
    let written = () => {};
    const { h, make } = await setup({ briefWritten: () => new Promise<void>((done) => (written = done)) });
    const making = make({ brief: "Read the changelog first." });
    await h.settle();
    const mission = h.store.open()[0]!;
    expect(h.queued.filter((one) => one.chatId === mission.id)).toHaveLength(0);
    written();
    const { status } = await making;
    await h.settle();
    expect(status).toBe(201);
    expect(h.briefs.get(mission.id)).toBe("Read the changelog first.");
    expect(h.queued.filter((one) => one.chatId === mission.id)).toHaveLength(1);
    expect(h.briefsSent).toEqual([]);
  });

  test("one that could not be written is said, and the mission is made all the same", async () => {
    const { make } = await setup({ briefWritten: async () => Promise.reject(new Error("the disk is full")) });
    const { status, body } = await make({ draft: true, brief: "Read the changelog first." });
    expect(status).toBe(201);
    expect(body).toMatchObject({ briefFailed: "the disk is full", note: "Its brief could not be written: the disk is full.", plain: "Saved, but its brief could not be written, so it has none for now. Whoever runs the server can see why." });
  });
});
