/**
 * Done outside its checks (0.8.7): the work landed another way, and a person — or the agent the mission is, through
 * `work` — closes it as accepted with a note saying where. Its checks do not run, and its notice never says they passed.
 * The same from a chat (`/mission accept <id> --outside "…"`), the control API and the CLI. And `/mission show`, where a
 * long question is read whole.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Client } from "@nouride/cli-kit";
import { mission as missionCommand } from "../../../cli/src/commands/mission.ts";
import { missionHooks } from "@/modules/hooks/builtins/mission.ts";
import type { HookContext } from "@/modules/hooks/types.ts";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { missionsHarness, STARTERS_CTX } from "./harness.ts";

/** `/mission …` typed in the mission's own DM. */
async function typed(h: Awaited<ReturnType<typeof missionsHarness>>, text: string): Promise<string | undefined> {
  const args = text.split(/\s+/).slice(1);
  const ctx = {
    deps: { missions: h.missions },
    args,
    gatewayId: "telegram:nova",
    chatId: "8142",
    senderId: "8142",
    agent: { config: { id: "nova" } },
    envelope: { chatType: "dm", senderName: "Gading" },
  } as unknown as HookContext;
  const result = await missionHooks[0]!.handler(ctx);
  return result.reply;
}

describe("closing a mission as done outside its checks", () => {
  test("ends it done and accepted, its checks not run, the notice saying so — never that checks passed", async () => {
    const h = await missionsHarness();
    let ran = 0;
    h.setChecks(async () => (ran++, { passed: true, failed: null }));
    const mission = await h.start("ship it", { checks: ["test -s out.md"] });
    const closed = h.missions.acceptOutside(mission.id, "merged by hand in #31", "Gading");
    expect("refused" in closed).toBe(false);
    const after = h.store.get(mission.id)!;
    expect(after.status).toBe("done");
    expect(after.report).toBe("Done outside its checks: merged by hand in #31");
    expect(ran).toBe(0);
    expect(h.stopped).toContain(mission.id);
    const notice = h.told.at(-1)!.text;
    expect(notice).toContain("done (accepted by Gading, done outside its checks: merged by hand in #31).");
    expect(notice).not.toContain("checks passed");
  });

  test("keeps the report the agent wrote: the note is why it was closed, not a replacement for what was done", async () => {
    const h = await missionsHarness();
    const mission = await h.start("ship it", { checks: ["git fetch && git merge-base --is-ancestor a b"] });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "The check cannot run. A) close it B) leave it" }));
    h.store.save({ ...h.store.get(mission.id)!, report: "Merged 4dd2a07a; 49 sabotage runs caught" });
    h.missions.acceptOutside(mission.id, "merged by hand", "Gading");
    expect(h.store.get(mission.id)!.report).toBe("Merged 4dd2a07a; 49 sabotage runs caught");
    // Sent whole as `report.md` (0.8.11): the mission was waiting on a question, so it had not reached the chat.
    await h.settle();
    expect(h.reports.at(-1)?.report).toBe("Merged 4dd2a07a; 49 sabotage runs caught");
  });

  test("refused without a note, and for one that already ended", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    expect(h.missions.acceptOutside(mission.id, "  ", "Gading")).toEqual({ refused: "Say where it was done: a note after the id.", why: "empty" });
    h.missions.stop(mission.id, "Gading");
    expect(h.missions.acceptOutside(mission.id, "x", "Gading")).toMatchObject({ refused: expect.stringContaining("has already ended") });
  });
});

describe("from a chat", () => {
  test('/mission accept <id> --outside "<note>" closes it; /mission show reads it whole', async () => {
    const h = await missionsHarness();
    const mission = await h.start("ship it", { checks: ["bun test"] });
    const question = `${"Long context. ".repeat(300)}\nA) keep\nB) drop`;
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question }));
    const shown = await typed(h, `/mission show ${mission.id.slice(0, 10)}`);
    expect(shown).toContain(`Asks: ${question}`);
    expect(shown).toContain("Done when: the commands pass (`bun test`");
    expect(await typed(h, `/mission accept ${mission.id.slice(0, 10)} --outside "done in msn_other"`)).toBeUndefined();
    expect(h.store.get(mission.id)!.report).toBe("Done outside its checks: done in msn_other");
  });
});

describe("from the control API and the CLI", () => {
  test("POST /missions/:id/accept with `outside` closes it so; without, it is the usual accept", async () => {
    const h = await missionsHarness();
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "operator", role: "operator", user: { id: "usr_op", username: "op", displayName: "Op" } });
      await next();
    });
    registerMissionRoutes(control as never, {
      ctx: STARTERS_CTX, missions: h.missions, notes: h.notes, approvals: { pending: () => [] }, audit: { record: () => {} } } as never);
    const mission = await h.start("ship it", { checks: ["bun test"] });
    const post = (body: unknown) => control.request(`/missions/${mission.id}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({})).status).toBe(409);
    expect((await post({ outside: "merged by hand" })).status).toBe(200);
    expect(h.store.get(mission.id)!.reason).toBe("accepted by Op, done outside its checks: merged by hand");
  });

  test("nouride mission accept <id> --outside <note> posts the note", async () => {
    const posted: { path: string; body: unknown }[] = [];
    const client = { post: async <T>(path: string, body: unknown) => (posted.push({ path, body }), { mission: { id: "msn_1", status: "done", waitKind: null } }) as T } as unknown as Client;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await missionCommand(client, ["accept", "msn_1", "--outside", "merged", "by", "hand"]);
    } finally {
      log.mockRestore();
    }
    expect(posted).toEqual([{ path: "/missions/msn_1/accept", body: { outside: "merged by hand" } }]);
  });
});
