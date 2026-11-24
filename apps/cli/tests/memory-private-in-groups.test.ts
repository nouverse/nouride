/**
 * `nouride memory set private_in_groups off` — whether a person's own facts are read in a group on the turns they are
 * the one speaking. An agent that is asked to turn it off does it with this command, as a person does.
 */

import { describe, expect, test } from "bun:test";
import { memoryCommand } from "../src/commands/memory.ts";

/** What the command printed around `run`, without its colours. */
async function capture(run: () => Promise<void>): Promise<string> {
  const said: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return said.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const VIEW = { pass: false, passAt: "01:00", passPerNight: 20, passMaxTokens: 0, maxAttempts: 3, passProvider: "", passModel: "", facts: "off", proposeShared: false, recall: true, promptRecent: 3, transcriptDays: 180, archive: true, semantic: { enabled: false, provider: "", model: "" } };

describe("nouride memory set private_in_groups", () => {
  test("off and on are sent as the setting, by the words every other switch takes", async () => {
    const sent: unknown[] = [];
    const client = { put: async (_path: string, body: unknown) => (sent.push(body), { restartRequired: false }) } as never;
    await capture(async () => {
      await memoryCommand(client, ["set", "private_in_groups", "off"]);
      await memoryCommand(client, ["set", "private_in_groups", "on"]);
    });
    expect(sent).toEqual([{ privateInGroups: false }, { privateInGroups: true }]);
  });

  test("the settings say which way it is, and nothing of it for a daemon that has no such setting", async () => {
    const settings = (view: Record<string, unknown>) => capture(() => memoryCommand({ get: async () => view, softGet: async () => null } as never, ["settings"]));
    expect(await settings({ ...VIEW, privateInGroups: true })).toContain("private_in_groups on: in a group, a person's own facts are read on the turns they speak");
    expect(await settings({ ...VIEW, privateInGroups: false })).toContain("private_in_groups off: a group reads only what was said in it");
    expect(await settings(VIEW)).not.toContain("private_in_groups");
  });
});
