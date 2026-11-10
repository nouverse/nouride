/**
 * Deleting the chat or the room on screen, from a menu at the end of the bar. The bin sat in the bar beside Notes, and
 * on a phone the two touched: a delete with no undo one slip from the notes. Both kinds are
 * deleted from the same menu, confirmed with words that say what goes, and the bar keeps no bin of its own.
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
/** The menu and the dialog are drawn on the document's body, outside the page's host. */
const bodyButton = (text: string) =>
  [...dom.document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) as HTMLButtonElement | undefined;

/** Opens the bar's menu, presses its delete, and confirms; returns what the dialog said. */
async function deleteFromMenu(host: HTMLElement, menuLabel: string, item: string, confirm: string): Promise<string> {
  await eventually(() => byLabel(header(host), menuLabel) !== null, 2_000, "the menu's button");
  byLabel(header(host), menuLabel)!.click();
  await eventually(() => bodyButton(item) !== undefined, 2_000, "the menu open");
  bodyButton(item)!.click();
  const dialog = () => dom.document.body.querySelector("dialog[open]");
  const confirmButton = () => [...(dialog()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === confirm);
  await eventually(() => confirmButton() !== undefined, 2_000, "the confirmation");
  const said = dialog()?.textContent ?? "";
  confirmButton()!.click();
  return said;
}

describe("deleting the chat or room on screen", () => {
  test("a conversation: no bin in the bar, its menu deletes it once confirmed, and the dialog says there is no undo", async () => {
    const recorded = recordDeletes({ ok: true, turns: 2, stopped: 0 });
    const seen: Record<string, string | boolean> = {};
    try {
      await renderPage("/chat/ses_1", async (host) => {
        await eventually(() => byLabel(header(host), "More for this conversation") !== null, 2_000, "the bar");
        seen.bin = byLabel(header(host), "Delete this conversation") !== null;
        seen.said = await deleteFromMenu(host, "More for this conversation", "Delete conversation", "Delete");
        await eventually(() => recorded.deletes.length > 0, 2_000, "the delete sent");
      });
    } finally {
      recorded.restore();
    }
    expect(seen.bin).toBe(false);
    expect(seen.said).toContain("Delete this conversation?");
    expect(seen.said).toContain("There is no undo.");
    expect(recorded.deletes).toEqual(["/sessions/ses_1"]);
  });

  test("a room: the room's bar has no bin, the same menu deletes the room, naming every member whose conversation goes", async () => {
    answer({ "/rooms/room_1": { status: 200, body: { room } } });
    const recorded = recordDeletes({ ok: true, turns: 3, events: 0, messages: 1, stopped: 0 });
    const seen: Record<string, string | boolean> = {};
    try {
      await renderPage("/chat/room/room_1", async (host) => {
        await eventually(() => host.textContent?.includes("@nix") === true || host.textContent?.includes("nix") === true, 2_000, "the room's members");
        seen.bin = byLabel(header(host), "Delete this room") !== null;
        seen.said = await deleteFromMenu(host, "More for this room", "Delete room", "Delete room");
        await eventually(() => recorded.deletes.length > 0, 2_000, "the delete sent");
      });
    } finally {
      recorded.restore();
    }
    expect(seen.bin).toBe(false);
    expect(seen.said).toContain("Delete this room?");
    expect(seen.said).toContain("nouva, nix");
    expect(recorded.deletes).toEqual(["/rooms/room_1"]);
  });

  // The owner looked for Delete on History's rows, as History had it before the chat page was rebuilt.
  test("a row in History has its own menu that deletes that conversation, asked as the bar asks it", async () => {
    const at = Date.now() - 60_000;
    const sessions = [
      { id: "ses_1", agentId: "nouva", chatId: "web-1", gatewayId: "web:dashboard", updatedAt: at, title: "on screen" },
      { id: "ses_old", agentId: "nouva", chatId: "web-2", gatewayId: "web:dashboard", updatedAt: at - 1_000, title: "an older one" },
    ];
    answer({ "/sessions?agent=nouva": { status: 200, body: { sessions, total: 2 } } });
    const recorded = recordDeletes({ ok: true, turns: 1, stopped: 0 });
    const seen: Record<string, unknown> = {};
    try {
      await renderPage("/chat/ses_1", async (host) => {
        await eventually(() => host.querySelector('button[aria-label$="\'s conversations"]') !== null, 3_000, "History");
        (host.querySelector('button[aria-label$="\'s conversations"]') as HTMLElement).click();
        const rowMenu = () => dom.document.body.querySelector('[data-drawer] button[aria-label="More for “an older one”"]') as HTMLButtonElement | null;
        await eventually(() => rowMenu() !== null, 3_000, "the row's menu");
        seen.rows = dom.document.body.querySelectorAll('[data-drawer] button[aria-label^="More for “"]').length;
        rowMenu()!.click();
        await eventually(() => bodyButton("Delete conversation") !== undefined, 2_000, "the menu open");
        bodyButton("Delete conversation")!.click();
        const dialog = () => dom.document.body.querySelector("dialog[open]");
        const confirmButton = () => [...(dialog()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === "Delete");
        await eventually(() => confirmButton() !== undefined, 2_000, "the confirmation");
        seen.said = dialog()?.textContent ?? "";
        confirmButton()!.click();
        await eventually(() => recorded.deletes.length > 0, 2_000, "the delete sent");
      });
    } finally {
      recorded.restore();
    }
    expect(seen.rows).toBe(2);
    expect(seen.said).toContain("Delete this conversation?");
    expect(seen.said).toContain("There is no undo.");
    expect(recorded.deletes).toEqual(["/sessions/ses_old"]);
  });

  // After one conversation was deleted from History, Delete on the next row did nothing: the question is one kept
  // object, asked again unchanged, and the dialog opened only when its question changed.
  test("a second row deleted from History is asked about too, and deleted", async () => {
    const at = Date.now() - 60_000;
    const row = (id: string, title: string, ago: number) => ({ id, agentId: "nouva", chatId: `web-${id}`, gatewayId: "web:dashboard", updatedAt: at - ago, title });
    const sessions = [row("ses_1", "on screen", 0), row("ses_a", "the first to go", 1_000), row("ses_b", "the second to go", 2_000)];
    answer({ "/sessions?agent=nouva": { status: 200, body: { sessions, total: 3 } } });
    const recorded = recordDeletes({ ok: true, turns: 1, stopped: 0 });
    const asked: string[] = [];
    try {
      await renderPage("/chat/ses_1", async (host) => {
        await eventually(() => host.querySelector('button[aria-label$="\'s conversations"]') !== null, 3_000, "History");
        (host.querySelector('button[aria-label$="\'s conversations"]') as HTMLElement).click();
        for (const [title, count] of [["the first to go", 1], ["the second to go", 2]] as const) {
          const rowMenu = () => dom.document.body.querySelector(`[data-drawer] button[aria-label="More for “${title}”"]`) as HTMLButtonElement | null;
          await eventually(() => rowMenu() !== null, 3_000, `the menu of "${title}"`);
          rowMenu()!.click();
          await eventually(() => bodyButton("Delete conversation") !== undefined, 2_000, "the menu open");
          bodyButton("Delete conversation")!.click();
          const dialog = () => dom.document.body.querySelector("dialog[open]");
          const confirmButton = () => [...(dialog()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === "Delete");
          await eventually(() => confirmButton() !== undefined, 2_000, `the confirmation for "${title}"`);
          asked.push(dialog()?.querySelector("h3")?.textContent?.trim() ?? "");
          confirmButton()!.click();
          await eventually(() => recorded.deletes.length === count && dialog() === null, 2_000, `"${title}" deleted and its dialog closed`);
        }
      });
    } finally {
      recorded.restore();
    }
    expect(asked).toEqual(["Delete this conversation?", "Delete this conversation?"]);
    expect(recorded.deletes).toEqual(["/sessions/ses_a", "/sessions/ses_b"]);
  });

  test("a new chat has nothing to delete, so no menu", async () => {
    const html = await renderPage("/chat");
    expect(html).not.toContain('aria-label="More for this');
  });
});
