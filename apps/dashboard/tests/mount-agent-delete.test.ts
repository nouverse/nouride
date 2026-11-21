/**
 * Deleting an agent from its Settings page: the question in layers. What goes is listed with its counts and how much
 * its folders hold; the affirmative button is dead until the agent's id is typed, exactly, and then for ten seconds
 * more, counted on the button; only then is the delete sent, with the id. The orchestrator has no button, and says
 * why; nobody but an admin has the card.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentDeletion } from "@nouride/wire";
import { answer, dom, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const FOUND: AgentDeletion = {
  agent: "nouva", displayName: "Nouva", missions: 1, jobs: 0, automations: 2, handed: 1, connections: ["telegram:nouva"], rooms: 1, grants: 3, signIns: 0,
  folder: { bytes: 5 * 1024 * 1024, files: 40, more: false }, account: true,
};
const STATUS = WIRE["/status"] as Record<string, unknown>;
const ME = WIRE["/auth/me"] as Record<string, unknown>;

/** The page with another agent as the orchestrator, so this one can be deleted. */
const deletable = (also: Parameters<typeof answer>[0] = {}) =>
  answer({ "/status": { status: 200, body: { ...STATUS, orchestrator: "other" } }, "/agents/nouva/delete": { status: 200, body: FOUND }, ...also });

const open = () => dom.document.querySelector("dialog[open]") as unknown as HTMLElement | null;
const deleteButton = (host: HTMLElement) => [...host.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "Delete Nouva") as HTMLButtonElement | undefined;
const affirm = () => [...(open()?.querySelectorAll("button") ?? [])].find((button) => (button.textContent ?? "").trim().startsWith("Delete nouva")) as HTMLButtonElement | undefined;
const field = () => (open()?.querySelector("input") ?? null) as HTMLInputElement | null;

describe("the Delete card on an agent's Settings page", () => {
  test("the orchestrator has no button, and the card says why in the owner's words", async () => {
    answer({ "/status": { status: 200, body: { ...STATUS, orchestrator: "nouva" } } });
    let said = "";
    let button = true;
    await renderPage("/agents/nouva/settings", async (host) => {
      await eventually(() => (host.textContent ?? "").includes("Delete this agent"), 3_000, "the card");
      said = host.querySelector("[data-delete-refused]")?.textContent?.trim() ?? "";
      button = deleteButton(host) !== undefined;
    });
    expect(said).toBe("You need at least an orchestrator. Make another agent the orchestrator first.");
    expect(button).toBe(false);
  });

  test("nobody but an admin has the card", async () => {
    deletable({ "/auth/me": { status: 200, body: { ...ME, role: "operator", user: { ...(ME.user as object), role: "operator" } } } });
    const html = await renderPage("/agents/nouva/settings");
    expect(html).not.toContain("Delete this agent");
  });
});

describe("the question that deletes an agent", () => {
  afterEach(() => dom.happyDOM.setViewport({ width: 1024, height: 768 }));

  test("an agent a coding CLI answers is told its sign-ins go with its files; the field has the keyboard in a wide window, and waits for a tap on a phone", async () => {
    const agents = (STATUS.agents as { id: string }[]).map((agent) => (agent.id === "nouva" ? { ...agent, external: { cli: "claude-code", profile: "default" } } : agent));
    const seen = { line: "", wide: false, phone: true };
    const ask = async (host: HTMLElement) => {
      await eventually(() => deleteButton(host) !== undefined, 3_000, "the button");
      deleteButton(host)!.click();
      await eventually(() => field() !== null, 3_000, "the question");
      // The focus is asked for frame by frame as the box appears: a few frames are let by before it is read.
      await eventually(() => dom.document.activeElement === (field() as unknown) || dom.window.innerWidth < 768, 2_000, "the field's focus");
    };
    deletable({ "/status": { status: 200, body: { ...STATUS, orchestrator: "other", agents } } });
    await renderPage("/agents/nouva/settings", async (host) => {
      await ask(host);
      seen.line = open()!.querySelector("[data-what-goes] li")?.textContent ?? "";
      seen.wide = dom.document.activeElement === (field() as unknown);
    });
    dom.happyDOM.setViewport({ width: 390, height: 844 });
    deletable();
    await renderPage("/agents/nouva/settings", async (host) => {
      await ask(host);
      await new Promise((resolve) => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
      seen.phone = dom.document.activeElement === (field() as unknown);
    });
    expect(seen.line).toBe("Its own files, with its coding CLI's sign-ins: 40 files, 5.0 MB");
    expect(seen.wide).toBe(true);
    expect(seen.phone).toBe(false);
  });

  test("lists what goes, and is dead until the id is typed exactly: then it counts ten seconds, and nothing has been sent", async () => {
    deletable();
    const seen = { lines: [] as string[], kept: false, before: true, wrong: true, wrongCounts: true, typed: true, counting: "", posts: -1, afterKeep: -1, closed: false };
    await renderPage("/agents/nouva/settings", async (host) => {
      await eventually(() => deleteButton(host) !== undefined, 3_000, "the button");
      const record = recordPosts();
      deleteButton(host)!.click();
      await eventually(() => affirm() !== undefined, 3_000, "the question");
      seen.lines = [...open()!.querySelectorAll("[data-what-goes] li")].map((line) => line.textContent ?? "");
      seen.kept = (open()!.textContent ?? "").includes("Its chats and memories are kept.");
      seen.before = affirm()!.disabled;
      // Close is not the same, in its case or with more after it.
      type(field()!, "Nouva");
      await eventually(() => field()!.value === "Nouva", 2_000, "typed");
      seen.wrong = affirm()!.disabled;
      seen.wrongCounts = /in \d+ s/.test(affirm()!.textContent ?? "");
      type(field()!, "nouva");
      await eventually(() => /in \d+ s/.test(affirm()!.textContent ?? ""), 2_000, "the countdown");
      seen.typed = affirm()!.disabled;
      seen.counting = (affirm()!.textContent ?? "").trim();
      seen.posts = record.posts.length;
      ([...open()!.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "Keep it") as HTMLElement).click();
      await eventually(() => open() === null, 2_000, "the question closed");
      seen.closed = true;
      seen.afterKeep = record.posts.length;
      record.restore();
    });
    expect(seen.lines).toEqual([
      "Its own files: 40 files, 5.0 MB",
      "1 mission still open, stopped first",
      "2 automations of its own",
      "1 automation of other agents with a step given to it: turned off, each saying why",
      "1 connection only it answers. Its key stays in Secrets",
      "Its seat in 1 room",
      "3 standing permissions",
      "Its own user on this machine",
    ]);
    expect(seen.kept).toBe(true);
    expect(seen.before).toBe(true);
    expect(seen.wrong).toBe(true);
    expect(seen.wrongCounts).toBe(false);
    // The id is right: still dead, and now it says for how long.
    expect(seen.typed).toBe(true);
    expect(seen.counting).toMatch(/^Delete nouva in (10|9) s$/);
    expect(seen.posts).toBe(0);
    expect(seen.afterKeep).toBe(0);
  });

  test("ten seconds after the id is typed the button works, and the delete is sent with the id", async () => {
    deletable();
    let sent: { path: string; body: unknown }[] = [];
    let waited = 0;
    await renderPage("/agents/nouva/settings", async (host) => {
      await eventually(() => deleteButton(host) !== undefined, 3_000, "the button");
      const record = recordPosts({ "/agents/nouva/delete": { status: 200, body: { deleted: "nouva", took: {}, account: "removed", notes: [] } } });
      deleteButton(host)!.click();
      await eventually(() => field() !== null, 3_000, "the question");
      type(field()!, "nouva");
      const from = Date.now();
      await eventually(() => affirm()?.disabled === false, 15_000, "ten seconds counted down");
      waited = Date.now() - from;
      affirm()!.click();
      await eventually(() => record.posts.length > 0, 3_000, "the delete");
      record.restore();
      sent = record.posts;
    });
    // Not before nine seconds, whatever the timers' slack: the wait is the layer.
    expect(waited).toBeGreaterThanOrEqual(9_000);
    expect(sent).toEqual([{ path: "/agents/nouva/delete", body: { confirm: "nouva" } }]);
  }, 30_000);

  test("the id untyped again starts the count from the top", async () => {
    deletable();
    const seen = { first: "", emptied: true, again: "" };
    await renderPage("/agents/nouva/settings", async (host) => {
      await eventually(() => deleteButton(host) !== undefined, 3_000, "the button");
      deleteButton(host)!.click();
      await eventually(() => field() !== null, 3_000, "the question");
      type(field()!, "nouva");
      // Two seconds in.
      await eventually(() => /in [0-8] s/.test(affirm()!.textContent ?? ""), 5_000, "the count going down");
      seen.first = (affirm()!.textContent ?? "").trim();
      type(field()!, "nouv");
      await eventually(() => !/in \d+ s/.test(affirm()!.textContent ?? ""), 2_000, "the count gone");
      seen.emptied = affirm()!.disabled;
      type(field()!, "nouva");
      await eventually(() => /in \d+ s/.test(affirm()!.textContent ?? ""), 2_000, "the count again");
      seen.again = (affirm()!.textContent ?? "").trim();
    });
    expect(seen.first).toMatch(/^Delete nouva in [0-8] s$/);
    expect(seen.emptied).toBe(true);
    expect(seen.again).toMatch(/^Delete nouva in (10|9) s$/);
  }, 20_000);
});
