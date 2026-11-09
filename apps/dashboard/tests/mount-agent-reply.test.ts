/**
 * An agent's reply beside its own cat, as a person's words sit beside their initials (`AgentReply`): the cat ringed in
 * the agent's colour, its name in that colour above, and the steps, the answer and Copy in the column beside it. A
 * person's row and an agent's share the face's size and the gap, so a group reads in one rhythm.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const classes = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/);

describe("an agent's reply", () => {
  test("sits beside the agent's cat, its name in its colour above, the steps, the answer and Copy in one column", async () => {
    answer({ "/sessions/ses_1/live": { status: 200, body: { turn: null, jobs: [] } }, "/turns/turn_1": { status: 404, body: { error: "no record" } } });
    const seen: Record<string, unknown> = {};
    await renderPage("/chat/ses_1", async (host) => {
      const reply = () => host.querySelector('[data-agent="nouva"]');
      await eventually(() => reply()?.querySelector("canvas") != null && (reply()?.textContent ?? "").includes("40% used"), 3_000, "the reply");
      const row = reply()!;
      const [face, column] = [...row.children];
      seen.face = face?.querySelector("canvas") != null;
      seen.faceHidden = face?.getAttribute("aria-hidden");
      seen.ring = classes(face?.firstElementChild);
      seen.tint = (row as HTMLElement).style.getPropertyValue("--agent-tint");
      seen.name = column?.firstElementChild?.textContent;
      seen.nameClass = classes(column?.firstElementChild?.firstElementChild);
      seen.column = [...(column?.children ?? [])].map((part) => part.textContent ?? "");
    });
    expect(seen.face).toBe(true);
    expect(seen.faceHidden).toBe("true");
    expect(seen.ring).toEqual(expect.arrayContaining(["ring-2", "size-8", "max-sm:size-7"]));
    expect(seen.tint).toContain("color-mix");
    expect(seen.name).toBe("Nouva");
    expect(seen.nameClass).toEqual(expect.arrayContaining(["font-display"]));
    expect(seen.nameClass).not.toContain("uppercase");
    // Name, then the steps, then the answer, then Copy: all in the column beside the cat.
    const column = seen.column as string[];
    expect(column[0]).toBe("Nouva");
    expect(column.findIndex((part) => part.includes("step"))).toBeGreaterThan(0);
    expect(column.findIndex((part) => part.includes("40% used"))).toBeGreaterThan(column.findIndex((part) => part.includes("step")));
    expect(column.at(-1)).toContain("Copy");
  });

  test("in a group, a person's row and an agent's share the face's size and the gap", async () => {
    const STATUS = WIRE["/status"] as Record<string, unknown>;
    const now = Date.now();
    const list = {
      agents: [],
      rooms: [],
      groups: [{ platform: "telegram", chatId: "-100", name: "Office", agents: ["nouva"], sessions: [{ agentId: "nouva", sessionId: "ses_g1", gatewayId: "telegram:nouva" }], at: now, working: false, people: 1 }],
    };
    const group = {
      session: { id: "ses_g1", agentId: "nouva", chatId: "-100", gatewayId: "telegram:nouva", updatedAt: now, writable: false },
      earlier: [],
      events: [],
      turns: [{ id: "t1", agentId: "nouva", chatId: "-100", sessionId: "ses_g1", prompt: "deploy?", reply: "Deployed.", status: "done", toolCalls: 0, startedAt: now - 5_000, endedAt: now - 4_000, steps: [] }],
      messages: [{ id: "m1", gatewayId: "telegram:nouva", chatId: "-100", senderId: "814", senderName: "Gading", text: "deploy?", at: now - 6_000 }],
    };
    answer({ "/status": { status: 200, body: STATUS }, "/chat-list": { status: 200, body: list }, "/sessions/ses_g1/turns": { status: 200, body: group } });
    const seen: Record<string, string[]> = {};
    await renderPage("/chat/group/telegram/-100", async (host) => {
      await eventually(() => host.querySelector("[data-person]") != null && host.querySelector("[data-agent] canvas") != null, 3_000, "a person and an agent");
      seen.person = classes(host.querySelector("[data-person]"));
      seen.agent = classes(host.querySelector("[data-agent]"));
      seen.personFace = classes(host.querySelector("[data-person]")?.firstElementChild);
      seen.agentFace = classes(host.querySelector("[data-agent]")?.firstElementChild?.firstElementChild);
    });
    for (const gap of ["gap-2", "sm:gap-3"]) {
      expect(seen.person).toContain(gap);
      expect(seen.agent).toContain(gap);
    }
    // 28 px on a phone and 32 above it, for both.
    expect(seen.personFace).toEqual(expect.arrayContaining(["size-7", "sm:size-8"]));
    expect(seen.agentFace).toEqual(expect.arrayContaining(["size-8", "max-sm:size-7"]));
  });
});
