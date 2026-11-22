/**
 * What a chat is called on the dashboard (`commons/lib/chats.ts`): by who is in it or by its name, never by an id.
 */

import { expect, test } from "bun:test";
import { chatLabel } from "@/commons/lib/chats";

test("a one-to-one is said with whom, a group by its name or by who is in it", () => {
  expect(chatLabel({ kind: "dm", people: ["Gading"] })).toBe("DM · Gading");
  expect(chatLabel({ kind: "group", title: "Nouride", people: ["Gading", "Sam"] })).toBe("Group · Nouride");
  expect(chatLabel({ kind: "group", people: ["Gading", "Sam", "Raka", "Budi"] })).toBe("Group with Gading, Sam, Raka");
  expect(chatLabel({ kind: "group", people: [] })).toBe("Group");
});

test("somebody the install has no name for is sent as the id they write from: said as someone, never as the number", () => {
  // A Discord account, a phone number, a Telegram id: each is what the label is there not to show.
  for (const id of ["1200000000000000042", "+62 811-0000-0000", "5550001111", "-1005550002", " "]) {
    expect({ id, label: chatLabel({ kind: "dm", people: [id] }) }).toEqual({ id, label: "DM · someone" });
  }
  expect(chatLabel({ kind: "dm", people: [] })).toBe("DM · someone");
  // The first of them with a name is who a one-to-one is with; in a group the numbers are left out.
  expect(chatLabel({ kind: "dm", people: ["5550001111", "Gading"] })).toBe("DM · Gading");
  expect(chatLabel({ kind: "group", people: ["5550001111", "Sam"] })).toBe("Group with Sam");
  expect(chatLabel({ kind: "group", people: ["5550001111"] })).toBe("Group");
  // A name with a number in it is a name.
  expect(chatLabel({ kind: "dm", people: ["Agent 47"] })).toBe("DM · Agent 47");
});
