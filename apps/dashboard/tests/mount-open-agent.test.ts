/**
 * An agent's Access page, mounted: the card that opens it to everyone and closes it again.
 *
 * Each case is a way the card would let an agent be opened that should not be, or say something else than what
 * opening means: a button for the main agent or one on a coding tool, numbers filled in for the admin, an agent with
 * notes opened with no second yes, an operator offered the switch, or an open agent with no way to close it.
 * In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { describe, expect, test } from "bun:test";
import type { AgentOpen, AgentSummary } from "@nouride/wire";
import { limitTyped, reachedOn, todaySaid } from "../src/modules/agents/components/OpenToEveryone.tsx";
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
});
const card = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("section, div")].find((one) => one.querySelector("h2, h3")?.textContent?.trim() === "Open to everyone") ?? host;
const drawn = (host: HTMLElement) => eventually(() => host.textContent?.includes("Open to everyone") === true, 3_000, "the card");
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
    const seen = { closed: "", form: "", empty: [] as string[], early: true, half: true };
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      seen.closed = card(host).textContent ?? "";
      press(host, "Open to everyone…");
      await eventually(() => host.textContent?.includes("Most tokens it may use in a day") === true, 2_000, "the form");
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
    expect(seen.closed).toContain("Closed. Only the people you let in can write to it.");
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
      press(host, "Open to everyone…");
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

  test("the main agent and one on a coding tool are never opened: why is said, and there is no button", async () => {
    for (const [never, why] of [
      ["orchestrator", "This is the main agent, the one that looks after this server, so it is never opened to everyone."],
      ["cli", "This agent works through a coding tool that brings tools of its own"],
    ] as const) {
      answer(withNora({ ...CAN, never }));
      let said = "";
      let has: string[] = [];
      await renderPage("/agents/nora/access", async (host) => {
        await drawn(host);
        said = card(host).textContent ?? "";
        has = buttons(host);
      });
      expect(said).toContain(why);
      expect(has).not.toContain("Open to everyone…");
    }
  });

  test("an operator is not offered the switch, and is told whose it is", async () => {
    answer({ ...withNora(CAN), "/auth/me": ok({ ...ME, role: "operator", user: { ...ME.user, role: "operator" } }) });
    let said = "";
    let has: string[] = [];
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      said = card(host).textContent ?? "";
      has = buttons(host);
    });
    expect(has).not.toContain("Open to everyone…");
    expect(said).toContain("Only an admin can open an agent to everyone.");
  });
});

describe("an open agent", () => {
  const OPEN: AgentOpen = { ...CAN, limits: { maxDailyTokens: 200_000, maxDailyMessagesPerPerson: 30, closedReply: null }, today: { tokens: 12_400, estimated: false, people: 3, messages: 7 } };

  test("says where it is reached and what it used today, and is closed with one press", async () => {
    answer(withNora(OPEN, "open"));
    const posted = recordPosts({ "/agents/nora/close": ok({ ok: true }) });
    let said = "";
    let has: string[] = [];
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      said = card(host).textContent ?? "";
      has = buttons(host);
      press(host, "Close it");
      await eventually(() => posted.posts.length === 1, 2_000, "the post");
    });
    posted.restore();
    expect(said).toContain("Open. Anyone who finds it can write to it on Telegram (nora), WhatsApp (shop), with no code for you to approve.");
    expect(said).toContain("12,400 of 200,000 tokens used today; 3 people have written, 7 messages answered.");
    expect(has).toEqual(expect.arrayContaining(["Change its limits", "Close it"]));
    expect(posted.posts).toEqual([{ path: "/agents/nora/close", body: {} }]);
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
    let has: string[] = [];
    await renderPage("/agents/nora/access", async (host) => {
      await drawn(host);
      has = buttons(host);
    });
    expect(has).toContain("Close it");
    expect(has).not.toContain("Change its limits");
  });
});
