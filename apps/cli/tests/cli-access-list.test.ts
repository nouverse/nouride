/**
 * `nouride access allow --from <file> --gateway <connection> [--dry-run]`: what a list's lines are read as, what is
 * asked of the daemon, and what the person is told (`commands/access-list.ts`).
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@nouride/cli-kit";
import { access } from "../src/commands/access.ts";
import { sendersIn } from "@nouride/shared";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "access-list-"));
  dirs.push(dir);
  const path = join(dir, "numbers.txt");
  writeFileSync(path, text);
  return path;
}

/** The command run against a daemon that answers `answer`, with what it posted and what it printed, colours off. */
async function run(args: string[], answer: Record<string, unknown>) {
  const posts: [string, unknown][] = [];
  const client = { post: async (path: string, body: unknown) => (posts.push([path, body]), answer) } as unknown as Client;
  const printed: string[] = [];
  const plain = (line?: unknown) => void printed.push(String(line ?? "").replace(/\x1b\[[0-9;]*m/g, ""));
  const out = spyOn(console, "log").mockImplementation(plain);
  const err = spyOn(console, "error").mockImplementation(plain);
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  let exited: string | null = null;
  try {
    await access(client, args);
  } catch (error) {
    exited = String((error as Error).message);
  } finally {
    out.mockRestore();
    err.mockRestore();
    exit.mockRestore();
  }
  return { posts, printed, exited };
}

const DONE = { gateway: "whatsapp:main", dryRun: false, read: 4, added: 3, already: 0, blocked: 0, duplicates: 0, invalid: { count: 1, examples: ["0812 3456"] } };

describe("a list's lines", () => {
  test("one sender a line, a name after a comma, a semicolon or a tab; empty lines, comments and a spreadsheet's quotes left out", () => {
    const text = "﻿# our contacts\r\n+62 812-3456-7890\r\n\r\n62 813 0000 0001, Bu Rina\n\"62 814 0000 0002\";\"Pak Budi, S.H.\"\n@sam_lee\tSam\n   \n,nobody\n";
    expect(sendersIn(text)).toEqual([
      { id: "+62 812-3456-7890" },
      { id: "62 813 0000 0001", name: "Bu Rina" },
      { id: "62 814 0000 0002", name: "Pak Budi, S.H." },
      { id: "@sam_lee", name: "Sam" },
    ]);
  });
});

describe("nouride access allow --from", () => {
  test("posts the list for that connection and says how it went, with what could not be read and how to write it", async () => {
    const file = listFile("+62 812-3456-7890\n62 813 0000 0001, Bu Rina\n6281400000002\n0812 3456\n");
    const { posts, printed, exited } = await run(["allow", "--from", file, "--gateway", "whatsapp:main"], DONE);
    expect(exited).toBeNull();
    expect(posts).toEqual([["/access/import", { gateway: "whatsapp:main", dryRun: false, senders: [{ id: "+62 812-3456-7890" }, { id: "62 813 0000 0001", name: "Bu Rina" }, { id: "6281400000002" }, { id: "0812 3456" }] }]]);
    expect(printed[0]).toBe("✓ allowed 3 on whatsapp:main (3 new · 1 could not be read)");
    expect(printed[1]).toBe("  could not be read, for example: 0812 3456");
    expect(printed[2]).toContain("WhatsApp: a phone number with its country code (+62 812…, not 0812…). Telegram and Discord: an account's id or its @username.");
    expect(printed[3]).toContain("revoke or block any of them like any other");
  });

  test("--dry-run asks for a dry run and says nothing was written, with every count", async () => {
    const file = listFile("6281234567890\n");
    const answer = { ...DONE, dryRun: true, read: 12_000, added: 10_000, already: 1_500, blocked: 2, duplicates: 400, invalid: { count: 98, examples: ["a", "b"] } };
    const { posts, printed } = await run(["allow", "--from", file, "--gateway", "whatsapp:main", "--dry-run"], answer);
    expect((posts[0]![1] as { dryRun: boolean }).dryRun).toBe(true);
    expect(printed[0]).toBe("○ would allow 10,000 on whatsapp:main (10,000 new · 1,500 in already · 2 blocked, left out · 400 said twice · 98 could not be read; nothing was written)");
    expect(printed[1]).toBe("  could not be read, for example: a, b, …");
    expect(printed.join("\n")).not.toContain("revoke or block");
  });

  test("a list none of whose lines is a sender there is an error, exit 1; no file, no connection named and an empty list say so and ask nothing", async () => {
    const file = listFile("0812 3456\nabc\n");
    const none = await run(["allow", "--from", file, "--gateway", "whatsapp:main"], { ...DONE, read: 2, added: 0, invalid: { count: 2, examples: ["0812 3456", "abc"] } });
    expect(none.exited).toBe("exit 1");
    expect(none.printed.join("\n")).toContain("None of the 2 lines is a sender on whatsapp:main.");

    const missing = await run(["allow", "--from", join(tmpdir(), "no-such-list.txt"), "--gateway", "whatsapp:main"], DONE);
    expect(missing.exited).toBe("exit 1");
    expect(missing.posts).toEqual([]);
    expect(missing.printed.join("\n")).toContain("is not a file here.");

    const noGateway = await run(["allow", "--from", file], DONE);
    expect(noGateway.exited).toBe("exit 2");
    expect(noGateway.posts).toEqual([]);

    const empty = await run(["allow", "--from", listFile("# nobody yet\n\n"), "--gateway", "whatsapp:main"], DONE);
    expect(empty.exited).toBe("exit 1");
    expect(empty.posts).toEqual([]);
    expect(empty.printed.join("\n")).toContain("names nobody.");
  });

  test("one sender, the old way, is asked as it was", async () => {
    const { posts } = await run(["allow", "telegram:main:5550001111", "--name", "Sam"], { ok: true });
    expect(posts.map(([path]) => path)).toEqual(["/access/allow?gateway=telegram%3Amain&sender=5550001111&name=Sam"]);
  });
});
