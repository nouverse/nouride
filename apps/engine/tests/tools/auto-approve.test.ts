/**
 * Switching the gate off for one conversation, and the line that stays on.
 *
 * The friction is real and was measured on a phone: scaffolding a small project is a dozen `write`
 * requests, each with a 24-character id to copy back. The operator mistyped one and had to hunt for
 * the right one in a wall of text. A gate that expensive to answer gets routed around — by disabling
 * approval globally, which is a far worse outcome than this.
 *
 * So the question these tests answer is not "does it turn off" but "what does it refuse to turn off".
 */

import { describe, expect, test } from "bun:test";
import { AutoApprove } from "@/modules/tools/auto-approve.store.ts";
import { decideExec, execGrantKey } from "@nouride/policy";

import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@/db/index.ts";
import { beforeEach, afterEach } from "bun:test";

let dir: string;
let db: SqliteDb;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-auto-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
});

afterEach(() => {
  db.close();
  removePath(dir);
});

const store = () => new AutoApprove({ db });

describe("scope", () => {
  test("follows the sender, not the conversation", () => {
    // The whole point of the change: a chat-scoped switch had to be re-said after every `/new`, in
    // every channel, which is the friction it exists to remove.
    const auto = store();
    auto.enable("telegram:bot", "5550001111", "gading");

    expect(auto.enabled("telegram:bot", "5550001111")).toBe(true);
  });

  test("does not leak across gateways", () => {
    // A Telegram user id and a Discord snowflake are both numeric strings. Trusting someone on one
    // bot must not silently trust whoever holds that number on another.
    const auto = store();
    auto.enable("telegram:bot", "123", "gading");

    expect(auto.enabled("discord:main", "123")).toBe(false);
  });

  test("does not leak to another sender", () => {
    const auto = store();
    auto.enable("telegram:bot", "123", "gading");
    expect(auto.enabled("telegram:bot", "456")).toBe(false);
  });

  test("survives a new store — it is on disk, not in memory", () => {
    // "Until you restart" is not what anyone means by "stop asking me".
    store().enable("telegram:bot", "123", "gading");
    expect(store().enabled("telegram:bot", "123")).toBe(true);
  });

  test("reports whether it changed anything", () => {
    const auto = store();
    expect(auto.enable("telegram:bot", "123", "gading")).toBe(true);
    expect(auto.enable("telegram:bot", "123", "gading")).toBe(false);
    expect(auto.disable("telegram:bot", "123", "gading")).toBe(true);
    expect(auto.disable("telegram:bot", "123", "gading")).toBe(false);
  });

  test("losing access forgets the standing decision", () => {
    // Otherwise revoking someone and pairing them again would silently restore a permission nobody
    // re-granted.
    const auto = store();
    auto.enable("telegram:bot", "123", "gading");
    auto.forget("telegram:bot", "123");

    expect(auto.enabled("telegram:bot", "123")).toBe(false);
  });
});

/**
 * The line that stays on.
 *
 * On this very install an agent with `exec` once stopped its own daemon mid-conversation and took itself down. What a
 * person's "stop asking me" covers is the approval level's (`/approvals balanced`), and the fixed list is what it is
 * read against: every entry marked, so the level can tell one from a new command.
 */
describe("what the level reads", () => {
  const ask = (argv: string[]) => {
    const request = { argv, cwd: "/srv/nouride", agentId: "nouva" };
    return decideExec({
      policy: { blocked: [] },
      request,
      grantKey: execGrantKey(request),
      grants: new Set<string>(),
      canAsk: true,
      ownStateByOs: false,
    });
  };

  test("a command on the fixed list is marked, with its entry", () => {
    // `grantable: false` is not the signal on its own — only `hardline` and its class say which question this is.
    for (const [argv, cls] of [
      [["sudo", "systemctl", "stop", "nouride"], "stop"],
      [["rm", "-rf", "/srv"], "delete"],
      [["poweroff"], "stop"],
    ] as const) {
      expect(ask([...argv])).toMatchObject({ action: "ask", hardline: true, hardlineClass: cls });
    }
  });

  test("an ordinary first-time command is not marked", () => {
    // This is what a level answers by itself. Marking it would make `balanced` pointless.
    const decision = ask(["bun", "test"]);
    expect(decision).toMatchObject({ action: "ask", grantable: true });
    if (decision.action === "ask") expect(decision.hardline).toBeUndefined();
  });
});
