/**
 * One question at a time in a chat — whichever turn asked it (0.8.7, live). A mission's turn asks in a conversation
 * nobody reads, and its prompt goes to the chat the mission began in; the gate kept its one-at-a-time line by the
 * asking conversation. In one Telegram chat a mission's second question waited 37 minutes behind its first, saying
 * nothing of it, while the chat's own turn's question went straight past both — and the dashboard listed all three.
 *
 * One line per chat a person reads, then: the prompt on screen says how many wait behind it as they come, a bare
 * `/approve` there answers what it shows, and the dashboard's list says which have not been asked there yet. Gate,
 * prompts and the control route as `index.ts` wires them, on a migrated database.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { Notifier } from "@/commons/notify.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { openAndMigrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { routePresses } from "@/modules/gateways/presses.ts";
import { answerApproval } from "@/modules/hooks/pending.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";
import { ApprovalPrompts } from "@/modules/tools/approval-prompts.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { eventually, FakeGateway, tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
const gates: SqliteApprovalGate[] = [];

beforeEach(async () => {
  dir = tempDir("approval-one-line");
  db = await openAndMigrate(join(dir, "test.db"));
});

afterEach(() => {
  for (const gate of gates.splice(0)) gate.shutDown();
  db.close();
  removePath(dir);
});

const CHAT = { gatewayId: "telegram:nix", chatId: "8142" } as const;
const MISSION = "msn_130fa9aaaaaaaaaa";

/** The gate and its prompts, a mission's questions put to the chat it began in — `askedIn` handed to both, as at boot. */
function wired() {
  const gateway = Object.assign(new FakeGateway(CHAT.gatewayId), { buttons: true });
  const gateways = new Map([[gateway.id, gateway]]);
  const askedIn = (request: { gateway: string; chatId: string }) => (request.gateway === "web:mission" && request.chatId === MISSION ? CHAT : null);
  let gate!: SqliteApprovalGate;
  const prompts = new ApprovalPrompts({ gateways, notifier: new Notifier({ gateways }), approvals: () => gate, voice: (_agent, gatewayId) => gatewayId, isAdmin: () => false, askedIn });
  gate = new SqliteApprovalGate({
    db,
    timeoutMs: 60_000,
    askedIn,
    onRequest: (notice) => void prompts.post(notice),
    onBehind: (id, behind) => prompts.behind(id, behind),
    onSettled: (request, settlement) => prompts.settled(request, settlement),
  });
  gates.push(gate);
  routePresses(gateways.values(), [prompts]);
  const isPrompt = (text: string) => text.includes("is waiting on you before running");
  /** The prompts open in the chat, as they read now — a count said again rewrites one in place, an answer settles it. */
  const shown = () => gateway.sent.filter((message) => isPrompt(message.text));
  /** Every prompt the chat was sent, in order, as it was first sent. */
  const asked = () => gateway.posted.filter(isPrompt);
  /** The pending request for `command`. */
  const asking = (command: string) => gate.pending().find((request) => request.params.command === command)!;
  return { gate, gateway, shown, asked, asking };
}

/** Asked by a mission's turn, in its own conversation. */
const fromMission = (command: string): ApprovalAsk => ({
  agentId: "nix",
  gatewayId: "web:mission",
  chatId: MISSION,
  gateway: "web",
  senderId: "8142",
  tool: "exec",
  params: { command },
  grantable: false,
  autoCoverable: false,
  reason: "a mission's command",
});

/** Asked by the chat's own turn. */
const fromChat = (command: string): ApprovalAsk => ({ ...fromMission(command), gatewayId: CHAT.gatewayId, chatId: CHAT.chatId, gateway: "telegram" });

describe("one line in the chat, whichever turn asked", () => {
  test("a mission's questions and the chat's own are put to it one at a time, in the order they were asked", async () => {
    const w = wired();
    void w.gate.request(fromMission("git push"));
    await eventually(() => w.asked().length === 1, 2_000, "the first prompt");
    void w.gate.request(fromMission("bun test"));
    // The chat's own turn's question went straight past the mission's two, live: two lines in one chat.
    void w.gate.request(fromChat("ls /tmp"));
    await eventually(() => w.shown()[0]?.text.includes("_2 more questions are waiting behind this one._") === true, 2_000, "both behind it");
    expect(w.asked()).toHaveLength(1);

    w.gate.resolve(w.asking("git push").id, "allow-once", "gading");
    await eventually(() => w.asked().length === 2, 2_000, "the second prompt");
    expect(w.asked()[1]).toContain("bun test");
    w.gate.resolve(w.asking("bun test").id, "allow-once", "gading");
    await eventually(() => w.asked().length === 3, 2_000, "the third prompt");
    expect(w.asked()[2]).toContain("ls /tmp");
  });

  test("the prompt on screen says how many wait behind it as each is asked — its buttons kept — and fewer when one is answered elsewhere", async () => {
    const w = wired();
    void w.gate.request(fromMission("git push"));
    await eventually(() => w.shown().length === 1, 2_000, "the first prompt");
    const first = w.shown()[0]!;
    expect(first.text).not.toContain("waiting behind this one");

    void w.gate.request(fromMission("bun test"));
    await eventually(() => first.text.includes("_One more question is waiting behind this one._"), 2_000, "one behind, said");
    // Rewritten with its buttons: an edit that drops them leaves a question nobody can tap.
    expect(first.buttons?.map((button) => button.label)).toEqual(["Approve", "Deny"]);
    void w.gate.request(fromChat("ls /tmp"));
    await eventually(() => first.text.includes("_2 more questions are waiting behind this one._"), 2_000, "two behind, said");

    // Answered on the dashboard while it waited its turn: one fewer behind, and nothing new posted for it.
    w.gate.resolve(w.asking("ls /tmp").id, "deny", "gading");
    await eventually(() => first.text.includes("_One more question is waiting behind this one._"), 2_000, "one behind again");
    expect(w.shown()).toHaveLength(1);

    // Pressed: settled, and the next comes up with nothing behind it.
    const pressed = await w.gateway.press({ chatId: CHAT.chatId, chatType: "dm", messageId: `${CHAT.gatewayId}#1`, data: `approval:once:${w.asking("git push").id}`, senderId: "8142", senderName: "Gading" });
    expect(pressed.notice).toBe("Approved.");
    expect(first.text).toStartWith("✅ Approved by Gading");
    expect(first.buttons).toBeUndefined();
    await eventually(() => w.shown().length === 1 && w.shown()[0]!.text.includes("bun test"), 2_000, "the next prompt");
    expect(w.shown()[0]!.text).not.toContain("waiting behind this one");
  });

  test("a bare /approve in the chat answers the mission's question it shows — not the chat's own one behind it", async () => {
    const w = wired();
    void w.gate.request(fromMission("git push"));
    await eventually(() => w.shown().length === 1, 2_000, "the first prompt");
    void w.gate.request(fromChat("ls /tmp"));
    await eventually(() => w.shown()[0]?.text.includes("_One more question is waiting behind this one._") === true, 2_000, "one behind it");

    const ctx = {
      agent: { config: { id: "nix" } },
      gatewayId: CHAT.gatewayId,
      chatId: CHAT.chatId,
      senderId: "8142",
      envelope: { gatewayId: CHAT.gatewayId, chatId: CHAT.chatId, senderId: "8142", senderName: "Gading", chatType: "dm" },
      deps: { registry: { enabled: () => [{ config: { id: "nix" } }] }, approvals: w.gate },
    } as unknown as HookContext;
    const result = await answerApproval(ctx, "allow-once");
    expect(result.reply).toContain("Approved");
    expect(w.gate.get(w.asking("ls /tmp").id)?.status).toBe("pending");
    expect(w.gate.pending().map((request) => request.params.command)).toEqual(["ls /tmp"]);
  });
});

describe("the dashboard's list", () => {
  test("says which pending requests the chat has not been asked yet — over the control route it reads", async () => {
    const w = wired();
    void w.gate.request(fromMission("git push"));
    await eventually(() => w.shown().length === 1, 2_000, "the first prompt");
    void w.gate.request(fromChat("ls /tmp"));
    await eventually(() => w.shown()[0]?.text.includes("_One more question is waiting behind this one._") === true, 2_000, "one behind it");

    const app = new Hono();
    const token = "control-token-for-tests-0000000000";
    mountControlRoutes(app, {
      ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
      token,
      audit: new AuditLog(db),
      approvals: w.gate,
    } as unknown as ControlDeps);
    const response = await app.request("/api/control/approvals", { headers: { "x-nouride-token": token } }, { clientAddress: "203.0.113.10" });
    const { pending } = (await response.json()) as { pending: { params: { command: string }; queued?: boolean }[] };
    expect(pending.map((request) => [request.params.command, request.queued ?? false])).toEqual([
      ["git push", false],
      ["ls /tmp", true],
    ]);

    // Shown once the one ahead of it is answered, and no longer marked.
    w.gate.resolve(w.asking("git push").id, "allow-once", "gading");
    await eventually(() => w.asked().length === 2, 2_000, "the second prompt");
    expect(w.asking("ls /tmp").queued).toBeUndefined();
  });
});
