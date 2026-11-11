/**
 * The chat that floats over every page: a button with an agent's face on it, and the panel it opens, so a person asks
 * an agent about what they are looking at without leaving the page. Through the whole app, as a person meets it.
 *
 * Each case is a way it would let somebody down: a panel that does not open or does not go, the wrong agent, a message
 * into a conversation Chats does not have, an agent not told which page is open, a page moved from under the person, a
 * button where there must be none, a card where a phone needs a sheet, or a tab that holds a connection and asks the
 * daemon for a conversation nobody is looking at.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { agentAtOpen, agentOfPage } from "@/commons/lib/floating-chat";
import { sectionTitle } from "@/commons/components/floating-chat/page-open";
import { DAILY, SETTINGS } from "@/commons/components/layout/nav";
import { sectionTabs } from "@/commons/components/layout/SectionTabs";
import { answer, dom, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { AT_REST, boxIn, card, FakeEventSource, floatButton, LAST_AGENT_KEY, pressKey, recordRequests, sendIn, sheet } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const globals = globalThis as unknown as Record<string, unknown>;
const phone = () => dom.happyDOM.setViewport({ width: 390, height: 844 });

afterEach(() => {
  dom.localStorage.removeItem(LAST_AGENT_KEY);
  dom.happyDOM.setViewport({ width: 1024, height: 768 });
  delete globals.EventSource;
  FakeEventSource.opened = [];
});

/** What the menu calls a section's tab and a menu item, read from the menu: a renamed one is not this test's to know. */
const tabLabel = (to: string) => sectionTabs(to)!.find((one) => one.to === to)!.label;
const itemLabel = (to: string) => [...DAILY, ...SETTINGS.flatMap((group) => group.items)].find((one) => one.to === to)!.label;

const focused = () => dom.document.activeElement as unknown as HTMLElement | null;
/**
 * Whether the card is open to stay: drawn, and not on its way out. A card that was just closed is still drawn for the
 * moment it takes to leave (`Leaving`), so "still there" alone would be true of one that a key wrongly closed.
 */
const staying = () => card() !== null && card()!.parentElement?.hasAttribute("data-leaving") === false;
/** What a key or a press just changed, drawn now: React draws a store's change a moment after the event that made it. */
async function drawn(): Promise<void> {
  const { flushSync } = await import("react-dom");
  flushSync(() => {});
}
/** The panel open, with the conversation drawn in it: the box is there to write in. */
async function open(host: HTMLElement, panel: () => HTMLElement | null = card): Promise<void> {
  await eventually(() => floatButton(host) !== null, 3_000, "the button");
  floatButton(host)!.click();
  await eventually(() => boxIn(panel()) !== null, 3_000, "the conversation in the panel");
}
const link = () => card()?.querySelector('a[aria-label="Open this conversation in Chats"]') as HTMLAnchorElement | null;
const sent = (posts: { path: string; body: unknown }[]) => posts.filter((post) => post.path === "/chat/send").map((post) => post.body);
const reply = (id: string, prompt: string, words: string) => ({
  status: 200,
  body: { jobs: [], turn: { id, agentId: "nouva", chatId: "web-1", sessionId: "ses_1", status: "done", prompt, reply: words, toolCalls: 0, startedAt: 1_760_000_001_000, endedAt: 1_760_000_002_000, durationMs: 1_000, steps: [], cursor: 0 } },
});

describe("opening and closing", () => {
  test("the button opens the panel over the page; pressing it again, Escape or the panel's own close puts it away", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await eventually(() => floatButton(host) !== null, 3_000, "the button");
      const button = floatButton(host)!;
      expect(button.getAttribute("aria-label")).toBe("Chat with Nouva");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(card()).toBeNull();

      // Pressed as a browser presses it: the button has the focus, and the box takes it from there.
      button.focus();
      button.click();
      await eventually(() => card() !== null, 2_000, "the panel");
      expect(card()!.getAttribute("role")).toBe("dialog");
      expect(card()!.getAttribute("aria-label")).toBe("Chat with Nouva");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.getAttribute("aria-label")).toBe("Close the chat with Nouva");
      // The box to write in takes the focus once the conversation is drawn.
      await eventually(() => boxIn(card()) !== null && focused() === boxIn(card()), 3_000, "the box focused");
      // The page under it is still there: nothing is drawn in its place.
      expect(host.querySelector("h1")?.textContent).toBe("Skills Workshop");

      button.click();
      await eventually(() => card() === null, 2_000, "put away by the button");
      expect(button.getAttribute("aria-expanded")).toBe("false");

      button.click();
      await eventually(() => boxIn(card()) !== null && focused() === boxIn(card()), 3_000, "open again");
      pressKey("Escape");
      await eventually(() => card() === null, 2_000, "put away by Escape");
      // And the focus is back on the button.
      expect(focused()).toBe(button);

      button.click();
      await eventually(() => card() !== null, 2_000, "open a third time");
      (card()!.querySelector('button[aria-label="Close the chat"]') as HTMLElement).click();
      await eventually(() => card() === null, 2_000, "put away by its own close");
    });
  });

  test("what is written and not sent is still in the box when the panel is opened again", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await open(host);
      type(boxIn(card())!, "half a thought");
      await eventually(() => sendIn(card())?.disabled === false, 2_000, "typed");
      floatButton(host)!.click();
      await eventually(() => card() === null, 2_000, "closed");
      await open(host);
      expect(boxIn(card())!.value).toBe("half a thought");
    });
  });

  test("Escape puts the list of agents away first, and the panel with the next", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await open(host);
      const picker = () => card()?.querySelector('button[aria-label^="Chatting with "]') as HTMLElement | null;
      const listed = () => [...(card()?.querySelectorAll("li button") ?? [])].map((row) => row.textContent?.replace(/\s+/g, " ").trim());
      picker()!.click();
      await eventually(() => listed().length === 2, 2_000, "the agents");
      // The orchestrator first and marked, as every list of agents has it; each with what it is for.
      expect(listed()).toEqual(["NouvaOrchestrator", "Nixengineer"]);
      pressKey("Escape");
      await eventually(() => listed().length === 0, 2_000, "the list put away");
      expect(staying()).toBe(true);
      pressKey("Escape");
      await eventually(() => card() === null, 2_000, "the panel put away");
    });
  });

  test("an Escape that is somebody else's leaves it open: one pressed in the page under it, one for a picture open over it", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await open(host);
      // The page under it is in reach, and an Escape pressed there is the page's.
      (host.querySelector('nav[aria-label="Menu"] a') as HTMLElement).focus();
      expect(card()!.contains(focused())).toBe(false);
      pressKey("Escape");
      await drawn();
      expect(staying()).toBe(true);
      // A picture opened from the conversation lies over the page as a dialog of its own, and closes by its own Escape.
      boxIn(card())!.focus();
      const picture = dom.document.createElement("div");
      picture.setAttribute("role", "dialog");
      dom.document.body.appendChild(picture);
      pressKey("Escape");
      await drawn();
      picture.remove();
      expect(staying()).toBe(true);
      pressKey("Escape");
      await eventually(() => card() === null, 2_000, "its own Escape puts it away");
    });
  });
});

describe("which agent it opens on", () => {
  const agents = [{ id: "nouva" }, { id: "nix" }];

  test("the page's own agent, else the one it was last on in this browser, else the orchestrator", () => {
    expect(agentAtOpen({ page: undefined, last: "", orchestrator: "nouva", agents })).toBe("nouva");
    expect(agentAtOpen({ page: undefined, last: "nix", orchestrator: "nouva", agents })).toBe("nix");
    expect(agentAtOpen({ page: "nix", last: "nouva", orchestrator: "nouva", agents })).toBe("nix");
  });

  test("an agent the daemon no longer has is passed over, and a box with no orchestrator opens on its first agent", () => {
    expect(agentAtOpen({ page: "ghost", last: "gone", orchestrator: "nouva", agents })).toBe("nouva");
    expect(agentAtOpen({ page: undefined, last: "gone", orchestrator: null, agents })).toBe("nouva");
    expect(agentAtOpen({ page: undefined, last: "", orchestrator: null, agents: [] })).toBe("");
  });

  test("a page is an agent's by its address: its own pages, not the list and not every agent's settings", () => {
    expect(["/agents/nix", "/agents/nix/model", "/agents", "/agents/settings", "/missions/msn_1", "/agentsmith/nix"].map(agentOfPage)).toEqual(["nix", "nix", undefined, undefined, undefined, undefined]);
  });

  test("as the app draws it: the orchestrator at first, the last one used after that, and an agent's page its own agent", async () => {
    answer(AT_REST);
    const face = async (path: string) => {
      let label = "";
      await renderPage(path, async (host) => {
        await eventually(() => floatButton(host) !== null, 3_000, "the button");
        label = floatButton(host)!.getAttribute("aria-label") ?? "";
        // Its face is the agent's own cat, not a mark alone.
        expect(floatButton(host)!.querySelector("canvas, img, svg")).not.toBeNull();
      });
      return label;
    };
    expect(await face("/skills")).toBe("Chat with Nouva");
    dom.localStorage.setItem(LAST_AGENT_KEY, JSON.stringify("nix"));
    expect(await face("/skills")).toBe("Chat with Nix");
    dom.localStorage.setItem(LAST_AGENT_KEY, JSON.stringify("nouva"));
    expect(await face("/agents/nix/model")).toBe("Chat with Nix");
  });

  test("the person picks another in the panel's bar: the conversation is that agent's, and it is the one it opens on next", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await open(host);
      expect(boxIn(card())!.getAttribute("placeholder")).toBe("Message Nouva…");
      (card()!.querySelector('button[aria-label^="Chatting with Nouva"]') as HTMLElement).click();
      await eventually(() => card()!.querySelectorAll("li button").length === 2, 2_000, "the agents");
      // The one it is on is marked.
      expect([...card()!.querySelectorAll('li button[aria-current="true"]')].map((row) => row.textContent)).toEqual(["NouvaOrchestrator"]);
      ([...card()!.querySelectorAll("li button")].find((row) => row.textContent?.startsWith("Nix")) as HTMLElement).click();
      await eventually(() => boxIn(card())?.getAttribute("placeholder") === "Message Nix…", 3_000, "Nix's conversation");
      expect(card()!.getAttribute("aria-label")).toBe("Chat with Nix");
      // Nix has no conversation yet: none of Nouva's is drawn under its name.
      expect(card()!.textContent).not.toContain("is the disk full?");
      expect(dom.localStorage.getItem(LAST_AGENT_KEY)).toBe(JSON.stringify("nix"));
    });
    let next = "";
    await renderPage("/skills", async (host) => {
      await eventually(() => floatButton(host) !== null, 3_000, "the button");
      next = floatButton(host)!.getAttribute("aria-label") ?? "";
    });
    expect(next).toBe("Chat with Nix");
  });
});

describe("the conversation in it", () => {
  test("is the one Chats has: a message goes into it with the page that is open, and its answer is drawn in the panel", async () => {
    answer(AT_REST);
    const posted = recordPosts({ "/chat/send": { status: 200, body: { sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" } } });
    try {
      await renderPage("/missions/msn_1", async (host, app) => {
        await open(host);
        // What was said before is here, as Chats draws it.
        await eventually(() => card()!.textContent?.includes("is the disk full?") === true, 3_000, "the transcript");
        expect(card()!.textContent).toContain("40% used");
        type(boxIn(card())!, "what is this one about?");
        await eventually(() => sendIn(card())?.disabled === false, 2_000, "send enabled");
        answer({ ...AT_REST, "/sessions/ses_1/live": reply("turn_9", "what is this one about?", "A report on the build box's disk.") });
        sendIn(card())!.click();
        await eventually(() => card()?.textContent?.includes("A report on the build box's disk.") === true, 4_000, "the answer in the panel");
        expect(boxIn(card())!.value).toBe("");
        // The page under it stays where it was.
        expect(app.location()).toEndWith("/missions/msn_1");
      });
      expect(sent(posted.posts)).toEqual([
        // Into the conversation by its id: whose it is, the daemon knows. And with the page, what it is called and about.
        {
          text: "what is this one about?",
          sessionId: "ses_1",
          page: { path: "/dashboard/missions/msn_1", title: tabLabel("/missions"), subject: "Write a report on the disk usage of the build box" },
        },
      ]);
    } finally {
      posted.restore();
    }
  });

  test("a turn at work is there as on Chats: its steps, its plan, the approval it waits on answered there, and Stop", async () => {
    const approval = { id: "ap_1", agentId: "nouva", chatId: "web-1", tool: "exec", params: { command: "rm -rf build/cache" }, grantable: false, requestedAt: Date.now(), timeoutMs: 60_000 };
    // The conversation as the daemon's own fixture has it: a turn at work, a step of it waiting on an approval.
    answer({ "/status": AT_REST["/status"], "/approvals": { status: 200, body: { pending: [approval] } } });
    const posted = recordPosts({ "/approvals/ap_1/deny": { status: 200, body: { ok: true, id: "ap_1", decision: "deny" } }, "/stop": { status: 200, body: { stopped: 1 } } });
    const posts = (path: string) => posted.posts.filter((post) => post.path === path).map((post) => post.body);
    try {
      await renderPage("/skills", async (host) => {
        await open(host);
        // What was asked, that it is at work and on what, and its steps a press away.
        await eventually(() => card()!.textContent?.includes("clean the build") === true, 3_000, "the turn at work");
        expect(card()!.textContent).toContain("waiting for approval: exec");
        expect(card()!.textContent).toContain("3 steps");
        // Its bar says so too, and the plan it keeps is over the box.
        expect(card()!.querySelector('button[aria-label^="Chatting with Nouva"]')?.textContent).toContain("Working");
        expect(card()!.textContent).toContain("2 of 4");
        // The approval it waits on, with what it would run, answered here.
        await eventually(() => card()!.textContent?.includes("rm -rf build/cache") === true, 3_000, "the approval");
        ([...card()!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Deny") as HTMLElement).click();
        await eventually(() => posts("/approvals/ap_1/deny").length === 1, 3_000, "the answer");
        // And Stop, beside Send.
        (card()!.querySelector('button[aria-label="Stop what is running"]') as HTMLElement).click();
        await eventually(() => posts("/stop").length === 1, 3_000, "the stop");
      });
      expect(posts("/stop")).toEqual([{ chatId: "web-1" }]);
      expect(posts("/chat/send")).toEqual([]);
    } finally {
      posted.restore();
    }
  });

  test("nothing can be written before the person's conversations are read: a message must not start a second one", async () => {
    answer({ ...AT_REST, "/chat-list": { status: 200, body: {}, hold: true } });
    await renderPage("/skills", async (host) => {
      await eventually(() => floatButton(host) !== null, 3_000, "the button");
      floatButton(host)!.click();
      // Its bar and the shape of a conversation on its way, and no box to write in.
      await eventually(() => card()?.querySelector('[aria-busy="true"]') != null, 2_000, "the conversation on its way");
      expect(card()!.querySelector('button[aria-label^="Chatting with Nouva"]')).not.toBeNull();
      expect(boxIn(card())).toBeNull();
    });
  });

  test("a read that fails says so and can be tried again; nothing is drawn as a new chat meanwhile", async () => {
    answer({ ...AT_REST, "/chat-list": { status: 500, body: { error: "the list is not readable" } } });
    await renderPage("/skills", async (host) => {
      await eventually(() => floatButton(host) !== null, 3_000, "the button");
      floatButton(host)!.click();
      await eventually(() => card()?.querySelector('[role="alert"]') != null, 3_000, "what failed");
      expect(card()!.textContent).toContain("the list is not readable");
      expect(boxIn(card())).toBeNull();
      answer(AT_REST);
      ([...card()!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Try again") as HTMLElement).click();
      await eventually(() => boxIn(card()) !== null, 3_000, "the conversation, once the list is read");
      expect(link()!.getAttribute("href")).toBe("/dashboard/chat/ses_1");
    });
  });

  test("opened again, what it read last is drawn at once: the panel does not wait on a slow line to show a conversation it knows", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await open(host);
      floatButton(host)!.click();
      await eventually(() => card() === null, 2_000, "closed");
      // This opening's read is on its way and does not answer.
      answer({ ...AT_REST, "/chat-list": { status: 200, body: {}, hold: true } });
      await open(host);
      expect(link()!.getAttribute("href")).toBe("/dashboard/chat/ses_1");
    });
  });

  test("the list is read again at each opening: a conversation started elsewhere since is the one it shows", async () => {
    answer(AT_REST);
    const list = WIRE["/chat-list"] as { agents: Record<string, unknown>[] } & Record<string, unknown>;
    await renderPage("/skills", async (host) => {
      await open(host);
      expect(link()!.getAttribute("href")).toBe("/dashboard/chat/ses_1");
      floatButton(host)!.click();
      await eventually(() => card() === null, 2_000, "closed");
      // A new chat with Nouva, started on the Chats page of another tab.
      answer({ ...AT_REST, "/chat-list": { status: 200, body: { ...list, agents: [{ ...list.agents[0], sessionId: "ses_2" }] } } });
      floatButton(host)!.click();
      await eventually(() => link()?.getAttribute("href") === "/dashboard/chat/ses_2", 3_000, "the conversation started since");
    });
  });

  test("its bar's link opens the same conversation on the Chats page, where there is no floating chat", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host, app) => {
      await open(host);
      expect(link()!.getAttribute("href")).toBe("/dashboard/chat/ses_1");
      link()!.click();
      await eventually(() => app.location().endsWith("/chat/ses_1"), 3_000, "the Chats page");
      await eventually(() => card() === null && floatButton(host) === null, 2_000, "no floating chat on Chats");
      await eventually(() => host.querySelector('[aria-label="Conversation"]')?.textContent?.includes("is the disk full?") === true, 3_000, "the same transcript");
    });
  });

  test("a first message to an agent starts its conversation without leaving the page, and the next goes into it", async () => {
    answer(AT_REST);
    dom.localStorage.setItem(LAST_AGENT_KEY, JSON.stringify("nix"));
    const posted = recordPosts({ "/chat/send": { status: 200, body: { sessionId: "ses_nix", chatId: "web-2", messageId: "msg_1", agentId: "nix" } } });
    try {
      await renderPage("/skills", async (host, app) => {
        await open(host);
        expect(boxIn(card())!.getAttribute("placeholder")).toBe("Message Nix…");
        // A new chat with it, until something is said.
        expect(link()!.getAttribute("href")).toBe("/dashboard/chat?agent=nix");
        // Its openers in one column, each whole: the panel is a phone's width in a wide window.
        const openers = card()!.querySelector("div.grid") as HTMLElement;
        expect(openers.textContent).toContain("Hi Nix, introduce yourself");
        expect(openers.className).not.toContain("sm:grid-cols-2");
        type(boxIn(card())!, "hello");
        await eventually(() => sendIn(card())?.disabled === false, 2_000, "send enabled");
        sendIn(card())!.click();
        await eventually(() => link()?.getAttribute("href") === "/dashboard/chat/ses_nix", 3_000, "the conversation it started, kept by the panel");
        expect(app.location()).toEndWith("/skills");
        type(boxIn(card())!, "and again");
        await eventually(() => sendIn(card())?.disabled === false, 2_000, "send enabled again");
        sendIn(card())!.click();
        await eventually(() => sent(posted.posts).length === 2, 3_000, "the second message");
        // Closed and opened before the list knows the conversation (here it never does): still that one, not a new chat.
        floatButton(host)!.click();
        await eventually(() => card() === null, 2_000, "closed");
        await open(host);
        expect(link()!.getAttribute("href")).toBe("/dashboard/chat/ses_nix");
      });
      // The page says its own title (`PageHeader`), and nothing it is about: it is a list.
      const page = { path: "/dashboard/skills", title: "Skills Workshop" };
      expect(sent(posted.posts)).toEqual([
        { text: "hello", agent: "nix", page },
        { text: "and again", sessionId: "ses_nix", page },
      ]);
    } finally {
      posted.restore();
    }
  });

  test("the page a message names is the one on screen as it is sent: a page that is gone takes what it was about with it", async () => {
    answer(AT_REST);
    const posted = recordPosts({ "/chat/send": { status: 200, body: { sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" } } });
    try {
      await renderPage("/missions/msn_1", async (host, app) => {
        await open(host);
        (host.querySelector('nav[aria-label="Menu"] a[href="/dashboard/skills"]') as HTMLElement).click();
        await eventually(() => app.location().endsWith("/skills") && host.querySelector("h1")?.textContent === "Skills Workshop", 3_000, "the Skills page");
        // From a tablet's width up the card stays over the page it is taken to.
        await drawn();
        expect(staying()).toBe(true);
        type(boxIn(card())!, "and this page?");
        await eventually(() => sendIn(card())?.disabled === false, 2_000, "send enabled");
        sendIn(card())!.click();
        await eventually(() => sent(posted.posts).length === 1, 3_000, "sent");
      });
      expect(sent(posted.posts)).toEqual([{ text: "and this page?", sessionId: "ses_1", page: { path: "/dashboard/skills", title: "Skills Workshop" } }]);
    } finally {
      posted.restore();
    }
  });

  test("a page with no title of its own is named by where the menu puts it: its section's tab, else its menu item", () => {
    // One mission's page is in Missions and one agent's pages are in Agents: the nearest tab at or over the address.
    expect(["/missions/msn_1", "/missions/msn_1/", "/agents/nix/model"].map(sectionTitle)).toEqual([tabLabel("/missions"), tabLabel("/missions"), tabLabel("/agents")]);
    // A page of no section is its menu item; Settings is its own; an address the menu does not know is nothing.
    expect(["/", "/llm-gateway/keys", "/settings", "/nowhere"].map(sectionTitle)).toEqual([itemLabel("/"), itemLabel("/llm-gateway"), "Settings", ""]);
    // And the menu says something for each: the names above are not all empty.
    expect([tabLabel("/missions"), tabLabel("/agents"), itemLabel("/"), itemLabel("/llm-gateway")].every((label) => label.length > 0)).toBe(true);
  });
});

describe("where it is not", () => {
  const status = WIRE["/status"] as Record<string, unknown>;
  const me = WIRE["/auth/me"] as { user: Record<string, unknown> };

  test("on Chats, where the conversation is the page; and on a page without the menu", async () => {
    answer(AT_REST);
    // Where it is, the test finds it: so not finding it below means it is not there.
    await renderPage("/agents", async (host) => {
      await eventually(() => floatButton(host) !== null, 3_000, "the button on a page with the menu");
    });
    for (const path of ["/chat", "/chat/ses_1"]) {
      await renderPage(path, async (host) => {
        await eventually(() => host.querySelector("textarea")?.getAttribute("placeholder") === "Message Nouva…", 3_000, `${path}, with its agents known`);
        expect(floatButton(host)).toBeNull();
      });
    }
    await renderPage("/welcome", async (host) => {
      await eventually(() => host.querySelector('input[type="password"]') !== null, 3_000, "the first password's page");
      expect(host.querySelector('nav[aria-label="Menu"]')).toBeNull();
      expect(floatButton(host)).toBeNull();
    });
    answer({ "/auth/me": { status: 401, body: { error: "not signed in" } } });
    await renderPage("/login", async (host) => {
      await eventually(() => host.querySelector('input[type="password"]') !== null, 3_000, "the sign-in page");
      expect(floatButton(host)).toBeNull();
    });
  });

  test("for an account that may only read, which sends nothing; and on a box with no agent to talk to", async () => {
    answer({ ...AT_REST, "/auth/me": { status: 200, body: { ...me, role: "viewer", user: { ...me.user, role: "viewer" } } } });
    await renderPage("/agents", async (host) => {
      // The agents are on the page: the button would have been drawn with them.
      await eventually(() => host.querySelector("main")?.textContent?.includes("Nix") === true, 3_000, "the agents listed");
      expect(floatButton(host)).toBeNull();
    });
    answer({ "/status": { status: 200, body: { ...status, agents: [] } } });
    await renderPage("/skills", async (host) => {
      await eventually(() => host.querySelector("h1")?.textContent === "Skills Workshop", 3_000, "the page");
      expect(floatButton(host)).toBeNull();
    });
  });
});

describe("on a phone", () => {
  test("it is a sheet from the foot of the screen, which keeps the focus so the keyboard stays down", async () => {
    phone();
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await open(host, sheet);
      expect(card()).toBeNull();
      expect(sheet()!.getAttribute("role")).toBe("dialog");
      expect(sheet()!.getAttribute("aria-label")).toBe("Chat with Nouva");
      await eventually(() => sheet()!.textContent?.includes("is the disk full?") === true, 3_000, "the transcript");
      expect(focused()).not.toBe(boxIn(sheet()));
      (sheet()!.querySelector('button[aria-label="Close the chat"]') as HTMLElement).click();
      await eventually(() => sheet() === null, 2_000, "the sheet put away");
      // And what was in it is let go a moment after: closed, no conversation is drawn.
      await eventually(() => dom.document.querySelector('[data-drawer="bottom"][aria-label^="Chat with "] textarea') === null, 2_000, "the conversation gone");
    });
  });

  test("a page opened while it is up puts the sheet away, where a card would stay", async () => {
    phone();
    answer(AT_REST);
    await renderPage("/skills", async (host, app) => {
      await open(host, sheet);
      (host.querySelector('nav[aria-label="Tabs"] a[href="/dashboard/agents"]') as HTMLElement).click();
      await eventually(() => app.location().endsWith("/agents"), 3_000, "the Agents page");
      await eventually(() => sheet() === null, 2_000, "the sheet put away");
    });
  });
});

describe("light on the browser", () => {
  test("closed, it asks the daemon for no conversation and holds no stream; open, one stream, closed with the panel", async () => {
    globals.EventSource = FakeEventSource;
    answer(AT_REST);
    const asked = recordRequests();
    const conversation = () => asked.paths.filter((path) => path === "/chat-list" || path.startsWith("/sessions/"));
    try {
      await renderPage("/skills", async (host) => {
        await eventually(() => floatButton(host) !== null, 3_000, "the button");
        expect(conversation()).toEqual([]);
        expect(FakeEventSource.opened).toEqual([]);

        floatButton(host)!.click();
        await eventually(() => FakeEventSource.opened.length === 1, 3_000, "its stream");
        expect(FakeEventSource.opened[0]!.url).toContain("chat=web-1");
        expect(conversation()).toEqual(expect.arrayContaining(["/chat-list", "/sessions/ses_1/turns", "/sessions/ses_1/live"]));

        floatButton(host)!.click();
        await eventually(() => card() === null && FakeEventSource.opened.every((stream) => stream.closed), 2_000, "the stream closed with the panel");
        expect(FakeEventSource.opened).toHaveLength(1);
      });
    } finally {
      asked.restore();
    }
  });
});
