/**
 * Whether the orchestrator installs the programs every agent runs (0.8.0): offered on the orchestrator's page alone,
 * where the setting counts, and only by a daemon that says.
 */

import { expect, test } from "bun:test";
import { offersSharedTools } from "@/modules/agents/components/SharedTools";
import type { AgentSummary } from "@nouride/wire";

const agent = (id: string, sharedTools?: boolean) => ({ id, ...(sharedTools === undefined ? {} : { sharedTools }) }) as AgentSummary;

test("on the orchestrator's page, on or off; on no other agent's; not from a daemon before 0.8.0", () => {
  expect(offersSharedTools("nouva", agent("nouva", true))).toBe(true);
  expect(offersSharedTools("nouva", agent("nouva", false))).toBe(true);
  expect(offersSharedTools("nouva", agent("nox", true))).toBe(false);
  expect(offersSharedTools(null, agent("nouva", true))).toBe(false);
  expect(offersSharedTools("nouva", agent("nouva"))).toBe(false);
});
