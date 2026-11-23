/**
 * `nouride memory set semantic <provider>/<model>`: search by meaning switched on from the command line, in the shape
 * the settings take it. The switch was the dashboard's alone, so an agent asked to set search by meaning up could add
 * the provider and then had no way to finish. And `nouride memory` says how far the vectors are, which is what the
 * agent checks afterwards.
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

const sending = () => {
  const sent: unknown[] = [];
  return { sent, client: { put: async (_path: string, body: unknown) => (sent.push(body), { restartRequired: false }) } as never };
};

describe("nouride memory set semantic", () => {
  test("a provider and a model switch it on with them; the model's name keeps its own slashes", async () => {
    const { sent, client } = sending();
    const said = await capture(async () => {
      await memoryCommand(client, ["set", "semantic", "ollama/bge-m3"]);
      await memoryCommand(client, ["set", "semantic", "openrouter/openai/text-embedding-3-small"]);
    });
    expect(sent).toEqual([
      { semantic: { enabled: true, provider: "ollama", model: "bge-m3" } },
      { semantic: { enabled: true, provider: "openrouter", model: "openai/text-embedding-3-small" } },
    ]);
    // What comes next is said: what was remembered before has no vector yet.
    expect(said).toContain("semantic = ollama/bge-m3: applied");
    expect(said).toContain("nouride memory embed gives what is already remembered its vectors now");
  });

  test("off and on turn the switch alone, and leave the provider and the model as they are", async () => {
    const { sent, client } = sending();
    const said = await capture(async () => {
      await memoryCommand(client, ["set", "semantic", "off"]);
    });
    await capture(async () => {
      await memoryCommand(client, ["set", "semantic", "-"]);
      await memoryCommand(client, ["set", "semantic", "On"]);
      await memoryCommand(client, ["set", "semantic", "bge-m3"]);
      await memoryCommand(client, ["set", "semantic_dimensions", "512"]);
    });
    expect(sent).toEqual([
      { semantic: { enabled: false } },
      { semantic: { enabled: false } },
      { semantic: { enabled: true } },
      // A model alone is another model of the provider it has.
      { semantic: { enabled: true, model: "bge-m3" } },
      { semantic: { dimensions: 512 } },
    ]);
    // Switched off, there is nothing to embed.
    expect(said).not.toContain("memory embed");
  });
});

describe("nouride memory, of search by meaning", () => {
  const view = { pass: false, passAt: "01:00", passPerNight: 20, passMaxTokens: 0, maxAttempts: 3, passProvider: "", passModel: "", facts: "off", proposeShared: false, recall: true, promptRecent: 3, transcriptDays: 180, archive: true };
  const daemon = (semantic: object, status: object | null) =>
    ({ get: async () => ({ ...view, semantic }), softGet: async () => (status === null ? Promise.reject(new Error("operator only")) : status) }) as never;

  test("says the model, how many items have a vector, and when it is not answering", async () => {
    const on = { enabled: true, provider: "ollama", model: "bge-m3" };
    expect(await capture(() => memoryCommand(daemon(on, { semantic: { items: 1204, running: true, reachable: true } }), ["settings"]))).toContain("semantic search  ollama · bge-m3 1,204 item(s) embedded, embedding now");
    const silent = await capture(() => memoryCommand(daemon(on, { semantic: { items: 9, running: false, reachable: false } }), []));
    expect(silent).toContain("semantic search  ollama · bge-m3 9 item(s) embedded the model is not responding: search falls back to words");
    // Someone who may not read the status still reads the setting.
    expect(await capture(() => memoryCommand(daemon(on, null), []))).toMatch(/semantic search  ollama · bge-m3$/m);
  });

  test("off says off, and asks nothing more", async () => {
    let asked = 0;
    const client = { get: async () => ({ ...view, semantic: { enabled: false, provider: "", model: "" } }), softGet: async () => ((asked += 1), {}) } as never;
    expect(await capture(() => memoryCommand(client, []))).toMatch(/semantic search  off$/m);
    expect(asked).toBe(0);
  });

  /**
   * Seen with a real model on the box's sandbox: asked to set it up where it had been on with `bge-m3:latest`, the
   * agent read "off", typed `ollama/bge-m3`, and every item was to be embedded again. The model it was set to is said,
   * with the word that switches back to it.
   */
  test("off still names the model it was set to, and how to switch back to it", async () => {
    const client = { get: async () => ({ ...view, semantic: { enabled: false, provider: "ollama", model: "bge-m3:latest" } }), softGet: async () => ({}) } as never;
    expect(await capture(() => memoryCommand(client, []))).toContain("semantic search  off (set to ollama/bge-m3:latest: nouride memory set semantic on switches it back on, with what it had embedded)");
  });
});
