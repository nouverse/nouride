/**
 * Which `[[people]]` entry a sender is.
 *
 * The case that made the old rule wrong is the one nobody thinks about when writing it: **a shared
 * Discord channel.** Which of our connections a message arrives on is decided by which bot the person
 * tagged — the platform resolves the mention on that bot and the other five drop it as addressed
 * elsewhere. So a connection-qualified id recognises Sam while she is talking to Nero and leaves her
 * a stranger the moment she tags Nox, in the same room, one message later.
 *
 * Hence two spellings and several ids per person. And hence the bare id still being refused: the whole
 * reason a platform has to be named is that a Telegram user id and a Discord snowflake are both plain
 * numbers, and matching one as the other identifies the wrong human with total confidence.
 */

import { describe, expect, test } from "bun:test";
import type { Person } from "@nouride/shared";
import {
  canonicalPersonId,
  findPerson,
  idFormsFor,
  idsOf,
  personIdMatches,
  refusePersonId,
  senderIsAdmin,
} from "@/modules/people/match.ts";

const sender = (gatewayId: string, senderId: string) => ({ gatewayId, senderId });

describe("a shared channel with several of our bots", () => {
  const sam: Person = { key: "sam", ids: ["discord:214777"], name: "Sam", notes: "Prefers short answers." };

  test("a platform-qualified id recognises her whichever bot she tags", () => {
    // The point of the whole change. Same human, same channel, different connection each time.
    expect(findPerson([sam], sender("discord:nero", "214777"))?.name).toBe("Sam");
    expect(findPerson([sam], sender("discord:nox", "214777"))?.name).toBe("Sam");
    expect(findPerson([sam], sender("discord:nouva", "214777"))?.name).toBe("Sam");
  });

  test("her notes travel with her", () => {
    expect(findPerson([sam], sender("discord:nox", "214777"))?.notes).toBe("Prefers short answers.");
  });

  test("somebody else in the same channel is still nobody", () => {
    expect(findPerson([sam], sender("discord:nero", "999"))).toBeUndefined();
  });

  test("an id written with a connection, as before 0.7.0, names her on every bot too", () => {
    // `whatsapp:nouva:628…` named a household member only while they wrote to Nouva's number; a second
    // WhatsApp connection met them as a stranger. The connection is read past, never kept.
    const written: Person = { key: "sam", ids: ["discord:nero:214777"], name: "Sam" };
    expect(findPerson([written], sender("discord:nero", "214777"))?.name).toBe("Sam");
    expect(findPerson([written], sender("discord:nox", "214777"))?.name).toBe("Sam");
    expect(canonicalPersonId("whatsapp:nouva:628111000001@s.whatsapp.net")).toBe("whatsapp:628111000001@s.whatsapp.net");
    expect(canonicalPersonId("web:dashboard:usr_1")).toBe("web:usr_1");
  });

  test("a segment of digits is the account's, not a connection", () => {
    // A WhatsApp device id: `628…:12@s.whatsapp.net`. Dropping `628…` as if it were a bot would name nobody.
    expect(canonicalPersonId("whatsapp:628111000001:12@s.whatsapp.net")).toBe("whatsapp:628111000001:12@s.whatsapp.net");
  });
});

describe("one human, several addresses", () => {
  const gading: Person = {
    key: "gading",
    // The ids this install had written as separate entries, with the name and notes duplicated in each
    // and free to drift apart on the next edit.
    ids: [
      "whatsapp:main:100000000000001@lid",
      "whatsapp:main:628111000001@s.whatsapp.net",
      "telegram:bot:5550001111",
      "discord:214000",
    ],
    name: "Gading",
    notes: "Founder.",
  };

  test("every id reaches the same person", () => {
    for (const [gatewayId, senderId] of [
      ["whatsapp:main", "100000000000001@lid"],
      ["whatsapp:main", "628111000001@s.whatsapp.net"],
      ["telegram:bot", "5550001111"],
      ["discord:nero", "214000"],
    ] as const) {
      expect(findPerson([gading], sender(gatewayId, senderId))).toEqual({
        name: "Gading",
        notes: "Founder.",
      });
    }
  });

  test("`idsOf` is every account in today's spelling, without blanks or repeats", () => {
    expect(idsOf({ ids: ["telegram:bot:1", "telegram:1", " ", "discord:2"] })).toEqual([
      "telegram:1",
      "discord:2",
    ]);
  });
});

describe("the two id forms", () => {
  test("a sender is described by both, most specific first", () => {
    expect(idFormsFor(sender("discord:nero", "214"))).toEqual(["discord:nero:214", "discord:214"]);
  });

  test("a gateway id with no instance yields one form, not a duplicate", () => {
    expect(idFormsFor(sender("discord", "214"))).toEqual(["discord:214"]);
  });

  test("matching is exact, never a prefix", () => {
    // `discord:214` covering `discord:2149999` would be a different person, silently.
    expect(personIdMatches("discord:214", sender("discord:nero", "2149999"))).toBe(false);
    expect(personIdMatches("discord:214", sender("discord:nero", "214"))).toBe(true);
    // Whitespace in a hand-edited file is not a mismatch.
    expect(personIdMatches("  discord:214  ", sender("discord:nero", "214"))).toBe(true);
  });

  test("the dashboard's own sender can be named too", () => {
    // `web:dashboard:<account id>` — for attaching notes to somebody the daemon already authenticates.
    const person: Person = { key: "gading", ids: ["web:dashboard:usr_1"], name: "Gading" };
    expect(findPerson([person], sender("web:dashboard", "usr_1"))?.name).toBe("Gading");
  });
});

describe("what is refused, and why", () => {
  test("a bare id, because numbers collide across platforms", () => {
    const refusal = refusePersonId("5550001111");
    expect(refusal).toContain("must name the platform");
    // The message offers the spelling that would have worked, and where to find the real ids.
    expect(refusal).toContain("discord:5550001111");
    expect(refusal).not.toContain("telegram:bot:");
    expect(refusal).toContain("nouride access");
  });

  test("a first segment that is not a platform", () => {
    // `nero:214` reads as qualified and is not — an agent name there matches nothing, forever.
    expect(refusePersonId("nero:214")).toContain("not a platform");
  });

  test("a platform with no sender", () => {
    expect(refusePersonId("discord:")).toContain("no sender");
    expect(refusePersonId("discord: ")).toContain("no sender");
  });

  test("an empty id", () => {
    expect(refusePersonId("   ")).toContain("is empty");
  });

  test("and the forms that are accepted", () => {
    for (const id of [
      "discord:214777",
      "discord:nero:214777",
      "telegram:bot:5550001111",
      "whatsapp:main:100000000000001@lid",
      "whatsapp:628111000001@s.whatsapp.net",
      "web:dashboard:usr_1",
    ]) {
      expect({ id, refusal: refusePersonId(id) }).toEqual({ id, refusal: null });
    }
  });
});

describe("senderIsAdmin", () => {
  const roles: Record<string, string> = { usr_admin: "admin", usr_ops: "operator" };
  const roleOf = (id: string) => roles[id];
  const sender = { gatewayId: "telegram:nouva", senderId: "814" };

  test("is the person this sender is, holding an admin's account — linked either way the dashboard writes it", () => {
    for (const account of ["web:usr_admin", "web:dashboard:usr_admin"]) {
      const people: Person[] = [{ key: "gading", ids: ["telegram:814", account], name: "Gading" }];
      expect({ account, admin: senderIsAdmin(people, sender, roleOf) }).toEqual({ account, admin: true });
    }
  });

  test("is not a person with an operator's account, a person with none, or nobody at all", () => {
    expect(senderIsAdmin([{ key: "gading", ids: ["telegram:814", "web:usr_ops"], name: "Gading" }], sender, roleOf)).toBe(false);
    expect(senderIsAdmin([{ key: "gading", ids: ["telegram:814"], name: "Gading" }], sender, roleOf)).toBe(false);
    expect(senderIsAdmin([{ key: "rani", ids: ["telegram:999", "web:usr_admin"], name: "Rani" }], sender, roleOf)).toBe(false);
  });
});
