/**
 * The openers of a fresh chat.
 *
 * Four: who the agent is, two kinds of work it does from a skill it has (a carousel from a person's writing, a
 * mockup), and how a chat app is connected. The two of work end at a colon for the person to finish, and their
 * buttons read with `…` after them; what a press puts in the message box is the words alone, and nothing is sent.
 *
 * Whether four fit is a browser's to say, and was measured there with the built stylesheet: the floating panel's
 * 443 px held 452 at the spacing three openers had, and the Chats page on a phone 640 px tall scrolled. This holds the
 * classes that measurement was taken with.
 */

import { describe, expect, test } from "bun:test";
import { dom, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

async function greet(props: Record<string, unknown>): Promise<{ host: HTMLElement; picked: string[]; unmount: () => void }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { EmptyState } = await import("@/commons/components/chat/EmptyState");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const picked: string[] = [];
  const root = createRoot(host);
  root.render(React.createElement(EmptyState, { agentName: "Nix", senderName: undefined, room: null, onPick: (prompt: string) => picked.push(prompt), ...props } as never));
  await eventually(() => host.querySelector("div.grid") !== null, 2_000, "the openers");
  return { host, picked, unmount: () => (root.unmount(), host.remove()) };
}

const grid = (host: HTMLElement) => host.querySelector("div.grid") as HTMLElement;
const openers = (host: HTMLElement) => [...grid(host).querySelectorAll<HTMLButtonElement>("button")];

describe("the openers of a fresh chat", () => {
  test("four: the agent by its name, a carousel and a mockup left for the person to finish, and how a chat app is connected", async () => {
    const { host, unmount } = await greet({});
    try {
      expect(openers(host).map((button) => button.textContent)).toEqual([
        "Hi Nix, introduce yourself and tell me what you can do.",
        "Make a carousel from this writing: …",
        "Design a mockup of a landing page for: …",
        "Connect Telegram, Discord or WhatsApp?",
      ]);
    } finally {
      unmount();
    }
  });

  test("a press hands over the words alone: no …, and a space after the colon for what the person adds", async () => {
    const { host, picked, unmount } = await greet({});
    try {
      for (const button of openers(host)) button.click();
      expect(picked).toEqual([
        "Hi Nix, introduce yourself and tell me what you can do.",
        "Make a carousel from this writing: ",
        "Design a mockup of a landing page for: ",
        "Connect Telegram, Discord or WhatsApp?",
      ]);
    } finally {
      unmount();
    }
  });

  test("on a page, two columns on a wide window with the page's own air; in the floating panel one column and less of it", async () => {
    const page = await greet({});
    const panel = await greet({ narrow: true });
    try {
      expect(grid(page.host).className).toContain("gap-2 sm:grid-cols-2");
      expect((grid(page.host).parentElement as HTMLElement).className).toContain("space-y-3.5 py-4 sm:space-y-5 sm:py-8");
      expect(grid(panel.host).className).toContain("gap-1.5");
      expect(grid(panel.host).className).not.toContain("sm:grid-cols-2");
      expect((grid(panel.host).parentElement as HTMLElement).className).toContain("space-y-3 py-3");
      // Whole in the panel, a line cut short on a wide page.
      expect(openers(panel.host).every((button) => !button.querySelector("span")!.className.includes("truncate"))).toBe(true);
      expect(openers(page.host).every((button) => button.querySelector("span")!.className.includes("sm:truncate"))).toBe(true);
    } finally {
      page.unmount();
      panel.unmount();
    }
  });

  test("a room has none: there is no one agent to ask", async () => {
    const { host, unmount } = await greet({ room: { id: "r", title: "Ops", members: [{ agentId: "nix" }, { agentId: "nouva" }] } });
    try {
      expect(grid(host).className.split(" ")).toContain("hidden");
    } finally {
      unmount();
    }
  });

  test("on the Chats page a press puts the words in the message box, the box focused, and sends nothing", async () => {
    const posted = recordPosts();
    try {
      await renderPage("/chat?agent=nix", async (host) => {
        await eventually(() => host.querySelector("div.grid")?.textContent?.includes("introduce yourself") === true, 3_000, "the fresh chat");
        const box = () => host.querySelector("textarea") as HTMLTextAreaElement;
        const carousel = openers(host).find((button) => button.textContent === "Make a carousel from this writing: …")!;
        carousel.click();
        await eventually(() => box().value === "Make a carousel from this writing: ", 2_000, "the words in the box");
        expect(dom.document.activeElement as unknown).toBe(box());
        expect(posted.posts.filter((post) => post.path.includes("/chat/send"))).toEqual([]);
      });
    } finally {
      posted.restore();
    }
  });
});
