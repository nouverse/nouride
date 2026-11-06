/**
 * What a coding CLI is lent of Nouride's own tools (`external-agents/lent-tools.ts`): its own reach, not what the CLI does
 * as well itself. `agent_configure` since 0.8.7: asked to think harder, a CLI agent had no way to set its effort — its
 * config.toml is not its user's to write, and no tool reached it.
 */

import { describe, expect, test } from "bun:test";
import { lends } from "@/modules/external-agents/lent-tools.ts";

describe("what a coding CLI is lent", () => {
  test("its own missions, work, memory and its effort", () => {
    for (const name of ["mission", "work", "memory_search", "ask_agent", "agent_configure"]) expect(lends(name)).toBe(true);
  });

  test("not what it does itself: files, the shell, the web", () => {
    for (const name of ["read", "write", "exec", "web_fetch"]) expect(lends(name)).toBe(false);
  });
});
