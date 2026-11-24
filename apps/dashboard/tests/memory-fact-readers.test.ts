/**
 * Who reads a fact, as a person's profile says it on the Memory page. A fact said in a direct chat is its person's:
 * read wherever they are the one asking, a group included, unless they kept it to their direct chats or the install
 * keeps private things out of groups. The page said "Only where" its person "is" of all of them.
 */

import { describe, expect, test } from "bun:test";
import { factsOf, readersLabel } from "../src/modules/memories/facts";

const PROFILE = [
  "---",
  "type: person",
  "name: Gading",
  "---",
  "",
  "## Vehicles",
  "- Has a Honda BR-V. ([[2026-09-25-0900-nouva]]) {gading}",
  "- Is planning a surprise. {gading, direct only}",
  "- Drives the family on Fridays. {gading, sam, in whatsapp:main:1203@g.us}",
  "- Likes his coffee black.",
].join("\n");

const nameOf = (key: string) => ({ gading: "Gading", sam: "Kak Sam" })[key] ?? key;

describe("a profile's fact lines", () => {
  test("the mark for direct chats is read as the mark, never as a person", () => {
    expect(factsOf(PROFILE).map((fact) => fact.readers)).toEqual([
      { people: ["gading"] },
      { people: ["gading"], direct: true },
      { people: ["gading", "sam"], chat: "whatsapp:main:1203@g.us" },
      undefined,
    ]);
  });

  test("each says who reads it, by where it was said and how the install is set", () => {
    const [own, kept, group, hand] = factsOf(PROFILE);
    expect(readersLabel(own!, nameOf)).toBe("Wherever Gading is the one asking");
    expect(readersLabel(own!, nameOf, false)).toBe("Only in direct chats with Gading");
    expect(readersLabel(kept!, nameOf)).toBe("Kept to direct chats with Gading");
    expect(readersLabel(kept!, nameOf, false)).toBe("Kept to direct chats with Gading");
    expect(readersLabel(group!, nameOf)).toBe("Said in a group with Gading, Kak Sam");
    expect(readersLabel(hand!, nameOf)).toBe("Written by hand");
  });
});
