/**
 * Resolving what a Discord message points at — a reply, or a pasted link.
 *
 * The link half exists because of a watched failure on 2026-09-02. Somebody pasted
 * `discord.com/channels/…/…/3333333333333333333` with "ini masih kena?" and the agent, holding an
 * 18-digit number it could not resolve, went looking for it: grepped memory, ran `git log`, SSH'd to
 * another machine and ran `git log` there. Six steps, 44.7 seconds, no answer. The id in the fixtures
 * below is that message.
 */

import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";
import { linkedContext, parseMessageLink, referencedContext } from "../src/channels/discord/references.ts";

const LINK = "https://discord.com/channels/1212121212121212121/4444444444444444444/3333333333333333333";

/**
 * A message whose client resolves exactly one channel and one message.
 *
 * Hand-built rather than mocked from discord.js: the adapter reads six fields, and a fixture that
 * names them is a fixture that fails loudly when one is renamed.
 */
function message(over: {
  id?: string;
  reference?: { messageId: string };
  fetchReference?: () => Promise<unknown>;
  channel?: { name?: string; isTextBased?: boolean; messages?: Record<string, unknown> } | null;
  channelThrows?: boolean;
} = {}): Message {
  const channel = over.channel === null
    ? null
    : {
        // `??` would swallow an explicit `undefined`, and "a DM has no name" is a case under test.
        ...(over.channel && "name" in over.channel
          ? { name: over.channel.name }
          : { name: "memory-monitoring" }),
        isTextBased: () => over.channel?.isTextBased ?? true,
        messages: {
          fetch: async (id: string) => {
            const found = (over.channel?.messages ?? {
              "3333333333333333333": { content: "ini masih kena?", author: { username: "gading" } },
            })[id];
            if (!found) throw new Error("Unknown Message");
            return found;
          },
        },
      };

  return {
    id: over.id ?? "9999",
    ...(over.reference ? { reference: over.reference } : {}),
    ...(over.fetchReference ? { fetchReference: over.fetchReference } : {}),
    client: {
      channels: {
        fetch: async () => {
          if (over.channelThrows) throw new Error("Missing Access");
          return channel;
        },
      },
    },
  } as unknown as Message;
}

describe("parseMessageLink", () => {
  test("reads the channel and message out of a copied link", () => {
    expect(parseMessageLink(`look at ${LINK} please`)).toEqual({
      channelId: "4444444444444444444",
      messageId: "3333333333333333333",
    });
  });

  test("accepts the clients and the old domain people actually paste from", () => {
    // canary, ptb and discordapp.com all still produce working links, and all three turn up in real
    // pastes. Matching only the main domain would leave the same silent miss for a subset of users.
    for (const host of ["canary.discord.com", "ptb.discord.com", "discordapp.com"]) {
      const link = LINK.replace("discord.com", host);
      expect({ host, parsed: parseMessageLink(link) !== null }).toEqual({ host, parsed: true });
    }
  });

  test("a DM link parses — `@me` sits where a guild id would", () => {
    expect(parseMessageLink("https://discord.com/channels/@me/123/456")).toEqual({
      channelId: "123",
      messageId: "456",
    });
  });

  test("plain text and other links are not message links", () => {
    expect(parseMessageLink("no link here")).toBeNull();
    // A channel link with no message id must not resolve to a message.
    expect(parseMessageLink("https://discord.com/channels/111/222")).toBeNull();
    expect(parseMessageLink("https://example.com/channels/1/2/3")).toBeNull();
    // Every id is there or it is not a link (the 0.7.11 mutation sweep: an empty one used to be let through by nothing).
    for (const broken of ["https://discord.com/channels//2/3", "https://discord.com/channels/1//3", "https://discord.com/channels/1/2/"]) {
      expect(parseMessageLink(broken)).toBeNull();
    }
  });

  test("an http link is a link too", () => {
    expect(parseMessageLink("http://discord.com/channels/1/2/3")).toEqual({ channelId: "2", messageId: "3" });
  });
});

describe("a pasted link becomes quoted context", () => {
  test("the linked message, attributed to its author and its channel", async () => {
    // The channel name is the half a reply never needs: a linked message happened somewhere else,
    // and where it happened is what tells the agent whether it is its own business.
    expect(await linkedContext(message(), `ini masih kena? ${LINK}`)).toEqual({
      quotedText: "ini masih kena?",
      quotedSender: "gading in #memory-monitoring",
    });
  });

  test("a server nickname wins over the account name", async () => {
    const m = message({
      channel: {
        messages: {
          "3333333333333333333": {
            content: "still failing",
            author: { username: "gading" },
            member: { displayName: "Gading Nasution" },
          },
        },
      },
    });
    expect((await linkedContext(m, LINK)).quotedSender).toBe("Gading Nasution in #memory-monitoring");
  });

  test("a DM has no channel name, so the attribution stays the plain author", async () => {
    const m = message({ channel: { name: undefined } });
    expect((await linkedContext(m, LINK)).quotedSender).toBe("gading");
  });

  test("only the first link, however many are pasted", async () => {
    // Five links would be five round-trips and five quote blocks for something meant as one
    // reference. Asserted through the resolved content rather than by counting calls.
    const second = LINK.replace("3333333333333333333", "3333333333333333334");
    const m = message({
      channel: {
        messages: {
          "3333333333333333333": { content: "the first one", author: { username: "gading" } },
          "3333333333333333334": { content: "the second one", author: { username: "gading" } },
        },
      },
    });
    expect((await linkedContext(m, `${LINK} and ${second}`)).quotedText).toBe("the first one");
  });
});

describe("what it refuses to do", () => {
  test("a message linking to itself is not quoted back at itself", async () => {
    const m = message({ id: "3333333333333333333" });
    expect(await linkedContext(m, LINK)).toEqual({});
  });

  test("a channel the bot cannot see fails silently", async () => {
    // The whole point: a missing quote must never cost the person their message. Discord answers
    // `Missing Access` for a guild the bot was never invited to, which is the common case for a link
    // someone pastes from another server.
    expect(await linkedContext(message({ channelThrows: true }), LINK)).toEqual({});
  });

  test("a deleted message fails silently", async () => {
    const m = message({ channel: { messages: {} } });
    expect(await linkedContext(m, LINK)).toEqual({});
  });

  test("a voice or category channel is not readable", async () => {
    expect(await linkedContext(message({ channel: { isTextBased: false } }), LINK)).toEqual({});
  });

  test("an empty linked message adds nothing", async () => {
    // An image with no caption. Quoting "" would put an empty block above the person's words.
    const m = message({
      channel: { messages: { "3333333333333333333": { content: "   ", author: { username: "g" } } } },
    });
    expect(await linkedContext(m, LINK)).toEqual({});
  });
});

describe("a reply wins over a link", () => {
  test("because the reply is the message being aimed at", async () => {
    // A link inside a reply is usually supporting material. Two quotes above one sentence leaves the
    // model to guess which one was meant.
    const m = message({
      reference: { messageId: "42" },
      fetchReference: async () => ({ content: "the replied-to one", author: { username: "nadia" } }),
    });
    expect(await referencedContext(m, `see also ${LINK}`)).toEqual({
      quotedText: "the replied-to one",
      quotedSender: "nadia",
    });
  });

  test("but a reply that cannot be fetched falls through to the link", async () => {
    const m = message({
      reference: { messageId: "42" },
      fetchReference: async () => {
        throw new Error("Unknown Message");
      },
    });
    expect((await referencedContext(m, LINK)).quotedText).toBe("ini masih kena?");
  });

  test("no reply and no link is no quote", async () => {
    expect(await referencedContext(message(), "just a sentence")).toEqual({});
  });

  test("a message that is not a reply never asks for what it replies to", async () => {
    let asked = false;
    const m = message({
      fetchReference: async () => {
        asked = true;
        return { content: "x", author: { username: "x" } };
      },
    });
    expect(await referencedContext(m, "just a sentence")).toEqual({});
    expect(asked).toBe(false);
  });

  test("a reply is quoted trimmed, and one of only blanks falls through to the link", async () => {
    const padded = message({ reference: { messageId: "42" }, fetchReference: async () => ({ content: "  hi  ", author: { username: "nadia" } }) });
    expect((await referencedContext(padded, LINK)).quotedText).toBe("hi");
    const blank = message({ reference: { messageId: "42" }, fetchReference: async () => ({ content: "   ", author: { username: "nadia" } }) });
    expect((await referencedContext(blank, LINK)).quotedText).toBe("ini masih kena?");
  });
});
