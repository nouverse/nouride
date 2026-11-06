/**
 * The knowledge base in everyday words (0.8.20): a collection's settings said as sentences, a document's state as one of
 * three, and what the orchestrator is asked when a program must be installed first. The people who use the dashboard are
 * not technical, so these are asserted word for word.
 */

import { describe, expect, test } from "bun:test";
import { readersOf } from "@/modules/memories/knowledge/collection-form";
import { addedLine } from "@/modules/memories/knowledge/uploads";
import { aboutLine, agentsLine, countsLine, groupKey, installMessage, listed, pagesLine, readersLine, statusOf, type Names } from "@/modules/memories/knowledge/words";

const NAMES: Names = {
  person: (key) => ({ gading: "Gading", sam: "Kak Sam", raka: "Raka" })[key] ?? key,
  group: (chat) => (chat === "telegram:main:-100200" ? "Rumah" : undefined),
  me: "gading",
};

describe("who may be answered from a collection", () => {
  test("anyone, a group by its name, the admins, you, or the people it names, each in a chat with just them", () => {
    expect(readersLine({ kind: "everyone" }, NAMES)).toBe("Your agents may answer anyone from it.");
    expect(readersLine({ kind: "group", chat: "telegram:main:-100200" }, NAMES)).toBe("Your agents may answer the Rumah group from it.");
    expect(readersLine({ kind: "group", chat: "discord:x:1" }, NAMES)).toBe("Your agents may answer one group chat from it.");
    expect(readersLine({ kind: "admins" }, NAMES)).toBe("Your agents may answer only the admins from it, each in a chat with just them.");
    expect(readersLine({ kind: "people", people: ["gading"] }, NAMES)).toBe("Your agents may answer only you from it, in a chat with just you.");
    expect(readersLine({ kind: "people", people: ["sam"] }, NAMES)).toBe("Your agents may answer only Kak Sam from it, in a chat with just them.");
    expect(readersLine({ kind: "people", people: ["gading", "sam", "raka"] }, NAMES)).toBe("Your agents may answer only you, Kak Sam and Raka from it, each in a chat with just them.");
  });

  test("a group is named by memory's key for its chat: the connection, then the chat", () => {
    expect(groupKey("telegram:main", "-100200")).toBe("telegram:main:-100200");
  });

  test("the form sends who may be answered only when it is not the maker: theirs is the daemon's to fill in", () => {
    const picked = { group: "telegram:main:-100200", people: ["sam"], me: "gading" };
    expect(readersOf("me", picked, true)).toBeNull();
    expect(readersOf("me", picked, false)).toEqual({ kind: "people", people: ["gading"] });
    expect(readersOf("everyone", picked, true)).toEqual({ kind: "everyone" });
    expect(readersOf("group", picked, true)).toEqual({ kind: "group", chat: "telegram:main:-100200" });
    expect(readersOf("people", picked, true)).toEqual({ kind: "people", people: ["sam"] });
  });
});

describe("the rest of a collection, said", () => {
  test("which agents look in it, whom it is about, and how much it holds", () => {
    const agent = (id: string) => ({ nouva: "Nouva", nix: "Nix" })[id] ?? id;
    expect(agentsLine(null, agent)).toBe("Every agent looks in it.");
    expect(agentsLine(["nouva"], agent)).toBe("Only Nouva looks in it.");
    expect(agentsLine(["nouva", "nix"], agent)).toBe("Only Nouva and Nix look in it.");
    expect(agentsLine([], agent)).toBe("No agent looks in it.");
    expect(aboutLine([], NAMES)).toBeNull();
    expect(aboutLine(["sam", "gading"], NAMES)).toBe("About Kak Sam and you.");
    expect(countsLine(1, 1)).toBe("1 document · 1 section");
    expect(countsLine(12, 1340)).toBe("12 documents · 1,340 sections");
    expect(listed(["a", "b", "c", "d"])).toBe("a, b, c and d");
  });
});

describe("a document, said", () => {
  test("ready, could not be read, or on its way in", () => {
    expect(statusOf({ status: "indexed" })).toEqual({ label: "Ready", tone: "ready" });
    expect(statusOf({ status: "unreadable" })).toEqual({ label: "Could not be read", tone: "not-read" });
    expect(statusOf({ status: "listed" })).toEqual({ label: "Kept, not searched", tone: "not-read" });
    expect(statusOf({ status: "reading" as never })).toEqual({ label: "Being read", tone: "reading" });
  });

  test("its pages, where it has them", () => {
    expect(pagesLine({})).toBeNull();
    expect(pagesLine({ pageFrom: 3 })).toBe("Page 3");
    expect(pagesLine({ pageFrom: 3, pageTo: 3 })).toBe("Page 3");
    expect(pagesLine({ pageFrom: 3, pageTo: 5 })).toBe("Pages 3 to 5");
  });

  test("the orchestrator is asked to install the package by its name, for the document by its title", () => {
    expect(installMessage("poppler-utils", "Lab results", "Mum's health")).toBe('Please install the poppler-utils package, so the knowledge base can read "Lab results" in Mum\'s health.');
  });

  test("what an upload says: how many went in, and how many could not be read", () => {
    expect(addedLine("House", [{ status: "indexed" }])).toEqual({ title: "Added to House" });
    expect(addedLine("House", [{ status: "listed" }])).toEqual({ title: "Added to House", detail: "It could not be read: open the collection to see why." });
    expect(addedLine("House", [{ status: "indexed" }, { status: "unreadable" }])).toEqual({ title: "2 documents added to House", detail: "1 could not be read: open the collection to see why." });
  });
});
