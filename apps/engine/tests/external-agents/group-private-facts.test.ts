/**
 * What a person brings into a group, their own facts said elsewhere, is not told to an agent that runs on a coding CLI.
 *
 * A model's prompt is built again on every turn, so the next person's turn holds none of it. A CLI's session keeps
 * every prompt it was given: told once, it would still be there when someone else spoke.
 */

import { expect, test } from "bun:test";
import { situationOf, untold } from "@/modules/external-agents/situation.ts";
import type { TurnRequest } from "@/modules/llm/executor/types.ts";
import type { Recall } from "@/modules/memory/index.ts";

const recall: Recall = {
  profiles: [{ name: "Gading", facts: [{ section: "Things", text: "Has a new bicycle." }] }],
  shared: [],
  upcoming: [],
  followUps: [],
  recent: [],
  waiting: [],
  own: { name: "Gading", facts: [{ section: "Vehicles", text: "Has a Honda BR-V, plate BG 1891 ZD." }] },
};
const req = (extra: Partial<TurnRequest> = {}) =>
  ({ toolset: { definitions: [], get: () => undefined }, gateway: "whatsapp", gatewayId: "whatsapp:coder", chatId: "1203@g.us", chatType: "group", senderId: "62811", person: { name: "Gading" }, recall, ...extra }) as unknown as TurnRequest;

test("its session is told who is speaking and what the group reads, and nothing of what he brought", () => {
  const told = situationOf(req());
  expect(told.who).toContain("You are talking to Gading.");
  expect(told.recall).toContain("Has a new bicycle.");
  expect(JSON.stringify(told)).not.toContain("BG 1891 ZD");
  expect(untold(told, undefined)).not.toContain("outside this group");
});
