/**
 * What other parts of the daemon ask of a mission's turn (`missions/gate-side.ts`): the chat that mission reports to,
 * for the approval prompts of its turn and for `send_message`'s list. A mission's own conversation is its work log, and
 * its person is somewhere else.
 */

import { describe, expect, test } from "bun:test";
import { gateSide } from "@/modules/missions/gate-side.ts";
import { SimilarAllowed } from "@/modules/missions/similar.ts";
import { missionsHarness } from "./harness.ts";

describe("the chat a mission's turn reports to", () => {
  test("is the chat the mission began in, for its own turn alone", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    const side = gateSide(h.store, new SimilarAllowed());
    expect(side.reportsTo({ gatewayId: "web:mission", chatId: mission.id })).toEqual({ gatewayId: "telegram:nova", chatId: "8142" });
    // The approval prompts of its turn go to the same place.
    expect(side.askedIn({ gateway: "web:mission", chatId: mission.id })).toEqual({ gatewayId: "telegram:nova", chatId: "8142" });
    // A chat's turn is no mission's, whatever its chat is called; nor is a mission nobody has a record of.
    expect(side.reportsTo({ gatewayId: "telegram:nova", chatId: mission.id })).toBeNull();
    expect(side.reportsTo({ gatewayId: "web:mission", chatId: "msn_not_there" })).toBeNull();
    expect(side.askedIn({ gateway: "telegram:nova", chatId: mission.id })).toBeNull();
  });
});
