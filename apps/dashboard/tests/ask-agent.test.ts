/**
 * "Ask Nouva to set it up" (0.8.19): where the dashboard cannot do a thing and the orchestrator can, the button opens
 * the chat with the orchestrator and a message written in the box, for the person to read and send. Never sent by the
 * page, and gone from the address once it is in the box: `?initialMessage=` once sent itself again on every reload.
 * Through the whole app, from the Models page's Coding CLIs card, where it is first used.
 */

import { describe, expect, test } from "bun:test";
import { AskAgentButton } from "@/commons/components/agents/AskAgentButton";
import { answer, recordPosts, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const MESSAGE = "Please install Claude Code on this server, with what Nouride needs to use it as an agent (its ACP adapter), and tell me when it is ready to sign in.";
const MISSING = { id: "claude-code", name: "Claude Code", maker: "Anthropic", installed: false, install: "npm i -g @agentclientprotocol/claude-agent-acp", shared: true, canLogin: true, accounts: [] };
const STATUS = { ...(WIRE["/status"] as Record<string, unknown>), orchestrator: "nouva" };

const ask = (host: HTMLElement) => [...host.querySelectorAll("a")].find((link) => link.textContent?.trim() === "Ask Nouva to set it up") as HTMLAnchorElement | undefined;

describe("Ask Nouva to set it up", () => {
  test("opens the chat with Nouva and the message in the box: not sent, and no longer in the address", async () => {
    answer({ "/cli-accounts": { status: 200, body: { clis: [MISSING] } }, "/status": { status: 200, body: STATUS } });
    const posted = recordPosts();
    try {
      await renderPage("/models?tab=clis", async (host, app) => {
        await eventually(() => ask(host) !== undefined, 3_000, "the button");
        expect(host.textContent).toContain("Claude Code is not set up on this server yet.");
        ask(host)!.click();
        await eventually(() => app.location().endsWith("/chat"), 3_000, "the chat");
        const box = () => host.querySelector("textarea");
        await eventually(() => box()?.value === MESSAGE, 3_000, "the message in the box");
        // The chat is Nouva's: the box says whom it writes to.
        expect(box()?.getAttribute("placeholder")).toBe("Message Nouva…");
        // Taken out of the address, so a reload neither sends it nor puts it back; the agent stays.
        await eventually(() => app.search().draft === undefined, 3_000, "the draft gone from the address");
        expect(app.search()).toEqual({ agent: "nouva" });
        // And never sent: no request carried it.
        expect(posted.posts.filter((post) => JSON.stringify(post.body ?? "").includes("Please install"))).toEqual([]);
      });
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
