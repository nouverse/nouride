/**
 * Where the Chats page's conversation goes, which is the page's own and not the conversation's (the floating chat draws
 * the same conversation and goes nowhere): a new chat's first message goes to its conversation's address, and a message
 * written for the person (`?draft=`) is put in the box, never sent, and dropped from the address.
 */

import { describe, expect, test } from "bun:test";
import { answer, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const STATUS = { ...(WIRE["/status"] as Record<string, unknown>), orchestrator: "nouva" };
const box = (host: HTMLElement) => host.querySelector("textarea") as HTMLTextAreaElement | null;
const send = (host: HTMLElement) => host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null;

describe("the Chats page's conversation", () => {
  test("a new chat's first message goes to the address of the conversation it started", async () => {
    answer({ "/status": { status: 200, body: STATUS } });
    const posted = recordPosts({ "/chat/send": { status: 200, body: { sessionId: "ses_new", chatId: "web-1", messageId: "msg_1", agentId: "nouva" } } });
    try {
      await renderPage("/chat?agent=nouva", async (host, app) => {
        await eventually(() => box(host) !== null, 3_000, "the box");
        type(box(host)!, "hello");
        await eventually(() => send(host)?.disabled === false, 2_000, "send enabled");
        send(host)!.click();
        await eventually(() => app.location().endsWith("/chat/ses_new"), 3_000, "the new conversation's address");
      });
      expect(posted.posts.filter((post) => post.path === "/chat/send").map((post) => post.body)).toEqual([{ text: "hello", agent: "nouva" }]);
    } finally {
      posted.restore();
    }
  });

  test("a message written for the person is in the box, not sent, and gone from the address; the agent stays in it", async () => {
    answer({ "/status": { status: 200, body: STATUS } });
    const posted = recordPosts();
    try {
      await renderPage(`/chat?agent=nouva&draft=${encodeURIComponent("Please set it up for me.")}`, async (host, app) => {
        await eventually(() => box(host)?.value === "Please set it up for me.", 3_000, "the message in the box");
        expect(box(host)?.getAttribute("placeholder")).toBe("Message Nouva…");
        await eventually(() => app.search().draft === undefined, 3_000, "the draft gone from the address");
        expect(app.search()).toEqual({ agent: "nouva" });
      });
      expect(posted.posts.filter((post) => post.path === "/chat/send")).toEqual([]);
    } finally {
      posted.restore();
    }
  });
});
