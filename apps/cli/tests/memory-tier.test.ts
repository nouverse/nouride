/**
 * `nouride memory set pass_model small` — the nightly pass on each agent's own small-tier model (0.8.0). A tier has
 * no provider of its own, so it clears `pass_provider` as the dashboard's Models page does; and the settings line says
 * which tier the pass runs on rather than "each agent's own model".
 */

import { describe, expect, test } from "bun:test";
import { memoryCommand } from "../src/commands/memory.ts";

/** What the command printed, and sent, around `run`. */
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

describe("nouride memory set pass_model", () => {
  test("a tier's name clears the pass's provider — each agent's own model of it, on its own provider", async () => {
    const sent: unknown[] = [];
    const client = { put: async (_path: string, body: unknown) => (sent.push(body), { restartRequired: false }) } as never;
    await capture(async () => {
      await memoryCommand(client, ["set", "pass_model", "small"]);
      await memoryCommand(client, ["set", "pass_model", "nougate/gemini-flash"]);
    });
    expect(sent).toEqual([{ passProvider: "", passModel: "small" }, { passProvider: "nougate", passModel: "gemini-flash" }]);
  });

  test("the settings line names the tier the pass runs on", async () => {
    const view = { pass: false, passAt: "01:00", passPerNight: 20, passMaxTokens: 0, maxAttempts: 3, passProvider: "", passModel: "small", facts: "off", proposeShared: false, recall: true, promptRecent: 3, transcriptDays: 180, archive: true, semantic: { enabled: false, provider: "", model: "" } };
    const client = { get: async () => view } as never;
    expect(await capture(() => memoryCommand(client, ["settings"]))).toContain("with each agent's own small-tier model");
  });
});
