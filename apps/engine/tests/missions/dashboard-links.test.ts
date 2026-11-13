/**
 * The dashboard links an agent's tools and a mission's notices carry (0.8.11, `web/links.ts`): a mission's page in
 * `work`'s answer, in what `mission` start answers and in the notices; where an approval is answered; a proposed job's
 * page among the automations. Each goes through the one rule, so a DM whose person holds no dashboard account gets none.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { linksFor, type LinkFor } from "@/modules/web/links.ts";
import { tempDir } from "../helpers.ts";
import { missionsHarness } from "./harness.ts";

const BASE = "https://agents.example.com";

/** 8142 holds a dashboard account, 555 none; a chat whose id starts `-100` is a group. */
function rule(publicUrl = BASE): LinkFor {
  return linksFor({ dashboard: () => ({ publicUrl }), hasAccount: (who) => who.senderId === "8142", chatTypeOf: (_gatewayId, chatId) => (chatId.startsWith("-100") ? "group" : "dm") });
}

const dm = (senderId: string) => ({ agentId: "nova", gatewayId: "telegram:nova", chatId: senderId, senderId, chatType: "dm" }) as ToolContext;
const ROOM = { agentId: "nova", gatewayId: "telegram:nova", chatId: "-100team", senderId: "555", chatType: "group" } as ToolContext;

async function workTool(linkFor?: LinkFor) {
  const h = await missionsHarness();
  const tool = createWorkTool({
    missions: h.missions,
    jobs: { list: () => [], get: () => null, tail: async () => "", kill: () => false },
    approvals: new SqliteApprovalGate({ db: h.db, timeoutMs: 60_000 }),
    ...(linkFor ? { linkFor } : {}),
  });
  return { h, tool };
}

describe("`work` mission: the page, for whom it opens", () => {
  test("a DM's person who holds a dashboard account, and a group: `Page:` under the first line", async () => {
    const { h, tool } = await workTool(rule());
    const mission = await h.start("write the report");
    const link = `${BASE}/dashboard/missions/${mission.id}`;
    for (const ctx of [dm("8142"), ROOM]) {
      const lines = (await tool.execute({ action: "mission", id: mission.id }, ctx)).content.split("\n");
      expect(lines[1]).toBe(`Page: ${link}`);
    }
  });

  test("none for a DM's person who holds no account, and none without `public_url`", async () => {
    const { h, tool } = await workTool(rule());
    const mission = await h.start("write the report");
    expect((await tool.execute({ action: "mission", id: mission.id }, dm("555"))).content).not.toContain("Page:");
    const unset = await workTool(rule(""));
    const other = await unset.h.start("write the report");
    expect((await unset.tool.execute({ action: "mission", id: other.id }, dm("8142"))).content).not.toContain("Page:");
  });
});

describe("`work` approval: where it is answered", () => {
  const park = (h: Awaited<ReturnType<typeof missionsHarness>>, id: string, gateway: string, chatId: string) =>
    h.db
      .prepare("INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, status, requested_at, timeout_ms) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, "nova", chatId, gateway, "exec", JSON.stringify({ command: "rm -rf build" }), 1_000_000, 60_000);

  test("a call a mission parked, on the mission's page; any other, on Overview", async () => {
    const { h, tool } = await workTool(rule());
    const mission = await h.start("clean the build");
    park(h, "apr_mission", "web:mission", mission.id);
    park(h, "apr_chat", "telegram:nova", "8142");
    expect((await tool.execute({ action: "approval", id: "apr_mission" }, dm("8142"))).content).toContain(`\nAnswer it: ${BASE}/dashboard/missions/${mission.id}\n`);
    expect((await tool.execute({ action: "approval", id: "apr_chat" }, dm("8142"))).content).toContain(`\nAnswer it: ${BASE}/dashboard/\n`);
    expect((await tool.execute({ action: "approval", id: "apr_chat" }, dm("555"))).content).not.toContain("Answer it:");
  });
});

describe("`mission` start: the page in what it answers", () => {
  test("started from a DM whose person holds an account, or a group: the page; from one who holds none: nothing", async () => {
    const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 } });
    const { chat } = createMissionTools(h.missions, { linkFor: rule() });
    const pageIn = async (ctx: ToolContext) => {
      const before = new Set(h.store.open().map((one) => one.id));
      const answer = (await chat.execute({ action: "start", goal: "count the lines", checks: ["true"] }, ctx)).content;
      const id = h.store.open().find((one) => !before.has(one.id))!.id;
      return { answer, link: `Page: ${BASE}/dashboard/missions/${id}` };
    };
    const own = await pageIn(dm("8142"));
    expect(own.answer).toContain(`\n${own.link}\n`);
    const room = await pageIn(ROOM);
    expect(room.answer).toContain(room.link);
    expect((await pageIn(dm("555"))).answer).not.toContain("Page:");
  });

  test("a start's result says the mission's page as a path, where the chat gets no link too; a refused start says none", async () => {
    const h = await missionsHarness();
    const { chat } = createMissionTools(h.missions, { linkFor: () => null });
    const started = await chat.execute({ action: "start", goal: "count the lines", checks: ["true"] }, dm("555"));
    expect(started.content).not.toContain("Page:");
    expect(started.page).toBe(`/missions/${h.store.open().at(-1)!.id}`);
    const refused = await chat.execute({ action: "start", goal: "" }, dm("555"));
    expect(refused.isError).toBe(true);
    expect(refused.page).toBeUndefined();
  });

  test("a mission proposed in a DM — nobody asked — carries the page for the chat's own person", async () => {
    const h = await missionsHarness();
    const { chat } = createMissionTools(h.missions, { linkFor: rule() });
    const answer = (await chat.execute({ action: "start", goal: "tidy the notes" }, { ...dm("8142"), senderId: "nouride:system" })).content;
    expect(answer).toStartWith("Drafted mission");
    expect(answer).toContain(`Page: ${BASE}/dashboard/missions/${h.store.open().at(-1)!.id}`);
  });
});

describe("a mission's notices: *started*, *needs you* and *done* carry its page", () => {
  test("each under the notice's text, where its chat gets a link", async () => {
    const h = await missionsHarness({ pageOf: (mission) => `${BASE}/dashboard/missions/${mission.id}` });
    const mission = await h.start("decide it");
    const page = `\n\nPage: ${BASE}/dashboard/missions/${mission.id}`;
    expect(h.told.at(-1)!.text).toEndWith(page);
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Blue it is.", report: "Why blue.", files: [] }));
    await h.settle();
    expect(h.store.get(mission.id)!.waitKind).toBe("accept");
    expect(h.told.at(-1)!.text).toContain(page);
    h.missions.accept(mission.id, "Gading");
    await h.settle();
    expect(h.told.at(-1)!.text).toStartWith("✓");
    expect(h.told.at(-1)!.text).toEndWith(page);
  });

  test("none where its chat gets none", async () => {
    const h = await missionsHarness({ pageOf: () => null });
    const mission = await h.start("write it", { checks: ["true"] });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Written.", report: "How.", files: [] }));
    await h.settle();
    expect(h.told.map((one) => one.text).join("\n")).not.toContain("Page:");
  });
});

describe("`schedule`: a proposed job's page among the automations", () => {
  async function scheduleTool(linkFor: LinkFor) {
    const db = openDatabase(join(tempDir("links-schedule"), "t.db"));
    await migrate(db);
    const store = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "Asia/Jakarta" });
    const tool = createScheduleTool({ chats: () => ({ chats: [], othersGateways: [] }), store, timezone: () => "Asia/Jakarta", agentExists: () => true, post: async () => true, linkFor });
    const propose = (ctx: ToolContext) => tool.execute({ name: "Standup", when: "cron 0 9 * * 1-5", text: "Standup in 15 minutes" }, { ...ctx, agentId: "nouva" });
    return { store, propose };
  }

  test("the link opens that job's card: for a DM's person with an account and in a group; not for one without", async () => {
    const { store, propose } = await scheduleTool(rule());
    const own = (await propose(dm("8142"))).content;
    const job = store.list({ includeDisabled: true }).at(-1)!;
    expect(own).toEndWith(` Its page: ${BASE}/dashboard/automations/${job.id}`);
    expect((await propose(ROOM)).content).toContain("/dashboard/automations/cron_");
    expect((await propose(dm("555"))).content).not.toContain("/dashboard/");
  });

  test("the result says the job's page as a path, with or without a link: a chat in the dashboard opens it", async () => {
    const { store, propose } = await scheduleTool(() => null);
    const made = await propose(dm("555"));
    expect(made.content).not.toContain("Its page");
    expect(made.page).toBe(`/automations/${store.list({ includeDisabled: true }).at(-1)!.id}`);
  });
});
