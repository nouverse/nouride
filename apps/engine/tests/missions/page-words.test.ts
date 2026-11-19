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
      '- Need the person? `mission` action "ask", one question, never `send_message`: what they answer in another chat does not come back to this mission. It reaches them at once and the mission waits for the answer.',
    );
  });
});

describe("how a mission writes its report, as its page says it", () => {
  test("what came of it first, a table for a list, and a picture handed back and named where it belongs", async () => {
    const h = await missionsHarness();
    const page = h.turn(await h.start())!.text;
    expect(page).toContain("- The report is read on the mission's page. Lead with what came of it; a list of things with their state is a table;");
    expect(page).toContain("draw it with the `diagrams` skill where you carry it, hand the picture back among the files, and name it in the report where it belongs, `![what it shows](its file name)`: the page draws it there.");
    expect(page).toContain("One or two pictures, and the report still reads without them.");
  });
});
