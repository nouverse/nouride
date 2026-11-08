/**
 * The room buffer, on its own.
 *
 * `pipeline.test.ts` covers whether the thing is wired up at all — chatter in a channel, a mention,
 * and the block reaching the provider. These are the cases that are awkward to drive through a whole
 * pipeline and easy to get wrong: what counts as a duplicate, which room a message belongs to, and
 * every exclusion that exists to stop the model seeing the same line twice.
 */

import { describe, expect, test } from "bun:test";
import {
  formatOverheard,
  GroupContext,
  lastAddressedAt,
  resolveGroupContextLimit,
  type OverheardMessage,
} from "@/modules/sessions/group-context.ts";
import { envelope } from "../helpers.ts";

/** A group message, since the fixture's default is a DM. */
function said(
  overrides: { id: string; text: string; at?: number } & Record<string, unknown>,
): ReturnType<typeof envelope> {
  const { id, text, at, ...rest } = overrides;
  return envelope({
    id,
    text,
    chatType: "group",
    timestamp: at ?? 1_000,
    ...rest,
  });
}

/** `since` with the parts a test rarely varies filled in. */
function replay(
  context: GroupContext,
  overrides: Partial<Parameters<GroupContext["since"]>[0]> = {},
) {
  return context.since({
    gateway: "telegram",
    chatId: "chat-1",
    after: 0,
    before: 9_000,
    carried: [],
    limit: 20,
    excludeAgent: "nouva",
    ...overrides,
  });
}

describe("what the room remembers", () => {
  test("holds what nobody was addressed in, oldest first", () => {
    const context = new GroupContext();
    context.record(said({ id: "a", text: "udah pesen tiket?", at: 1_000, senderName: "Jordan" }), 20);
    context.record(said({ id: "b", text: "belum", at: 2_000, senderName: "Ani" }), 20);

    expect(replay(context).map((message) => `${message.senderName}: ${message.text}`)).toEqual([
      "Jordan: udah pesen tiket?",
      "Ani: belum",
    ]);
  });

  test("stores one copy of a message handed to every bot in the room", () => {
    // Six agents in one Discord channel means six connections, and the platform delivers each message
    // to all of them within milliseconds. Counted once per delivery, twenty messages of chatter would
    // fill the window with three real messages repeated six times.
    const context = new GroupContext();
    const first = context.record(said({ id: "same", text: "hai" }), 20);
    const second = context.record(said({ id: "same", text: "hai", gatewayId: "telegram:second" }), 20);
    const third = context.record(said({ id: "same", text: "hai", gatewayId: "telegram:third" }), 20);

    expect([first, second, third]).toEqual([true, false, false]);
    expect(replay(context)).toHaveLength(1);
  });

  test("stores one copy in a Telegram basic group, where each bot numbers the message differently", () => {
    const context = new GroupContext();
    const copy = { text: "hai", senderName: "Jordan", idsPerConnection: true };
    const first = context.record(said({ ...copy, id: "57" }), 20);
    const second = context.record(said({ ...copy, id: "102", gatewayId: "telegram:second" }), 20);
    // The same words a second later are a second message, not a copy.
    const again = context.record(said({ ...copy, id: "58", at: 2_000 }), 20);

    expect([first, second, again]).toEqual([true, false, true]);
    expect(replay(context)).toHaveLength(2);
  });

  test("keys on the room, not the connection that delivered the message", () => {
    // Two bots in one channel are two connections onto one conversation. Keyed by `gatewayId`, each
    // agent would overhear only the deliveries its own bot received — which on a platform that fans
    // out to every bot is arbitrary, and on one that does not is nothing.
    const context = new GroupContext();
    context.record(said({ id: "a", text: "from bot one", gatewayId: "telegram:main" }), 20);
    context.record(said({ id: "b", text: "from bot two", gatewayId: "telegram:second" }), 20);

    expect(replay(context)).toHaveLength(2);
  });

  test("a different platform is a different room, even on the same chat id", () => {
    // A Telegram chat id and a Discord snowflake are both opaque strings and can collide.
    const context = new GroupContext();
    context.record(said({ id: "a", text: "on telegram", gateway: "telegram" }), 20);
    context.record(said({ id: "b", text: "on discord", gateway: "discord" }), 20);

    expect(replay(context, { gateway: "telegram" }).map((m) => m.text)).toEqual(["on telegram"]);
    expect(replay(context, { gateway: "discord" }).map((m) => m.text)).toEqual(["on discord"]);
  });

  test("replays the newest, and only as many as the window", () => {
    const context = new GroupContext();
    for (let index = 0; index < 8; index += 1) {
      context.record(said({ id: `m${index}`, text: `line ${index}`, at: 1_000 + index }), 3);
    }

    expect(replay(context, { limit: 3 }).map((message) => message.text)).toEqual([
      "line 5",
      "line 6",
      "line 7",
    ]);
  });

  test("it holds headroom, so the tag itself does not cost a line of context", () => {
    // The message that tags the agent is a message in the room like any other, and `since` excludes
    // it as the turn's own question. Sized exactly to the window, the buffer spent one slot on the
    // tag: a window of 20 replayed 19, and a window of 2 replayed 1.
    const context = new GroupContext();
    for (let index = 0; index < 4; index += 1) {
      context.record(said({ id: `m${index}`, text: `line ${index}`, at: 1_000 + index }), 2);
    }
    context.record(said({ id: "tag", text: "@nouva ini", at: 1_004 }), 2);

    const replayed = replay(context, { before: 1_004, carried: ["@nouva ini"], limit: 2 });
    expect(replayed.map((message) => message.text)).toEqual(["line 2", "line 3"]);
  });

  test("a lowered setting stops holding the surplus on the next message", () => {
    // The dashboard writes into the live config, so a value saved there is read on the very next
    // message. A buffer sized once at construction would go on holding the old window for the life of
    // the process.
    const context = new GroupContext();
    for (let index = 0; index < 40; index += 1) {
      context.record(said({ id: `m${index}`, text: `line ${index}`, at: 1_000 + index }), 20);
    }
    context.record(said({ id: "last", text: "line 40", at: 1_040 }), 2);

    // Replayed with a window far larger than anything configured, so what comes back is what the
    // buffer actually still holds rather than what `since` would have sliced anyway.
    const held = replay(context, { limit: 100 }).map((message) => message.text);
    expect(held.length).toBeLessThanOrEqual(4);
    expect(held.at(-1)).toBe("line 40");
  });

  test("nothing is kept when the window is off", () => {
    // Off has to mean off: a buffer that fills up while the setting is 0 is a record of a room the
    // operator asked the daemon not to keep.
    const context = new GroupContext();
    context.record(said({ id: "a", text: "hai" }), 0);

    expect(replay(context)).toEqual([]);
    expect(context.size()).toBe(0);
  });

  test("a message with no text of its own is not a line", () => {
    // A sticker, a join event, an image whose caption was empty. The envelope reaches the pipeline
    // because the attachment matters; a blank line in the block does not.
    const context = new GroupContext();
    expect(context.record(said({ id: "a", text: "   " }), 20)).toBe(false);
    expect(replay(context)).toEqual([]);
  });

  test("a message held here and edited says what it says now — and only that message, in that room (G11)", () => {
    const context = new GroupContext();
    context.record(said({ id: "a", text: "lunch at 12?", at: 1_000 }), 20);
    context.record(said({ id: "b", text: "sure", at: 2_000 }), 20);
    context.record(said({ id: "a", text: "elsewhere", chatId: "chat-2", at: 1_500 }), 20);

    expect(context.revise("telegram", "chat-1", "a", "lunch at 1?\nmy bad")).toBe(true);
    expect(replay(context).map((message) => message.text)).toEqual(["lunch at 1? my bad", "sure"]);
    expect(replay(context, { chatId: "chat-2" }).map((message) => message.text)).toEqual(["elsewhere"]);
    // Not held — gone from the window, or never heard — and an edit that leaves no words: nothing changes.
    expect(context.revise("telegram", "chat-1", "z", "new words")).toBe(false);
    expect(context.revise("telegram", "chat-1", "b", "   ")).toBe(false);
    expect(replay(context).map((message) => message.text)).toEqual(["lunch at 1? my bad", "sure"]);
  });

  test("it stops remembering rooms it has not heard from", () => {
    // The map only grows while messages arrive, which is exactly when nobody is watching it. A daemon
    // that has passed through a few thousand channels must not hold a buffer for each one.
    const context = new GroupContext();
    for (let index = 0; index < 600; index += 1) {
      context.record(said({ id: `m${index}`, text: "hai", chatId: `chat-${index}` }), 20);
    }

    expect(context.size()).toBeLessThan(600);
    // The coldest room went and the newest stayed — an eviction that dropped the wrong end would
    // satisfy the bound above and lose every room anyone is actually talking in.
    expect(replay(context, { chatId: "chat-0" })).toEqual([]);
    expect(replay(context, { chatId: "chat-599" })).toHaveLength(1);
  });
});

describe("what is left out of the replay", () => {
  test("the message that triggered the turn", () => {
    // It is the turn's own user message. Replayed as context too, the model reads the question twice
    // and the second copy is labelled "do not answer".
    const context = new GroupContext();
    context.record(said({ id: "chatter", text: "udah pesen tiket?", at: 1_000 }), 20);
    context.record(said({ id: "trigger", text: "@nouva ini", at: 2_000 }), 20);

    // `before` is deliberately past the trigger here, so `carried` is the only thing that can exclude
    // it. Set to the trigger's own timestamp the two guards cover for each other and neither is
    // actually pinned by this test.
    const replayed = replay(context, { before: 3_000, carried: ["@nouva ini"] });
    expect(replayed.map((message) => message.text)).toEqual(["udah pesen tiket?"]);
  });

  test("anything that arrived after the question", () => {
    // `observe` runs on the gateway's callback and the block is built on the queue's, so a message can
    // land between the two. Replayed into a turn it postdates, it reads as context for a question that
    // was asked before it existed.
    const context = new GroupContext();
    context.record(said({ id: "before", text: "sebelum", at: 1_000 }), 20);
    context.record(said({ id: "after", text: "sesudah", at: 3_000 }), 20);

    expect(replay(context, { before: 2_000 }).map((message) => message.text)).toEqual(["sebelum"]);
  });

  test("the message it was replying to, which the quote already carries", () => {
    // Reply-and-tag is how people actually ask an agent about something above — the quote is
    // prepended to the question, and the buffer holds that same message as chatter. Two copies of it,
    // one of them labelled "do not answer", is a contradiction the model has to resolve on its own.
    const context = new GroupContext();
    context.record(said({ id: "quoted", text: "the build is red", at: 1_000 }), 20);
    context.record(said({ id: "other", text: "sejak kapan?", at: 1_500 }), 20);

    const replayed = replay(context, {
      before: 2_000,
      carried: ["still red?", "the build is red"],
    });
    expect(replayed.map((message) => message.text)).toEqual(["sejak kapan?"]);
  });

  test("the siblings of a media burst the batcher merged into the trigger", () => {
    // Two photos sent together become one envelope whose text is the captions joined by a blank line.
    // The pieces are what the buffer holds, so the join has to be split before it is compared.
    const context = new GroupContext();
    context.record(said({ id: "photo-1", text: "lihat ini", at: 1_000 }), 20);
    context.record(said({ id: "photo-2", text: "dan ini", at: 2_000 }), 20);

    expect(replay(context, { before: 2_000, carried: ["lihat ini\n\ndan ini"] })).toEqual([]);
  });

  test("a one-word message is not dropped for appearing inside the question", () => {
    // The comparison is equality on the whole line, not a substring test: "ok" is a substring of
    // almost anything, and losing the room's "ok" because the question spells "oke" would be a
    // silent, unexplainable gap in the context.
    const context = new GroupContext();
    context.record(said({ id: "a", text: "ok", at: 1_000 }), 20);

    expect(replay(context, { before: 2_000, carried: ["ok lanjut aja"] }).map((m) => m.text)).toEqual([
      "ok",
    ]);
  });

  test("what the answering agent said itself", () => {
    // Its own messages are in its history as `assistant`. Replayed as overheard chatter as well, the
    // agent reads its own last answer as something a third party said.
    const context = new GroupContext();
    context.record(said({ id: "a", text: "sudah gw cek", at: 1_000 }), 20, "nouva");
    context.record(said({ id: "b", text: "sip", at: 1_100 }), 20, "nox");

    expect(replay(context, { excludeAgent: "nouva" }).map((m) => m.text)).toEqual(["sip"]);
  });

  test("what the agent answered, even once its history is emptied — and only for that agent", () => {
    // After a rollover the window falls back to the buffer, and the question answered the evening before came back as
    // something the agent "was not addressed in" (2026-10-22).
    const context = new GroupContext();
    const question = said({ id: "q", text: "enakan pake xl prio atau indihome?", at: 1_000 });
    context.record(question, 20);
    context.answering(question, "nouva");
    context.record(said({ id: "b", text: "ada yang tau?", at: 2_000 }), 20);

    expect(replay(context, { excludeAgent: "nouva" }).map((m) => m.text)).toEqual(["ada yang tau?"]);
    expect(replay(context, { excludeAgent: "nox" }).map((m) => m.text)).toEqual(["enakan pake xl prio atau indihome?", "ada yang tau?"]);
  });

  test("what the agent answered, matched as a copy where each bot numbers the message its own way", () => {
    const context = new GroupContext();
    context.record(said({ id: "1001", text: "halo semua", at: 1_000, idsPerConnection: true, senderName: "Gading" }), 20);
    context.answering(said({ id: "77", text: "halo semua", at: 1_000, idsPerConnection: true, senderName: "Gading" }), "nouva");

    expect(replay(context, { excludeAgent: "nouva" })).toEqual([]);
  });

  test("everything the agent has already been shown", () => {
    // The block is stored with the message that carried it, so a window that did not advance would
    // replay the same lines on every turn and grow the history by a copy each time.
    const context = new GroupContext();
    context.record(said({ id: "a", text: "already seen", at: 1_000 }), 20);
    context.record(said({ id: "b", text: "new", at: 3_000 }), 20);

    expect(replay(context, { after: 2_000 }).map((message) => message.text)).toEqual(["new"]);
  });

  test("everything, when the window is switched off between capture and replay", () => {
    const context = new GroupContext();
    context.record(said({ id: "a", text: "hai" }), 20);

    expect(replay(context, { limit: 0 })).toEqual([]);
  });

  test("the oldest, when more was captured than the current window replays", () => {
    const context = new GroupContext();
    for (let index = 0; index < 5; index += 1) {
      context.record(said({ id: `m${index}`, text: `line ${index}`, at: 1_000 + index }), 20);
    }

    expect(replay(context, { limit: 2 }).map((message) => message.text)).toEqual([
      "line 3",
      "line 4",
    ]);
  });
});

describe("the block the model reads", () => {
  const lines = [
    { id: "a", senderName: "Jordan", text: "udah pesen tiket?", timestamp: 1 },
    { id: "b", senderName: "Ani", text: "belum, nunggu approval", timestamp: 2 },
  ];

  test("says it is background and not a question", () => {
    // Every line in it is somebody asking somebody else something. Unlabelled, the model answers the
    // chatter instead of the person who tagged it.
    const block = formatOverheard(lines);
    expect(block).toContain("not addressed");
    expect(block).toContain("do not reply to them");
    // Background is not a list of topics: the model raised an invite link nobody asked about.
    expect(block).toContain("do not bring up anything from them unless the message after them (the one you are answering) asks about it");
    // Not "the message you were tagged in": the front desk answers a message that tags nobody, and read that as "nobody
    // asked me anything" (2026-10-22).
    expect(block).not.toContain("tagged");
  });

  test("attributes every line", () => {
    const block = formatOverheard(lines);
    expect(block).toContain("Jordan: udah pesen tiket?");
    expect(block).toContain("Ani: belum, nunggu approval");
    expect(block.indexOf("Jordan")).toBeLessThan(block.indexOf("Ani"));
  });

  test("counts what it is showing", () => {
    expect(formatOverheard(lines)).toContain("2 messages");
    expect(formatOverheard([lines[0]!])).toContain("1 message ");
  });

  test("nothing to replay is an empty string, not an empty header", () => {
    // The caller concatenates this in front of the question. A header with no lines under it would
    // ride on every turn in a quiet channel saying nothing.
    expect(formatOverheard([])).toBe("");
  });
});

describe("how a line survives whatever was pasted into the chat", () => {
  test("a multi-line message becomes one line", () => {
    // The block is read one message per line. A pasted stack trace would otherwise look like twenty
    // separate people saying twenty unattributed things.
    const context = new GroupContext();
    context.record(said({ id: "a", text: "error:\n  at foo\n  at bar" }), 20);

    expect(replay(context)[0]?.text).toBe("error: at foo at bar");
  });

  test("an enormous message is bounded in memory, and that bound is not the display one", () => {
    // Capping storage and display at one number was the mistake: at 400 characters a chatter line was
    // never cut and an agent's answer always was — the one message worth replaying in full, because
    // reviewing it is why the next agent got tagged. What is *shown* is now decided by the block's own
    // budget; this is only the bound that stops a pasted 6MB log living in the buffer.
    const context = new GroupContext();
    context.record(said({ id: "a", text: "x".repeat(500_000) }), 20);

    const text = replay(context)[0]?.text ?? "";
    expect(text.length).toBeLessThan(5_000);
    expect(text.length).toBeGreaterThan(1_000);
    expect(text.endsWith("…")).toBe(true);
  });

  test("a sender with no display name is still attributable", () => {
    const context = new GroupContext();
    context.record(said({ id: "a", text: "hai", senderName: "", senderId: "628123" }), 20);

    expect(replay(context)[0]?.senderName).toBe("628123");
  });
});

describe("where the replay window starts", () => {
  test("the last message the agent was addressed with, not the last thing in its history", () => {
    // Assistant and tool messages are stamped when they are produced. A turn that spends thirty
    // seconds in a tool stamps its reply *after* the chatter that arrived while it ran, so keying on
    // the last message of any role swallows exactly the messages the agent missed while it was busy.
    expect(
      lastAddressedAt([
        { role: "user", timestamp: 1_000 },
        { role: "assistant", timestamp: 31_000 },
      ]),
    ).toBe(1_000);
  });

  test("zero for a conversation with nothing in it", () => {
    // A brand-new session must replay the room rather than nothing: being added to a group is the
    // first moment the feature is worth anything.
    expect(lastAddressedAt([])).toBe(0);
    expect(lastAddressedAt([{ role: "assistant", timestamp: 5_000 }])).toBe(0);
  });

  test("the most recent one, when the agent has been addressed several times", () => {
    expect(
      lastAddressedAt([
        { role: "user", timestamp: 1_000 },
        { role: "assistant", timestamp: 1_100 },
        { role: "user", timestamp: 2_000 },
      ]),
    ).toBe(2_000);
  });
});

describe("which limit applies", () => {
  test("the connection's own setting wins over the daemon's", () => {
    expect(resolveGroupContextLimit(5, 20)).toBe(5);
  });

  test("a connection that overrides it to off is off, not inheriting", () => {
    // `?? fallback` on a falsy check would read 0 as "unset" and hand back 20 — a connection the
    // operator switched off would keep reading the room.
    expect(resolveGroupContextLimit(0, 20)).toBe(0);
  });

  test("the daemon's setting applies where a connection has none", () => {
    expect(resolveGroupContextLimit(undefined, 20)).toBe(20);
  });

  test("the ceiling holds against a value the loader never saw", () => {
    // The dashboard writes into the live config object directly, so a value can reach the buffer
    // without passing the loader that refuses it.
    expect(resolveGroupContextLimit(5_000, 20)).toBe(100);
    expect(resolveGroupContextLimit(undefined, -1)).toBe(0);
    expect(resolveGroupContextLimit(undefined, Number.NaN)).toBe(0);
  });
});

/**
 * One budget for the block, spent from the newest backwards.
 *
 * The per-line cap it replaces bounded the wrong thing. At 400 characters a chatter message was never
 * truncated — nobody types that much in a channel — while an agent's answer always was, so the one
 * message worth replaying in full, because reviewing it is why the next agent got tagged, was the only
 * one guaranteed to arrive as a stub. And the block's real size was `window × cap`, so raising the cap
 * to fix that multiplied the worst case by twenty.
 */
describe("how the block spends its budget", () => {
  /** A message of exactly `chars` characters, so a budget test can do arithmetic. */
  const sized = (id: string, chars: number, sender = "Nero"): OverheardMessage => ({
    id,
    gatewayId: "discord:main",
    senderId: sender,
    senderName: sender,
    text: "x".repeat(chars),
    timestamp: Number(id),
  });

  test("the newest message arrives whole, even when it is long", () => {
    // The case the change is for: a person asks Nero, Nero answers at length, the person tags Nox to review
    // that answer. Nox needs the answer, not its opening sentence.
    const block = formatOverheard([sized("1", 50, "Gading"), sized("2", 2_500)], 6_000);

    expect(block).toContain("x".repeat(2_500));
    expect(block).not.toContain("…");
  });

  test("the oldest are what get cut when the budget runs out", () => {
    const messages = [sized("1", 3_000, "Old"), sized("2", 3_000, "Mid"), sized("3", 3_000, "New")];
    const block = formatOverheard(messages, 6_000);

    // Newest whole, the one before it truncated with what was left, the oldest not shown at all.
    expect(block).toContain(`New: ${"x".repeat(3_000)}`);
    expect(block).toContain("Mid: ");
    expect(block).not.toContain(`Mid: ${"x".repeat(3_000)}`);
    expect(block).not.toContain("Old: ");
  });

  test("it says how many did not fit, rather than looking like a short room", () => {
    // A model that cannot tell a quiet room from a trimmed one answers as if it has the whole
    // conversation — which is the failure the whole block exists to prevent, reintroduced by silence.
    // Four long messages against a 6k budget: the newest whole, the one before it cut down to what was
    // left, and the two beyond that with no room at all. Only the fully absent ones are counted —
    // a truncated line carries its own "…" and the model can see it.
    const block = formatOverheard(
      [sized("1", 5_000), sized("2", 5_000), sized("3", 5_000), sized("4", 5_000)],
      6_000,
    );

    expect(block).toContain("2 older messages did not fit");
    expect(block).toContain("2 messages before this one");
  });

  test("nothing is said about dropped messages when nothing was dropped", () => {
    const block = formatOverheard([sized("1", 20, "Jordan"), sized("2", 20, "Ani")], 6_000);

    expect(block).toContain("2 messages before this one");
    expect(block).not.toContain("did not fit");
  });

  test("a fragment too small to mean anything is left out instead of shown", () => {
    // Forty characters of a paragraph tells the model something exists and nothing about what it said.
    const block = formatOverheard([sized("1", 3_000, "Old"), sized("2", 900, "New")], 1_000);

    expect(block).toContain("New: ");
    expect(block).not.toContain("Old: ");
    expect(block).toContain("1 older message did not fit");
  });

  test("the whole block stays inside its budget", () => {
    // Twenty long messages used to mean twenty times the per-line cap. The bound is now the number
    // written down, not that number multiplied by the window.
    const messages = Array.from({ length: 20 }, (_, i) => sized(String(i + 1), 3_000));
    const block = formatOverheard(messages, 6_000);

    expect(block.length).toBeLessThan(6_500);
  });

  test("a room of short messages is replayed in full", () => {
    // The common case has to be unaffected: chatter is short, and all of it fits.
    const messages = Array.from({ length: 20 }, (_, i) => sized(String(i + 1), 30, `P${i}`));
    const block = formatOverheard(messages, 6_000);

    expect(block).toContain("20 messages before this one");
    expect(block).not.toContain("did not fit");
    for (let i = 0; i < 20; i += 1) expect(block).toContain(`P${i}: `);
  });

  test("oldest first, whatever order it spent the budget in", () => {
    // Spent newest-first, rendered oldest-first: the model reads a conversation, not a stack.
    const block = formatOverheard([sized("1", 20, "First"), sized("2", 20, "Second")], 6_000);

    expect(block.indexOf("First:")).toBeLessThan(block.indexOf("Second:"));
  });
});
