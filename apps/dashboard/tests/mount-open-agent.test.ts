/**
 * An agent's Access page, mounted: who can write to it is one card of four answers, and open to everyone is the fourth.
 *
 * Each case is a way the card would let an agent be opened that should not be, or say something else than what
 * opening means: the answer offered to the main agent or one on a coding tool, numbers filled in for the admin, an
 * agent with notes opened with no second yes, an operator offered the answers, an agent opened by a press alone, or an
 * open agent with no way to close it.
 * In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { describe, expect, test } from "bun:test";
import type { AgentOpen, AgentSummary, PublicConversation } from "@nouride/wire";
import { openOn } from "../src/modules/access/open-agents.tsx";
import { limitTyped, OPEN_MEANS, reachedOn, todaySaid } from "../src/modules/agents/components/OpenToEveryone.tsx";
import { whoWrote } from "../src/modules/agents/components/PublicConversations.tsx";
import { answer, buttons, enabled, press, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const STATUS = WIRE["/status"] as { agents: AgentSummary[] };
const ME = WIRE["/auth/me"] as { role: string; user: { role: string } };
const CAN: AgentOpen = { never: null, notes: false, connections: ["telegram:nora", "whatsapp:shop"], limits: null };
/** Nora beside the install's first agent, with what her page is told of being open. */
const withNora = (open: AgentOpen, access: AgentSummary["access"] = "follow") => ({
  "/status": ok({ ...STATUS, orchestrator: "nouva", agents: [STATUS.agents[0]!, { ...STATUS.agents[0]!, id: "nora", displayName: "Nora", access, open }] }),
  // Nobody has written to it, unless a test says who did.
  "/agents/nora/public": ok({ conversations: [], total: 0 }),
});
const card = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("section")].find((one) => one.querySelector("h2, h3")?.textContent?.trim() === "Who can write to this agent") ?? host;
const drawn = (host: HTMLElement) => eventually(() => host.querySelector('[data-access-answer="open"]') !== null, 3_000, "the card");
const drawn_card = drawn;
/** One of the four answers: its radio, and what the card shows of each as `label: chosen|not, disabled|free`. */
const answerOf = (host: HTMLElement, value: string) => host.querySelector<HTMLInputElement>(`[data-access-answer="${value}"] input`)!;
const answers = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>("[data-access-answer]")].map((one) => {
    const radio = one.querySelector<HTMLInputElement>("input")!;
    return `${one.querySelector("span span")?.textContent?.trim()}: ${radio.checked ? "chosen" : "not"}, ${radio.disabled ? "disabled" : "free"}`;
  });
/** The fourth answer picked: its form is under the answers. */
const pickOpen = async (host: HTMLElement) => {
  answerOf(host, "open").click();
  await eventually(() => host.querySelector("[data-open-form]") !== null, 2_000, "the form");
};
const field = (host: HTMLElement, label: string) => [...host.querySelectorAll("label")].find((one) => one.textContent?.includes(label))!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;

describe("the words", () => {
  test("where strangers would reach it, by the app's name; and nowhere, said as what to do first", () => {
    expect(reachedOn(["telegram:nora", "whatsapp:shop"])).toBe("Anyone who finds it can write to it on Telegram (nora), WhatsApp (shop), with no code for you to approve.");
    expect(reachedOn([])).toBe("It has no connection of its own yet, so nobody can reach it. Give it one on its Connections tab first.");
  });

  test("a limit is a whole number of 1 or more: nothing typed, a zero, a fraction or a word is none", () => {
    expect(["200000", " 30 ", "1"].map(limitTyped)).toEqual([200_000, 30, 1]);
    expect(["", "  ", "0", "-5", "1.5", "many"].map(limitTyped)).toEqual([null, null, null, null, null, null]);
  });

  test("today against the limit, and marked where part of the count is Nouride's own", () => {
    expect(todaySaid({ tokens: 12_400, estimated: false, people: 3, messages: 7 }, 200_000)).toBe("12,400 of 200,000 tokens used today; 3 people have written, 7 messages answered.");
    expect(todaySaid({ tokens: 900, estimated: true, people: 1, messages: 1 }, 1_000)).toBe("900 of 1,000 tokens used today (part of it counted by Nouride, as an estimate); 1 person has written, 1 message answered.");
    expect(todaySaid({ tokens: 0, estimated: false, people: 0, messages: 0 }, 1_000)).toBe("0 of 1,000 tokens used today; nobody has written yet.");
  });
});

describe("a closed agent", () => {
  test("says what opening means before it is taken, starts with no numbers, and opens only once both are whole", async () => {
    answer(withNora(CAN));
    const posted = recordPosts({ "/agents/nora/open": ok({ ok: true }) });
    const seen = { closed: "", before: [] as string[], picked: [] as string[], unsaved: -1, form: "", empty: [] as string[], early: true, half: true };
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      seen.closed = card(host).textContent ?? "";
      seen.before = answers(host);
      await pickOpen(host);
      seen.picked = answers(host);
      seen.unsaved = posted.posts.length;
      seen.form = card(host).textContent ?? "";
      seen.empty = [field(host, "Most tokens it may use in a day").value, field(host, "Most messages one person may send it in a day").value];
      const open = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Open to everyone")!;
      seen.early = open().disabled;
      type(field(host, "Most tokens it may use in a day"), "200000");
      type(field(host, "Most messages one person may send it in a day"), "1.5");
      await eventually(() => field(host, "Most tokens it may use in a day").value === "200000", 2_000, "the typing");
      seen.half = open().disabled;
      type(field(host, "Most messages one person may send it in a day"), "30");
      await enabled(host, "Open to everyone");
      press(host, "Open to everyone");
      await eventually(() => posted.posts.length === 1, 2_000, "the post");
    });
    posted.restore();
    // One card, four answers, the fourth among them and saying what it is; the agent follows the install until one is taken.
    expect(seen.before).toEqual(["Follow the default: chosen, free", "Ask first: not, free", "Approved only: not, free", "Open to everyone: not, free"]);
    // Which of the two the default is now, said with it, so "follow" is not a guess.
    expect(seen.closed).toContain("Whatever Agents → Settings says for every agent: ask first, as it is now.");
    expect(seen.closed).toContain(OPEN_MEANS);
    expect(seen.closed).not.toContain("Most tokens it may use in a day");
    // Picked, it is shown as the answer being taken and nothing is sent: it is saved by its form, with its numbers.
    expect(seen.picked.at(-1)).toBe("Open to everyone: chosen, free");
    expect(seen.unsaved).toBe(0);
    // What it means, before it is taken: where, what it may say, what it can do, and that it keeps nothing.
    expect(seen.form).toContain("Anyone who finds it can write to it on Telegram (nora), WhatsApp (shop), with no code for you to approve.");
    expect(seen.form).toContain("It may say whatever its persona files and its notes hold.");
    expect(seen.form).toContain("Its other tools are switched off, whatever its Tools list says.");
    expect(seen.form).toContain("It remembers nothing a chat tells it");
    expect(seen.form).toContain("there is no starting value");
    expect(seen).toMatchObject({ empty: ["", ""], early: true, half: true });
    expect(posted.posts).toEqual([{ path: "/agents/nora/open", body: { maxDailyTokens: 200_000, maxDailyMessagesPerPerson: 30 } }]);
  });

  test("with notes of its own it takes a second yes, sent with the numbers", async () => {
    answer(withNora({ ...CAN, notes: true, limits: { maxDailyTokens: 50_000, maxDailyMessagesPerPerson: 10, closedReply: "Closed for today." } }));
    const posted = recordPosts({ "/agents/nora/open": ok({ ok: true }) });
    const seen = { kept: [] as string[], unticked: false, said: "" };
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      await pickOpen(host);
      await eventually(() => host.textContent?.includes("has notes of its own") === true, 2_000, "the second yes");
      // The numbers of the last time it was open are offered again.
      seen.kept = [field(host, "Most tokens it may use in a day").value, field(host, "Most messages one person may send it in a day").value, field(host, "What people are told").value];
      seen.said = card(host).textContent ?? "";
      const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Open to everyone")!;
      seen.unticked = open.disabled;
      host.querySelector<HTMLInputElement>('input[type="checkbox"].checkbox')!.click();
      await enabled(host, "Open to everyone");
      press(host, "Open to everyone");
      await eventually(() => posted.posts.length === 1, 2_000, "the post");
    });
    posted.restore();
    expect(seen.kept).toEqual(["50000", "10", "Closed for today."]);
    expect(seen.said).toContain("Nora has notes of its own. Once it is open it may say what they hold to anyone who asks.");
    expect(seen.unticked).toBe(true);
    expect(posted.posts).toEqual([{ path: "/agents/nora/open", body: { maxDailyTokens: 50_000, maxDailyMessagesPerPerson: 10, closedReply: "Closed for today.", knowsItsNotes: true } }]);
  });

  test("the main agent and one on a coding tool are never opened: the answer says why and cannot be taken, the other three can", async () => {
    for (const [never, why] of [
      ["orchestrator", "This is the main agent, the one that looks after this server, so it is never opened to everyone."],
      ["cli", "This agent works through a coding tool that brings tools of its own"],
    ] as const) {
      answer(withNora({ ...CAN, never }));
      let said = "";
      let shown: string[] = [];
      let form = true;
      await renderPage("/agents/nora/access", async (host) => {
        await drawn(host);
        said = host.querySelector('[data-access-answer="open"]')?.textContent ?? "";
        shown = answers(host);
        answerOf(host, "open").click();
        form = host.querySelector("[data-open-form]") !== null;
      });
      // The answer is there, so a person sees there is such a thing, with why it is not this agent's to take.
      expect(said).toContain(why);
      expect(said).not.toContain(OPEN_MEANS);
      expect(shown.at(-1)).toBe("Open to everyone: not, disabled");
      expect(shown.slice(0, 3).every((one) => one.endsWith("free"))).toBe(true);
      expect(form).toBe(false);
    }
  });

  test("an operator is offered none of the answers, and is told whose they are", async () => {
    answer({ ...withNora(CAN), "/auth/me": ok({ ...ME, role: "operator", user: { ...ME.user, role: "operator" } }) });
    let said = "";
    let shown: string[] = [];
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      said = card(host).textContent ?? "";
      shown = answers(host);
    });
    expect(shown.map((one) => one.split(", ")[1])).toEqual(["disabled", "disabled", "disabled", "disabled"]);
    expect(said).toContain("Only an admin can change who may write to an agent.");
  });

  test("the form put away leaves the agent as it was: the answer it had is the one chosen, and nothing was sent", async () => {
    answer(withNora(CAN, "allowlist"));
    const posted = recordPosts({ "/agents/nora/open": ok({ ok: true }), "/agents/nora/access": ok({ ok: true }) });
    let after: string[] = [];
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      await pickOpen(host);
      press(host, "Cancel");
      await eventually(() => host.querySelector("[data-open-form]") === null, 2_000, "the form gone");
      after = answers(host);
    });
    posted.restore();
    expect(after.map((one) => one.split(": ")[1]!.split(", ")[0])).toEqual(["not", "not", "chosen", "not"]);
    expect(posted.posts).toEqual([]);
  });

  test("another answer taken while the form is up puts the form away and is saved, as any of the three is", async () => {
    answer(withNora(CAN));
    const posted = recordPosts({ "/agents/nora/open": ok({ ok: true }), "/agents/nora/access": ok({ ok: true }) });
    let form = true;
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      await pickOpen(host);
      answerOf(host, "pair").click();
      await eventually(() => posted.posts.length === 1, 2_000, "the post");
      form = host.querySelector("[data-open-form]") !== null;
    });
    posted.restore();
    expect(form).toBe(false);
    expect(posted.posts).toEqual([{ path: "/agents/nora/access", body: { access: "pair" } }]);
  });
});

describe("an open agent", () => {
  const OPEN: AgentOpen = { ...CAN, limits: { maxDailyTokens: 200_000, maxDailyMessagesPerPerson: 30, closedReply: null }, today: { tokens: 12_400, estimated: false, people: 3, messages: 7 } };

  test("is the answer chosen, says where it is reached and what it used today, and is closed by taking another answer", async () => {
    answer(withNora(OPEN, "open"));
    const posted = recordPosts({ "/agents/nora/close": ok({ ok: true }), "/agents/nora/access": ok({ ok: true }) });
    let said = "";
    let has: string[] = [];
    let shown: string[] = [];
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      await eventually(() => host.querySelector("[data-open-now]") !== null, 2_000, "what it is doing");
      said = card(host).textContent ?? "";
      has = buttons(host);
      shown = answers(host);
      answerOf(host, "pair").click();
      await eventually(() => posted.posts.length === 1, 2_000, "the post");
    });
    posted.restore();
    expect(shown.map((one) => one.split(": ")[1]!.split(", ")[0])).toEqual(["not", "not", "not", "chosen"]);
    expect(said).toContain("Open. Anyone who finds it can write to it on Telegram (nora), WhatsApp (shop), with no code for you to approve.");
    expect(said).toContain("12,400 of 200,000 tokens used today; 3 people have written, 7 messages answered.");
    expect(said).toContain("Taking another answer above closes it. Its limits are kept for the next time.");
    // One way to close it for the one who holds the answers, not a button beside them as well.
    expect(has).toContain("Change its limits");
    expect(has).not.toContain("Close it");
    expect(posted.posts).toEqual([{ path: "/agents/nora/access", body: { access: "pair" } }]);
  });

  test("its limits are changed in place, with no second question about notes it was opened with", async () => {
    answer(withNora({ ...OPEN, notes: true }, "open"));
    const posted = recordPosts({ "/agents/nora/open": ok({ ok: true }) });
    let asked = true;
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      press(host, "Change its limits");
      await eventually(() => host.textContent?.includes("Most tokens it may use in a day") === true, 2_000, "the form");
      asked = host.textContent?.includes("has notes of its own") === true;
      type(field(host, "Most tokens it may use in a day"), "90000");
      await enabled(host, "Save limits");
      press(host, "Save limits");
      await eventually(() => posted.posts.length === 1, 2_000, "the post");
    });
    posted.restore();
    expect(asked).toBe(false);
    expect(posted.posts).toEqual([{ path: "/agents/nora/open", body: { maxDailyTokens: 90_000, maxDailyMessagesPerPerson: 30 } }]);
  });

  test("an operator may close it, and is not offered its limits", async () => {
    answer({ ...withNora(OPEN, "open"), "/auth/me": ok({ ...ME, role: "operator", user: { ...ME.user, role: "operator" } }) });
    const posted = recordPosts({ "/agents/nora/close": ok({ ok: true }) });
    let has: string[] = [];
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      await eventually(() => buttons(host).includes("Close it"), 2_000, "the button");
      has = buttons(host);
      press(host, "Close it");
      await eventually(() => posted.posts.length === 1, 2_000, "the post");
    });
    posted.restore();
    // The answers are an admin's, so they are no way to close it for an operator: the button is.
    expect(has).toContain("Close it");
    expect(has).not.toContain("Change its limits");
    expect(posted.posts).toEqual([{ path: "/agents/nora/close", body: {} }]);
  });
});

describe("where else an open agent is said", () => {
  const OPEN: AgentOpen = { ...CAN, limits: { maxDailyTokens: 200_000, maxDailyMessagesPerPerson: 30, closedReply: null }, today: { tokens: 0, estimated: false, people: 0, messages: 0 } };

  test("the Access page, which lists who was let in, names the agents that answer anyone and where: nobody of theirs is in its lists", async () => {
    answer(withNora(OPEN, "open"));
    let said = "";
    await renderPage("/access", async (host) => {
      await eventually(() => host.querySelector("[data-open-agents]") !== null, 3_000, "the line");
      said = host.querySelector("[data-open-agents]")?.textContent ?? "";
    });
    expect(said).toBe("Open to everyone, with no code: Nora on Telegram (nora), WhatsApp (shop). Whoever writes to it is not in the lists below: nobody was asked for a code.");
    expect(openOn({ open: { ...OPEN, connections: [] } })).toBe("with no connection of its own yet");
    // No agent open: no line.
    answer(withNora(CAN));
    let drawn = true;
    await renderPage("/access", async (host) => {
      await eventually(() => host.textContent?.includes("Pending") === true, 3_000, "the page");
      drawn = host.querySelector("[data-open-agents]") !== null;
    });
    expect(drawn).toBe(false);
  });

  test("its Tools are shown switched off while it is open, with why and the way to close it; a closed agent's are its own to switch", async () => {
    answer(withNora(OPEN, "open"));
    const seen = { said: "", off: false, save: false };
    await renderPage("/agents/nora/settings", async (host) => {
      await eventually(() => host.querySelector("[data-tools-locked]") !== null, 3_000, "the notice");
      seen.said = host.querySelector("[data-tools-locked]")?.textContent ?? "";
      const tools = [...host.querySelectorAll<HTMLElement>("section")].find((card) => card.querySelector("h2")?.textContent === "Tools")!;
      await eventually(() => tools.querySelectorAll("input").length > 0, 3_000, "the switches");
      seen.off = [...tools.querySelectorAll<HTMLInputElement>("input")].every((input) => input.disabled);
      seen.save = [...tools.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Save tools")!.disabled;
    });
    expect(seen.said).toContain("Switched off while this agent is open to everyone.");
    expect(seen.said).toContain("What is picked below is kept, and used again once you close it on its Access tab.");
    expect(seen).toMatchObject({ off: true, save: true });

    answer(withNora(CAN));
    let locked = true;
    let on = false;
    await renderPage("/agents/nora/settings", async (host) => {
      const tools = () => [...host.querySelectorAll<HTMLElement>("section")].find((card) => card.querySelector("h2")?.textContent === "Tools");
      await eventually(() => (tools()?.querySelectorAll("input").length ?? 0) > 0, 3_000, "the switches");
      locked = host.querySelector("[data-tools-locked]") !== null;
      on = [...tools()!.querySelectorAll<HTMLInputElement>("input")].some((input) => !input.disabled);
    });
    expect({ locked, on }).toEqual({ locked: false, on: true });
  });

  test("the switch for every agent has two positions, and says where one agent is opened to everyone", async () => {
    let said = "";
    await renderPage("/agents/settings", async (host) => {
      await eventually(() => host.textContent?.includes("Accept new senders") === true, 3_000, "the switch");
      said = host.textContent ?? "";
    });
    expect(said).toContain("To let anyone write to one agent with no code, open that agent to everyone there.");
  });
});

describe("the people who wrote to it", () => {
  const OPEN: AgentOpen = { ...CAN, limits: { maxDailyTokens: 200_000, maxDailyMessagesPerPerson: 30, closedReply: null }, today: { tokens: 0, estimated: false, people: 2, messages: 3 } };
  const row = (sessionId: string, more: Partial<PublicConversation>): PublicConversation => ({ sessionId, gatewayId: "telegram:nora", chatId: sessionId, kind: "private", sender: { id: "7001", name: "Budi Santoso", blocked: false }, title: "when do you open?", updatedAt: Date.now() - 5 * 60_000, ...more });
  const BUDI = row("ses_budi", {});
  const SITI = row("ses_siti", { gatewayId: "whatsapp:shop", sender: { id: "62812@s.whatsapp.net", name: null, blocked: true }, title: "berapa harga kopi?" });
  const GROUP = row("ses_group", { kind: "group", sender: { id: "9009", name: null, blocked: false }, title: "are you a bot?" });
  const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-public-row]")];

  test("are listed on its Access page with what they first asked, each read as any conversation is; a blocked sender is marked, and has no Block", async () => {
    answer({ ...withNora(OPEN, "open"), "/agents/nora/public": ok({ conversations: [GROUP, SITI, BUDI], total: 3 }) });
    const seen = { said: [] as string[], read: [] as (string | null)[], block: [] as boolean[] };
    await renderPage("/agents/nora/access", async (host) => {
      await eventually(() => rows(host).length === 3, 3_000, "the rows");
      seen.said = rows(host).map((one) => one.textContent ?? "");
      seen.read = rows(host).map((one) => one.querySelector("a")?.getAttribute("href") ?? null);
      seen.block = rows(host).map((one) => [...one.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Block"));
    });
    expect(seen.said[0]).toContain("9009, in a group");
    expect(seen.said[0]).toContain("“are you a bot?”");
    expect(seen.said[1]).toContain("62812@s.whatsapp.net");
    expect(seen.said[1]).toContain("WhatsApp");
    expect(seen.said[1]).toContain("Blocked");
    expect(seen.said[2]).toContain("Budi Santoso");
    expect(seen.said[2]).toContain("Telegram");
    expect(seen.said[2]).toContain("5 min ago");
    expect(seen.read).toEqual(["/dashboard/chat/ses_group", "/dashboard/chat/ses_siti", "/dashboard/chat/ses_budi"]);
    expect(seen.block).toEqual([true, false, true]);
    expect(whoWrote({ kind: "private", sender: null })).toBe("Somebody");
  });

  test("Block asks first, says what it does, and blocks that sender on that connection", async () => {
    answer({ ...withNora(OPEN, "open"), "/agents/nora/public": ok({ conversations: [BUDI], total: 1 }) });
    const posted = recordPosts({ "/access/block": ok({ ok: true }) });
    let asked = "";
    await renderPage("/agents/nora/access", async (host) => {
      await eventually(() => rows(host).length === 1, 3_000, "the row");
      press(rows(host)[0]!, "Block");
      await eventually(() => host.ownerDocument.body.textContent?.includes("Block Budi Santoso?") === true, 2_000, "the question");
      const question = () => [...host.ownerDocument.querySelectorAll<HTMLDialogElement>("dialog")].find((one) => one.textContent?.includes("Block Budi Santoso?"))!;
      const answer = (label: string) => [...question().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label)!.click();
      asked = question().textContent ?? "";
      // A no blocks nobody. The button is held while its question is open and what follows it runs: free again, the
      // no has been acted on, whatever it did.
      const block = () => [...rows(host)[0]!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Block")!;
      answer("Cancel");
      await eventually(() => !block().disabled, 2_000, "the no acted on");
      expect(posted.posts).toEqual([]);
      press(rows(host)[0]!, "Block");
      await eventually(() => question()?.open === true, 2_000, "the question again");
      answer("Block");
      await eventually(() => posted.posts.length === 1, 2_000, "the post");
    });
    posted.restore();
    expect(asked).toContain("Their messages are ignored from now on, with no reply, on this connection.");
    expect(posted.posts.map((one) => one.path)).toEqual(["/access/block"]);
  });

  test("more than a page: the rest are asked for under the ones on screen", async () => {
    const first = Array.from({ length: 2 }, (_, n) => row(`ses_a${n}`, { title: `first ${n}` }));
    answer({ ...withNora(OPEN, "open"), "/agents/nora/public": ok({ conversations: first, total: 3, nextBefore: 1234 }), "/agents/nora/public?before=1234": ok({ conversations: [row("ses_b", { title: "the last one" })], total: 3 }) });
    let shown: string[] = [];
    let offered = "";
    await renderPage("/agents/nora/access", async (host) => {
      await eventually(() => rows(host).length === 2, 3_000, "the first page");
      offered = buttons(host).find((label) => label.startsWith("Show more")) ?? "";
      press(host, offered);
      await eventually(() => rows(host).length === 3, 3_000, "the next page");
      shown = rows(host).map((one) => one.dataset.publicRow ?? "");
    });
    expect(offered).toBe("Show more (1 more)");
    expect(shown).toEqual(["ses_a0", "ses_a1", "ses_b"]);
  });

  test("nobody yet is said; and an operator, or a closed agent's page, has no such list", async () => {
    answer({ ...withNora(OPEN, "open"), "/agents/nora/public": ok({ conversations: [], total: 0 }) });
    let said = "";
    await renderPage("/agents/nora/access", async (host) => {
      await eventually(() => host.textContent?.includes("Nobody has written to it yet.") === true, 3_000, "the empty line");
      said = host.textContent ?? "";
    });
    expect(said).toContain("People who wrote");
    for (const override of [{ ...withNora(OPEN, "open"), "/auth/me": ok({ ...ME, role: "operator", user: { ...ME.user, role: "operator" } }) }, withNora(CAN)]) {
      answer({ ...override, "/agents/nora/public": ok({ conversations: [BUDI], total: 1 }) });
      let drawn = true;
      await renderPage("/agents/nora/access", async (host) => {
        await drawn_card(host);
        drawn = host.textContent?.includes("People who wrote") === true;
      });
      expect(drawn).toBe(false);
    }
  });
});
