/**
 * A tag is how you address a bot in a channel, so a tag has to be able to carry a command.
 *
 * Discord sends a mention as `<@id>`, and the engine recognises a command only from text that starts
 * with `/` — its queue decides urgency the same way. Leaving the tag in place therefore broke the one
 * thing that has to work while a turn is blocked: `<@Nouva> /approve` was not a command and was not
 * urgent, so it queued behind the very turn waiting to be approved and neither could move until the
 * approval timed out.
 */

import { describe, expect, test } from "bun:test";
import {
  stripLeadingSelfMention,
  tagsUser,
  worthDelivering,
  writtenMentions,
} from "../src/channels/discord/envelope.ts";

const SELF = "8888888888888888888";
const OTHER = "1111111111111111111";

describe("stripLeadingSelfMention", () => {
  test("a leading tag of ourselves comes off, leaving a usable command", () => {
    expect(stripLeadingSelfMention(`<@${SELF}> /approve`, SELF)).toBe(" /approve");
    // Trimmed by the caller, which is what makes it parse.
    expect(stripLeadingSelfMention(`<@${SELF}> /approve`, SELF).trim()).toBe("/approve");
  });

  test("the nickname form is the same mention", () => {
    // Discord has sent both `<@id>` and `<@!id>`; matching one leaves the other in place.
    expect(stripLeadingSelfMention(`<@!${SELF}> /auto on`, SELF).trim()).toBe("/auto on");
  });

  test("several of our own tags in a row all come off", () => {
    expect(stripLeadingSelfMention(`<@${SELF}> <@!${SELF}> hidup?`, SELF).trim()).toBe("hidup?");
  });

  test("a tag naming somebody else stays", () => {
    // Information the agent needs: it is being asked to involve another agent or person.
    const text = `<@${OTHER}> tolong cek ini`;
    expect(stripLeadingSelfMention(text, SELF)).toBe(text);
  });

  test("our tag in the middle stays — it is part of what was written", () => {
    const text = `tolong tanya <@${SELF}> soal ini`;
    expect(stripLeadingSelfMention(text, SELF)).toBe(text);
  });

  test("a leading tag of somebody else is not stripped, even before ours", () => {
    // Order matters to the reader, and removing a name that is not ours would change the meaning.
    const text = `<@${OTHER}> <@${SELF}> gimana?`;
    expect(stripLeadingSelfMention(text, SELF)).toBe(text);
  });

  test("no self id — before the client is ready — changes nothing", () => {
    const text = `<@${SELF}> /approve`;
    expect(stripLeadingSelfMention(text, undefined)).toBe(text);
  });

  test("plain text is untouched", () => {
    expect(stripLeadingSelfMention("nouva: /approve", SELF)).toBe("nouva: /approve");
    expect(stripLeadingSelfMention("", SELF)).toBe("");
  });
});

/**
 * A ping that rides on a reply is not an address.
 *
 * The live failure: two agents replying to each other, each reply pinging the other because we send
 * `repliedUser: true`, each ping read as a mention, eleven turns of it before the hop budget stopped
 * them — and the notice announcing the budget was a reply too, so it pinged back and started another.
 */
describe("tagsUser", () => {
  test("a tag written in the text is an address", () => {
    expect(tagsUser(`<@${OTHER}> tolong cek ini`, OTHER)).toBe(true);
    expect(tagsUser(`tolong tanya <@${OTHER}> soal ini`, OTHER)).toBe(true);
    // The nickname spelling is the same tag, as everywhere else here.
    expect(tagsUser(`<@!${OTHER}> cek`, OTHER)).toBe(true);
  });

  test("a reply with no tag in it addresses nobody", () => {
    // What Discord attaches to a reply is not in the content, and the content is what someone wrote.
    // This is the ping-pong, in one line.
    expect(tagsUser("Pengujian unit test sudah selesai dan 100% pass.", OTHER)).toBe(false);
    expect(
      tagsUser("(nox and I have gone back and forth 10 times, so I am leaving it there.)", OTHER),
    ).toBe(false);
  });

  test("a tag naming somebody else is not a tag of ours", () => {
    expect(tagsUser(`<@${OTHER}> gimana?`, SELF)).toBe(false);
  });

  test("an id that is not a snowflake never matches", () => {
    // It is interpolated into a pattern; `.*` in that position would match every message.
    expect(tagsUser(`<@${SELF}> hi`, ".*")).toBe(false);
    expect(tagsUser(`<@${SELF}> hi`, "")).toBe(false);
  });
});

describe("writtenMentions", () => {
  const NOX = { id: OTHER, username: "Nox | Security Agent" };
  const ME = { id: SELF, username: "Nero | Infra Agent" };

  test("a written tag is reported, by name and by id", () => {
    expect(writtenMentions({ content: `<@${OTHER}> tolong audit`, users: [NOX], selfId: SELF })).toEqual({
      mentions: ["Nox | Security Agent", OTHER],
      mentionsSelf: false,
    });
  });

  test("being tagged ourselves is an address", () => {
    const result = writtenMentions({ content: `<@${SELF}> gimana?`, users: [ME], selfId: SELF });
    expect(result.mentionsSelf).toBe(true);
  });

  test("the reply ping Discord attaches is not an address", () => {
    // The incident, exactly: Nero replies to Nox's message with no tag in it. Discord attaches Nox to
    // `mentions.users` because we send `repliedUser: true`, and read as an address that wakes Nox,
    // whose reply pings Nero, and neither stops until the hop budget does.
    expect(
      writtenMentions({
        content: "Pengujian unit test sudah selesai dan 100% pass.",
        users: [NOX],
        selfId: OTHER,
      }),
    ).toEqual({ mentions: [], mentionsSelf: false });
  });

  test("the notice that ends a runaway chain does not start another one", () => {
    // It goes out as a reply too, so before this it pinged back and bought one more turn on each side.
    expect(
      writtenMentions({
        content: "(nox and I have gone back and forth 10 times, so I am leaving it there.)",
        users: [NOX],
        selfId: OTHER,
      }).mentionsSelf,
    ).toBe(false);
  });

  test("a tag written alongside a reply ping still counts", () => {
    // A handover that also happens to be a reply is a handover. Only the unwritten half is dropped.
    expect(
      writtenMentions({ content: `<@${OTHER}> lanjut ya`, users: [NOX, ME], selfId: OTHER }),
    ).toEqual({ mentions: ["Nox | Security Agent", OTHER], mentionsSelf: true });
  });
});

/**
 * A tag with no words behind it.
 *
 * Live, on Discord, twice: tagging an agent and typing nothing did nothing at all. `<@self>` is
 * stripped off the front so the model does not read its own name as every message's first token — and
 * the message that was *only* that tag became an empty string and was dropped as "nothing was said".
 */
describe("worthDelivering", () => {
  test("a tag with nothing behind it is still a message", () => {
    // The regression. `@Nouva` alone is how a person points at the line above, and it is the most
    // common way anyone addresses a bot in a busy channel.
    expect(worthDelivering({ text: "", attachmentCount: 0, mentionsSelf: true })).toBe(true);
  });

  test("whitespace left behind by the stripped tag counts as nothing said", () => {
    // `stripLeadingSelfMention` leaves the space that followed the tag, so the check cannot be a
    // plain truthiness test on the string.
    expect(worthDelivering({ text: "   ", attachmentCount: 0, mentionsSelf: true })).toBe(true);
    expect(worthDelivering({ text: "   ", attachmentCount: 0, mentionsSelf: false })).toBe(false);
  });

  test("an empty message nobody addressed to us is still dropped", () => {
    // The rule the bare tag is an exception to, and it has to survive the exception: a sticker, a
    // join event, an embed-only post is not a turn.
    expect(worthDelivering({ text: "", attachmentCount: 0, mentionsSelf: false })).toBe(false);
  });

  test("an attachment with no caption is a message, tagged or not", () => {
    // Dropping it made the bot look like it ignored the sender — no reply and no error.
    expect(worthDelivering({ text: "", attachmentCount: 1, mentionsSelf: false })).toBe(true);
    expect(worthDelivering({ text: "", attachmentCount: 1, mentionsSelf: true })).toBe(true);
  });

  test("ordinary text is delivered without needing a tag", () => {
    expect(worthDelivering({ text: "hidup?", attachmentCount: 0, mentionsSelf: false })).toBe(true);
  });
});
