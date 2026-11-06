/**
 * `nouride approvals --all` and `nouride approvals show <id>` (0.8.7): the answered requests beside the pending ones,
 * and one request in full — read from the daemon, never from a file.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@/cli/client.ts";
import { approvals } from "@/cli/commands/approvals.ts";

const PENDING = [{ id: "apr_wait", agentId: "nouva", chatId: "c", gateway: "telegram", tool: "exec", params: { command: "ls" }, status: "pending", requestedAt: 0 }];
const SETTLED = [{ id: "apr_done", agentId: "nouva", chatId: "c", gateway: "telegram", tool: "exec", params: { command: "rm x" }, status: "denied", decision: "deny", resolvedBy: "gading", requestedAt: 0, resolvedAt: 0 }];

function fakeClient(): Client & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    get: async <T>(path: string) => {
      gets.push(path);
      if (path.startsWith("/approvals/")) return { approval: SETTLED[0] } as T;
      return (path.includes("all=1") ? { pending: PENDING, settled: SETTLED } : { pending: PENDING }) as T;
    },
  } as unknown as Client & { gets: string[] };
}

async function printed(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(String(line ?? "")));
  try {
    await run();
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

describe("nouride approvals --all and show", () => {
  test("--all asks for the answered ones and prints how each ended and who said so", async () => {
    const client = fakeClient();
    const out = await printed(() => approvals(client, ["--all"]));
    expect(client.gets).toEqual(["/approvals?all=1"]);
    expect(out).toContain("apr_wait");
    expect(out).toContain("apr_done");
    expect(out).toContain("deny by gading");
  });

  test("without --all it asks for the pending ones only", async () => {
    const client = fakeClient();
    const out = await printed(() => approvals(client, []));
    expect(client.gets).toEqual(["/approvals"]);
    expect(out).not.toContain("apr_done");
  });

  test("--all cuts an answered one to a line each; a pending one, and show, stay whole", async () => {
    const long = `R=review && ${"git diff origin/a...origin/b > $R/x.patch && ".repeat(30)}echo done`;
    const answered = { ...SETTLED[0]!, reason: `Claude Code asks to ${long}`, params: { command: long } };
    const waiting = { ...PENDING[0]!, params: { command: long } };
    const client = {
      get: async <T>(path: string) => (path.startsWith("/approvals/") ? { approval: answered } : { pending: [waiting], settled: [answered] }) as T,
    } as unknown as Client;
    const listed = await printed(() => approvals(client, ["--all"]));
    const lines = listed.split("\n");
    // The pending one whole: its command is what a person approves.
    expect(listed).toContain(JSON.stringify({ command: long }));
    // The answered one: its reason and its parameters a line each, cut, with the end gone.
    const reasonLine = lines.find((line) => line.includes("Claude Code asks to"))!;
    expect(reasonLine.length).toBeLessThan(200);
    expect(reasonLine).toContain("…");
    expect(lines.filter((line) => line.includes(JSON.stringify({ command: long })))).toHaveLength(1);
    const shown = await printed(() => approvals(client, ["show", "apr_done"]));
    expect(shown).toContain(`Claude Code asks to ${long}`);
    expect(shown).toContain(JSON.stringify({ command: long }));
  });

  test("show <id> reads that one request and prints its parameters", async () => {
    const client = fakeClient();
    const out = await printed(() => approvals(client, ["show", "apr_done"]));
    expect(client.gets).toEqual(["/approvals/apr_done"]);
    expect(out).toContain('{"command":"rm x"}');
    expect(out).toContain("asked in telegram c");
  });
});
