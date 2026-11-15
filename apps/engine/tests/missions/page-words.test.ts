/**
 * The rules a mission's turn reads on its page, word for word: what is sent to a model is behaviour, and each of these
 * sentences is there because a mission did the other thing.
 */

import { describe, expect, test } from "bun:test";
import { missionsHarness } from "./harness.ts";

describe("how a mission reaches its person, as its page says it", () => {
  test("a question goes through `ask`, never `send_message`", async () => {
    const h = await missionsHarness();
    const page = h.turn(await h.start())!.text;
    expect(page).toContain(
      '- Need the person? `mission` action "ask", one question, never `send_message`: what they answer in another chat does not come back to this mission.',
    );
  });
});
