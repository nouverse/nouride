/**
 * What the daemon's numbers sent, by id (`sent-here.ts`): chosen before a send, and a number's own record read back at
 * start, so a copy WhatsApp hands over after a restart is still known as the daemon's.
 */

import { expect, test } from "bun:test";
import { idToSend, sentBefore, sentHere } from "../src/sent-here.ts";

test("an id chosen to send is known; one nobody here chose is not", () => {
  const id = idToSend();
  expect(sentHere(id)).toBe(true);
  expect(sentHere("3EB0NOBODYCHOSETHIS")).toBe(false);
  expect(sentHere(undefined)).toBe(false);
});

test("a number's record read back: the ids still in their day are known again, and only those are kept", () => {
  const now = 1_800_000_000_000;
  const record = [`${now - 60_000} 3EB0RESTARTED1`, `${now - 2 * 86_400_000} 3EB0YESTERDAYS`, "not a line", "", `${now - 1_000} 3EB0RESTARTED2`].join("\n");
  const kept = sentBefore(record, now);
  expect(kept).toBe(`${now - 60_000} 3EB0RESTARTED1\n${now - 1_000} 3EB0RESTARTED2\n`);
  expect([sentHere("3EB0RESTARTED1", now), sentHere("3EB0RESTARTED2", now), sentHere("3EB0YESTERDAYS", now)]).toEqual([true, true, false]);
});
