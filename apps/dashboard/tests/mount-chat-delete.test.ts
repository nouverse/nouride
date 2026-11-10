/**
 * Deleting the chat or the room on screen, from Delete at the end of its bar: the owner looked for it there and found
 * it behind a menu. Both kinds are confirmed with words that say what goes, and neither menu holds a delete any more.
 */

import { describe, expect, test } from "bun:test";
import { answer, dom, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const room = {
  gatewayId: "web:dashboard",
  chatId: "room_1",
  title: "Build crew",
  createdAt: 1760000000000,
  members: [
    { agentId: "nouva", addedAt: 1760000000000 },
    { agentId: "nix", addedAt: 1760000000000 },
  ],
};

/** Every DELETE the page sends, answered with `body`; anything else goes to the harness. */
function recordDeletes(body: unknown) {
  const deletes: string[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    if (init?.method !== "DELETE") return (spy as typeof fetch)(input as RequestInfo, init);
    const url = String(typeof input === "string" ? input : (input as Request).url);
    deletes.push(new URL(url, "http://localhost").pathname.replace(/^\/api\/control/, ""));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { deletes, restore: () => void (globalThis.fetch = spy) };
}

/** The chat's own bar, not the app's phone header above it: the one with the history toggle. */
const header = (host: HTMLElement) =>
  (host.querySelector('button[title="Show or hide past conversations"]')?.closest("header") ?? host) as HTMLElement;
const byLabel = (root: ParentNode, label: string) => root.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

/** What a bar's menu holds, opened and read; closed again by its button. */
async function menuItems(host: HTMLElement, menuLabel: string): Promise<string[]> {
  await eventually(() => byLabel(header(host), menuLabel) !== null, 2_000, "the menu's button");
  byLabel(header(host), menuLabel)!.click();
  const items = () => [...dom.document.body.querySelectorAll('[role="menu"] button, ul.menu button')].map((button) => button.textContent?.trim() ?? "");
  await eventually(() => items().length > 0, 2_000, "the menu open");
  const seen = items();
  byLabel(header(host), menuLabel)!.click();
  return seen;
}

/** Presses the bar's Delete and confirms; returns what the dialog said. */
async function deleteFromBar(host: HTMLElement, label: string, confirm: string): Promise<string> {
  await eventually(() => byLabel(header(host), label) !== null, 2_000, "the bar's Delete");
  byLabel(header(host), label)!.click();
  const dialog = () => dom.document.body.querySelector("dialog[open]");
  const confirmButton = () => [...(dialog()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === confirm);
  await eventually(() => confirmButton() !== undefined, 2_000, "the confirmation");
  const said = dialog()?.textContent ?? "";
  confirmButton()!.click();
  return said;
}

describe("deleting the chat or room on screen", () => {
  test("a conversation: Delete in the bar, a word beside its bin, deletes it once confirmed; the menu holds no delete", async () => {
    const recorded = recordDeletes({ ok: true, turns: 2, stopped: 0 });
    const seen: Record<string, unknown> = {};
    try {
      await renderPage("/chat/ses_1", async (host) => {
        await eventually(() => byLabel(header(host), "Delete this conversation") !== null, 2_000, "the bar");
        seen.word = byLabel(header(host), "Delete this conversation")!.textContent?.trim();
        seen.menu = await menuItems(host, "More for this conversation");
        seen.said = await deleteFromBar(host, "Delete this conversation", "Delete");
        await eventually(() => recorded.deletes.length > 0, 2_000, "the delete sent");
      });
    } finally {
      recorded.restore();
    }
    expect(seen.word).toBe("Delete");
    expect((seen.menu as string[]).some((item) => item.includes("Delete"))).toBe(false);
    expect(seen.said).toContain("Delete this conversation?");
    expect(seen.said).toContain("There is no undo.");
    expect(recorded.deletes).toEqual(["/sessions/ses_1"]);
  });

  test("a room: Delete in the bar deletes the room once confirmed, naming every member whose conversation goes", async () => {
    answer({ "/rooms/room_1": { status: 200, body: { room } } });
    const recorded = recordDeletes({ ok: true, turns: 3, events: 0, messages: 1, stopped: 0 });
    const seen: Record<string, unknown> = {};
    try {
      await renderPage("/chat/room/room_1", async (host) => {
        await eventually(() => host.textContent?.includes("@nix") === true || host.textContent?.includes("nix") === true, 2_000, "the room's members");
        seen.menu = await menuItems(host, "More for this room");
        seen.said = await deleteFromBar(host, "Delete this room", "Delete room");
        await eventually(() => recorded.deletes.length > 0, 2_000, "the delete sent");
      });
    } finally {
      recorded.restore();
    }
    expect((seen.menu as string[]).some((item) => item.includes("Delete"))).toBe(false);
    expect(seen.menu).toEqual(expect.arrayContaining(["Rename room"]));
    expect(seen.said).toContain("Delete this room?");
    expect(seen.said).toContain("nouva, nix");
    expect(recorded.deletes).toEqual(["/rooms/room_1"]);
  });

  test("a conversation with no work notes: Delete in the bar, and no menu left with nothing in it", async () => {
    answer({ "/sessions/ses_1/notes": { status: 404, body: { error: "no notes" } } });
    const seen: Record<string, boolean> = {};
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => byLabel(header(host), "Delete this conversation") !== null, 2_000, "the bar");
      seen.menu = byLabel(header(host), "More for this conversation") !== null;
    });
    expect(seen.menu).toBe(false);
  });

  test("a new chat has nothing to delete, so no Delete and no menu", async () => {
    const html = await renderPage("/chat");
    expect(html).not.toContain('aria-label="More for this');
    expect(html).not.toContain('aria-label="Delete this');
  });
});
