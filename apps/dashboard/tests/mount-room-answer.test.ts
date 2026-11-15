/**
 * Who answers a message that tags nobody, picked in the header of a room made in the dashboard
 * (`chat/components/RoomAnswer.tsx`). Through the whole app, on the room's own page.
 *
 * It is the choice `/mention` writes when typed in the room, and there was no way to make it without typing that: the
 * header said who answers and nothing in it could be pressed. Each case is a way the header would say or send something
 * else than the chat does: the wrong choice shown as picked, a change sent as another, the header not following once
 * it is made, a refusal swallowed, or the choice offered to someone it is not theirs to make.
 */

import { describe, expect, test } from "bun:test";
import { answer, recordPosts, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const NOW = Date.now();
const STATUS = WIRE["/status"] as { agents: Record<string, unknown>[] } & Record<string, unknown>;
const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
const agent = (id: string) => ({ ...STATUS.agents[0], id, displayName: id[0]!.toUpperCase() + id.slice(1), headline: null });
const status = { ...STATUS, orchestrator: "nouva", agents: ["nouva", "nix", "nero"].map(agent) };
const room = { gatewayId: "web:dashboard", chatId: "room_1", title: "Harness research", createdAt: NOW - 600_000, members: ["nouva", "nix"].map((agentId) => ({ agentId, addedAt: NOW - 600_000 })) };
/** The room as the chat list says it: who answers there with no tag, and its own choice where it made one. */
const box = (said: Record<string, unknown> = { untagged: "nouva" }, me: Record<string, unknown> = ME) => ({
  "/auth/me": ok(me),
  "/status": ok(status),
  "/chat-list": ok({ agents: [], rooms: [{ chatId: "room_1", title: "Harness research", members: ["nouva", "nix"], at: NOW - 120_000, working: false, ...said }], groups: [] }),
  "/rooms/room_1": ok({ room }),
  "/rooms/room_1/live": ok({ turns: [], jobs: [] }),
  "/rooms/room_1/turns": ok({ session: null, room, earlier: [], turns: [], events: [], messages: [] }),
});
const OPERATOR = { ...ME, role: "operator", user: { ...ME.user, role: "operator" } };

const LABEL = "Who answers a message that tags nobody";
const picker = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(`header button[aria-label="${LABEL}"]`);
const rows = (host: HTMLElement) => [...host.ownerDocument.body.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitemradio"]')];
const labels = (host: HTMLElement) => rows(host).map((row) => `${row.getAttribute("aria-checked") === "true" ? "✓ " : ""}${row.querySelector("span")?.textContent}`);
const choose = (host: HTMLElement, label: string) => rows(host).find((row) => row.querySelector("span")?.textContent === label)!.click();
/** The member whose tag says it answers, by the header. */
const answering = (host: HTMLElement) => [...host.querySelectorAll('ul[aria-label="In this room"] li')].filter((chip) => chip.textContent?.includes("answers when nobody is tagged")).map((chip) => chip.textContent?.split("answers")[0]?.trim());
const header = (host: HTMLElement) => host.querySelector<HTMLElement>('ul[aria-label="In this room"]');

describe("a room's header, for an admin", () => {
  test("the choices are the room's members, a tag needed and the default, with what is picked checked and the default said as who that is now", async () => {
    answer(box());
    await renderPage("/chat/room/room_1", async (host) => {
      await eventually(() => picker(host) !== null, 4_000, "the picker");
      expect(picker(host)!.textContent).toBe("Who answers with no tag");
      // Beside the members' tags, in their row.
      expect(header(host)!.parentElement!.contains(picker(host))).toBe(true);
      picker(host)!.click();
      await eventually(() => rows(host).length > 0, 2_000, "the choices");
      expect(labels(host)).toEqual(["✓ Default", "A tag is needed", "Nouva", "Nix"]);
      // An agent that is not in the room is not offered: the router answers a room by its members.
      expect(labels(host).join(" ")).not.toContain("Nero");
      expect(rows(host)[0]!.textContent).toContain("Now: Nouva");
      expect(rows(host)[3]!.textContent).toContain("@nix");
    });

    for (const [said, checked] of [
      [{ mention: { requireTag: true } }, "✓ A tag is needed"],
      [{ mention: { requireTag: false, answerer: "nix" }, untagged: "nix" }, "✓ Nix"],
    ] as const) {
      answer(box(said));
      await renderPage("/chat/room/room_1", async (host) => {
        await eventually(() => picker(host) !== null, 4_000, "the picker");
        picker(host)!.click();
        await eventually(() => rows(host).length > 0, 2_000, "the choices");
        expect(labels(host).filter((label) => label.startsWith("✓"))).toEqual([checked]);
        // Its own choice made: the default says nothing of who it would be.
        expect(rows(host)[0]!.textContent).not.toContain("Now:");
      });
    }
  });

  test("a member picked is sent as `/mention` writes it, and the header and the line under the box follow", async () => {
    answer(box());
    const posted = recordPosts({ "/groups/mention": ok({ ok: true, mention: { requireTag: false, answerer: "nix" }, untagged: "nix" }) });
    try {
      await renderPage("/chat/room/room_1", async (host) => {
        await eventually(() => picker(host) !== null && answering(host).length === 1, 4_000, "the header");
        expect(answering(host)).toEqual(["@nouva"]);
        expect(host.textContent).toContain("No tag: Nouva answers.");
        picker(host)!.click();
        await eventually(() => rows(host).length > 0, 2_000, "the choices");
        // What the daemon says of the room once the change is made.
        answer(box({ mention: { requireTag: false, answerer: "nix" }, untagged: "nix" }));
        choose(host, "Nix");
        await eventually(() => answering(host)[0] === "@nix", 4_000, "the header following");
        expect(host.textContent).toContain("No tag: Nix answers.");
        // Closed by the pick, and said.
        expect(rows(host).length).toBe(0);
        await eventually(() => host.ownerDocument.body.textContent?.includes("Nix answers in Harness research when nobody is tagged") === true, 2_000, "the toast");
      });
      expect(posted.posts).toEqual([{ path: "/groups/mention", body: { gatewayId: "web:dashboard", chatId: "room_1", mention: "agent", agent: "nix" } }]);
    } finally {
      posted.restore();
    }
  });

  test("a tag needed and the default are each sent as what they are; what is already picked sends nothing", async () => {
    for (const [said, label, sent] of [
      [{ untagged: "nouva" }, "A tag is needed", { mention: "required" }],
      [{ mention: { requireTag: true } }, "Default", { mention: "default" }],
      [{ mention: { requireTag: true } }, "A tag is needed", null],
    ] as const) {
      answer(box(said));
      const posted = recordPosts({ "/groups/mention": ok({ ok: true }) });
      try {
        await renderPage("/chat/room/room_1", async (host) => {
          await eventually(() => picker(host) !== null, 4_000, "the picker");
          picker(host)!.click();
          await eventually(() => rows(host).length > 0, 2_000, "the choices");
          choose(host, label);
          await eventually(() => rows(host).length === 0, 2_000, "the menu closed");
          if (sent) await eventually(() => posted.posts.length > 0, 2_000, "the change");
        });
        expect(posted.posts, label).toEqual(sent ? [{ path: "/groups/mention", body: { gatewayId: "web:dashboard", chatId: "room_1", ...sent } }] : []);
      } finally {
        posted.restore();
      }
    }
  });

  test("a change the daemon refuses is said in its words, and the header keeps what it showed", async () => {
    answer(box());
    const posted = recordPosts({ "/groups/mention": { status: 400, body: { error: "`nix` is not in this room", plain: "That agent is not in this room. Add it to the room first." } } });
    try {
      await renderPage("/chat/room/room_1", async (host) => {
        await eventually(() => picker(host) !== null, 4_000, "the picker");
        picker(host)!.click();
        await eventually(() => rows(host).length > 0, 2_000, "the choices");
        choose(host, "Nix");
        await eventually(() => host.ownerDocument.body.textContent?.includes("That agent is not in this room.") === true, 3_000, "the refusal");
        expect(answering(host)).toEqual(["@nouva"]);
      });
    } finally {
      posted.restore();
    }
  });

  test("on a phone, where the tags are not drawn, the same choices are a page of the room's menu, opened from it and left by Back", async () => {
    answer(box({ mention: { requireTag: false, answerer: "nix" }, untagged: "nix" }));
    const posted = recordPosts({ "/groups/mention": ok({ ok: true, mention: { requireTag: true } }) });
    try {
      await renderPage("/chat/room/room_1", async (host) => {
        const menu = () => host.querySelector<HTMLButtonElement>('header button[aria-label="More for this room"]')!;
        const items = () => [...host.ownerDocument.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button')];
        const item = (label: string) => items().find((one) => one.textContent?.trim() === label);
        await eventually(() => menu() !== null, 4_000, "the room's menu");
        menu().click();
        await eventually(() => item("Who answers with no tag") !== undefined, 2_000, "the menu's entry");
        // Only below a laptop's width: beside the tags it is already there.
        expect(item("Who answers with no tag")!.closest("li")!.className).toContain("md:hidden");
        expect(rows(host).length).toBe(0);
        item("Who answers with no tag")!.click();
        await eventually(() => rows(host).length > 0, 2_000, "the choices");
        expect(labels(host)).toEqual(["Default", "A tag is needed", "Nouva", "✓ Nix"]);
        expect(item("Rename room")).toBeUndefined();
        item("Back")!.click();
        await eventually(() => item("Rename room") !== undefined && rows(host).length === 0, 2_000, "the menu's first page");
        item("Who answers with no tag")!.click();
        await eventually(() => rows(host).length > 0, 2_000, "the choices again");
        choose(host, "A tag is needed");
        await eventually(() => posted.posts.length > 0 && items().length === 0, 2_000, "the change, and the menu closed");
        // Opened again, it is on its first page.
        menu().click();
        await eventually(() => item("Rename room") !== undefined, 2_000, "the menu again");
        expect(rows(host).length).toBe(0);
      });
      expect(posted.posts).toEqual([{ path: "/groups/mention", body: { gatewayId: "web:dashboard", chatId: "room_1", mention: "required" } }]);
    } finally {
      posted.restore();
    }
  });
});

describe("a room's header, for someone who is not an admin", () => {
  test("says who answers, as before, and offers nothing to press: not beside the tags, not in the room's menu", async () => {
    answer(box({ untagged: "nouva" }, OPERATOR));
    await renderPage("/chat/room/room_1", async (host) => {
      await eventually(() => answering(host).length === 1, 4_000, "the header");
      expect(answering(host)).toEqual(["@nouva"]);
      expect(picker(host) === null).toBe(true);
      host.querySelector<HTMLButtonElement>('header button[aria-label="More for this room"]')!.click();
      await eventually(() => host.ownerDocument.body.querySelector('[role="menu"]') !== null, 2_000, "the room's menu");
      expect(host.ownerDocument.body.querySelector('[role="menu"]')!.textContent).not.toContain("Who answers");
    });
  });
});
