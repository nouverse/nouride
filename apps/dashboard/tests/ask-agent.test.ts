/**
 * "Ask Nouva to set it up" (0.8.19): where the dashboard cannot do a thing and the orchestrator can, the button opens
 * the chat over the page, with the orchestrator and a message written in the box, for the person to read and send.
 * Never sent by the page: `?initialMessage=` once sent itself again on every reload. The message replaces what the box
 * held: put under it, the ask from the page before sat over this one and the two went as one request. Through the whole
 * app, from the Models page's Coding CLIs card, where it is first used.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { AskAgentButton } from "@/commons/components/agents/AskAgentButton";
import { answer, dom, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { AT_REST, boxIn, card, floatButton, LAST_AGENT_KEY, sendIn } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

afterEach(() => dom.localStorage.removeItem(LAST_AGENT_KEY));

const MESSAGE = "Please install Claude Code on this server, with what Nouride needs to use it as an agent (its ACP adapter), and tell me when it is ready to sign in.";
const MISSING = { id: "claude-code", name: "Claude Code", maker: "Anthropic", installed: false, install: "npm i -g @agentclientprotocol/claude-agent-acp", shared: true, canLogin: true, accounts: [] };
const STATUS = { ...(WIRE["/status"] as Record<string, unknown>), orchestrator: "nouva" };
const CLIS = { "/cli-accounts": { status: 200, body: { clis: [MISSING] } } };

const ask = (host: HTMLElement) => [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Ask Nouva to set it up") as HTMLButtonElement | undefined;
const focused = () => dom.document.activeElement as unknown as HTMLElement | null;
const sent = (posts: { path: string; body: unknown }[]) => posts.filter((post) => post.path === "/chat/send");

describe("Ask Nouva to set it up", () => {
  test("opens the chat over the page with Nouva and the message in the box, the caret in it: not sent, and the page not left", async () => {
    answer({ ...AT_REST, ...CLIS });
    const posted = recordPosts();
    try {
      await renderPage("/models?tab=clis", async (host, app) => {
        await eventually(() => ask(host) !== undefined, 3_000, "the button");
        expect(host.textContent).toContain("Claude Code is not set up on this server yet.");
        ask(host)!.click();
        await eventually(() => boxIn(card())?.value === MESSAGE, 3_000, "the message in the box");
        // The chat is Nouva's: the box says whom it writes to.
        expect(boxIn(card())!.getAttribute("placeholder")).toBe("Message Nouva…");
        // The caret is in it, for the person to change it.
        await eventually(() => focused() === boxIn(card()), 2_000, "the box focused");
        // Still on the page that was asked about, with nothing of the message in its address.
        expect(app.location()).toBe("/models");
        expect(app.search()).toEqual({ tab: "clis" });
        // Pressed again, it is not written twice.
        ask(host)!.click();
        await eventually(() => focused() === boxIn(card()), 2_000, "the box focused again");
        expect(boxIn(card())!.value).toBe(MESSAGE);
        // Deleted by the person and asked for again, it is written again: the first was let go of once it was in the box.
        type(boxIn(card())!, "");
        ask(host)!.click();
        await eventually(() => boxIn(card())!.value === MESSAGE, 2_000, "the message again");
      });
      // And never sent: no request carried it.
      expect(sent(posted.posts)).toEqual([]);
    } finally {
      posted.restore();
    }
  });

  test("what the box held, an ask from another page, is replaced by the message, whichever agent the chat was on", async () => {
    answer({ ...AT_REST, ...CLIS });
    dom.localStorage.setItem(LAST_AGENT_KEY, JSON.stringify("nix"));
    const posted = recordPosts();
    try {
      await renderPage("/models?tab=clis", async (host) => {
        await eventually(() => floatButton(host) !== null && ask(host) !== undefined, 3_000, "the page");
        // The chat is open on Nix, holding the ask another page wrote there and nobody sent.
        floatButton(host)!.click();
        await eventually(() => boxIn(card())?.getAttribute("placeholder") === "Message Nix…", 3_000, "Nix's chat");
        type(boxIn(card())!, "Update Claude Code on this server: run `nouride cli update claude-code`, and tell me how it went.");
        await eventually(() => sendIn(card())?.disabled === false, 2_000, "typed");
        // Pressed as a browser presses it: the button on the page has the focus, outside the open chat.
        ask(host)!.focus();
        ask(host)!.click();
        // The orchestrator is asked, as the button says, and the box holds this page's message alone.
        await eventually(() => boxIn(card())?.getAttribute("placeholder") === "Message Nouva…", 3_000, "Nouva's chat");
        await eventually(() => boxIn(card())!.value === MESSAGE, 2_000, "the message alone in the box");
        // And the caret is brought to it, from the page.
        await eventually(() => focused() === boxIn(card()), 2_000, "the box focused, from the page");
      });
      expect(sent(posted.posts)).toEqual([]);
    } finally {
      posted.restore();
    }
  });

  test("a file attached in the box and not sent goes with what the box held: the message is sent alone", async () => {
    answer({ ...AT_REST, ...CLIS, "/chat/upload": { status: 200, body: { files: [{ path: "/srv/uploads/shot.png", name: "shot.png", mimeType: "image/png", bytes: 4 }] } } });
    dom.localStorage.setItem(LAST_AGENT_KEY, JSON.stringify("nix"));
    const posted = recordPosts({ "/chat/send": { status: 200, body: { sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" } } });
    try {
      await renderPage("/models?tab=clis", async (host) => {
        await eventually(() => floatButton(host) !== null && ask(host) !== undefined, 3_000, "the page");
        floatButton(host)!.click();
        await eventually(() => boxIn(card())?.getAttribute("placeholder") === "Message Nix…", 3_000, "Nix's chat");
        // A screenshot pasted into Nix's box, and not sent.
        const paste = new (dom as unknown as typeof globalThis).Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", { value: { files: [new File([new Uint8Array(4)], "shot.png", { type: "image/png" })] } });
        boxIn(card())!.dispatchEvent(paste);
        await eventually(() => (card()?.textContent ?? "").includes("shot.png"), 3_000, "the file attached");
        ask(host)!.click();
        await eventually(() => boxIn(card())?.getAttribute("placeholder") === "Message Nouva…" && boxIn(card())!.value === MESSAGE, 3_000, "the message in Nouva's box");
        await eventually(() => !(card()?.textContent ?? "").includes("shot.png"), 2_000, "the file gone with what the box held");
        await eventually(() => sendIn(card())?.disabled === false, 2_000, "ready to send");
        sendIn(card())!.click();
        await eventually(() => sent(posted.posts).length === 1, 3_000, "sent");
      });
      expect(sent(posted.posts).map((post) => post.body)).toEqual([{ text: MESSAGE, sessionId: "ses_1", page: { path: "/dashboard/models?tab=clis", title: "Models" } }]);
    } finally {
      posted.restore();
    }
  });

  test("sent by the person, it goes to the orchestrator's conversation with the page it was asked from", async () => {
    answer({ ...AT_REST, ...CLIS });
    const posted = recordPosts({ "/chat/send": { status: 200, body: { sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" } } });
    try {
      await renderPage("/models?tab=clis", async (host) => {
        await eventually(() => ask(host) !== undefined, 3_000, "the button");
        ask(host)!.click();
        await eventually(() => boxIn(card())?.value === MESSAGE && sendIn(card())?.disabled === false, 3_000, "the message, ready to send");
        sendIn(card())!.click();
        await eventually(() => sent(posted.posts).length === 1, 3_000, "sent");
      });
      expect(sent(posted.posts).map((post) => post.body)).toEqual([{ text: MESSAGE, sessionId: "ses_1", page: { path: "/dashboard/models?tab=clis", title: "Models" } }]);
    } finally {
      posted.restore();
    }
  });

  test("is not drawn before the orchestrator is known: its name is on the button", async () => {
    const React = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const client = new QueryClient();
    client.setQueryData(["status"], { ...STATUS, orchestrator: null });
    const html = renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(AskAgentButton, { task: "to set it up", message: MESSAGE })));
    expect(html).toBe("");
  });
});
