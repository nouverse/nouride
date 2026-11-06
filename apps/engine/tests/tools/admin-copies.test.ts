/**
 * A question only an admin answers (0.8.10): it says so where it was asked, and it is put in front of each admin in their
 * own chat too — answerable there by its buttons, and settled there with it. Before, it waited in a family member's chat
 * or a room, which was shown "Tap a button below" and told no only once it tapped, and no admin was told.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import type { ChatType, Gateway, Person } from "@nouride/shared";
import { approvalPrompt, Notifier } from "@/commons/notify.ts";
import { openAndMigrate } from "@/db/index.ts";
import { adminChatsOf } from "@/boot/admin-chats.ts";
import { routePresses } from "@/modules/gateways/presses.ts";
import { ApprovalPrompts } from "@/modules/tools/approval-prompts.ts";
import type { ApprovalAsk, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { eventually, FakeGateway, tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
const gates: SqliteApprovalGate[] = [];
beforeEach(async () => {
  dir = tempDir("admin-copies");
  db = await openAndMigrate(join(dir, "test.db"));
});
afterEach(() => {
  for (const gate of gates.splice(0)) gate.shutDown();
  db.close();
  removePath(dir);
});

/** A family member's chat with the agent (555), and the admin's own (814), on one connection with buttons. */
function bench(admins: { gatewayId: string; chatId: string }[] = [{ gatewayId: "telegram:main", chatId: "814" }]) {
  const gateway = Object.assign(new FakeGateway("telegram:main"), { buttons: true });
  // The dashboard's chat: a client that asks itself, as the CLI does.
  const dashboard = Object.assign(new FakeGateway("web:dashboard", "web"), { promptsApprovals: true });
  const gateways = new Map<string, FakeGateway>([[gateway.id, gateway], [dashboard.id, dashboard]]);
  let gate!: SqliteApprovalGate;
  // Each question's posting, the copies included: what is not sent once it has ended is never sent.
  const posting: Promise<void>[] = [];
  const prompts = new ApprovalPrompts({
    gateways,
    notifier: new Notifier({ gateways }),
    approvals: () => gate,
    voice: (_agentId, gatewayId) => gatewayId,
    isAdmin: (who) => who.senderId === "814",
    adminChats: () => admins,
  });
  gate = new SqliteApprovalGate({ db, timeoutMs: 60_000, onRequest: (notice) => void posting.push(prompts.post(notice)), onSettled: (request, settlement) => prompts.settled(request, settlement) });
  gates.push(gate);
  routePresses(gateways.values(), [prompts]);
  return { gateway, dashboard, gate, posted: () => Promise.all(posting) };
}

const people = (chatId = "555", over: Partial<ApprovalAsk> = {}): ApprovalAsk => ({
  agentId: "nix",
  gatewayId: "telegram:main",
  chatId,
  gateway: "telegram",
  senderId: chatId,
  tool: "nouride",
  params: { args: ["people", "set", "telegram:5550001111", "--name", "Probe"] },
  grantable: false,
  autoCoverable: false,
  reason: "changes who the agents know a person to be, and an admin is one",
  hardlineClass: "people",
  ...over,
});

const press = (gateway: FakeGateway, chatId: string, messageId: string, data: string, senderId: string, chatType: ChatType = "dm") =>
  gateway.press({ chatId, chatType, messageId, data, senderId, senderName: senderId });

describe("an admin-only question", () => {
  test("says only an admin answers it, where it was asked", () => {
    const shown = approvalPrompt({ request: { id: "apr_1", agentId: "nix", tool: "nouride", params: {} }, grantable: false, reason: "changes who the agents know a person to be", adminOnly: true }, { buttons: true });
    expect(shown).toContain("Only an admin can answer this one.");
    expect(approvalPrompt({ request: { id: "apr_1", agentId: "nix", tool: "exec", params: {} }, grantable: true, reason: "first time" }, { buttons: true })).not.toContain("Only an admin");
  });

  test("is put in the admin's own chat too, answered there by a button, and both prompts say how it settled", async () => {
    const { gateway, gate } = bench();
    const outcome: Promise<ApprovalOutcome> = gate.request(people());
    await eventually(() => gateway.sent.length >= 2, 2_000, "the question and the admin's copy");
    const [asked, copy] = gateway.sent;
    expect(asked).toMatchObject({ chatId: "555", text: expect.stringContaining("Only an admin can answer this one.") });
    expect(copy).toMatchObject({ chatId: "814" });
    expect(copy!.text).toContain("is waiting on an admin before running **nouride**. It was asked in another chat, where only an admin can answer it; you are one.");
    expect(copy!.text).toContain("Tap a button below, or answer it on the dashboard's Approvals.");
    // `/approve` typed there answers only what was asked there: it is not offered.
    expect(copy!.text).not.toContain("/approve");
    const id = gate.pending()[0]!.id;
    // The family member's press: refused, as before.
    expect(await press(gateway, "555", "telegram:main#1", `approval:once:${id}`, "555")).toMatchObject({ notice: expect.stringContaining("Only an admin can answer this one") });
    // The admin's, on the copy.
    expect(await press(gateway, "814", "telegram:main#2", `approval:once:${id}`, "814")).toMatchObject({ notice: "Approved." });
    expect((await outcome).status).toBe("approved");
    // The question where it was asked loses its buttons too.
    await eventually(() => gateway.settled.some((one) => one.messageId === "telegram:main#1"), 2_000, "the asked prompt settled");
  });

  test("not copied into the chat it was asked in, and an ordinary question is never copied", async () => {
    const { gateway, gate, posted } = bench();
    void gate.request(people("814"));
    await eventually(() => gateway.sent.length >= 1, 2_000, "the question");
    await posted();
    expect(gateway.sent.map((one) => one.chatId)).toEqual(["814"]);
    void gate.request(people("555", { tool: "exec", params: { command: ["make"] }, hardlineClass: undefined, grantable: true, autoCoverable: true }));
    await eventually(() => gateway.sent.length >= 2, 2_000, "the second question");
    await posted();
    expect(gateway.sent.map((one) => one.chatId)).toEqual(["814", "555"]);
  });

  test("asked in the dashboard's chat, which asks itself: not posted there, and copied to the admin's chat all the same", async () => {
    const { gateway, dashboard, gate, posted } = bench();
    void gate.request(people("chat_op", { gatewayId: "web:dashboard", gateway: "web", senderId: "usr_operator" }));
    await eventually(() => gateway.sent.length >= 1, 2_000, "the admin's copy");
    await posted();
    expect(dashboard.sent).toEqual([]);
    expect(gateway.sent.map((one) => one.chatId)).toEqual(["814"]);
    expect(gateway.sent[0]!.text).toContain("asked in another chat, where only an admin can answer it; you are one.");
  });

  test("asked by someone who answers it where they asked: no copy — an admin in a room or the dashboard's chat, the terminal", async () => {
    const { gateway, dashboard, gate, posted } = bench();
    void gate.request(people("room_1", { senderId: "814" }));
    await eventually(() => gateway.sent.length >= 1, 2_000, "the question in the room");
    void gate.request(people("chat_admin", { gatewayId: "web:dashboard", gateway: "web", senderId: "814" }));
    // `nouride chat`: the CLI answers anything.
    void gate.request(people("chat_terminal", { gatewayId: "web:dashboard", gateway: "web", senderId: "terminal" }));
    await eventually(() => gate.pending().length >= 3, 2_000, "the other two questions");
    await posted();
    expect(gateway.sent.map((one) => one.chatId)).toEqual(["room_1"]);
    expect(dashboard.sent).toEqual([]);
  });

  test("answered on the dashboard: the question and its copy both say so, their buttons gone", async () => {
    const { gateway, gate } = bench();
    void gate.request(people());
    await eventually(() => gateway.sent.length >= 2, 2_000, "the question and the copy");
    gate.resolve(gate.pending()[0]!.id, "deny", { id: "usr_admin", name: "Gading, on the dashboard" });
    await eventually(() => gateway.settled.length >= 2, 2_000, "both prompts settled");
    expect(gateway.settled.map((one) => one.messageId).sort()).toEqual(["telegram:main#1", "telegram:main#2"]);
  });

  test("a press from a chat that has neither the question nor a copy is refused", async () => {
    const { gateway, gate } = bench();
    void gate.request(people());
    await eventually(() => gateway.sent.length >= 2, 2_000, "the question and the copy");
    const id = gate.pending()[0]!.id;
    expect(await press(gateway, "999", "telegram:main#9", `approval:once:${id}`, "814")).toEqual({ notice: "That request was not asked here." });
  });
});

describe("each admin's own chat", () => {
  test("found as the morning line finds a person: the account they last wrote from, on a connected gateway of its platform", () => {
    const connected = (id: string, platform: string): Gateway => ({ id, platform, status: "connected" }) as unknown as Gateway;
    const gateways = new Map([["telegram:main", connected("telegram:main", "telegram")], ["discord:main", connected("discord:main", "discord")]]);
    const admin: Person = { key: "gading", name: "Gading", ids: ["web:usr_admin", "discord:42", "telegram:814"] } as Person;
    const family: Person = { key: "rina", name: "Rina", ids: ["web:usr_family", "telegram:555"] } as Person;
    const chats = adminChatsOf({
      config: () => ({ people: [admin, family] }),
      gateways,
      turns: { lastFrom: () => [{ gatewayId: "telegram:main", senderId: "814" }] },
      isAdmin: (who) => who.senderId === "usr_admin",
    });
    expect(chats()).toEqual([{ gatewayId: "telegram:main", chatId: "814" }]);
  });
});
