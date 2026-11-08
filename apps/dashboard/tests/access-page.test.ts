/**
 * The Access page's address and its clock: the tab and agent an agent's own Access tab links to, and
 * the "asked 3 min ago · may ask again in 23 h" every row is read by.
 */

import { describe, expect, test } from "bun:test";
import { parseAccessSearch } from "@/modules/access/search";
import { byWhom } from "@/modules/access/sender-line";
import { ago, inTime } from "@/commons/lib/format";
import { personFor } from "@/modules/access/approved.tab";
import { platformName } from "@/commons/lib/platform";
import type { PersonRecord } from "@nouride/wire";

describe("parseAccessSearch", () => {
  test("reads the tab and the agent an agent's Access tab links with", () => {
    expect(parseAccessSearch({ tab: "blocked", agent: "nouva" })).toEqual({ tab: "blocked", agent: "nouva" });
    // Denied and Blocked are two answers, so two tabs.
    expect(parseAccessSearch({ tab: "denied" })).toEqual({ tab: "denied" });
  });

  test("drops what it does not know, so an old or hand-typed link still opens the page", () => {
    expect(parseAccessSearch({ tab: "kept-out", agent: " ", colour: "red" })).toEqual({});
    expect(parseAccessSearch({ agent: 3 })).toEqual({});
  });
});

describe("the clock on a row", () => {
  const now = 1_000_000_000;

  test("how long ago, the way a person says it", () => {
    expect(ago(now - 20_000, now)).toBe("just now");
    expect(ago(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(ago(now - 5 * 3_600_000, now)).toBe("5 h ago");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2 days ago");
  });

  test("how long until — a denial's day, counted down", () => {
    expect(inTime(now + 86_400_000 - 30_000, now)).toBe("in 24 h");
    expect(inTime(now + 40 * 60_000, now)).toBe("in 40 min");
    expect(inTime(now - 1, now)).toBe("in less than a minute");
  });

  test("who answered: a dashboard user by name, the control token as the CLI", () => {
    expect(byWhom("gading")).toBe(" by gading");
    expect(byWhom("cli")).toBe(" by the server itself");
    expect(byWhom(undefined)).toBe("");
  });
});

describe("which person an account is", () => {
  // As the daemon decides it, so the name on the Access page is the name the agents know them by. Access
  // itself stays per connection — that is which bot lets somebody in; this is only who they are.
  // Typed, so a fixture that drifts from the wire shape fails `lint:types` — these said `id` for a release after
  // people moved to `key`, and passed only because `personFor` reads `name` and `ids`.
  const people: PersonRecord[] = [
    { key: "p1", name: "Alex", ids: ["telegram:5550003333", "discord:7770001"] },
    { key: "p2", name: "Sam", ids: ["whatsapp:15550001111@s.whatsapp.net"] },
    { key: "p3", name: "Bare", ids: ["4440004444"] },
  ];

  test("a platform-wide id names them on every connection of that platform", () => {
    expect(personFor("telegram:nouva", "5550003333", people)).toBe("Alex");
    expect(personFor("telegram:nero", "5550003333", people)).toBe("Alex");
  });

  test("an account names them on every connection of its platform — who is not where", () => {
    expect(personFor("discord:nero", "7770001", people)).toBe("Alex");
    expect(personFor("discord:nix", "7770001", people)).toBe("Alex");
    expect(personFor("whatsapp:nouva", "15550001111@s.whatsapp.net", people)).toBe("Sam");
    expect(personFor("whatsapp:nero", "15550001111@s.whatsapp.net", people)).toBe("Sam");
  });

  test("another platform's id is somebody else, and a bare id is nobody", () => {
    expect(personFor("discord:nouva", "5550003333", people)).toBeUndefined();
    expect(personFor("telegram:nouva", "4440004444", people)).toBeUndefined();
  });
});

describe("the platform on a row", () => {
  test("is the prefix, as people write it", () => {
    expect(platformName("telegram:nouva")).toBe("Telegram");
    expect(platformName("whatsapp:628111000001@s.whatsapp.net")).toBe("WhatsApp");
    expect(platformName("discord:nero")).toBe("Discord");
    expect(platformName("web:usr_1")).toBe("Web");
    expect(platformName("matrix:main")).toBe("matrix");
  });
});
