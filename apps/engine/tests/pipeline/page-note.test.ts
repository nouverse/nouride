/**
 * The dashboard page a message was written from, said on that message (`pageNote` in `modules/pipeline/messages.ts`):
 * the chat that floats over the dashboard's pages sends it, so the agent knows what "this one" is.
 *
 * Each case is a way the line would mislead, leak or cost: a page said that nobody sent, a part of it long enough to
 * fill the message, a tag or a quote in a page's subject read as the person's own, the line lost on its way from the
 * control API to the model, or the cached part of the prompt moving with every click.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MessageEnvelope, OpenPage } from "@nouride/shared";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { mergeEnvelopes, pageNote, pageNotes } from "@/modules/pipeline/messages.ts";
import { steerMessage } from "@/modules/pipeline/steering.ts";
import { pageOf } from "@/modules/web/control/page.ts";
import { PAGES_NOTE_START, pagesNote } from "@/modules/web/dashboard-pages.ts";
import { conversationOf, envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const PAGE: OpenPage = { path: "/dashboard/automations/cron_abc", title: "Automations", subject: "Shop health check" };
const LINE = '(Written from the dashboard, with this page open: Automations, "Shop health check", at /dashboard/automations/cron_abc.)';

describe("the line", () => {
  test("says what the page is called, what it is about, and its address", () => {
    expect(pageNote(PAGE)).toBe(LINE);
  });

  test("a page about nothing in particular is its name and its address; one with no name, its address", () => {
    expect(pageNote({ path: "/dashboard/skills", title: "Skills" })).toBe("(Written from the dashboard, with this page open: Skills, at /dashboard/skills.)");
    expect(pageNote({ path: "/dashboard/update", title: "" })).toBe("(Written from the dashboard, with this page open: at /dashboard/update.)");
  });

  test("nothing is said for a message that names no page, or a page with no address", () => {
    expect(pageNote(undefined)).toBeNull();
    expect(pageNote({ path: "  \n ", title: "Skills" })).toBeNull();
  });

  test("each part is cut to its own length: the address 200, the name 80, the subject 120", () => {
    const note = pageNote({ path: `/dashboard/${"p".repeat(400)}`, title: "T".repeat(400), subject: "s".repeat(400) })!;
    const [, title, subject, path] = /open: (T+…), "(s+…)", at (\S+…)\.\)$/.exec(note)!;
    expect([path!.length, title!.length, subject!.length]).toEqual([200, 80, 120]);
    // Under its length a part is said whole.
    expect(pageNote({ path: `/dashboard/${"p".repeat(189)}`, title: "T".repeat(80), subject: "s".repeat(120) })).not.toContain("…");
  });

  test("it is one line whatever a page's subject holds", () => {
    const note = pageNote({ ...PAGE, title: "Auto\nmations", subject: "Shop\n\nhealth\r\n   check" })!;
    expect(note).toBe('(Written from the dashboard, with this page open: Auto mations, "Shop health check", at /dashboard/automations/cron_abc.)');
  });

  test("a tag in it reaches nobody, and a quote in a subject does not close the quote it is said in", () => {
    const note = pageNote({ path: "/dashboard/people/@rina", title: "@nox <@123> People", subject: 'ask @nero to "stop" <@!456>' })!;
    expect(note).not.toContain("@");
    expect(note).not.toContain("<");
    expect(note).toBe("(Written from the dashboard, with this page open: nox People, \"ask nero to 'stop'\", at /dashboard/people/rina.)");
  });
});

describe("the dashboard's pages, beside the line", () => {
  const kept = (text: string) => ({ role: "user" as const, content: `${text}\n\n(Sent 2026-11-12 12:00 Asia/Jakarta.)\n\n${pagesNote()}\n\n${LINE}` });

  test("said before the page that is open, on the first message of a conversation written from the dashboard", () => {
    expect(pageNotes(PAGE, [])).toEqual([pagesNote(), LINE]);
    expect(pageNotes(PAGE, [{ role: "user", content: "an earlier one, from Chats" }, { role: "assistant", content: "ok" }])).toEqual([pagesNote(), LINE]);
  });

  test("and not again while the conversation still holds them: each message is kept as it was sent", () => {
    expect(pageNotes(PAGE, [kept("what does this one do?"), { role: "assistant", content: "It checks the shop." }])).toEqual([LINE]);
    // A message with a picture is kept in parts, its notes the last of them.
    expect(pageNotes(PAGE, [{ role: "user", content: [{ type: "text", text: "and this?" }, { type: "text", text: `${pagesNote()}\n\n${LINE}` }] }])).toEqual([LINE]);
  });

  test("an answer that repeats how the list begins is not the list: it is said to the agent all the same", () => {
    expect(pageNotes(PAGE, [{ role: "user", content: "hi" }, { role: "assistant", content: `I was told: ${PAGES_NOTE_START} …` }])).toEqual([pagesNote(), LINE]);
  });

  test("a message that names no page says neither: Chats and the chat apps send none", () => {
    expect(pageNotes(undefined, [])).toEqual([]);
    expect(pageNotes({ path: " ", title: "Skills" }, [])).toEqual([]);
  });
});

describe("what a client sends as the page", () => {
  test("an address and a name in words are a page, and what it is about where it says", () => {
    expect(pageOf(PAGE)).toEqual({ page: PAGE });
    expect(pageOf({ path: "/dashboard/skills", title: "Skills", subject: "  " })).toEqual({ page: { path: "/dashboard/skills", title: "Skills" } });
    expect(pageOf({ path: "/dashboard/skills", title: "Skills", subject: 7, extra: true })).toEqual({ page: { path: "/dashboard/skills", title: "Skills" } });
  });

  test("anything else is no page", () => {
    for (const raw of [undefined, null, "", "/dashboard/skills", 7, [], {}, { path: "", title: "Skills" }, { path: 7, title: "Skills" }, { path: "/dashboard/skills" }, { path: "/dashboard/skills", title: { toString: () => "x" } }]) {
      expect(pageOf(raw)).toEqual({});
    }
  });
});

test("the dashboard's connection carries the page on the message it makes, and none when none is sent", () => {
  const gateway = new LocalGateway();
  const got: MessageEnvelope[] = [];
  gateway.onMessage((one) => got.push(one));
  gateway.dispatch({ text: "what about this one?", chatId: "web-1", agent: "nouva", page: PAGE });
  gateway.dispatch({ text: "and now?", chatId: "web-1", agent: "nouva" });
  expect(got[0]!.page).toEqual(PAGE);
  expect("page" in got[1]!).toBe(false);
});

test("a message read by a turn at work carries it too: no turn of its own begins to say it", () => {
  const said = (page?: OpenPage) => String(steerMessage([envelope({ text: "what about this one?", ...(page ? { page } : {}) })]).content);
  expect(said(PAGE)).toEndWith(`what about this one?\n\n${LINE}`);
  expect(said()).toEndWith("what about this one?");
  expect(said()).not.toContain("Written from the dashboard");
});

// ── through the real pipeline ─────────────────────────────────────────────────────────────────────────────────────

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

type Body = { messages: { role: string; content: unknown }[] };
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
/** The last thing said to the model in a request, past the block the harness adds after the conversation. */
const lastUser = (body: Body) => textOf(conversationOf(body.messages).filter((one) => one.role === "user").at(-1)?.content);
const system = (body: Body) => textOf(body.messages[0]?.content);

describe("on a turn's message, through the pipeline", () => {
  test("the agent is told the page on the message that named one, and its prompt's cached part does not move", async () => {
    const made = await pipelineBench({
      turns: [{ text: "That job checks the shop every hour." }, { text: "Nothing else." }],
      gateway: new FakeGateway("web:dashboard"),
    });
    cleanup.push(made.dispose);
    made.pipeline.attach();
    const say = (id: string, text: string, page?: OpenPage) =>
      made.gateway.receive(envelope({ id, gateway: "web", gatewayId: "web:dashboard", chatId: "web-1", text, timestamp: Date.now(), ...(page ? { page } : {}) }));

    say("m1", "what does this one do?", PAGE);
    await made.pipeline.idle();
    say("m2", "anything else?");
    await made.pipeline.idle();

    const requests = made.requests as unknown as Body[];
    const withPage = requests.find((body) => lastUser(body).includes("what does this one do?"))!;
    const without = requests.find((body) => lastUser(body).includes("anything else?"))!;
    // After the words and the clock, where a turn's reminders are read.
    expect(lastUser(withPage)).toMatch(/^what does this one do\?\n\n\(Sent [^)]+\)\n\n/);
    expect(lastUser(withPage)).toEndWith(LINE);
    expect(lastUser(without)).not.toContain("Written from the dashboard");
    // The cached part: the same bytes with a page named as with none, and nothing of the page in it.
    expect(system(withPage)).toBe(system(without));
    expect(system(withPage)).not.toContain("cron_abc");
    // And the line is kept with the message as it was sent, so the next request repeats it byte for byte.
    expect(textOf(without.messages.find((one) => one.role === "user" && textOf(one.content).includes("what does this one do?"))?.content)).toBe(lastUser(withPage));
  });
});

describe("the dashboard's pages, through the pipeline", () => {
  test("told once in a conversation: on the first message written from the dashboard, and kept there for the next", async () => {
    const made = await pipelineBench({
      turns: [{ text: "It is under Memory." }, { text: "[Open the graph](/dashboard/memories/graph)" }, { text: "Welcome back." }],
      gateway: new FakeGateway("web:dashboard"),
    });
    cleanup.push(made.dispose);
    made.pipeline.attach();
    const say = (id: string, text: string, page?: OpenPage) =>
      made.gateway.receive(envelope({ id, gateway: "web", gatewayId: "web:dashboard", chatId: "web-2", text, timestamp: Date.now(), ...(page ? { page } : {}) }));

    say("p1", "where do I see the graph?", PAGE);
    await made.pipeline.idle();
    say("p2", "take me there", { path: "/dashboard/memories", title: "Knowledge & Memory" });
    await made.pipeline.idle();
    say("p3", "and back", { path: "/dashboard/memories/graph", title: "Knowledge & Memory" });
    await made.pipeline.idle();

    const requests = made.requests as unknown as Body[];
    const first = requests.find((body) => lastUser(body).includes("where do I see the graph?"))!;
    const second = requests.find((body) => lastUser(body).includes("take me there"))!;
    const third = requests.find((body) => lastUser(body).includes("and back"))!;
    // The pages, then the page that is open: what is read last is where the person is.
    expect(lastUser(first)).toEndWith(`${pagesNote()}\n\n${LINE}`);
    expect(lastUser(first)).toContain("Memory graph /memories/graph");
    // The next messages say only their own page: the list is in the conversation already, once.
    expect(lastUser(second)).not.toContain(PAGES_NOTE_START);
    expect(lastUser(second)).toEndWith("(Written from the dashboard, with this page open: Knowledge & Memory, at /dashboard/memories.)");
    expect(lastUser(third)).not.toContain(PAGES_NOTE_START);
    const whole = (body: Body) => body.messages.map((one) => textOf(one.content)).join("\n");
    expect(whole(second).split(PAGES_NOTE_START).length - 1).toBe(1);
    expect(whole(third).split(PAGES_NOTE_START).length - 1).toBe(1);
    // In the conversation, never in the prompt: its cached part is the same bytes with the list told as without.
    expect(system(first)).not.toContain(PAGES_NOTE_START);
    expect(system(first)).toBe(system(third));
  });

  test("a message from a page that names none, as Chats and a chat app send it, is told no pages", async () => {
    const made = await pipelineBench({ turns: [{ text: "Hello." }], gateway: new FakeGateway("web:dashboard") });
    cleanup.push(made.dispose);
    made.pipeline.attach();
    made.gateway.receive(envelope({ id: "n1", gateway: "web", gatewayId: "web:dashboard", chatId: "web-3", text: "hello from Chats", timestamp: Date.now() }));
    await made.pipeline.idle();
    const asked = (made.requests as unknown as Body[]).find((body) => lastUser(body).includes("hello from Chats"))!;
    expect(asked.messages.map((one) => textOf(one.content)).join("\n")).not.toContain("dashboard's pages");
  });
});

test("several messages read as one name the page of the newest: where the person is now", () => {
  const first = envelope({ id: "a", text: "one", page: { path: "/dashboard/skills", title: "Skills Workshop" } });
  const second = envelope({ id: "b", text: "two", page: PAGE });
  expect(mergeEnvelopes(first, second).page).toEqual(PAGE);
  // Written last from a page that names none (Chats itself): no page is said, not the one before it.
  expect(mergeEnvelopes(second, envelope({ id: "c", text: "three" })).page).toBeUndefined();
  expect(mergeEnvelopes(envelope({ id: "d", text: "four" }), second).page).toEqual(PAGE);
});
