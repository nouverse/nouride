/**
 * A refused `mission` call is said in the log with the tool's own words.
 *
 * Two of an agent's starts failed in a millisecond on a live box and the third went through. The agent was told
 * why; the log said only "mission failed", and the turn journal that held the answer was gone by the time anyone
 * asked. Each refusal is now a log line naming the agent, the chat, the action and the words the agent was given.
 */

import { describe, expect, test } from "bun:test";
import { addLogSink, type LogEntry, type ToolContext } from "@nouride/shared";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { missionsHarness } from "./harness.ts";

const lines: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "tools.mission" && lines.push(entry)));

const chatCtx = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", senderId: "8142", turnId: "trn_1" } as ToolContext;

describe("a refused mission call", () => {
  test("in a chat: the line names the agent, the chat, the turn, the action, and says the words the agent got", async () => {
    const h = await missionsHarness();
    const tools = createMissionTools(h.missions);
    lines.length = 0;
    const answer = await tools.chat.execute({ action: "start", goal: "a motion graphic", now: true }, chatCtx);
    expect(answer.isError).toBe(true);
    // The agent, the chat and the turn are the line's own fields, as every line about a turn has them.
    const line = lines[0] as LogEntry & Record<string, unknown>;
    expect(lines).toHaveLength(1);
    expect([line.level, line.message, line.agent_id, line.chat_id, line.turn_id]).toEqual(["info", "mission call refused", "nova", "8142", "trn_1"]);
    expect(line.data).toEqual({ action: "start", why: answer.content });
  });

  test("inside a mission's turn too, and with an action that is none of its own", async () => {
    const h = await missionsHarness();
    const tools = createMissionTools(h.missions);
    lines.length = 0;
    const notAMission = await tools.inside.execute({ action: "done", summary: "x" }, chatCtx);
    const unknown = await tools.chat.execute({ action: "launch" }, chatCtx);
    expect([notAMission.isError, unknown.isError]).toEqual([true, true]);
    expect(lines.map((entry) => [entry.data?.action, entry.data?.why])).toEqual([
      ["done", "This turn is not a mission's."],
      ["launch", unknown.content],
    ]);
  });

  test("a call that went through says nothing here, and a very long answer is cut, not left out", async () => {
    const h = await missionsHarness();
    const tools = createMissionTools(h.missions);
    lines.length = 0;
    const started = await tools.chat.execute({ action: "start", goal: "draft a plan", workdir: "/tmp/x" }, { ...chatCtx, turnId: undefined } as ToolContext);
    expect(started.isError).toBe(false);
    expect(lines).toEqual([]);
    // A refusal that names what it was given: a draft id of 600 characters is said back in the answer.
    const long = await tools.chat.execute({ action: "edit", id: `msn_${"y".repeat(600)}` }, chatCtx);
    expect(long.isError).toBe(true);
    expect(long.content.length).toBeGreaterThan(400);
    const why = String(lines[0]?.data?.why ?? "");
    expect(why.length).toBe(400);
    expect(why.endsWith("…")).toBe(true);
    expect(long.content.startsWith(why.slice(0, -1))).toBe(true);
  });
});
