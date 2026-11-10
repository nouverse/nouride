/**
 * `nouride mcp add --env-secret VAR=secret_name` (0.7.19): a stdio server's credential variable, naming a secret the
 * store already holds — the value never passes through the command line, shell history or the audit log.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { mcp } from "@/cli/commands/mcp.ts";

function recording(): { client: Client; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const client = {
    baseUrl: "http://127.0.0.1:9",
    post: async (_path: string, body: Record<string, unknown>) => (bodies.push(body), { ok: true, restartRequired: false }),
  } as unknown as Client;
  return { client, bodies };
}

describe("--env-secret", () => {
  test("each VAR=secret names a secret, sent as the server's credential variables", async () => {
    const { client, bodies } = recording();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await mcp(client, ["add", "--agent", "nouva", "--name", "gh", "--command", "npx", "--env-secret", "GITHUB_TOKEN=github_token", "--env-secret", "OTHER=other_key"]);
    } finally {
      log.mockRestore();
    }
    expect(bodies[0]!.envSecrets).toEqual({ GITHUB_TOKEN: { secret: "github_token" }, OTHER: { secret: "other_key" } });
  });

  test("anything but VAR=name is a usage error, exit 2, and nothing is sent", async () => {
    const { client, bodies } = recording();
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(mcp(client, ["add", "--agent", "nouva", "--name", "gh", "--command", "npx", "--env-secret", "GITHUB_TOKEN"])).rejects.toThrow("exit 2");
      await expect(mcp(client, ["add", "--agent", "nouva", "--name", "gh", "--command", "npx", "--env-secret", "BAD-NAME=x"])).rejects.toThrow("exit 2");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
    expect(bodies).toEqual([]);
  });
});
