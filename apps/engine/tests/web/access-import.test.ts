/**
 * A whole list of people let in ahead (`POST /access/import`, `nouride access allow --from`), and the door that then
 * knows them. A business with ten thousand numbers of its own contacts could let each in one call at a time, or set
 * the door `open`, which the daemon refuses beside an agent that can run commands (issue #27).
 *
 * Against the real store, audit log and route, and each platform's own adapter reading the written ids: what is kept
 * has to be what a message from that person carries, or the list lets nobody in. On WhatsApp that is a hidden id
 * with the number beside it; on Telegram and Discord an id with the username beside it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { createGateways } from "@nouride/gateways";
import type { GatewayInstanceConfig } from "@nouride/shared";
import { removePath, type SqliteDb } from "@nouride/runtime";
import type { AccessImported, AccessListing } from "@nouride/wire";
import { openAndMigrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { AccessStore } from "@/modules/access/access.store.ts";
import { APPROVED_LISTED } from "@/modules/access/access-many.store.ts";
import { registerAccessRoutes } from "@/modules/web/control/routes/access.ts";
import { tempDir } from "../helpers.ts";

const WA = "whatsapp:main";
const LID = "100000000000001@lid";
const NUMBER = "6281234567890@s.whatsapp.net";

let dir: string;
let db: SqliteDb;
let clock: number;
let access: AccessStore;
let audit: AuditLog;
let app: Hono<{ Variables: { principal: unknown } }>;
let role = "admin";

beforeEach(async () => {
  dir = tempDir("access-import");
  db = await openAndMigrate(join(dir, "test.db"));
  clock = 1_000_000;
  audit = new AuditLog(db, () => clock);
  access = new AccessStore({ db, audit, codeTtlMs: 900_000, notifyCooldownMs: 300_000, denyCooldownMs: 86_400_000, now: () => clock });
  role = "admin";
  // The adapters as the daemon builds them from its config, never connected.
  const instance = (platform: string, more: Record<string, unknown> = {}) => ({ id: `${platform}:main`, platform, name: "main", enabled: true, ...more }) as unknown as GatewayInstanceConfig;
  const gateways: Map<string, unknown> = await createGateways(
    [instance("whatsapp", { sessionDir: join(dir, "wa"), encryptionKeySecret: "wa_key" }), instance("telegram", { tokenSecret: "tg" }), instance("discord", { tokenSecret: "dc" })],
    (name) => (name === "wa_key" ? "a".repeat(64) : "1:a"),
    (() => ({})) as never,
  );
  // A connection whose ids are written as they arrive, and one of the daemon's own.
  gateways.set("plain:main", { id: "plain:main", platform: "plain" });
  gateways.set("web:mission", { id: "web:mission", platform: "web", internal: true });
  app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role });
    await next();
  });
  registerAccessRoutes(app as never, { access, audit, ctx: { gateways, config: { security: { access: { mode: "pair", allowlist: [] } } } } } as never);
});

afterEach(() => {
  db.close();
  removePath(dir);
});

const send = (body: unknown) => app.request("/access/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const imported = async (body: unknown) => (await (await send(body)).json()) as AccessImported;
const approvedOn = (gateway: string) => access.list("approved").filter((one) => one.gatewayId === gateway).map((one) => one.senderId).sort();
/** A message at the door, in `pair` mode: from `senderId`, with the other ids its platform sent beside it. */
const door = (gatewayId: string, senderId: string, alsoKnownAs?: string[], mode: "pair" | "allowlist" = "pair") =>
  access.check({ gatewayId, senderId, chatId: senderId, mode, staticAllowlist: [], ...(alsoKnownAs ? { alsoKnownAs } : {}) }).action;

describe("a list of numbers, on WhatsApp", () => {
  const LIST = ["+62 812-3456-7890", { id: "62 813 0000 0001", name: "Bu Rina" }, "6281234567890", "081234567890", "not a number", "14155550123"];

  test("each is kept as WhatsApp's address of it; what is no number is said, and one said twice is one", async () => {
    const done = await imported({ gateway: WA, senders: LIST });
    expect(done).toEqual({ gateway: WA, dryRun: false, read: 6, added: 3, already: 0, blocked: 0, duplicates: 1, invalid: { count: 2, examples: ["081234567890", "not a number"] } });
    expect(approvedOn(WA)).toEqual(["14155550123@s.whatsapp.net", NUMBER, "6281300000001@s.whatsapp.net"]);
    expect(access.get(WA, "6281300000001@s.whatsapp.net")).toMatchObject({ senderName: "Bu Rina", status: "approved", resolvedBy: "gading" });
  });

  // The Access page hands over what a person pasted or picked, as written: no reader of lines in the browser.
  test("the list as written, as a page sends it, is read as a file is: a comment, a row's quotes, a name, the same counts", async () => {
    const text = '# our contacts\r\n+62 812-3456-7890\r\n\r\n"62 813 0000 0001","Bu Rina"\n6281234567890\n081234567890\nnot a number\n14155550123\n';
    const dry = await imported({ gateway: WA, text, dryRun: true });
    expect(dry).toEqual({ gateway: WA, dryRun: true, read: 6, added: 3, already: 0, blocked: 0, duplicates: 1, invalid: { count: 2, examples: ["081234567890", "not a number"] } });
    expect(access.list()).toEqual([]);
    expect(await imported({ gateway: WA, text })).toMatchObject({ dryRun: false, read: 6, added: 3 });
    expect(access.get(WA, "6281300000001@s.whatsapp.net")).toMatchObject({ senderName: "Bu Rina", status: "approved" });
    // Nothing but comments and empty lines names nobody.
    const empty = await send({ gateway: WA, text: "# nobody yet\n\n" });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { plain: string }).plain).toBe("The list names nobody. Check it, and send it again.");
    expect((await send({ gateway: WA, text: Array.from({ length: 50_001 }, (_, i) => `62812${String(i).padStart(8, "0")}`).join("\n") })).status).toBe(400);
  });

  test("the reply of somebody on it gets through under the hidden id WhatsApp delivers them by, with no code", async () => {
    // Before the list: a stranger, given a code, and listed as asking.
    expect(door(WA, LID, [NUMBER])).toBe("pair");
    expect(access.get(WA, LID)!.status).toBe("pending");

    await imported({ gateway: WA, senders: ["+62 812-3456-7890"] });
    expect(door(WA, LID, [NUMBER])).toBe("allow");
    // Let in by their number, the code they asked for under the hidden id waits for nobody: it is gone.
    expect(access.get(WA, LID)).toBeNull();
    expect(access.list("pending")).toEqual([]);
    expect(door(WA, LID, [NUMBER], "allowlist")).toBe("allow");
    // Under the number itself, as WhatsApp still delivers some.
    expect(door(WA, NUMBER)).toBe("allow");
    // The same hidden id with no number beside it, or another's number, is still a stranger.
    expect(door(WA, "100000000000002@lid")).toBe("pair");
    expect(door(WA, "100000000000003@lid", ["6289999999999@s.whatsapp.net"], "allowlist")).toBe("ignore");
    // And the name they write under is kept on the row the list made, which had none.
    access.check({ gatewayId: WA, senderId: LID, senderName: "Mira", chatId: LID, mode: "pair", staticAllowlist: [], alsoKnownAs: [NUMBER] });
    expect(access.get(WA, NUMBER)!.senderName).toBe("Mira");
  });

  test("a block on either id keeps them out, and a number written in config.toml lets its hidden id in", async () => {
    await imported({ gateway: WA, senders: ["6281234567890"] });
    access.block(WA, LID, "gading");
    expect(door(WA, LID, [NUMBER])).toBe("ignore");
    access.unblock(WA, LID, "gading");
    access.block(WA, NUMBER, "gading");
    expect(door(WA, LID, [NUMBER])).toBe("ignore");
    expect(access.check({ gatewayId: WA, senderId: "100000000000009@lid", chatId: "x", mode: "allowlist", staticAllowlist: [`${WA}:6287700000000@s.whatsapp.net`], alsoKnownAs: ["6287700000000@s.whatsapp.net"] }).action).toBe("allow");
  });

  test("a dry run counts and writes nothing; a second run finds them in already; a blocked one stays out", async () => {
    const before = await imported({ gateway: WA, senders: LIST, dryRun: true });
    expect(before).toMatchObject({ dryRun: true, added: 3, already: 0, duplicates: 1, invalid: { count: 2 } });
    expect(access.list()).toEqual([]);
    expect(audit.ofActions(["access_imported"])).toEqual([]);

    await imported({ gateway: WA, senders: LIST });
    access.block(WA, "14155550123@s.whatsapp.net", "gading");
    const again = await imported({ gateway: WA, senders: [...LIST, "+62 899 1111 2222"] });
    expect(again).toMatchObject({ added: 1, already: 2, blocked: 1 });
    expect(access.get(WA, "14155550123@s.whatsapp.net")!.status).toBe("blocked");
    // One already in keeps who approved it and when; a name is filled in only where it had none.
    clock += 60_000;
    await imported({ gateway: WA, senders: [{ id: "6281300000001", name: "Somebody else" }, { id: "6281234567890", name: "Pak Budi" }] });
    expect(access.get(WA, "6281300000001@s.whatsapp.net")).toMatchObject({ senderName: "Bu Rina", resolvedAt: 1_000_000 });
    expect(access.get(WA, NUMBER)).toMatchObject({ senderName: "Pak Budi", resolvedAt: 1_000_000 });
  });

  test("one line in the history for the whole list, with its counts", async () => {
    await imported({ gateway: WA, senders: LIST });
    await audit.flush();
    const history = ((await (await app.request("/access/history")).json()) as { entries: { action: string; actor?: string; gatewayId?: string; details?: unknown }[] }).entries;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: "access_imported", actor: "gading", gatewayId: WA, details: { added: 3, already: 0, blocked: 0 } });
  });
});

describe("on Telegram and Discord", () => {
  test("an id is kept as it is and a username as @name; a message from that account, its username beside its id, gets through", async () => {
    const telegram = await imported({ gateway: "telegram:main", senders: ["5550001111", "@Sam_Lee", "t.me/budi_santoso", "+62 812 3456 7890", "ab"] });
    expect(telegram).toMatchObject({ added: 3, invalid: { count: 2, examples: ["+62 812 3456 7890", "ab"] } });
    expect(approvedOn("telegram:main")).toEqual(["5550001111", "@budi_santoso", "@sam_lee"]);
    expect(door("telegram:main", "700700700", ["@sam_lee"])).toBe("allow");
    expect(door("telegram:main", "5550001111")).toBe("allow");
    // Somebody else, whose username is not on it, and one with no username at all.
    expect(door("telegram:main", "700700701", ["@sam_leee"])).toBe("pair");
    expect(door("telegram:main", "700700702")).toBe("pair");

    const discord = await imported({ gateway: "discord:main", senders: ["1111111111111111111", "Sam.Lee", "sam#1234"] });
    expect(discord).toMatchObject({ added: 2, invalid: { count: 1, examples: ["sam#1234"] } });
    expect(approvedOn("discord:main")).toEqual(["1111111111111111111", "@sam.lee"]);
    expect(door("discord:main", "2222222222222222222", ["@sam.lee"])).toBe("allow");
    // A username let in on one connection lets nobody in on another.
    expect(door("telegram:main", "900900900", ["@sam.lee"])).toBe("pair");
  });

  test("a connection that reads no written form keeps an id as written, whole, and refuses one with a space in it", async () => {
    expect(await imported({ gateway: "plain:main", senders: [" u-1 ", "u 2", ""] })).toMatchObject({ added: 1, invalid: { count: 2 } });
    expect(approvedOn("plain:main")).toEqual(["u-1"]);
  });
});

describe("who may, and what is refused", () => {
  test("an admin's alone; no such connection, the daemon's own, an empty list and one past the limit are refused with nothing written", async () => {
    role = "operator";
    expect((await send({ gateway: WA, senders: ["6281234567890"] })).status).toBe(403);
    role = "admin";
    const none = await send({ gateway: "whatsapp:nope", senders: ["6281234567890"] });
    expect(none.status).toBe(404);
    expect(((await none.json()) as { plain: string }).plain).toBe("There is no connection of that name. Check its name under Connections.");
    expect((await send({ gateway: "web:mission", senders: ["x"] })).status).toBe(404);
    expect((await send({ gateway: WA, senders: [] })).status).toBe(400);
    expect((await send({ gateway: WA })).status).toBe(400);
    expect((await send({ gateway: WA, senders: Array.from({ length: 50_001 }, (_, i) => `62812${String(i).padStart(8, "0")}`) })).status).toBe(400);
    expect(access.list()).toEqual([]);
  });

  test("ten thousand numbers go in at once", async () => {
    const senders = Array.from({ length: 10_000 }, (_, i) => `+62 812 ${String(10_000_000 + i).slice(1)} 0`);
    const done = await imported({ gateway: WA, senders });
    expect(done).toMatchObject({ read: 10_000, added: 10_000, duplicates: 0, invalid: { count: 0 } });
    expect(door(WA, "100000000000077@lid", ["6281200042710@s.whatsapp.net"])).toBe("allow");
  });
});

describe("what a page or a terminal lists, once thousands are in", () => {
  test(`the newest ${APPROVED_LISTED} approved with how many there are; everyone asking still listed; one beyond them found by id or name`, async () => {
    const senders = Array.from({ length: APPROVED_LISTED + 100 }, (_, i) => ({ id: `62812${String(i).padStart(8, "0")}`, name: i === 7 ? "Bu Rina" : undefined }));
    await imported({ gateway: WA, senders: senders.slice(0, 100) });
    clock += 60_000;
    await imported({ gateway: WA, senders: senders.slice(100) });
    access.check({ gatewayId: "telegram:main", senderId: "555", senderName: "A stranger", chatId: "555", mode: "pair", staticAllowlist: [] });

    const page = (await (await app.request("/access")).json()) as AccessListing;
    expect(page.approvedTotal).toBe(APPROVED_LISTED + 100);
    // Counted on each connection too, every one of them and not only the newest sent.
    expect(page.approvedOn).toEqual({ [WA]: APPROVED_LISTED + 100 });
    expect(page.senders.filter((one) => one.status === "approved")).toHaveLength(APPROVED_LISTED);
    expect(page.senders.filter((one) => one.status === "pending").map((one) => one.senderId)).toEqual(["555"]);
    // The newest: none of the first hundred, let in a minute earlier.
    expect(page.senders.some((one) => one.senderId === "6281200000007@s.whatsapp.net")).toBe(false);

    const byName = (await (await app.request("/access?q=rina")).json()) as AccessListing;
    expect(byName.senders.filter((one) => one.status === "approved").map((one) => one.senderId)).toEqual(["6281200000007@s.whatsapp.net"]);
    expect(byName.approvedTotal).toBe(APPROVED_LISTED + 100);
    const byId = (await (await app.request("/access?status=approved&q=6281200000007")).json()) as AccessListing;
    expect(byId.senders.map((one) => one.senderName)).toEqual(["Bu Rina"]);
    // What is typed is looked for as it is: `%` and `_` match themselves.
    expect(((await (await app.request("/access?status=approved&q=%25")).json()) as AccessListing).senders).toEqual([]);

    // Two let in on another connection, older than every one sent: counted on theirs, whatever the page was sent.
    clock -= 3_600_000;
    await imported({ gateway: "telegram:main", senders: ["5550001111", "5550002222"] });
    const both = (await (await app.request("/access")).json()) as AccessListing;
    expect(both.approvedOn).toEqual({ [WA]: APPROVED_LISTED + 100, "telegram:main": 2 });
    expect(both.approvedTotal).toBe(APPROVED_LISTED + 102);
    expect(both.senders.filter((one) => one.gatewayId === "telegram:main" && one.status === "approved")).toEqual([]);
  });

  test("searched on named connections, the newest it sends are theirs: another connection's many crowd none of them out", async () => {
    // Many on WhatsApp whose ids hold "555", newer than the two on Telegram that do.
    clock -= 3_600_000;
    await imported({ gateway: "telegram:main", senders: ["5550001111", "5550002222"] });
    clock += 7_200_000;
    await imported({ gateway: WA, senders: Array.from({ length: APPROVED_LISTED + 10 }, (_, i) => `62555${String(i).padStart(8, "0")}`) });
    access.check({ gatewayId: "telegram:main", senderId: "777", senderName: "Asking on Telegram", chatId: "777", mode: "pair", staticAllowlist: [] });
    access.check({ gatewayId: WA, senderId: "6289900000001@s.whatsapp.net", senderName: "Asking on WhatsApp", chatId: "6289900000001@s.whatsapp.net", mode: "pair", staticAllowlist: [] });

    // The whole install: the newest five hundred matches are all WhatsApp's.
    const everywhere = (await (await app.request("/access?q=555")).json()) as AccessListing;
    expect(everywhere.senders.filter((one) => one.status === "approved" && one.gatewayId === "telegram:main")).toEqual([]);
    // On Telegram's: its two, and nothing of WhatsApp's, asking or approved.
    const onTelegram = (await (await app.request("/access?q=555&on=telegram%3Amain")).json()) as AccessListing;
    expect(onTelegram.senders.filter((one) => one.status === "approved").map((one) => one.senderId).sort()).toEqual(["5550001111", "5550002222"]);
    expect(onTelegram.senders.map((one) => one.gatewayId).every((id) => id === "telegram:main")).toBe(true);
    expect(onTelegram.senders.some((one) => one.senderId === "777")).toBe(true);
    // Repeated, both; the counts every connection's either way.
    const onBoth = (await (await app.request(`/access?status=pending&on=telegram%3Amain&on=${encodeURIComponent(WA)}`)).json()) as AccessListing;
    expect(onBoth.senders.map((one) => one.senderId).sort()).toEqual(["6289900000001@s.whatsapp.net", "777"]);
    expect(onTelegram.approvedOn).toEqual({ [WA]: APPROVED_LISTED + 10, "telegram:main": 2 });
    // Asked as before, the answer is as before.
    expect(((await (await app.request("/access?status=pending")).json()) as AccessListing).senders).toHaveLength(2);
  });
});
