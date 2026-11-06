/**
 * The Access page's answers, over the control API (`routes/access.ts`): deny for a day, block until
 * unblocked, and the history the page reads.
 *
 * Against the real store and audit log: what these guard is the wiring between a button and the row it
 * changes — which state an answer may touch, and what an answer given to the wrong state says back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { AccessStore } from "@/modules/access/access.store.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { registerAccessRoutes } from "@/modules/web/control/routes/access.ts";
import { tempDir } from "../helpers.ts";

const DAY = 24 * 60 * 60_000;
const SENDER = { gatewayId: "telegram:nouva", senderId: "814", senderName: "Sam", chatId: "814" };

let dir: string;
let db: SqliteDb;
let clock: number;
let access: AccessStore;
let rooms: RoomMessageStore;
let audit: AuditLog;
let forgotten: string[];
let app: Hono<{ Variables: { principal: unknown } }>;
let role = "operator";

beforeEach(async () => {
  dir = tempDir("access-routes");
  db = await openAndMigrate(join(dir, "test.db"));
  clock = 1_000_000;
  audit = new AuditLog(db, () => clock);
  access = new AccessStore({ db, audit, codeTtlMs: 900_000, notifyCooldownMs: 300_000, denyCooldownMs: DAY, now: () => clock });
  forgotten = [];
  role = "operator";
  rooms = new RoomMessageStore(db);
  app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role });
    await next();
  });
  registerAccessRoutes(app as never, {
    access,
    audit,
    roomMessages: rooms,
    ctx: { config: { security: { access: { mode: "pair", allowlist: ["telegram:main:5550001111"] } } } },
    autoApprove: { forget: (gatewayId: string, senderId: string) => forgotten.push(`${gatewayId} ${senderId}`) },
  } as never);
});

afterEach(() => {
  db.close();
  removePath(dir);
});

const answer = (action: string, senderId = SENDER.senderId) =>
  app.request(`/access/${action}?gateway=${SENDER.gatewayId}&sender=${senderId}`, { method: "POST" });
const ask = () => access.check({ ...SENDER, mode: "pair", staticAllowlist: [] });

describe("the page", () => {
  test("shows the allowlist that admits without pairing — [security.access] allowlist, which it never showed", async () => {
    const page = (await (await app.request("/access")).json()) as { mode: string; allowlist: string[] };
    expect(page).toMatchObject({ mode: "pair", allowlist: ["telegram:main:5550001111"] });
  });
});

describe("answering one sender", () => {
  test("deny is for a day, and the list says until when; reset ends it", async () => {
    ask();
    expect((await answer("deny")).status).toBe(200);

    const { senders } = (await (await app.request("/access")).json()) as { senders: { status: string; expiresAt: number }[] };
    expect(senders).toEqual([expect.objectContaining({ status: "denied", expiresAt: clock + DAY })]);

    expect((await answer("reset")).status).toBe(200);
    expect(ask().action).toBe("pair");
  });

  test("block lasts until unblock; unblocking twice is a 404", async () => {
    ask();
    expect((await answer("block")).status).toBe(200);
    clock += 30 * DAY;
    expect(ask().action).toBe("ignore");

    expect((await answer("unblock")).status).toBe(200);
    expect((await answer("unblock")).status).toBe(404);
  });

  test("an answer given to the wrong state is refused, and says what the sender is", async () => {
    // Revoke pressed on a page that still shows an approval nobody has any more must not lift a block.
    access.block(SENDER.gatewayId, SENDER.senderId, "cli");
    const res = await answer("revoke");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "telegram:nouva:814 is blocked, so there is nothing to revoke" });
    expect(access.get(SENDER.gatewayId, SENDER.senderId)?.status).toBe("blocked");
    expect((await answer("deny")).status).toBe(404);
    expect(access.get(SENDER.gatewayId, SENDER.senderId)?.status).toBe("blocked");
  });

  test("deny, block and revoke drop the sender's own approval level; reset and unblock end no access", async () => {
    ask();
    await answer("deny");
    await answer("reset");
    await answer("block");
    await answer("unblock");
    expect(forgotten).toEqual(["telegram:nouva 814", "telegram:nouva 814"]);
  });

  test("an unknown answer is a 400 naming the ones there are", async () => {
    const res = await answer("ban");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unblock");
  });
});

describe("allow: in before they ask", () => {
  test("an admin's, as approving a code is; it lands under Approved, and a block is not reached past", async () => {
    expect((await answer("allow")).status).toBe(403);

    role = "admin";
    const allowed = await app.request(`/access/allow?gateway=${SENDER.gatewayId}&sender=${SENDER.senderId}&name=Sam`, { method: "POST" });
    expect(allowed.status).toBe(200);
    expect(access.get(SENDER.gatewayId, SENDER.senderId)).toMatchObject({ status: "approved", senderName: "Sam", resolvedBy: "gading" });

    access.block(SENDER.gatewayId, "999", "cli");
    const refused = await answer("allow", "999");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("Unblock them first");
  });
});

describe("allow names an account the room log already knows", () => {
  test("its last name on that connection, when none is given; a given one wins", async () => {
    // An id from config.toml carries no name, and listing its owner as "Unnamed sender" when the room
    // log has seen them write a hundred times is a gap, not caution.
    role = "admin";
    rooms.record({ id: "m1", gatewayId: "discord:nouva", chatId: "c", senderId: "214", senderName: "Old Name", text: "hi", at: 1 });
    rooms.record({ id: "m2", gatewayId: "discord:nouva", chatId: "c", senderId: "214", senderName: "Gading Nasution", text: "hi", at: 2 });
    rooms.record({ id: "m3", gatewayId: "discord:nix", chatId: "c", senderId: "214", senderName: "Elsewhere", text: "hi", at: 3 });

    await app.request("/access/allow?gateway=discord:nouva&sender=214", { method: "POST" });
    expect(access.get("discord:nouva", "214")?.senderName).toBe("Gading Nasution");

    await app.request("/access/allow?gateway=discord:nero&sender=214&name=Given", { method: "POST" });
    expect(access.get("discord:nero", "214")?.senderName).toBe("Given");
  });

  test("allowing somebody already in only writes the name: the approval is as it was", async () => {
    role = "admin";
    access.allow("discord:nouva", "214", "cli");
    await app.request("/access/allow?gateway=discord:nouva&sender=214&name=Gading%20Nasution", { method: "POST" });
    expect(access.get("discord:nouva", "214")).toMatchObject({ status: "approved", senderName: "Gading Nasution", resolvedBy: "cli" });
  });
});

describe("reading", () => {
  test("a code that ran out is not listed as waiting", async () => {
    ask();
    clock += 900_001;
    const { senders } = (await (await app.request("/access")).json()) as { senders: unknown[] };
    expect(senders).toEqual([]);
  });

  test("the history: every answer, newest first, with who gave it", async () => {
    ask();
    await answer("block");
    clock += 1;
    await answer("unblock");

    const { entries } = (await (await app.request("/access/history")).json()) as {
      entries: { action: string; actor: string; details: Record<string, unknown> }[];
    };
    expect(entries.map((entry) => entry.action)).toEqual(["access_unblocked", "access_blocked", "access_requested"]);
    expect(entries[0]).toMatchObject({ actor: "gading", details: { sender: "814", sender_name: "Sam" } });
  });
});
