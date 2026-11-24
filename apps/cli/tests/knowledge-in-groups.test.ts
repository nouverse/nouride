/**
 * `nouride knowledge in-groups <collection> on|off|default` — whether a collection kept to people is used in a group on
 * the messages its own reader sends. The command an agent runs when a person asks for one collection to be kept out of
 * groups, or brought in where the install keeps private things out.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { knowledge } from "../src/commands/knowledge.ts";

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

const ROW = { id: "car", name: "Car", description: "", readers: { kind: "people", people: ["gading"] }, agents: null, about: [], archived: false, documents: 1, sections: 1 };

function client(rows: Record<string, unknown>[] = [ROW]) {
  const sent: { path: string; body: unknown }[] = [];
  return {
    sent,
    client: {
      get: async () => ({ collections: rows }),
      patch: async (path: string, body: unknown) => (sent.push({ path, body }), { collection: null }),
    } as never,
  };
}

describe("nouride knowledge in-groups", () => {
  test("on, off and default are sent as the collection's own answer, and each says what it now is", async () => {
    const { client: api, sent } = client();
    const said = await capture(async () => {
      await knowledge(api, ["in-groups", "Car", "off"]);
      await knowledge(api, ["in-groups", "car", "on"]);
      await knowledge(api, ["in-groups", "car", "default"]);
    });
    expect(sent).toEqual([
      { path: "/knowledge/car", body: { inGroups: false } },
      { path: "/knowledge/car", body: { inGroups: true } },
      { path: "/knowledge/car", body: { inGroups: null } },
    ]);
    expect(said).toContain("✓ car is used only in a chat with its reader alone");
    expect(said).toContain("✓ car is used in a group on the messages its own reader sends");
    expect(said).toContain("✓ car follows the memory setting for what is private in groups");
  });

  test("a value that is none of the three, or none at all, is asking wrongly: exit 2, nothing sent", async () => {
    const { client: api, sent } = client();
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(knowledge(api, ["in-groups", "car", "sometimes"])).rejects.toThrow("exit 2");
      await expect(knowledge(api, ["in-groups", "car"])).rejects.toThrow("exit 2");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
    expect(sent).toEqual([]);
  });

  test("the list says so beside who may be answered from it, and nothing where a collection follows the setting", async () => {
    const lines = async (row: Record<string, unknown>) => capture(() => knowledge(client([row]).client, ["list"]));
    expect(await lines({ ...ROW, inGroups: false })).toContain("· never in a group");
    expect(await lines({ ...ROW, inGroups: true })).toContain("· in groups on its reader's messages");
    expect(await lines(ROW)).not.toContain("group");
  });
});
