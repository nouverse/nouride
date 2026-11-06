/**
 * Who may talk to the daemon.
 *
 * The default used to be: whoever finds the bot. `sender_allowlist` was empty on a fresh install and
 * an empty list meant "allow everyone", so a Telegram bot token in the wrong hands was a shell on the
 * operator's host. These tests are about the three postures that replace it, and about the two ways
 * the gate could fail open.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { ACCESS_ACTIONS, AccessStore, generatePairCode, pairMessage } from "@/modules/access/access.store.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
let clock = 1_000_000;

beforeEach(async () => {
  dir = tempDir("access");
  db = await openAndMigrate(join(dir, "test.db"));
  clock = 1_000_000;
});

afterEach(() => {
  db.close();
  removePath(dir);
});

const DAY = 24 * 60 * 60_000;

function store(options: { codeTtlMs?: number; notifyCooldownMs?: number; audit?: AuditLog } = {}) {
  return new AccessStore({
    db,
    codeTtlMs: options.codeTtlMs ?? 900_000,
    notifyCooldownMs: options.notifyCooldownMs ?? 300_000,
    denyCooldownMs: DAY,
    now: () => clock,
    ...(options.audit ? { audit: options.audit } : {}),
  });
}

const SENDER = {
  gatewayId: "telegram:nouva",
  senderId: "123456789",
  senderName: "Someone",
  chatId: "chat-1",
};

describe("open mode", () => {
  test("lets anyone through", () => {
    const decision = store().check({ ...SENDER, mode: "open", staticAllowlist: [] });
    expect(decision.action).toBe("allow");
  });
});

describe("allowlist mode", () => {
  test("drops an unknown sender in silence", () => {
    // Exactly what was asked for: no reply, no error. A stranger learns nothing, not even that the
    // bot is live.
    const decision = store().check({ ...SENDER, mode: "allowlist", staticAllowlist: ["999"] });
    expect(decision.action).toBe("ignore");
  });

  test("accepts a bare id", () => {
    const decision = store().check({ ...SENDER, mode: "allowlist", staticAllowlist: ["123456789"] });
    expect(decision.action).toBe("allow");
  });

  test("accepts a fully qualified id", () => {
    const decision = store().check({
      ...SENDER,
      mode: "allowlist",
      staticAllowlist: ["telegram:nouva:123456789"],
    });
    expect(decision.action).toBe("allow");
  });

  test("a qualified entry for another gateway does not match", () => {
    // A Telegram user id and a Discord snowflake are both numeric. Without the gateway in the
    // identity, an id allowed on one platform would be allowed on all of them.
    const decision = store().check({
      ...SENDER,
      mode: "allowlist",
      staticAllowlist: ["discord:main:123456789"],
    });
    expect(decision.action).toBe("ignore");
  });

  test("never issues a pairing code", () => {
    // Pair mode is opt-in. In allowlist mode a stranger must not be able to make the daemon speak.
    expect(store().check({ ...SENDER, mode: "allowlist", staticAllowlist: [] }).action).toBe("ignore");
  });

  test("someone paired earlier still gets through", () => {
    /**
     * The whole point of being able to turn pairing off.
     *
     * An operator pairs the people they want, then flips the switch to stop a spammer. If the stored
     * approval stopped counting the moment the mode changed, that flip would lock out the people it
     * was meant to protect — and they would have no way back in, because no code is issued in this
     * mode either.
     */
    const access = store();
    access.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    const record = access.list("pending")[0];
    expect(access.approveByCode(record!.code!, "test")).not.toBeNull();

    expect(access.check({ ...SENDER, mode: "allowlist", staticAllowlist: [] }).action).toBe("allow");
    // And a stranger, in the same breath, is not.
    expect(
      access.check({
        ...SENDER,
        senderId: "999",
        mode: "allowlist",
        staticAllowlist: [],
      }).action,
    ).toBe("ignore");
  });
});

describe("pair mode", () => {
  test("an unknown sender gets a code and is not admitted", () => {
    const decision = store().check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    expect(decision.action).toBe("pair");
    expect(decision.action === "pair" && decision.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  });

  test("writing again reuses the same code rather than piling up requests", () => {
    // Someone who writes three times should leave the operator one decision, not three.
    const s = store({ notifyCooldownMs: 0 });
    const first = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    const second = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    expect(first.action === "pair" && second.action === "pair" && first.code === second.code).toBe(true);
    expect(s.list("pending")).toHaveLength(1);
  });

  test("the not-authorized reply is rate limited", () => {
    // Otherwise an unknown sender can make the daemon answer every message they send — a way to spam
    // a chat, and a way to bury the operator.
    const s = store({ notifyCooldownMs: 60_000 });
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("pair");
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("ignore");

    clock += 60_001;
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("pair");
  });

  test("an approved sender is admitted from then on", () => {
    const s = store();
    const issued = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    if (issued.action !== "pair") throw new Error("expected a code");

    expect(s.approveByCode(issued.code, "cli")).not.toBeNull();
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("allow");
  });

  test("approval survives a fresh store — it is on disk, not in memory", () => {
    const first = store();
    const issued = first.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    if (issued.action !== "pair") throw new Error("expected a code");
    first.approveByCode(issued.code, "cli");

    expect(store().check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("allow");
  });

  test("an expired code cannot be approved", () => {
    // A code that sat in a chat overnight must not still work.
    const s = store({ codeTtlMs: 1000 });
    const issued = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    if (issued.action !== "pair") throw new Error("expected a code");

    clock += 1001;
    expect(s.approveByCode(issued.code, "cli")).toBeNull();
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("pair");
  });

  test("a wrong code approves nobody", () => {
    const s = store();
    s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    expect(s.approveByCode("AAA-AAA", "cli")).toBeNull();
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).not.toBe("allow");
  });

  test("codes are matched case-insensitively", () => {
    // The operator retypes it from a chat message; insisting on case is friction for no security.
    const s = store();
    const issued = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    if (issued.action !== "pair") throw new Error("expected a code");
    expect(s.approveByCode(issued.code.toLowerCase(), "cli")).not.toBeNull();
  });

  test("a denied sender is dropped in silence for a day — then asking again is a new request", () => {
    // Deny is "no, this time". It used to be for good: one "no" at a code nobody recognised was a ban,
    // with nothing on any screen to say so. Silent while it lasts, because telling them invites retrying.
    const s = store();
    const first = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    const denied = s.resolve(SENDER.gatewayId, SENDER.senderId, "denied", "cli");
    expect(denied?.expiresAt).toBe(clock + DAY);

    clock += DAY - 1;
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("ignore");

    clock += 1;
    const again = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    expect(again.action).toBe("pair");
    if (again.action !== "pair" || first.action !== "pair") throw new Error("expected codes");
    expect(again.code).not.toBe(first.code);
    expect(s.get(SENDER.gatewayId, SENDER.senderId)?.status).toBe("pending");
  });

  test("reset ends a denial's wait at once", () => {
    const s = store();
    s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    s.resolve(SENDER.gatewayId, SENDER.senderId, "denied", "cli");

    expect(s.reset(SENDER.gatewayId, SENDER.senderId, "gading")).toBe(true);
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("pair");
  });

  test("a denied sender stays out in allowlist mode once the wait is over, as anybody unknown does", () => {
    const s = store();
    s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    s.resolve(SENDER.gatewayId, SENDER.senderId, "denied", "cli");
    clock += DAY;
    expect(s.check({ ...SENDER, mode: "allowlist", staticAllowlist: [] }).action).toBe("ignore");
  });

  test("a block lasts — past any wait — until it is lifted, and lifting it lets them ask, not in", () => {
    const s = store();
    s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    expect(s.block(SENDER.gatewayId, SENDER.senderId, "gading").status).toBe("blocked");

    clock += 365 * DAY;
    s.tidy();
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("ignore");

    expect(s.unblock(SENDER.gatewayId, SENDER.senderId, "gading")).toBe(true);
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("pair");
  });

  test("an approved sender can be blocked, and so can an id that never wrote", () => {
    const s = store();
    const issued = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    if (issued.action !== "pair") throw new Error("expected a code");
    s.approveByCode(issued.code, "cli");
    s.block(SENDER.gatewayId, SENDER.senderId, "gading");
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("ignore");

    s.block(SENDER.gatewayId, "555", "gading");
    expect(s.check({ ...SENDER, senderId: "555", mode: "pair", staticAllowlist: [] }).action).toBe("ignore");
  });

  test("revoke, reset and unblock each answer only their own state", () => {
    // From a page a minute old: Revoke pressed on an approval somebody has since blocked must not lift it.
    const s = store();
    s.block(SENDER.gatewayId, SENDER.senderId, "gading");
    expect(s.revoke(SENDER.gatewayId, SENDER.senderId, "cli")).toBe(false);
    expect(s.reset(SENDER.gatewayId, SENDER.senderId, "cli")).toBe(false);
    expect(s.get(SENDER.gatewayId, SENDER.senderId)?.status).toBe("blocked");

    expect(s.unblock(SENDER.gatewayId, "nobody", "cli")).toBe(false);
  });

  test("a block beats an id written in config.toml, and the open posture too", () => {
    // "Until somebody says otherwise" is said on the Access page; a line in a file must not undo it.
    const s = store();
    s.block(SENDER.gatewayId, SENDER.senderId, "gading");
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: ["telegram:nouva:123456789"] }).action).toBe("ignore");
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: ["123456789"] }).action).toBe("ignore");
    expect(s.check({ ...SENDER, mode: "open", staticAllowlist: [] }).action).toBe("ignore");
    // Somebody else on the list is still let in.
    expect(s.check({ ...SENDER, senderId: "42", mode: "pair", staticAllowlist: ["42"] }).action).toBe("allow");
  });

  test("allow lets somebody in before they have asked — under Approved, where revoke reaches it", () => {
    const s = store();
    const allowed = s.allow(SENDER.gatewayId, SENDER.senderId, "gading", "Gading");
    expect(allowed).toMatchObject({ status: "approved", senderName: "Gading", resolvedBy: "gading" });
    expect(s.check({ ...SENDER, mode: "allowlist", staticAllowlist: [] }).action).toBe("allow");

    expect(s.revoke(SENDER.gatewayId, SENDER.senderId, "gading")).toBe(true);
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("pair");
  });

  test("allow does not reach past a block, and an approval is left as it is", () => {
    const s = store();
    s.block(SENDER.gatewayId, SENDER.senderId, "gading");
    expect(s.allow(SENDER.gatewayId, SENDER.senderId, "gading")).toBeNull();
    expect(s.get(SENDER.gatewayId, SENDER.senderId)?.status).toBe("blocked");

    s.allow(SENDER.gatewayId, "42", "gading");
    clock += 1000;
    expect(s.allow(SENDER.gatewayId, "42", "someone-else")?.resolvedBy).toBe("gading");
    // A name given is still written: how a row let in without one gets it.
    expect(s.allow(SENDER.gatewayId, "42", "someone-else", "Forty Two")).toMatchObject({ senderName: "Forty Two", resolvedBy: "gading" });
  });

  test("an approved sender's name is the one their platform reports now", () => {
    // Somebody let in by allow has no name until they write; people rename themselves.
    const s = store();
    s.allow(SENDER.gatewayId, SENDER.senderId, "gading");
    expect(s.get(SENDER.gatewayId, SENDER.senderId)?.senderName).toBeNull();
    s.check({ ...SENDER, senderName: "Gading N", mode: "pair", staticAllowlist: [] });
    expect(s.get(SENDER.gatewayId, SENDER.senderId)?.senderName).toBe("Gading N");
  });

  test("deny answers a request, and only a request: a block is not softened into a day", () => {
    const s = store();
    s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    s.block(SENDER.gatewayId, SENDER.senderId, "gading");

    expect(s.resolve(SENDER.gatewayId, SENDER.senderId, "denied", "cli")).toBeNull();
    expect(s.get(SENDER.gatewayId, SENDER.senderId)?.status).toBe("blocked");
  });

  test("revoking sends them back to pairing", () => {
    // "You are no longer on the team" — not "go away", which is a block.
    const s = store();
    const issued = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    if (issued.action !== "pair") throw new Error("expected a code");
    s.approveByCode(issued.code, "cli");

    expect(s.revoke(SENDER.gatewayId, SENDER.senderId, "cli")).toBe(true);
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("pair");
  });

  test("the static allowlist wins in pair mode too", () => {
    // An operator who wrote the id down has already decided. A second gate over the same question
    // would just be confusing.
    const decision = store().check({ ...SENDER, mode: "pair", staticAllowlist: ["123456789"] });
    expect(decision.action).toBe("allow");
  });

  test("pairing one bot does not admit the sender to another", () => {
    const s = store();
    const issued = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    if (issued.action !== "pair") throw new Error("expected a code");
    s.approveByCode(issued.code, "cli");

    const other = s.check({
      ...SENDER,
      gatewayId: "telegram:nox",
      mode: "pair",
      staticAllowlist: [],
    });
    expect(other.action).not.toBe("allow");
  });
});

describe("tidy", () => {
  test("drops pending requests whose code has expired", () => {
    const s = store({ codeTtlMs: 1000 });
    s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    clock += 1001;

    expect(s.tidy()).toBe(1);
    expect(s.list("pending")).toHaveLength(0);
  });

  test("puts away a denial whose wait is over, and keeps one still waiting", () => {
    const s = store();
    s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    s.resolve(SENDER.gatewayId, SENDER.senderId, "denied", "cli");
    s.check({ ...SENDER, senderId: "777", mode: "pair", staticAllowlist: [] });
    clock += 1000;
    s.resolve(SENDER.gatewayId, "777", "denied", "cli");

    clock += DAY - 500;
    expect(s.tidy()).toBe(1);
    expect(s.list("denied").map((sender) => sender.senderId)).toEqual(["777"]);
  });

  test("a denial is never made a block: only block makes one", () => {
    // A denial with no end is a row only a build from before deny and block were split wrote, and the upgrade floor
    // ran the boot that turned each into a block. Nothing reads one as a block any more.
    db.prepare(
      "INSERT INTO sender_access (gateway_id, sender_id, status, requested_at, resolved_at, resolved_by) VALUES (?, ?, 'denied', ?, ?, 'cli')",
    ).run(SENDER.gatewayId, SENDER.senderId, clock, clock);
    const s = store();

    expect(s.tidy()).toBe(0);
    expect(s.get(SENDER.gatewayId, SENDER.senderId)?.status).toBe("denied");
  });

  test("leaves approvals alone", () => {
    const s = store({ codeTtlMs: 1000 });
    const issued = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    if (issued.action !== "pair") throw new Error("expected a code");
    s.approveByCode(issued.code, "cli");

    clock += 10_000_000;
    expect(s.tidy()).toBe(0);
    expect(s.check({ ...SENDER, mode: "pair", staticAllowlist: [] }).action).toBe("allow");
  });
});

describe("generatePairCode", () => {
  test("avoids characters people mistype", () => {
    // Read off a phone and typed into a terminal. `O`/`0` and `I`/`1` are the whole problem.
    for (let i = 0; i < 50; i++) {
      expect(generatePairCode()).not.toMatch(/[O0I1U]/);
    }
  });

  test("is grouped for reading aloud", () => {
    expect(generatePairCode()).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  });
});

describe("pairMessage", () => {
  test("gives the code and nothing else useful to a stranger", () => {
    const text = pairMessage("ABC-234");
    expect(text).toContain("ABC-234");
    // No agent name, no tool list, no operator identity. Anything more is reconnaissance handed out
    // for free.
    expect(text.toLowerCase()).not.toContain("exec");
    expect(text.toLowerCase()).not.toContain("tool");
  });

  test("says what to do next", () => {
    expect(pairMessage("ABC-234")).toMatch(/whoever runs me/);
  });

  test("names the page to approve it on, because the person pairing is usually the operator", () => {
    /**
     * "Send that code to whoever runs me" is a dead end when you *are* that person and nothing has
     * told you there is a page for it — which is the common case, somebody setting up their own bot.
     * One page holds every agent's requests, so the path names no agent.
     */
    const text = pairMessage("ABC-234");
    expect(text).toContain("go to Access");
    expect(text).toContain("under Pending");
    // The code again, next to the instruction, so it is not scrolled away from the action.
    expect(text.match(/ABC-234/g)?.length).toBeGreaterThan(1);
  });

  test("quotes no expiry duration, because the TTL is configurable", () => {
    // A message that says fifteen minutes on a daemon set to five is worse than one that says
    // neither. `codeTtlMs` is an option on the store.
    expect(pairMessage("ABC-234")).not.toMatch(/\d+\s*(minute|hour)/i);
  });
});

describe("the history", () => {
  test("every answer is in the audit log — who, to whom by name, and what they were before", () => {
    // The Access page's History reads these: the table holds where a person stands now, and a revoke,
    // a reset or an unblock deletes the row.
    const audit = new AuditLog(db, () => clock);
    const s = store({ codeTtlMs: 1000, audit });
    const issued = s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    if (issued.action !== "pair") throw new Error("expected a code");
    s.approveByCode(issued.code, "gading");
    s.block(SENDER.gatewayId, SENDER.senderId, "gading");
    s.unblock(SENDER.gatewayId, SENDER.senderId, "gading");
    s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    s.resolve(SENDER.gatewayId, SENDER.senderId, "denied", "gading");
    s.reset(SENDER.gatewayId, SENDER.senderId, "gading");
    s.check({ ...SENDER, mode: "pair", staticAllowlist: [] });
    clock += 1001;
    s.tidy();

    const history = audit.ofActions(ACCESS_ACTIONS).reverse();
    expect(history.map((entry) => entry.action)).toEqual([
      "access_requested",
      "access_approved",
      "access_blocked",
      "access_unblocked",
      "access_requested",
      "access_denied",
      "access_reset",
      "access_requested",
      "access_expired",
    ]);
    for (const entry of history) {
      expect(entry.details).toMatchObject({ sender: SENDER.senderId, sender_name: "Someone" });
      expect(entry.gatewayId).toBe(SENDER.gatewayId);
    }
    expect(history[2]).toMatchObject({ actor: "gading", details: { was: "approved" } });
    expect(history[5]!.details).toMatchObject({ until: expect.any(Number) });
    expect(history[8]).toMatchObject({ actor: "system" });
  });
});
