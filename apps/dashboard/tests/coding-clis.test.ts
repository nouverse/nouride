/**
 * Coding CLIs on the Models page (0.8.1): each CLI with its accounts and the agents on each — green answers, amber needs
 * a sign-in, with the button beside it: on a shared account for a CLI that signs in once (Claude Code), on each agent's
 * Brain tab for one that does not. And a line saying the agent runs inside the CLI itself, signed in with its own sign-in,
 * so people can trust it is not a token swap.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { CliAccountsView } from "@nouride/wire";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const;
let dom: Window;
let realFetch: typeof fetch;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CLIS: CliAccountsView[] = [
  { id: "claude-code", name: "Claude Code", maker: "Anthropic", installed: true, version: "0.95.0", install: "npm i -g", shared: true, canLogin: true, accounts: [{ name: "team", signedIn: false, agents: [{ id: "nix", name: "Nix", signedIn: false }, { id: "nox", name: "Nox", signedIn: false }] }] },
  { id: "codex", name: "Codex", installed: true, version: "0.9.1", install: "npm i -g codex-acp", shared: false, canLogin: true, accounts: [{ name: "work", signedIn: null, agents: [{ id: "coder", name: "Coder", signedIn: false }] }] },
  { id: "gemini", name: "Gemini CLI", installed: false, install: "npm i -g gemini-acp", shared: false, canLogin: true, accounts: [] },
  { id: "mine", name: "Mine", installed: false, install: "download mine-acp from mine.example.test onto the PATH", shared: false, canLogin: false, accounts: [] },
];

function serve(): { posted: string[] } {
  const posted: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method === "POST") {
      posted.push(`${path} ${String(init.body ?? "")}`);
      return json({ ok: true, login: { running: true, output: "Open https://claude.example.test/x\n", links: ["https://claude.example.test/x"], exitCode: null, signedIn: false } });
    }
    if (path === "/api/control/auth/me") return json({ id: "u1", username: "mira", role: "admin" });
    if (path === "/api/control/cli-accounts") return json({ clis: CLIS });
    if (path === "/api/control/status") return json({ orchestrator: "nouva", agents: [{ id: "nouva", displayName: "Nouva" }], gateways: [] });
    if (path.endsWith("/login")) return json({ login: { running: true, output: "Open https://claude.example.test/x\n", links: ["https://claude.example.test/x"], exitCode: null, signedIn: false } });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { posted };
}

async function mount(): Promise<{ host: HTMLElement; unmount: () => void }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
  const { CodingClis } = await import("@/modules/models/components/CodingClis");
  const root = createRootRoute({ component: () => React.createElement(Outlet) });
  const route = createRoute({ getParentRoute: () => root, path: "/", component: () => React.createElement(CodingClis) });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const reactRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reactRoot.render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
  await eventually(() => (host.textContent ?? "").includes("Mine"), 3_000, "the CLIs");
  return { host, unmount: () => (reactRoot.unmount(), host.remove(), client.clear()) };
}

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text) as HTMLButtonElement | undefined;
/** The links that ask the orchestrator to set a CLI up. */
const asks = (host: HTMLElement) => [...host.querySelectorAll("a")].filter((link) => link.textContent?.trim() === "Ask Nouva to set it up");

/** The text outside every "Details" section: what a person reads without opening anything. */
const plainText = (host: HTMLElement) => {
  const copy = host.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll("details")) details.remove();
  return copy.textContent ?? "";
};

describe("Coding CLIs on the Models page", () => {
  test("says the agent runs inside the CLI itself, signed in with its own sign-in — no token swap", async () => {
    serve();
    const { host, unmount } = await mount();
    try {
      // In plain words (0.8.19): what it means for the person, and that their login stays theirs.
      expect(plainText(host)).toContain("Some agents work inside Claude Code or Codex, signed in with your own account.");
      expect(plainText(host)).toContain("Nouride uses your subscription the way its maker allows: it never pretends to be the app or shares your login with another program.");
      // "Gemini CLI" is a product's own name; "coding CLI" is the page's word for them, now under Details.
      expect(plainText(host)).not.toMatch(/ACP|adapter|registry|coding CLI/i);
      // The route, and where to check it (said to be the official ACP, with its links), under Details, closed.
      const details = [...host.querySelectorAll("details")].find((entry) => entry.textContent?.includes("Agent Client Protocol"))!;
      expect(details.querySelector("summary")?.textContent).toBe("Details");
      expect(details.open).toBe(false);
      expect(details.textContent).toContain("using the official adapters from the ACP registry. Zed and JetBrains use the same adapters, made with Anthropic and OpenAI.");
      expect([...host.querySelectorAll('a[target="_blank"]')].map((link) => link.getAttribute("href"))).toEqual([
        "https://agentclientprotocol.com",
        "https://agentclientprotocol.com/registry",
        "https://github.com/agentclientprotocol/claude-agent-acp",
        "https://github.com/agentclientprotocol/codex-acp",
      ]);
      // Installed, with no version: the scan reads the ACP adapter's (claude-agent-acp 0.95.0), not Claude Code's 2.x.
      expect(host.textContent).not.toContain("0.95.0");
      expect(host.textContent).not.toContain("0.9.1");
      expect(host.querySelectorAll(".badge").length).toBeGreaterThan(0);
      expect([...host.querySelectorAll(".badge")].filter((badge) => badge.textContent === "installed")).toHaveLength(2);
    } finally {
      unmount();
    }
  });

  test("a shared account is signed in on its row, for all its agents; a per-agent CLI sends each agent to its Brain tab", async () => {
    const { posted } = serve();
    const { host, unmount } = await mount();
    try {
      expect(host.textContent).toContain("Each account is signed in once, here, and every agent on it answers with it.");
      expect(host.textContent).toContain("its agents share its limits");
      expect(host.textContent).toContain("Each agent on an account signs in once, on its own Brain tab");
      expect(host.textContent).toContain("One sign-in per agent");
      expect(host.querySelector('a[href$="/agents/coder/cli"]')?.textContent).toBe("Sign in");
      // A missing CLI a package manager installs: one plain line, and the orchestrator asked to set it up in a message
      // the person sends; the command under Details, for whoever runs the server (0.8.19).
      expect(plainText(host)).toContain("Gemini CLI is not set up on this server yet.");
      await eventually(() => asks(host).length === 1, 2_000, "the button naming the orchestrator");
      const ask = new URL(asks(host)[0]!.getAttribute("href")!, "http://localhost");
      expect(ask.pathname).toEndWith("/chat");
      expect(ask.searchParams.get("agent")).toBe("nouva");
      expect(ask.searchParams.get("draft")).toBe("Please install Gemini CLI on this server, with what Nouride needs to use it as an agent (its ACP adapter), and tell me when it is ready to sign in.");
      const command = [...host.querySelectorAll("details")].find((entry) => entry.textContent?.includes("npm i -g gemini-acp"))!;
      expect(command.querySelector("summary")?.textContent).toBe("Details");
      expect(plainText(host)).not.toContain("npm i -g");
      // One a package manager does not install: who can set it up, and its command under Details; no button for it.
      expect(plainText(host)).toContain("Mine is not set up on this server yet.Whoever runs this server needs to set this up.");
      expect(plainText(host)).not.toContain("download mine-acp");
      expect([...host.querySelectorAll("details")].some((entry) => entry.textContent?.includes("download mine-acp from mine.example.test onto the PATH"))).toBe(true);
      // Who makes it, beside its name (0.8.1).
      expect(host.textContent).toContain("Anthropic: Claude Code");
      await eventually(() => !button(host, "Sign in")?.disabled, 2_000, "the account's Sign in, once the admin is known");
      button(host, "Sign in")!.click();
      await eventually(() => (host.textContent ?? "").includes("Signing in the account team"), 3_000, "the account's sign-in");
      expect(posted).toEqual(["/api/control/cli-accounts/claude-code/team/login {}"]);
      expect(host.querySelector('a[href="https://claude.example.test/x"]')?.textContent?.trim()).toBe("Open the sign-in page");
    } finally {
      unmount();
    }
  });

  test("a shared account whose agents signed in on their own says so, not that it is signed out", async () => {
    const answering = structuredClone(CLIS);
    answering[0]!.accounts[0]!.agents = answering[0]!.accounts[0]!.agents.map((agent) => ({ ...agent, signedIn: true }));
    serve();
    const fetchWith = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (new URL(String(input), "http://localhost").pathname === "/api/control/cli-accounts" ? json({ clis: answering }) : fetchWith(input, init))) as typeof fetch;
    const { host, unmount } = await mount();
    try {
      expect(host.textContent).toContain("Each agent signed in on its own. Sign in here once to share one sign-in");
      expect(host.textContent).not.toContain("Not signed in");
    } finally {
      unmount();
    }
  });
});
