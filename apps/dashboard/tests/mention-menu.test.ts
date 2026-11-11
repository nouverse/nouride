/**
 * The mention menu's three pure pieces: what is being typed, who matches, and what the box becomes.
 *
 * Tested rather than eyeballed because each of them was wrong at least once in a way that is
 * invisible until somebody's message reaches nobody — a tag that does not match is not an error, it
 * is silence.
 */

import { describe, expect, test } from "bun:test";
import { applyMention, matchMentions, mentionToken, orderMentions } from "../src/commons/components/chat/MentionMenu.tsx";
import type { Room } from "@nouride/wire";

const room = (ids: string[]): Room => ({
  gatewayId: "web:dashboard",
  chatId: "r1",
  createdAt: 0,
  members: ids.map((agentId) => ({ agentId, addedAt: 0 })),
});

const candidates = [
  { agentId: "nouva", displayName: "Nouva" },
  { agentId: "nero", displayName: "Nero" },
  { agentId: "nexa", displayName: "Nexa" },
];

describe("what is being typed", () => {
  test("an @ at the end of the box, however much follows it", () => {
    expect(mentionToken("@")).toBe("");
    expect(mentionToken("@ner")).toBe("ner");
    // Not anchored to the start: "tolong cek ini @nero" is how people write.
    expect(mentionToken("tolong cek ini @ner")).toBe("ner");
  });

  test("nothing once the tag is finished", () => {
    // The trailing space is what closes the menu, which is why `applyMention` adds one.
    expect(mentionToken("@nero ")).toBeNull();
    expect(mentionToken("halo")).toBeNull();
    expect(mentionToken("")).toBeNull();
  });

  test("an email is not a mention", () => {
    // `@` bound to the preceding character is somebody's address, not a tag. Offering the menu there
    // would put a room's agent list under every email anybody pastes.
    expect(mentionToken("gading@nouverse")).toBeNull();
  });
});

describe("who matches", () => {
  test("only members of this room", () => {
    // Nexa is a real agent and not in this room. Offering it would offer a tag that reaches nobody —
    // the router narrows on the membership list too.
    const out = matchMentions(room(["nouva", "nero"]), candidates, "");
    expect(out.map((c) => c.agentId)).toEqual(["nouva", "nero"]);
  });

  test("by id or by display name, case-insensitively", () => {
    expect(matchMentions(room(["nouva", "nero"]), candidates, "ne").map((c) => c.agentId)).toEqual([
      "nero",
    ]);
    expect(matchMentions(room(["nouva", "nero"]), candidates, "NOU").map((c) => c.agentId)).toEqual([
      "nouva",
    ]);
  });
});

describe("what the box becomes", () => {
  test("the half-typed token is replaced and a space follows it", () => {
    // Without the space the next keystroke extends the mention — `@nero` becomes `@nerotolong` — and
    // the router then matches nothing, which is the failure the menu exists to prevent.
    expect(applyMention("halo @ner", "nero")).toBe("halo @nero ");
    expect(applyMention("@", "nouva")).toBe("@nouva ");
  });

  test("only the token at the end, leaving an earlier tag alone", () => {
    // Two agents in one message is a thing now, so completing the second must not rewrite the first.
    expect(applyMention("@nouva @ner", "nero")).toBe("@nouva @nero ");
  });
});

describe("an agent already named in the message", () => {
  test("is not offered again", () => {
    /**
     * Tagging somebody twice is not a thing anybody means — the router matches a name once, and the
     * second `@nouva` is dead text that only makes the message harder to read. The menu kept
     * offering an agent that was already in the box, so picking twice produced `@nouva @nouva @`,
     * with the menu doing the suggesting.
     */
    const out = matchMentions(room(["nouva", "nero"]), candidates, "", "mantap @nouva @");

    expect(out.map((c) => c.agentId)).toEqual(["nero"]);
  });

  test("the half-typed tag at the end does not count as named", () => {
    // `@no` is not yet an address, so the thing being completed must stay in the list.
    const out = matchMentions(room(["nouva", "nero"]), candidates, "no", "halo @no");

    expect(out.map((c) => c.agentId)).toEqual(["nouva"]);
  });

  test("a display name counts as naming them too", () => {
    // The router matches either, so the menu has to exclude on either.
    const out = matchMentions(room(["nouva", "nero"]), candidates, "", "halo @Nero ");

    expect(out.map((c) => c.agentId)).toEqual(["nouva"]);
  });
});

describe("an agent that is mid-turn", () => {
  test("sorts to the bottom rather than disappearing", () => {
    /**
     * Shown, not hidden. A name that vanishes from the list looks like an agent that left the room,
     * and the useful thing to say is "not yet" — it answers again the moment it finishes.
     *
     * Bottom rather than in place because the highlight sits on the first row and that is the row
     * Enter aims at. An unpickable row there would make the menu's most common keystroke do nothing.
     */
    const out = orderMentions([
      { agentId: "nouva", displayName: "Nouva", busy: true },
      { agentId: "nero", displayName: "Nero" },
      { agentId: "nox", displayName: "Nox", busy: true },
    ]);

    expect(out.map((c) => c.agentId)).toEqual(["nero", "nouva", "nox"]);
  });

  test("order is otherwise left alone", () => {
    // The caller already sorted by something meaningful — the room's own member order — and this only
    // moves the ones that cannot be picked.
    const out = orderMentions([
      { agentId: "nouva", displayName: "Nouva" },
      { agentId: "nero", displayName: "Nero" },
    ]);

    expect(out.map((c) => c.agentId)).toEqual(["nouva", "nero"]);
  });
});
