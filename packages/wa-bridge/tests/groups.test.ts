/**
 * The groups a number is in (`groups.ts`): what the daemon routes a group's message by when it holds two numbers.
 * Fetched whole once linked, kept by the joins and leaves WhatsApp reports, and unknown until fetched.
 */

import { describe, expect, test } from "bun:test";
import { aboutSelf, Membership } from "../src/groups.ts";

const SELF = ["628111000111@s.whatsapp.net", "99887766@lid"];

describe("a change to a group's people is about this number", () => {
  test("by its phone address or its hidden one, with or without a device, as a contact or a bare address", () => {
    expect(aboutSelf(["628111000111:12@s.whatsapp.net"], SELF)).toBe(true);
    expect(aboutSelf([{ id: "99887766@lid" }], SELF)).toBe(true);
    expect(aboutSelf([{ id: "55555@lid", phoneNumber: "628111000111@s.whatsapp.net" }], SELF)).toBe(true);
    expect(aboutSelf([{ id: "55555@lid", lid: "99887766:3@lid" }], SELF)).toBe(true);
  });

  test("and not when only others are named, nor when the number's own address is not known", () => {
    expect(aboutSelf(["628222000222@s.whatsapp.net", { id: "12345@lid" }], SELF)).toBe(false);
    expect(aboutSelf(["628111000111@s.whatsapp.net"], [])).toBe(false);
    // The same digits on the other kind of address are another account.
    expect(aboutSelf(["99887766@s.whatsapp.net"], SELF)).toBe(false);
  });
});

describe("the groups, as the daemon is told them", () => {
  test("nothing is said before they are fetched, and a join before then adds to nothing", () => {
    const told: string[][] = [];
    const groups = new Membership((ids) => told.push(ids));
    groups.joined(["g9@g.us"]);
    groups.left("g9@g.us");
    expect(told).toEqual([]);
  });

  test("fetched, then each join and leave says the whole set, in order; a change that changes nothing says nothing", () => {
    const told: string[][] = [];
    const groups = new Membership((ids) => told.push(ids));
    groups.fetched(["g2@g.us", "g1@g.us"]);
    groups.joined(["g3@g.us"]);
    groups.joined(["g3@g.us"]);
    groups.left("g1@g.us");
    groups.left("g1@g.us");
    expect(told).toEqual([["g1@g.us", "g2@g.us"], ["g1@g.us", "g2@g.us", "g3@g.us"], ["g2@g.us", "g3@g.us"]]);
  });
});
