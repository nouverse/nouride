/**
 * A request the daemon took up and is still working on ends in a timeout when the CLI's wait runs out. That is not
 * "cannot reach the daemon — is it running?": live (2026-10-21), `nouride memory pass` said so while the pass was
 * filing ten conversations, and the honest answer is that it may still be working.
 */

import { expect, test } from "bun:test";
import { isTimeout } from "@nouride/cli-kit";

test("a wait that ran out is told apart from a daemon that is not there", () => {
  expect(isTimeout(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
  expect(isTimeout(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }))).toBe(true);
  expect(isTimeout(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(false);
  expect(isTimeout(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18254"), { code: "ECONNREFUSED" }))).toBe(false);
});
