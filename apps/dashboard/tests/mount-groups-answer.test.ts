/**
 * Who answers a message that tags nobody in a room, picked on the Groups page (`groups/components/WhoAnswers.tsx`).
 * Through the whole app.
 *
 * It is the room's own setting, the one `/mention` writes from the chat. Before, the only way to give a topic to one
 * agent was a line in a file under every bot's connection, and a person who typed `/mention@TheirBot` in the group was
 * answered by the orchestrator. Each case is a way the page would say or do something else than the chat does: the
 * wrong choice shown, a change sent as another, a change not shown once made, a refusal swallowed, or a choice offered
 * where there is none to make.
 */

import { describe, expect, test } from "bun:test";
import { pickedOf } from "@/modules/groups/components/WhoAnswers";
import { answer, dropdown, recordPosts, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const LABEL = "Who answers a message that tags nobody";
const ok = (body: unknown) => ({ status: 200, body });
const kept = (WIRE["/groups"] as { groups: Record<string, unknown>[] }).groups[0]!;
const status = WIRE["/status"] as { agents: Record<string, unknown>[] } & Record<string, unknown>;
const nouva = status.agents[0]!;
/** A box with two agents, Nouva the orchestrator, and one Telegram group with what is said of who answers there. */
const box = (group: Record<string, unknown> = {}) => ({
  "/status": ok({ ...status, orchestrator: "nouva", agents: [nouva, { ...nouva, id: "novelist", displayName: "Novelist" }] }),
  "/groups": ok({ groups: [{ ...kept, ...group }] }),
});
const ROOM = { gatewayId: kept.gatewayId, chatId: kept.chatId };
const row = (host: HTMLElement) => [...host.querySelectorAll("tbody tr")].find((one) => one.textContent?.includes("Rumah")) as HTMLElement | undefined;

describe("what is picked, from what the daemon says of the room", () => {
  test("nothing of its own is the default; a tag needed; the agent named; and what `/mention off` left, by who answers", () => {
    expect(pickedOf({})).toBe("default");
    expect(pickedOf({ untagged: "nouva" })).toBe("default");
    expect(pickedOf({ mention: { requireTag: true } })).toBe("required");
    expect(pickedOf({ mention: { requireTag: false, answerer: "novelist" }, untagged: "novelist" })).toBe("agent:novelist");
    // No tag needed and nobody named: the orchestrator answers, and that is the one shown.
    expect(pickedOf({ mention: { requireTag: false }, untagged: "nouva" })).toBe("agent:nouva");
    // And where nobody answers at all, none of the choices.
    expect(pickedOf({ mention: { requireTag: false } })).toBe("agent:");
  });
});

describe("the Groups page", () => {
  test("shows the room's choice, the orchestrator marked among the agents, and what the default means now", async () => {
    answer(box({ untagged: "nouva" }));
    await renderPage("/groups", async (host) => {
      await eventually(() => row(host) !== undefined, 4_000, "the room's row");
      const pick = dropdown(row(host)!, LABEL);
      expect(pick.holds()).toBe("Default");
      expect(row(host)!.textContent).toContain("Now: Nouva answers without a tag");
      expect(await pick.open()).toEqual(["Default", "A tag is needed", "Nouva", "Novelist"]);
      // The orchestrator is the first agent, and marked.
      const rows = [...host.ownerDocument.body.querySelectorAll(`[role="listbox"][aria-label="${LABEL}"] [role="option"]`)];
      expect(rows[2]!.textContent).toContain("Orchestrator");
      expect(rows[3]!.textContent).not.toContain("Orchestrator");
    });

    answer(box({ mention: { requireTag: true } }));
    await renderPage("/groups", async (host) => {
      await eventually(() => row(host) !== undefined, 4_000, "the room's row");
      expect(dropdown(row(host)!, LABEL).holds()).toBe("A tag is needed");
      expect(row(host)!.textContent).not.toContain("Now:");
    });

    // The default where a tag is needed by the server's own setting, or nobody is named: said as it is.
    answer(box());
    await renderPage("/groups", async (host) => {
      await eventually(() => row(host) !== undefined, 4_000, "the room's row");
      expect(row(host)!.textContent).toContain("Now: nobody answers without a tag");
    });

    answer(box({ mention: { requireTag: false, answerer: "novelist" }, untagged: "novelist" }));
    await renderPage("/groups", async (host) => {
      await eventually(() => row(host) !== undefined, 4_000, "the room's row");
      expect(dropdown(row(host)!, LABEL).holds()).toBe("Novelist");
    });
  });

  test("each choice is sent as what it is, and the room is read again and shows it", async () => {
    for (const [option, sent, then, holds] of [
      ["Novelist", { mention: "agent", agent: "novelist" }, { mention: { requireTag: false, answerer: "novelist" }, untagged: "novelist" }, "Novelist"],
      ["A tag is needed", { mention: "required" }, { mention: { requireTag: true } }, "A tag is needed"],
    ] as const) {
      answer(box({ untagged: "nouva" }));
      const posted = recordPosts({ "/groups/mention": ok({ ok: true, ...then }) });
      try {
        await renderPage("/groups", async (host) => {
          await eventually(() => row(host) !== undefined, 4_000, "the room's row");
          // What the daemon says of the room once the change is made.
          answer(box(then));
          await dropdown(row(host)!, LABEL).pick(option);
          await eventually(() => dropdown(row(host)!, LABEL).holds() === holds, 4_000, `the room showing ${holds}`);
        });
        expect(posted.posts, option).toEqual([{ path: "/groups/mention", body: { ...ROOM, ...sent } }]);
      } finally {
        posted.restore();
      }
    }
  });

  test("back to the default from a choice of its own, and the same choice picked again sends nothing", async () => {
    answer(box({ mention: { requireTag: true } }));
    const posted = recordPosts({ "/groups/mention": ok({ ok: true, untagged: "nouva" }) });
    try {
      await renderPage("/groups", async (host) => {
        await eventually(() => row(host) !== undefined, 4_000, "the room's row");
        const pick = dropdown(row(host)!, LABEL);
        await pick.pick("A tag is needed");
        answer(box({ untagged: "nouva" }));
        await pick.pick("Default");
        await eventually(() => dropdown(row(host)!, LABEL).holds() === "Default", 4_000, "the room at its default");
      });
      expect(posted.posts).toEqual([{ path: "/groups/mention", body: { ...ROOM, mention: "default" } }]);
    } finally {
      posted.restore();
    }
  });

  test("a change the daemon refuses is said in its words, and the room keeps what it showed", async () => {
    answer(box({ untagged: "nouva" }));
    const posted = recordPosts({ "/groups/mention": { status: 400, body: { error: "no agent `novelist`", plain: "That agent is not there any more. Reload the page." } } });
    try {
      await renderPage("/groups", async (host) => {
        await eventually(() => row(host) !== undefined, 4_000, "the room's row");
        await dropdown(row(host)!, LABEL).pick("Novelist");
        await eventually(() => row(host)!.textContent?.includes("That agent is not there any more.") === true, 4_000, "the refusal");
        expect(dropdown(row(host)!, LABEL).holds()).toBe("Default");
      });
    } finally {
      posted.restore();
    }
  });

  test("says it in words where there is nothing to pick: to who is not an admin, and of a room made in the dashboard", async () => {
    const me = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
    answer({ ...box({ mention: { requireTag: false, answerer: "novelist" }, untagged: "novelist" }), "/auth/me": ok({ ...me, role: "operator", user: { ...me.user, role: "operator" } }) });
    await renderPage("/groups", async (host) => {
      await eventually(() => row(host) !== undefined, 4_000, "the room's row");
      expect(dropdown(row(host)!, LABEL).button()).toBeUndefined();
      expect(row(host)!.textContent).toContain("Novelist answers");
    });

    answer(box({ dashboard: true, untagged: "nouva" }));
    await renderPage("/groups", async (host) => {
      await eventually(() => row(host) !== undefined, 4_000, "the room's row");
      expect(dropdown(row(host)!, LABEL).button()).toBeUndefined();
      expect(row(host)!.textContent).toContain("Nouva answers");
    });

    answer(box({ dashboard: true }));
    await renderPage("/groups", async (host) => {
      await eventually(() => row(host) !== undefined, 4_000, "the room's row");
      expect(row(host)!.textContent).toContain("Nobody answers");
    });
  });
});
