/**
 * `nouride skills <agent>` says "no read on record", not "never read" (0.7.27).
 *
 * Reads before 0.7.27 are known only as far as the audit log kept them — 14 days on a live box — and an agent reading
 * "19 of 37 never read" proposed deleting skills another agent had read three weeks earlier.
 */

import { expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { skills } from "@/cli/commands/skills.ts";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

test("a skill with no read is 'none on record', and the total says the same", async () => {
  const skill = (name: string, lastUsedAt: number | null) => ({ name, description: "", scope: "shared", path: `/x/${name}/SKILL.md`, requires: [], missing: [], needsTools: [], missingTools: [], lastUsedAt });
  const agents = [{ agentId: "nouva", skills: [skill("deployment", Date.UTC(2026, 9, 15)), skill("server-report", null)] }];
  const client = { get: async <T>() => ({ agents }) as T } as unknown as Client;
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(plain(String(line ?? ""))));
  try {
    await skills(client, ["nouva"]);
  } finally {
    log.mockRestore();
  }
  const out = lines.join("\n");
  expect(out).toContain("deployment  last read 2026-10-15");
  expect(out).toContain("server-report  last read none on record");
  expect(out).toContain("1 of 2 with no read on record");
  expect(out).not.toContain("never");
});
