/**
 * `nouride mission delete` (0.8.13): the terminal's way to delete an ended mission, as the page's Delete is — the route's
 * own refusals (still open, work nobody committed) are its tests'; here, what the command sends and says.
 */

import { expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { mission as missionCommand } from "@/cli/commands/mission.ts";

test("nouride mission delete <id> [--force] asks the daemon to delete it, and says what went with it", async () => {
  const asked: string[] = [];
  const client = { del: async <T>(path: string) => (asked.push(path), { ok: true, mission: "msn_1", turns: 4 }) as T } as unknown as Client;
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line?: unknown) => void said.push(String(line)));
  try {
    await missionCommand(client, ["delete", "msn_1"]);
    await missionCommand(client, ["delete", "msn_1", "--force"]);
  } finally {
    log.mockRestore();
  }
  expect(asked).toEqual(["/missions/msn_1", "/missions/msn_1?force=1"]);
  expect(said.join("\n")).toContain("msn_1 deleted: its conversation (4 turn records), checklist and own folder");
});
