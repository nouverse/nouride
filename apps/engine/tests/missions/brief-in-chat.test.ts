/**
 * A mission's brief reaches its chat as a file, and has one place.
 *
 * Read on a live install: twenty-eight of an install's last thirty-three missions ended their goal with "Full brief:"
 * and a path, sixteen of them a path on the server, and the draft's notice said of the others "brief: on the mission's
 * page". A person reading the draft in a chat app could open neither, and started work whose instructions they had not
 * read. The daemon had asked for it: the goal's field said "a long one points at a brief file by its absolute path".
 */

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@nouride/shared";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { missionsHarness } from "./harness.ts";

const BRIEF = "Read docs/rfc first. Done means every section answers the owner.";
const person = (extra: Partial<ToolContext> = {}) => ({ agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", senderId: "8142", ...extra }) as ToolContext;

async function setup(options: Parameters<typeof missionsHarness>[0] = {}) {
  const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 }, ...options });
  const tools = createMissionTools(h.missions);
  const draft = async (args: Record<string, unknown> = {}) => {
    const before = new Set(h.store.open().map((one) => one.id));
    const answer = await tools.chat.execute({ action: "start", title: "A test mission", goal: "Revise the RFC to the owner's answers", checks: ["test -s RFC.md"], ...args }, person());
    await h.settle();
    return { answer, mission: h.store.open().find((one) => !before.has(one.id)) ?? null };
  };
  /** A mission at work hands a piece to another agent: a start with no draft before it. */
  const handOut = async (parent: Mission, args: Record<string, unknown> = {}) => {
    const before = new Set(h.store.open().map((one) => one.id));
    const answer = await tools.inside.execute({ action: "start", title: "A piece", goal: "the appendix, checked against the sources", agent: "nox", ...args }, person({ gatewayId: "web:mission", chatId: parent.id }));
    await h.settle();
    return { answer, mission: h.store.open().find((one) => !before.has(one.id)) ?? null };
  };
  return { h, tools, draft, handOut };
}

describe("a draft's brief, in the chat", () => {
  test("follows the draft's notice as BRIEF.md, whole, and the notice names the file", async () => {
    const { h, draft } = await setup();
    const { mission, answer } = await draft({ brief: BRIEF });
    expect(h.sent).toEqual(["notice", "BRIEF.md"]);
    expect(h.briefsSent).toEqual([{ mission: mission!.id, text: BRIEF }]);
    expect(h.told.at(-1)!.text).toContain("brief: BRIEF.md, the file below");
    expect(h.told.at(-1)!.text).not.toContain("on the mission's page");
    // The agent is told the person has it, so it neither pastes it nor keeps a copy of its own to point at.
    expect(answer.content).toContain("The person was sent it as BRIEF.md under the notice: do not paste it into the chat as well. Change it before it starts with `edit`, and they are sent it again.");
  });

  test("a brief the goal names by its path, in the agent's own folder, is sent as the same file", async () => {
    const named = "/work/private/nova/work/audit/BRIEF.md";
    const { h, draft } = await setup({ goalBriefOf: (mission) => (mission.goal.includes(named) ? named : null), readBrief: (path) => (path === named ? "Audit five vouchers against the ledger." : null) });
    const { mission } = await draft({ goal: `The five vouchers are audited. Full brief: ${named}` });
    expect(h.briefsSent).toEqual([{ mission: mission!.id, text: "Audit five vouchers against the ledger." }]);
    expect(h.told.at(-1)!.text).toContain("brief: BRIEF.md, the file below");
  });

  test("a draft with no brief sends none, and says so", async () => {
    const { h, draft } = await setup();
    const { mission, answer } = await draft();
    expect(h.sent).toEqual(["notice"]);
    expect(h.told.at(-1)!.text).toContain("brief: none");
    expect(answer.content).toContain(`It has no brief. One given with \`edit\` is kept as /work/private/nova/missions/${mission!.id}/BRIEF.md and sent to the person.`);
  });

  test("written anew by its agent it is sent again; another field changed, or a person's own change of it, sends nothing", async () => {
    const { h, tools, draft } = await setup();
    const { mission } = await draft({ brief: BRIEF });
    await tools.chat.execute({ action: "edit", id: mission!.id, title: "A better name" }, person());
    expect(h.briefsSent).toHaveLength(1);
    await tools.chat.execute({ action: "edit", id: mission!.id, brief: "Read docs/rfc and the owner's two answers first." }, person());
    expect(h.briefsSent.map((one) => one.text)).toEqual([BRIEF, "Read docs/rfc and the owner's two answers first."]);
    // On the dashboard, by the person: they wrote it, and are not sent their own words.
    expect("refused" in (await h.missions.edit(mission!.id, { brief: "Mine: start with section 3." }, {}))).toBe(false);
    expect(h.briefs.get(mission!.id)).toBe("Mine: start with section 3.");
    expect(h.briefsSent).toHaveLength(2);
  });

  test("a chat that cannot take the file is told so, with where the brief is read", async () => {
    const { h, draft } = await setup();
    h.setBriefRefused("it is 30 MB, over the 20 MB limit for this install.");
    await draft({ brief: BRIEF });
    expect(h.told.at(-1)!.text).toBe("BRIEF.md was not sent: it is 30 MB, over the 20 MB limit for this install. The brief is on the mission's page.");
  });

  test("a person's own draft, made on the dashboard, is not sent its brief back", async () => {
    const { h } = await setup();
    const mission = await h.start("the report, revised", { proposed: true, brief: "Mine: start with section 3." });
    expect(h.briefs.get(mission.id)).toBe("Mine: start with section 3.");
    expect(h.told.at(-1)!.text).toContain("brief: BRIEF.md, the file below");
    expect(h.briefsSent).toEqual([]);
  });

  test("a draft an automation's run made is sent the brief its goal names: nobody typed it just now", async () => {
    const named = "/work/private/nova/work/audit/BRIEF.md";
    const { h } = await setup({ goalBriefOf: (mission) => (mission.goal.includes(named) ? named : null), readBrief: (path) => (path === named ? "Audit five vouchers against the ledger." : null) });
    const mission = await h.start(`The week's vouchers are audited. Full brief: ${named}`, { proposed: true, jobId: "cron_1" });
    expect(h.told.at(-1)!.text).toContain("brief: BRIEF.md, the file below");
    expect(h.briefsSent).toEqual([{ mission: mission.id, text: "Audit five vouchers against the ledger." }]);
  });

  test("started, the brief sent under its draft is not sent a second time", async () => {
    const { h, draft } = await setup();
    const { mission } = await draft({ brief: BRIEF });
    h.missions.accept(mission!.id, "Gading");
    await h.settle();
    expect(h.store.get(mission!.id)!.status).toBe("running");
    expect(h.briefsSent).toHaveLength(1);
  });
});

describe("a start with no draft before it", () => {
  test("an agent's brief is in the mission's folder before its first turn, and sent under the notice that it started", async () => {
    let written = () => {};
    const { h, handOut } = await setup({ briefWritten: () => new Promise<void>((done) => (written = done)) });
    const parent = await h.start("the whole report");
    h.sent.length = 0;
    const handing = handOut(parent, { brief: BRIEF });
    await h.settle();
    // Held while its brief is being written: no first turn, which would name a file that is not there yet.
    const child = h.store.open().find((one) => one.parentId === parent.id)!;
    expect(h.queued.filter((one) => one.chatId === child.id)).toHaveLength(0);
    expect(h.briefs.has(child.id)).toBe(false);
    written();
    const { answer } = await handing;
    await h.settle();
    expect(h.briefs.get(child.id)).toBe(BRIEF);
    expect(h.queued.filter((one) => one.chatId === child.id)).toHaveLength(1);
    expect(h.sent).toEqual(["notice", "BRIEF.md"]);
    expect(h.briefsSent).toEqual([{ mission: child.id, text: BRIEF }]);
    expect(answer.content).toContain("Its brief is in its folder as BRIEF.md, and the person is sent it under the notice that it started.");
  });

  test("a brief that could not be written is said to the agent, and the mission begins from its goal", async () => {
    const { h, handOut } = await setup({ briefWritten: async () => Promise.reject(new Error("the disk is full")) });
    const parent = await h.start("the whole report");
    const { answer, mission } = await handOut(parent, { brief: BRIEF });
    expect(answer.content).toContain("Its brief could not be written (the disk is full): it starts from its goal alone.");
    expect(h.store.get(mission!.id)!.status).toBe("running");
    expect(h.briefsSent).toEqual([]);
  });

  test("a person's own start is sent nothing back, and neither is a job's run", async () => {
    const named = "/work/private/nova/work/audit/BRIEF.md";
    const { h } = await setup({ goalBriefOf: () => named, readBrief: () => "Audit five vouchers against the ledger." });
    await h.start(`The five vouchers are audited. Full brief: ${named}`);
    await h.start(`The five vouchers are audited again. Full brief: ${named}`, { byAgent: "nova", jobId: "cron_1" });
    expect(h.briefsSent).toEqual([]);
    // The same goal started by an agent, for a person to read: sent.
    await h.start(`The five vouchers are audited a third time. Full brief: ${named}`, { byAgent: "nova" });
    expect(h.briefsSent).toHaveLength(1);
  });
});

describe("what an agent is told about a brief", () => {
  const fields = (tool: { definition: { parameters: unknown } }) => (tool.definition.parameters as { properties: Record<string, { description: string }> }).properties;

  test("both tools take one, and say the person is sent it", () => {
    const tools = createMissionTools({} as never);
    expect(fields(tools.chat).brief!.description).toBe(
      "start, edit: the mission's brief (what the work is, why, what to read, what done means), in English: kept as BRIEF.md in its folder, named to each turn, and sent to the person as a file under its notice. Change it with `edit`, which sends it again, not with your file tools.",
    );
    expect(fields(tools.inside).brief!.description).toBe(
      "start: that mission's brief (what the work is, why, what to read, what done means), in English: kept as BRIEF.md in its folder, named to each turn, and sent to the person as a file under its notice.",
    );
  });

  test("neither tool's goal sends the detail to a file of the agent's own", () => {
    const tools = createMissionTools({} as never);
    for (const tool of [tools.chat, tools.inside]) {
      expect(fields(tool).goal!.description).toContain("Its detail goes in `brief`, never in a file of your own that the goal points at.");
      expect(JSON.stringify(tool.definition)).not.toContain("points at a brief file");
    }
  });
});
