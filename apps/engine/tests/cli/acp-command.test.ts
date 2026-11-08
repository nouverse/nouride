/**
 * `nouride acp` end to end against a daemon that answers as one does: an editor's client on one
 * side, the adapter on the other. A session's folder is one of the agent's roots or refused naming the fix; a prompt
 * is the local connection's message, its turn's rows arrive as updates, a parked call is the editor's permission and
 * its answer the daemon's approval; a cancel is the daemon's stop; a reopened session replays what was said.
 */

import { describe, expect, test } from "bun:test";
import { AcpClient, type PermissionOutcome, type RequestPermissionParams, type SessionUpdate } from "@nouride/acp";
import { serveAcp } from "@/cli/commands/acp.ts";
import { LOCAL_GATEWAY_ID } from "@/modules/gateways/local.ts";
import { eventually } from "../wait.ts";

const later = (fn: () => void) => void setTimeout(fn, 0);
const encoder = new TextEncoder();

function daemon() {
  const posted: { path: string; body: unknown }[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  let feed: ReadableStreamDefaultController<Uint8Array> | null = null;
  let seq = 10;
  let answerMessage: (value: unknown) => void = () => {};
  let onMessage: (body: Record<string, unknown>) => void = () => {};
  const push = (kind: string, data: Record<string, unknown>, turnId = "t1") =>
    feed?.enqueue(encoder.encode(`id: ${++seq}\ndata: ${JSON.stringify({ seq, at: 0, turnId, agentId: "nouva", gatewayId: LOCAL_GATEWAY_ID, chatId: "x", kind, data })}\n\n`));
  const fake = {
    softGet: async (path: string) => {
      asked.push(path);
      if (path === "/status") return { orchestrator: "nouva", agents: [{ id: "nouva", displayName: "Nouva", workspaceRoots: [{ path: "/work/projects", exists: true }] }] };
      if (path === "/approvals") return { pending: [{ id: "apr_1", tool: "write", params: { path: "notes.md" }, grantable: true }] };
      if (path.startsWith("/events?")) {
        return {
          events: path.includes("since=0")
            ? [
                { seq: 1, turnId: "t0", kind: "turn", data: { phase: "start", prompt: "what changed?" } },
                { seq: 2, turnId: "h0", kind: "turn", data: { phase: "start", prompt: "helper work", via: "delegate" } },
                { seq: 3, turnId: "t0", kind: "turn", data: { phase: "end", status: "done", reply: "Two files." } },
              ]
            : [],
          next: 3,
        };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    softPost: async (path: string, body?: unknown) => {
      posted.push({ path, body });
      asked.push(`POST ${path}`);
      if (path !== "/message") return { ok: true };
      onMessage(body as Record<string, unknown>);
      return await new Promise((resolve) => (answerMessage = resolve));
    },
    open: async (path: string) => {
      opened.push(path);
      // Opened after the caller moved on, as a stream over HTTP is: a message sent before it is open loses its first rows.
      await Promise.resolve();
      return new ReadableStream<Uint8Array>({
        start: (controller) => {
          feed = controller;
          controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ version: "1.4", oldest: 0, latest: seq, epoch: "e1" })}\n\n`));
        },
      });
    },
  };
  return { fake, posted, opened, asked, push, answer: (value: unknown) => answerMessage(value), whenMessage: (fn: (body: Record<string, unknown>) => void) => (onMessage = fn) };
}

function editor(d: ReturnType<typeof daemon>, permission: (request: RequestPermissionParams) => Promise<PermissionOutcome> = async () => ({ outcome: "cancelled" })) {
  const updates: SessionUpdate[] = [];
  let adapter!: ReturnType<typeof serveAcp>;
  const client = new AcpClient({
    transport: { send: (line) => later(() => adapter.receive(line)) },
    permission,
    unclaimed: (_sessionId, update) => void updates.push(update),
  });
  adapter = serveAcp({ daemon: d.fake as never, send: (line) => later(() => client.receive(line)), settleMs: 200 });
  return { client, updates };
}

describe("nouride acp", () => {
  test("a session's folder is one of the agent's roots — another is refused, naming the fix", async () => {
    const { client } = editor(daemon());
    await client.initialize();
    expect((await client.newSession("/work/projects/app")).sessionId).toStartWith("acp-");
    await expect(client.newSession("/home/someone/elsewhere")).rejects.toThrow("/home/someone/elsewhere is not a folder Nouva works in (its roots: /work/projects). Add it to [workspace] roots in its pack's config.toml");
  });

  test("a prompt is the local connection's message; its turn arrives as updates, and a parked call is the editor's to answer", async () => {
    const d = daemon();
    const asked: RequestPermissionParams[] = [];
    const { client } = editor(d, async (request) => (asked.push(request), { outcome: "selected", optionId: "allow-always" }));
    await client.initialize();
    const { sessionId } = await client.newSession("/work/projects");
    d.whenMessage(() => {
      d.push("tool", { step: 1, text: "write notes.md", callId: "c1", name: "write" });
      d.push("waiting", { step: 2, text: "waiting for approval: write", callId: "c1", name: "write", approvalId: "apr_1" });
    });
    const updates: SessionUpdate[] = [];
    const prompting = client.prompt(sessionId, [{ type: "text", text: "note it down" }], (update) => void updates.push(update));
    await eventually(() => d.posted.some((post) => post.path === "/approvals/apr_1/allow-always"), 4_000, "the editor's answer at the daemon");
    d.push("tool_done", { step: 3, text: "write ok", callId: "c1", name: "write", error: false });
    d.push("reply", { from: 0, text: "Noted" });
    d.push("turn", { phase: "end", status: "done", reply: "Noted." });
    await eventually(() => updates.length >= 3, 4_000, "the rows as updates");
    d.answer({ replies: ["Noted."], answered: true });
    expect(await prompting).toBe("end_turn");

    expect(d.opened[0]).toBe(`/events/stream?chat=${sessionId}&gateway=${encodeURIComponent(LOCAL_GATEWAY_ID)}&tail=1`);
    expect(d.posted.find((post) => post.path === "/message")?.body).toEqual({ text: "note it down", chatId: sessionId });
    // Polled before the message goes, so the local connection counts as someone to ask while the editor watches.
    expect(d.asked.indexOf("/approvals")).toBeGreaterThan(-1);
    expect(d.asked.indexOf("/approvals")).toBeLessThan(d.asked.indexOf("POST /message"));
    expect(asked[0]).toMatchObject({ toolCall: { toolCallId: "c1", title: "waiting for approval: write", rawInput: { path: "notes.md" } } });
    expect(asked[0]!.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect(updates).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "write notes.md", kind: "edit", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "write ok" } }] },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Noted" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } },
    ]);
  });

  test("a cancel is the daemon's stop, and the prompt answers cancelled", async () => {
    const d = daemon();
    const { client } = editor(d);
    await client.initialize();
    const { sessionId } = await client.newSession("/work/projects");
    let sent = false;
    d.whenMessage(() => void (sent = true));
    const prompting = client.prompt(sessionId, [{ type: "text", text: "a long job" }], () => {});
    await eventually(() => sent, 4_000, "the message at the daemon");
    client.cancel(sessionId);
    await eventually(() => d.posted.some((post) => post.path === "/stop"), 4_000, "the stop at the daemon");
    d.push("turn", { phase: "end", status: "cancelled" });
    d.answer({ replies: [], answered: true });
    expect(await prompting).toBe("cancelled");
    expect(d.posted.find((post) => post.path === "/stop")?.body).toEqual({ chatId: sessionId, gateway: LOCAL_GATEWAY_ID });
  });

  test("a reopened session replays what was asked and answered, a delegate's work left out", async () => {
    const d = daemon();
    const { client, updates } = editor(d);
    await client.initialize();
    await client.loadSession("acp-earlier", "/work/projects");
    expect(updates).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "what changed?" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Two files." } },
    ]);
  });
});
