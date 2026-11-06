/**
 * The steps a chat's turns took (0.8.0), as each turn's own line counts them — a call, or a wait on a person — so a
 * mission's page says the same number above its turns as the turns listed under it. Counting tool calls alone said 8
 * above turns of 8 and 3: the first had waited three times on a person. A turn recorded without its steps counts its
 * tool calls.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { openAndMigrate } from "@/db/index.ts";
import { tempDir, turnStore } from "../helpers.ts";

test("calls and waits, as the turns' own lines count them; a turn without steps by its tool calls; that chat's only", async () => {
  const db = await openAndMigrate(join(tempDir("steps-in"), "nouride.db"));
  const turns = turnStore(db);
  const begin = (chatId: string) => turns.begin({ sessionId: `ses_${chatId}`, agentId: "nouva", gatewayId: "web:mission", chatId, prompt: "go" });

  // Five calls and three waits on a person: eight, as its line says — though only five were tool calls.
  const first = begin("msn_1");
  for (let n = 0; n < 5; n += 1) {
    turns.step(first, "tool", "send_message", { callId: `c${n}`, name: "send_message" });
    turns.step(first, "tool_done", "send_message ok", { callId: `c${n}`, name: "send_message", error: false, outcome: "ok" });
  }
  for (let n = 0; n < 3; n += 1) turns.step(first, "waiting", "waiting for approval: send_message", { callId: `c${n}` });
  turns.step(first, "reasoning", "thinking it over");
  turns.finish(first, { status: "done", toolCalls: 5 });
  // Steps not kept: its tool calls stand in.
  turns.finish(begin("msn_1"), { status: "done", toolCalls: 3 });
  turns.finish(begin("msn_2"), { status: "done", toolCalls: 9 });

  expect(turns.stepsIn("web:mission", "msn_1")).toBe(11);
  expect(turns.stepsIn("web:mission", "msn_none")).toBe(0);
});
