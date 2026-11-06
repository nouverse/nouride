/**
 * What a group's front desk is shown on the first message after its conversation was emptied (`room-memory.ts`).
 *
 * Live (2026-10-22): after the night's rollover, Nouva's first message in a Telegram group carried the question it had
 * answered the evening before, in the block of messages it "was not addressed in" — and it answered that nobody had
 * asked it anything. A message an agent answered is taken as its own when it answers it, and never overheard by it again.
 */

import { describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import { RoomMemory } from "@/modules/pipeline/room-memory.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import { envelope, fakeAgent } from "../helpers.ts";

function rooms(): RoomMemory {
  const deps = { config: { gateways: [], agents: { groupContextMessages: 5 }, people: [] }, attachmentIndex: undefined, chatEvents: undefined } as unknown as PipelineDeps;
  return new RoomMemory(deps, { outbound: { authorOf: () => null } } as never);
}

const inGroup = (id: string, text: string, timestamp: number): MessageEnvelope =>
  envelope({ id, text, timestamp, chatType: "group", chatId: "-5550007777", gateway: "telegram", gatewayId: "telegram:nouva", senderName: "Gading" });

describe("the first message after a rollover", () => {
  test("does not carry what this agent answered before it — another agent still overhears it", () => {
    const memory = rooms();
    const nouva = fakeAgent();
    const nox = fakeAgent();
    nox.config = { ...nox.config, id: "nox" };

    const yesterday = inGroup("q1", "enakan pake xl prio max 5g+ atau indihome ya?", 1_000);
    memory.observe(yesterday);
    memory.overheardBefore(nouva, yesterday, [], 0);

    // The rollover emptied the history: the window falls back to the room's buffer.
    const today = inGroup("q2", "nouride bisa support channel google chat ga ya?", 50_000);
    memory.observe(today);
    expect(memory.overheardBefore(nouva, today, [], 0)).toBe("");
    expect(memory.overheardBefore(nox, today, [], 0)).toContain("enakan pake xl prio");
  });
});
