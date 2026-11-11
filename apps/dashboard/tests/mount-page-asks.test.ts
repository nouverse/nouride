/**
 * "Ask Nouva" on every page that has a job a person can hand to the orchestrator: a button in the page's header that
 * opens the chat with the orchestrator and the page's request already written in the box, for the person to finish and
 * send. Nothing is sent from the page. A viewer, who can send nothing, sees none; nor does a box with no orchestrator.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

useMountHarness();

const PAGES: [path: string, key: keyof typeof PAGE_ASKS][] = [
  ["/agents", "agents"],
  ["/skills", "skills"],
  ["/mcp", "connectors"],
  ["/automations", "automations"],
  ["/missions", "missions"],
  ["/work", "work"],
  ["/memories", "memory"],
  ["/people", "people"],
  ["/groups", "groups"],
  ["/models", "models"],
  ["/integrations", "integrations"],
  ["/web-search", "webSearch"],
  ["/secrets", "secrets"],
  ["/access", "access"],
  ["/logs", "logs"],
  ["/box", "box"],
  ["/office", "office"],
];

const status = WIRE["/status"] as Record<string, unknown>;
const withOrchestrator = { "/status": { status: 200, body: { ...status, orchestrator: "nouva" } } };
const me = WIRE["/auth/me"] as { user: Record<string, unknown> };
const asViewer = { "/auth/me": { status: 200, body: { ...me, role: "viewer", user: { ...me.user, role: "viewer" } } } };

/** The header's ask link: its address's agent and message, and what it says. */
function askOf(host: HTMLElement) {
  const link = [...host.querySelectorAll("header a")].find((a) => /\/chat\b/.test(a.getAttribute("href") ?? "") && a.textContent?.trim().startsWith("Ask "));
  if (!link) return null;
  const search = new URL(link.getAttribute("href")!, "http://localhost").searchParams;
  const value = (name: string) => {
    const raw = search.get(name) ?? "";
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw;
    }
  };
  return { agent: value("agent"), draft: value("draft"), words: link.textContent?.replace(/\s+/g, " ").trim() ?? "", title: link.getAttribute("title") ?? "" };
}

describe("Ask Nouva on each page", () => {
  for (const [path, key] of PAGES) {
    test(`${path}: opens the chat with the orchestrator and the page's request written, nothing sent`, async () => {
      answer(withOrchestrator);
      let ask: ReturnType<typeof askOf> = null;
      await renderPage(path, async (host) => {
        await eventually(() => askOf(host) !== null, 2_000, "the ask button");
        ask = askOf(host);
      });
      expect(ask).not.toBeNull();
      expect(ask!.agent).toBe("nouva");
      expect(ask!.draft).toBe(PAGE_ASKS[key].message);
      expect(ask!.title).toBe(`Ask Nouva ${PAGE_ASKS[key].task}`);
      // On a phone it says only who; the rest is from sm up.
      expect(ask!.words).toContain("Ask Nouva");
      expect(ask!.words).toContain(PAGE_ASKS[key].task);
    });
  }

  test("a viewer, who can send nothing, is not offered it; nor is a box with no orchestrator", async () => {
    answer({ ...withOrchestrator, ...asViewer });
    let viewer: ReturnType<typeof askOf> = null;
    await renderPage("/automations", async (host) => {
      await eventually(() => host.textContent?.includes("Automations") === true, 2_000, "the page");
      viewer = askOf(host);
    });
    expect(viewer).toBeNull();
    answer({});
    let none: ReturnType<typeof askOf> = null;
    await renderPage("/agents", async (host) => {
      await eventually(() => host.textContent?.includes("Agents") === true, 2_000, "the page");
      none = askOf(host);
    });
    expect(none).toBeNull();
  });
});
