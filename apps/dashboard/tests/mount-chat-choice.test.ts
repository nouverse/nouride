/**
 * The model and effort a conversation is answered with, picked in its bar (`ChatChoice`): through the whole app, on the
 * Chats page, against the answers the daemon gives.
 *
 * Each case is a way the picker could mislead or misfire: a button that says a model the conversation is not on, a
 * first message that leaves without the pick made for it, a pick saved at every keystroke, a list asked of the
 * provider on every page drawn, a model that embeds offered for a chat, a pick offered where it would be refused.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ChatChoices } from "@nouride/wire";
import { answer, dom, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();
// A test that makes the window a phone's leaves it one: the tests after it drew a sheet where they read a panel.
afterEach(() => {
  dom.happyDOM.setViewport({ width: 1024, height: 768 });
});

const ok = (body: unknown) => ({ status: 200, body });
const OWN: ChatChoices = { model: { own: "gemini-3.8-flash" }, effort: { own: "low" }, efforts: ["low", "medium", "high", "xhigh", "max"] };
const LISTED = ok({ models: ["gemini-3.8-flash", "claude-sonnet-5-5", "text-embedding-3-large"] });
const SENT = { "/chat/send": ok({ sessionId: "ses_new", chatId: "web-9", messageId: "msg_9", agentId: "nouva" }) };
const NEW_CHAT = "/chat?agent=nouva";

/** The picker's button in the conversation's bar, by what it is named for. */
const button = (host: HTMLElement) => [...host.querySelectorAll("header button")].find((one) => one.getAttribute("aria-label")?.startsWith("Model and effort for this conversation")) as HTMLButtonElement | undefined;
const says = (host: HTMLElement) => button(host)?.getAttribute("aria-label")?.replace("Model and effort for this conversation: ", "") ?? null;
/** The panel, drawn at the body. */
const panel = () => dom.document.querySelector('[role="dialog"][aria-label="Model and effort for this conversation"]') as HTMLElement | null;
const field = () => panel()?.querySelector('input[role="combobox"]') as HTMLInputElement | null;
const level = (name: string) => [...(panel()?.querySelectorAll('[role="radio"]') ?? [])].find((one) => one.textContent?.trim() === name) as HTMLButtonElement | undefined;
const checked = () => [...(panel()?.querySelectorAll('[role="radio"][aria-checked="true"]') ?? [])].map((one) => one.textContent?.trim());
/** The rows of the model field's list, drawn at the body. */
const rows = () => [...dom.document.querySelectorAll('ul[role="listbox"] [role="option"]')].map((row) => row.textContent?.trim() ?? "");
const row = (starts: string) => [...dom.document.querySelectorAll('ul[role="listbox"] [role="option"] button')].find((one) => one.textContent?.trim().startsWith(starts)) as HTMLButtonElement | undefined;
const key = (target: Element, name: string) => target.dispatchEvent(new (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
/** A finger or a mouse going down on something, before the click it becomes. */
const pressDown = (target: Element) => target.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event("pointerdown", { bubbles: true }));
const wholeList = () => (panel()!.querySelector('button[aria-label="Show the whole list"]') as HTMLButtonElement).click();
const backButton = () => [...(panel()?.querySelectorAll("button") ?? [])].find((one) => one.textContent?.trim().startsWith("Back to "));
const submit = (form: Element) => form.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event("submit", { bubbles: true, cancelable: true }));
const composer = (host: HTMLElement) => host.querySelector("textarea") as HTMLTextAreaElement;
const sendButton = (host: HTMLElement) => host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null;
/** Whether the bar's button marks the conversation as on a pick of its own. */
const picked = (host: HTMLElement) => button(host)?.hasAttribute("data-picked") === true;

/** Every request to these paths, by its address: what the page asked, and when. */
function watch(...paths: string[]) {
  const asked: string[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
    const path = url.pathname.replace(/^\/api\/control/, "");
    if (paths.includes(path)) asked.push(`${init?.method ?? "GET"} ${path}${url.search}`);
    return (spy as typeof fetch)(input as RequestInfo, init);
  }) as typeof fetch;
  return { asked, restore: () => void (globalThis.fetch = spy) };
}

async function opened(host: HTMLElement) {
  await eventually(() => button(host) !== undefined, 4_000, "the picker's button");
  button(host)!.click();
  await eventually(() => panel() !== null && field() !== null, 3_000, "the panel");
}

describe("a conversation not begun", () => {
  test("says the agent's own model and effort, and asks the provider for no list until the panel is open", async () => {
    answer({ "/chat/choices": ok(OWN), "/chat/models": LISTED });
    const seen = watch("/chat/models", "/chat/choices");
    try {
      await renderPage(NEW_CHAT, async (host) => {
        await eventually(() => says(host) !== null, 4_000, "the picker's button");
        expect(says(host)).toBe("gemini-3.8-flash · low");
        expect(seen.asked).toEqual(["GET /chat/choices?agent=nouva"]);
        button(host)!.click();
        await eventually(() => seen.asked.includes("GET /chat/models?agent=nouva"), 3_000, "the list asked for");
        expect(checked()).toEqual(["Nouva's own (low)"]);
        // Nothing is picked, so there is nothing to go back from.
        expect(backButton()).toBeUndefined();
        // The whole list, by the field's arrow: the provider's models that chat, never one that embeds.
        await eventually(() => (panel()!.querySelector('button[aria-label="Show the whole list"]') as HTMLButtonElement | null)?.disabled === false, 3_000, "the list in the field");
        wholeList();
        await eventually(() => rows().length > 0, 2_000, "the whole list");
        expect(rows()).toEqual(["gemini-3.8-flash", "claude-sonnet-5-5"]);
        // Its own name picked from the list is no pick: the conversation stays on the agent's own.
        row("gemini-3.8-flash")!.click();
        await eventually(() => rows().length === 0, 2_000, "the list closed on the pick");
        expect(says(host)).toBe("gemini-3.8-flash · low");
        expect(picked(host)).toBe(false);
        expect(backButton()).toBeUndefined();
      });
    } finally {
      seen.restore();
    }
  });

  test("a level and a model picked are the page's until the first message, which they go with: nothing is saved before", async () => {
    answer({ "/chat/choices": ok(OWN), "/chat/models": LISTED });
    const posted = recordPosts(SENT);
    try {
      await renderPage(NEW_CHAT, async (host) => {
        await opened(host);
        level("high")!.click();
        await eventually(() => says(host) === "gemini-3.8-flash · high", 2_000, "the level on the button");
        // A name typed is no pick yet: every prefix of it on the way would be one.
        type(field()!, "claude-son");
        await eventually(() => rows().length > 0, 2_000, "the list");
        expect(says(host)).toBe("gemini-3.8-flash · high");
        // The typed text first, then what the provider lists that holds it; a model that embeds is never offered.
        expect(rows().map((one) => one.replace(/use as typed$/, "").trim())).toEqual(["claude-son", "claude-sonnet-5-5"]);
        // The list is drawn at the body, outside the panel: a press on it is a press in the panel, which stays.
        pressDown(row("claude-sonnet-5-5")!);
        row("claude-sonnet-5-5")!.click();
        await eventually(() => says(host) === "claude-sonnet-5-5 · high", 2_000, "the model on the button");
        expect(button(host)!.getAttribute("aria-expanded")).toBe("true");
        expect(posted.posts).toEqual([]);
        // And a press anywhere else is a press away: the panel goes.
        pressDown(composer(host));
        await eventually(() => button(host)!.getAttribute("aria-expanded") === "false", 2_000, "the panel closed");

        type(composer(host), "halo");
        await eventually(() => sendButton(host)?.disabled === false, 2_000, "send enabled");
        sendButton(host)!.click();
        await eventually(() => posted.posts.some((post) => post.path === "/chat/send"), 3_000, "the message sent");
        expect(posted.posts.find((post) => post.path === "/chat/send")!.body).toEqual({ text: "halo", agent: "nouva", model: "claude-sonnet-5-5", effort: "high" });
      });
    } finally {
      posted.restore();
    }
  });

  test("a name typed and Enter is a pick; the agent's own name is its own back, and a message then carries no model", async () => {
    answer({ "/chat/choices": ok(OWN), "/chat/models": ok({ models: [] }) });
    const posted = recordPosts(SENT);
    try {
      await renderPage(NEW_CHAT, async (host) => {
        await opened(host);
        const typeAndEnter = (name: string) => {
          type(field()!, name);
          key(field()!, "Enter");
          submit(panel()!.querySelector("form")!);
        };
        // A level picked and taken back, before anything is sent: the agent's own again, and nothing left picked.
        level("high")!.click();
        await eventually(() => says(host) === "gemini-3.8-flash · high" && picked(host), 2_000, "the level picked");
        level("Nouva's own (low)")!.click();
        await eventually(() => says(host) === "gemini-3.8-flash · low" && !picked(host), 2_000, "the level taken back");

        typeAndEnter("my-own-finetune");
        await eventually(() => says(host) === "my-own-finetune · low", 2_000, "the typed model on the button");
        expect(picked(host)).toBe(true);
        expect(backButton()?.textContent?.trim()).toBe("Back to Nouva's own (gemini-3.8-flash)");
        // The field emptied and Enter: the agent's own back, never a model called nothing.
        typeAndEnter("");
        await eventually(() => says(host) === "gemini-3.8-flash · low", 2_000, "its own, by an emptied field");
        expect(picked(host)).toBe(false);
        // And by its button.
        typeAndEnter("my-own-finetune");
        await eventually(() => backButton() !== undefined, 2_000, "the way back");
        backButton()!.click();
        await eventually(() => says(host) === "gemini-3.8-flash · low" && !picked(host), 2_000, "its own, by the button");

        type(composer(host), "halo");
        await eventually(() => sendButton(host)?.disabled === false, 2_000, "send enabled");
        sendButton(host)!.click();
        await eventually(() => posted.posts.some((post) => post.path === "/chat/send"), 3_000, "the message sent");
        expect(posted.posts.find((post) => post.path === "/chat/send")!.body).toEqual({ text: "halo", agent: "nouva" });
      });
    } finally {
      posted.restore();
    }
  });
});

describe("the model field's list", () => {
  /** Forty models that chat, the agent's own after them, and one that embeds. */
  const MANY = ok({ models: [...Array.from({ length: 40 }, (_, index) => `model-${String(index + 1).padStart(2, "0")}`), "gemini-3.8-flash", "text-embedding-3-large"] });
  const listReady = () => eventually(() => (panel()!.querySelector('button[aria-label="Show the whole list"]') as HTMLButtonElement | null)?.disabled === false, 3_000, "the list in the field");
  const phone = () => dom.happyDOM.setViewport({ width: 390, height: 844 });

  test("is not there as the panel opens; a press on the field brings the whole of it, at the model the field holds", async () => {
    answer({ "/chat/choices": ok(OWN), "/chat/models": MANY });
    // What the list brought into view: no layout here, so the call itself is what is read.
    const shown: string[] = [];
    const rowsOf = (dom as unknown as { HTMLElement: { prototype: { scrollIntoView?: unknown } } }).HTMLElement.prototype;
    const had = rowsOf.scrollIntoView;
    rowsOf.scrollIntoView = function (this: HTMLElement) {
      shown.push(this.textContent?.trim() ?? "");
    };
    try {
      await renderPage(NEW_CHAT, async (host) => {
        await opened(host);
        await listReady();
        // The panel hands the field the focus as it opens: a list then would cover the levels under it.
        expect(rows()).toEqual([]);
        field()!.click();
        await eventually(() => rows().length > 0, 2_000, "the list on a press");
        // Every model that chats, though the field holds one of them: on typing alone it showed that one and no other.
        expect(rows().length).toBe(41);
        expect(rows()).not.toContain("text-embedding-3-large");
        // It scrolls: held to a height, and opened at the model the conversation is on, its forty-first row.
        const list = dom.document.querySelector('ul[role="listbox"]') as unknown as HTMLElement;
        expect(list.style.maxHeight).toBe("240px");
        expect(list.className).toContain("overflow-y-auto");
        expect(shown).toContain("gemini-3.8-flash");
        row("model-07")!.click();
        await eventually(() => says(host) === "model-07 · low", 2_000, "the row picked");
      });
    } finally {
      rowsOf.scrollIntoView = had;
    }
  });

  test("an emptied field shows the whole list again, and a name typed narrows it", async () => {
    answer({ "/chat/choices": ok(OWN), "/chat/models": MANY });
    await renderPage(NEW_CHAT, async (host) => {
      await opened(host);
      await listReady();
      type(field()!, "");
      await eventually(() => rows().length === 41, 2_000, "the whole list for an emptied field");
      type(field()!, "model-1");
      // The words typed, then the ten models that hold them.
      await eventually(() => rows().length === 11, 2_000, "the list narrowed");
      expect(rows().slice(1)).toEqual(Array.from({ length: 10 }, (_, index) => `model-1${index}`));
    });
  });

  test("Escape closes the list and leaves the panel; pressed again, it closes the panel", async () => {
    answer({ "/chat/choices": ok(OWN), "/chat/models": MANY });
    await renderPage(NEW_CHAT, async (host) => {
      await opened(host);
      await listReady();
      field()!.click();
      await eventually(() => rows().length > 0, 2_000, "the list on a press");
      key(field()!, "Escape");
      await eventually(() => rows().length === 0, 2_000, "the list closed");
      expect(field()).not.toBeNull();
      expect(panel()!.closest("[data-leaving]")).toBeNull();
      key(field()!, "Escape");
      await eventually(() => panel() === null || panel()!.closest("[data-leaving]") !== null, 2_000, "the panel closed");
    });
  });

  test("on a phone a press brings no list, which the keyboard would move under the finger: the field's arrow does", async () => {
    phone();
    answer({ "/chat/choices": ok(OWN), "/chat/models": MANY });
    await renderPage(NEW_CHAT, async (host) => {
      await opened(host);
      await listReady();
      field()!.click();
      type(field()!, "");
      await eventually(() => (panel()!.querySelector('button[aria-label="Show the whole list"]') as HTMLButtonElement).getAttribute("aria-expanded") === "false", 2_000, "the field settled");
      expect(rows()).toEqual([]);
      wholeList();
      await eventually(() => rows().length === 41, 2_000, "the whole list by the arrow");
    });
  });
});

describe("a conversation that has begun", () => {
  const CHOSEN: ChatChoices = { ...OWN, model: { own: "gemini-3.8-flash", chosen: "claude-sonnet-5-5" }, effort: { own: "low", chosen: "high" } };

  test("says what it chose, set apart from one on the agent's own, and its pick is saved at once and drawn from the answer", async () => {
    answer({ "/chat/choices?session=ses_1": ok(CHOSEN), "/chat/models": LISTED });
    const posted = recordPosts({ "/chat/choices": ok({ ...CHOSEN, effort: { own: "low", chosen: "max" } }) });
    try {
      await renderPage("/chat/ses_1", async (host) => {
        await eventually(() => says(host) !== null, 4_000, "the picker's button");
        expect(says(host)).toBe("claude-sonnet-5-5 · high");
        expect(picked(host)).toBe(true);
        expect(button(host)!.className).toContain("text-secondary");
        button(host)!.click();
        await eventually(() => panel() !== null, 3_000, "the panel");
        expect(checked()).toEqual(["high"]);
        level("max")!.click();
        await eventually(() => says(host) === "claude-sonnet-5-5 · max", 3_000, "the answer drawn");
        expect(posted.posts).toEqual([{ path: "/chat/choices", body: { sessionId: "ses_1", effort: "max" } }]);
      });
    } finally {
      posted.restore();
    }
  });

  test("the agent's own back is a pick of nothing, for the model and for the level", async () => {
    answer({ "/chat/choices?session=ses_1": ok(CHOSEN), "/chat/models": LISTED });
    const posted = recordPosts({ "/chat/choices": ok(OWN) });
    try {
      await renderPage("/chat/ses_1", async (host) => {
        await opened(host);
        [...panel()!.querySelectorAll("button")].find((one) => one.textContent?.trim().startsWith("Back to Nouva's own"))!.click();
        await eventually(() => posted.posts.length === 1, 3_000, "the model's pick");
        await eventually(() => says(host) === "gemini-3.8-flash · low", 3_000, "its own on the button");
        expect(picked(host)).toBe(false);
        level("Nouva's own (low)")!.click();
        await eventually(() => posted.posts.length === 2, 3_000, "the level's pick");
        expect(posted.posts.map((post) => post.body)).toEqual([{ sessionId: "ses_1", model: null }, { sessionId: "ses_1", effort: null }]);
      });
    } finally {
      posted.restore();
    }
  });

  test("a pick the daemon refuses is said in its words, and the button keeps what is in force", async () => {
    answer({ "/chat/choices?session=ses_1": ok(OWN), "/chat/models": LISTED });
    const posted = recordPosts({ "/chat/choices": { status: 400, body: { error: "its CLI does not offer `max`", plain: "That level is not offered for the model it is on. Pick another." } } });
    try {
      await renderPage("/chat/ses_1", async (host) => {
        await opened(host);
        level("max")!.click();
        await eventually(() => panel()?.textContent?.includes("That level is not offered for the model it is on. Pick another.") === true, 3_000, "the refusal");
        expect(says(host)).toBe("gemini-3.8-flash · low");
      });
    } finally {
      posted.restore();
    }
  });

  test("a level its model refused is said under the levels, with the model that refused it", async () => {
    answer({ "/chat/choices?session=ses_1": ok({ ...OWN, effort: { own: "low", chosen: "max", refusedBy: "gemini-3.8-flash" } }), "/chat/models": LISTED });
    await renderPage("/chat/ses_1", async (host) => {
      await opened(host);
      expect(panel()!.textContent).toContain("gemini-3.8-flash did not take max, so it is asked for none.");
    });
  });
});

describe("an agent a coding CLI answers", () => {
  const CLI: ChatChoices = { model: { own: "default" }, effort: {}, efforts: ["low", "high"], cli: { id: "claude", name: "Claude Code", models: [{ value: "default", name: "Opus 5.5" }, { value: "sonnet", name: "Sonnet 5.5" }] } };

  test("picks among its CLI's own models by their names, and its provider is never asked for a list", async () => {
    answer({ "/chat/choices?session=ses_1": ok(CLI) });
    const seen = watch("/chat/models");
    const posted = recordPosts({ "/chat/choices": ok({ ...CLI, model: { own: "default", chosen: "sonnet" } }) });
    try {
      await renderPage("/chat/ses_1", async (host) => {
        await eventually(() => says(host) !== null, 4_000, "the picker's button");
        // The model by the name its CLI gives it, and no level where the agent sets none.
        expect(says(host)).toBe("Opus 5.5");
        button(host)!.click();
        await eventually(() => field() !== null, 3_000, "the panel");
        expect([...panel()!.querySelectorAll('[role="radio"]')].map((one) => one.textContent?.trim())).toEqual(["Nouva's own", "low", "high"]);
        // The whole list, by the field's own arrow: nothing is typed, and the panel opened with no list over it.
        expect(rows()).toEqual([]);
        (panel()!.querySelector('button[aria-label="Show the whole list"]') as HTMLButtonElement).click();
        await eventually(() => rows().length === 2, 2_000, "its CLI's models");
        expect(rows()).toEqual([expect.stringContaining("Opus 5.5"), expect.stringContaining("Sonnet 5.5")]);
        row("Sonnet 5.5")!.click();
        await eventually(() => says(host) === "Sonnet 5.5", 3_000, "the pick drawn");
        expect(posted.posts).toEqual([{ path: "/chat/choices", body: { sessionId: "ses_1", model: "sonnet" } }]);
        expect(seen.asked).toEqual([]);
      });
    } finally {
      posted.restore();
      seen.restore();
    }
  });

  test("before its CLI has listed any model, says so and where its model is set: the agent's own page", async () => {
    answer({ "/chat/choices?session=ses_1": ok({ ...CLI, model: { own: "" }, cli: { id: "claude", name: "Claude Code", models: [] } }) });
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => says(host) !== null, 4_000, "the picker's button");
      expect(says(host)).toBe("Claude Code's own");
      button(host)!.click();
      await eventually(() => panel() !== null, 3_000, "the panel");
      expect(panel()!.textContent).toContain("Claude Code lists its models after its first answer.");
      const link = panel()!.querySelector("a") as HTMLAnchorElement;
      expect(link.textContent).toBe("Nouva's own page");
      expect(link.getAttribute("href")).toEndWith("/agents/nouva/cli");
    });
  });
});

describe("where nothing can be picked, there is no picker", () => {
  const drawn = async (path: string) => {
    let there: boolean | undefined;
    await renderPage(path, async (host, app) => {
      await eventually(() => host.querySelector("header h2") !== null && composerOrNote(host), 4_000, "the conversation");
      // Every read the page began has come back, the picker's own among them where it made one.
      await eventually(() => app.queryClient.isFetching() === 0, 4_000, "the page's reads");
      there = button(host) !== undefined;
    });
    return there;
  };
  const composerOrNote = (host: HTMLElement) => host.querySelector("textarea") !== null || host.textContent?.includes("Read-only") === true;

  test("an account that only reads", async () => {
    const me = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
    answer({ "/chat/choices": ok(OWN), "/auth/me": ok({ ...me, role: "viewer", user: { ...me.user, role: "viewer" } }) });
    expect(await drawn("/chat/ses_1")).toBe(false);
  });

  test("a conversation that lives on a chat app, read here", async () => {
    const transcript = WIRE["/sessions/ses_1/turns"] as { session: Record<string, unknown> } & Record<string, unknown>;
    answer({ "/chat/choices": ok(OWN), "/sessions/ses_1/turns": ok({ ...transcript, session: { ...transcript.session, gatewayId: "telegram:nouva", writable: false } }) });
    expect(await drawn("/chat/ses_1")).toBe(false);
  });

  test("a daemon that answers nothing of it: no button, where a dead one would be worse", async () => {
    answer({ "/chat/choices": { status: 404, body: { error: "not found" } } });
    expect(await drawn("/chat/ses_1")).toBe(false);
  });

  test("an answer that is not the picker's: no button, and the conversation is still on the page", async () => {
    for (const body of [{}, { model: { own: "x" } }, { efforts: [] }]) {
      answer({ "/chat/choices": ok(body) });
      expect({ body, there: await drawn("/chat/ses_1") }).toEqual({ body, there: false });
    }
  });

  test("and it is there for an account that writes, in its own conversation", async () => {
    answer({ "/chat/choices": ok(OWN) });
    expect(await drawn("/chat/ses_1")).toBe(true);
  });
});
