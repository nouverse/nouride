/**
 * The daemon's own voice.
 *
 * Two properties matter more than the wording: an alert must never be able to break the thing it
 * is reporting on, and a repeated failure must not flood the channel into being muted.
 */

import { describe, expect, test } from "bun:test";
import type { Gateway, OutboundMessage } from "@nouride/shared";
import { Notifier, approvalPrompt } from "@/commons/notify.ts";

function fakeGateway(id: string, options: { failing?: boolean } = {}) {
  const sent: OutboundMessage[] = [];
  // Attempts, not deliveries. A failing channel that is *retried* on every event is a distinct bug
  // from one that is silent, and only the attempt count can tell them apart.
  const attempts: OutboundMessage[] = [];
  const gateway = {
    id,
    platform: "telegram",
    status: "connected",
    async start() {},
    async stop() {},
    async send(msg: OutboundMessage) {
      attempts.push(msg);
      if (options.failing) throw new Error("telegram is down");
      sent.push(msg);
    },
    async setTyping() {},
    onMessage() {},
    onEvent() {},
  } as unknown as Gateway;
  return { gateway, sent, attempts };
}

function notifier(options: { failing?: boolean; owner?: boolean; now?: () => number } = {}) {
  const { gateway, sent, attempts } = fakeGateway("telegram:nouva", {
    ...(options.failing ? { failing: true } : {}),
  });
  const gateways = new Map([[gateway.id, gateway]]);
  return {
    sent,
    attempts,
    n: new Notifier({
      gateways,
      ...(options.owner === false
        ? {}
        : { owner: { gatewayId: "telegram:nouva", chatId: "chat-owner" } }),
      alertCooldownMs: 1000,
      ...(options.now ? { now: options.now } : {}),
    }),
  };
}

describe("toChat", () => {
  test("delivers to the named gateway", async () => {
    const { n, sent } = notifier();
    expect(await n.toChat({ gatewayId: "telegram:nouva", chatId: "c1" }, "hello")).toBe(true);
    expect(sent).toEqual([{ gatewayId: "telegram:nouva", chatId: "c1", text: "hello" }]);
  });

  test("an unknown gateway is a false, not a throw", async () => {
    const { n } = notifier();
    expect(await n.toChat({ gatewayId: "telegram:gone", chatId: "c1" }, "hello")).toBe(false);
  });

  test("a failing send is a false, not a throw", async () => {
    // This is used to say "I am waiting on you". If it cannot be delivered, the turn it describes
    // still has to carry on.
    const { n } = notifier({ failing: true });
    expect(await n.toChat({ gatewayId: "telegram:nouva", chatId: "c1" }, "hello")).toBe(false);
  });
});

describe("alert", () => {
  test("goes to the owner chat with a marker", async () => {
    const { n, sent } = notifier();
    expect(await n.alert("gateway_dead:x", "telegram:nouva is disconnected")).toBe(true);
    expect(sent[0]?.chatId).toBe("chat-owner");
    expect(sent[0]?.text).toContain("telegram:nouva is disconnected");
  });

  test("suppresses a repeat of the same kind inside the cooldown", async () => {
    // A reconnect loop emits the same failure every few seconds. A channel that repeats itself
    // gets muted, and a muted channel is worse than none because it looks like coverage.
    let clock = 1000;
    const { n, sent } = notifier({ now: () => clock });

    expect(await n.alert("gateway_dead:x", "attempt 1")).toBe(true);
    expect(await n.alert("gateway_dead:x", "attempt 2")).toBe(false);
    expect(sent).toHaveLength(1);

    clock += 1001;
    expect(await n.alert("gateway_dead:x", "attempt 3")).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test("the cooldown is per kind, so an unrelated failure still gets through", async () => {
    const { n, sent } = notifier({ now: () => 1000 });
    await n.alert("gateway_dead:telegram", "a");
    await n.alert("provider_down:nougate", "b");
    expect(sent).toHaveLength(2);
  });

  test("a changing message does not defeat the cooldown", async () => {
    // Keyed on the kind, not the text: "gave up after 3 attempts" and "after 4" are the same
    // incident, and keying on text would let every retry through.
    const { n, sent } = notifier({ now: () => 1000 });
    await n.alert("gateway_dead:x", "gave up after 3 attempts");
    await n.alert("gateway_dead:x", "gave up after 4 attempts");
    expect(sent).toHaveLength(1);
  });

  test("with no owner configured it reports false rather than throwing", async () => {
    const { n, sent } = notifier({ owner: false });
    expect(n.canAlert).toBe(false);
    expect(await n.alert("x", "y")).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("a failing send still consumes the cooldown", async () => {
    // Otherwise a broken alert channel is retried on every event, which is the loudest possible
    // response to being unable to be loud.
    //
    // Asserted on *attempts*, not return values: both calls report false whether or not the
    // cooldown was recorded, so a return-value assertion passes even with the bug in place. It
    // did — this test was rewritten after a deliberately broken version slipped through it.
    const { n, attempts } = notifier({ failing: true, now: () => 1000 });
    await n.alert("k", "first");
    await n.alert("k", "second");
    expect(attempts).toHaveLength(1);
  });
});

describe("approvalPrompt", () => {
  const notice = (overrides: Partial<Parameters<typeof approvalPrompt>[0]> = {}) =>
    approvalPrompt({
      request: { id: "apr_1", agentId: "nouva", tool: "exec", params: { command: ["bun", "test"] } },
      grantable: true,
      reason: "first time this agent has run this command",
      ...overrides,
    });

  test("shows the command the way a terminal would", () => {
    // An operator recognises `bun test`, not `{"command":["bun","test"]}`. One they can judge in a
    // glance; the other they either approve blindly or ignore.
    expect(notice()).toContain("bun test");
  });

  test("offers the answers in the form a person can type on a phone", () => {
    // The id used to be the *only* form offered, and it is 24 hex characters. An operator answering a
    // dozen `write` requests while scaffolding a project mistyped one, got "not waiting for an answer
    // any more", and had to hunt for the right id. `/approve` alone has always worked when one request
    // is waiting; nothing said so.
    const text = notice();
    expect(text).toContain("`/approve`");
    expect(text).toContain("`/approve always`");
    expect(text).toContain("`/deny`");
    // The id is still there for the case that needs it — several waiting, or the CLI.
    expect(text).toContain("apr_1");
  });

  test("points at the way out of answering one at a time — and names a level only when the daemon's hint says to", () => {
    const text = notice();
    expect(text).toContain("/approve all");
    // `/approvals balanced` was on every prompt; since 0.8.0 it is the daemon's hint under `careful`, once a day at most
    // (`tools/careful-hint.ts`).
    expect(text).not.toContain("/approvals balanced");
  });

  test("does not offer `always` when it would do nothing, and says why", () => {
    const text = notice({ grantable: false });
    // Asserted on the *command*, not the word: the explanation legitimately says "always asks".
    expect(text).not.toContain("`/approve always`");
    expect(text).toContain("cannot be granted permanently");
  });

  test("carries the reason", () => {
    expect(notice()).toContain("first time this agent has run this command");
  });

  test("names the agent that is asking", () => {
    // The prompt is posted under the asking agent's own bot where it has one — and in a one-to-one
    // chat a peer usually has none, so its question arrives wearing the face of the agent the person
    // was talking to. Two peers working at once then read as one agent asking twice.
    expect(notice({ request: { id: "apr_5", agentId: "nexa", tool: "exec", params: {} } })).toContain(
      "**nexa**",
    );
  });

  test("says nothing about a queue when there is none", () => {
    // The overwhelmingly common case is one turn with one question, and a line saying "0 more" would
    // be noise on every single prompt.
    expect(notice()).not.toContain("waiting behind");
  });

  test("says how many more questions are behind this one", () => {
    // Without it, a person answers the prompt, watches the chat go quiet, and concludes the turn is
    // over — while a second agent is parked on a question that has not been shown yet.
    expect(notice({ queuedBehind: 1 })).toContain("One more question is waiting behind this one.");
    expect(notice({ queuedBehind: 3 })).toContain("3 more questions are waiting behind this one.");
  });

  test("names the directory when one was requested", () => {
    const text = notice({
      request: { id: "apr_2", agentId: "nouva", tool: "exec", params: { command: ["ls"], cwd: "/srv/app" } },
    });
    expect(text).toContain("/srv/app");
  });

  test("marks a clipped command instead of silently shortening it", () => {
    // A shortened command is not something anyone can meaningfully approve, so the clip has to be
    // visible and point at where the full text is.
    const text = notice({
      request: { id: "apr_3", agentId: "nouva", tool: "exec", params: { command: ["echo", "x".repeat(400)] } },
    });
    expect(text).toContain("clipped");
    expect(text).toContain("nouride approvals");
  });

  test("falls back to JSON for a tool that is not exec", () => {
    const text = notice({
      request: { id: "apr_4", agentId: "nouva", tool: "write", params: { path: "notes.md", content: "hi" } },
    });
    expect(text).toContain("notes.md");
  });

  test("a change to a file is shown by its summary — a write's size, an edit's diff — not by its arguments (0.8.13)", () => {
    const written = notice({
      request: { id: "apr_5", agentId: "nouva", tool: "write", params: { path: "notes.md", content: "hi" }, preview: { kind: "new_file", path: "notes.md", lines: 1, bytes: 2 } },
    });
    expect(written).toContain("notes.md · new file");
    expect(written).not.toContain('"content"');
    const edited = notice({
      request: {
        id: "apr_6",
        agentId: "nouva",
        tool: "persona",
        params: { file: "SOUL.md", content: "# SOUL\n- b\n", reason: "Tidy." },
        preview: { kind: "edit", path: "SOUL.md", added: 1, removed: 1, hunk: [{ sign: "-", text: "[# SOUL] - a" }, { sign: "+", text: "[# SOUL] - b" }], clipped: false },
      },
    });
    expect(edited).toContain("SOUL.md · +1 −1\n```diff\n- [# SOUL] - a\n+ [# SOUL] - b\n```");
    expect(edited).not.toContain('"content"');
  });

  test("a command keeps its own line and the folder it runs in, though it has a summary too", () => {
    const text = notice({
      request: { id: "apr_7", agentId: "nouva", tool: "exec", params: { command: ["ls"], cwd: "/srv/app" }, preview: { kind: "command", command: "ls", cwd: "/srv/app", clipped: false } },
    });
    expect(text).toContain("```\nls\n(in /srv/app)\n```");
  });
});
