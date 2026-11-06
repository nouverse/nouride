/**
 * Both ends of ACP against each other, in memory: Nouride's client driving an agent, and Nouride served as one.
 *
 * Wired line for line, each delivery a turn of the event loop later, as a pipe would deliver it — so a call answered
 * while another waits, a permission asked in the middle of a prompt, and a peer that dies with calls in flight all run
 * the way they run against a real process.
 */

import { describe, expect, test } from "bun:test";
import { AcpClient } from "../src/client.ts";
import { AcpError, AcpPeer } from "../src/peer.ts";
import { ACP_PROTOCOL_VERSION, AUTH_REQUIRED, parseMessage, type PermissionOutcome, type RequestPermissionParams, type SessionUpdate } from "../src/protocol.ts";
import { AcpServer, authRequired, type AcpAgentHandlers } from "../src/server.ts";
import { eventually, sleep } from "./wait.ts";

const later = (fn: () => void) => void setTimeout(fn, 0);

function pair(handlers: Partial<AcpAgentHandlers> = {}, permission?: (request: RequestPermissionParams) => Promise<PermissionOutcome>) {
  const unclaimed: { sessionId: string; update: SessionUpdate }[] = [];
  const strays: string[] = [];
  let server!: AcpServer;
  const client = new AcpClient({
    transport: { send: (line) => later(() => server.receive(line)) },
    permission: permission ?? (async () => ({ outcome: "cancelled" })),
    unclaimed: (sessionId, update) => unclaimed.push({ sessionId, update }),
    stray: (line) => strays.push(line),
  });
  server = new AcpServer({
    transport: { send: (line) => later(() => client.receive(line)) },
    agentInfo: { name: "test-agent", version: "1.0.0" },
    handlers: {
      newSession: async () => ({ sessionId: "s1" }),
      prompt: async () => "end_turn",
      cancel: () => {},
      ...handlers,
    },
  });
  return { client, server, unclaimed, strays };
}

describe("the handshake", () => {
  test("version 1, the agent's name, and loadSession only when the agent reopens sessions", async () => {
    const without = await pair().client.initialize();
    expect(without.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(without.agentInfo?.name).toBe("test-agent");
    expect(without.agentCapabilities?.loadSession).toBe(false);
    const withLoad = await pair({ loadSession: async () => {} }).client.initialize();
    expect(withLoad.agentCapabilities?.loadSession).toBe(true);
  });

  test("an agent that answers another version is refused, naming both", async () => {
    let client!: AcpClient;
    const agent = new AcpPeer(
      { send: (line) => later(() => client.receive(line)) },
      { request: async () => ({ protocolVersion: 2, agentCapabilities: {} }) },
    );
    client = new AcpClient({ transport: { send: (line) => later(() => agent.receive(line)) }, permission: async () => ({ outcome: "cancelled" }) });
    await expect(client.initialize()).rejects.toThrow("the agent speaks ACP version 2, and this Nouride speaks 1");
  });

  test("a session wanting a sign-in is refused with the code an editor shows its sign-in for", async () => {
    const { client } = pair({
      newSession: async () => {
        throw authRequired("sign in first");
      },
    });
    await client.initialize();
    const error = await client.newSession("/work").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AcpError);
    expect((error as AcpError).code).toBe(AUTH_REQUIRED);
  });
});

describe("a prompt", () => {
  test("its updates arrive in order while it runs, then why it stopped; another session's go to unclaimed", async () => {
    const { client, unclaimed } = pair({
      prompt: async ({ sessionId }, channel) => {
        channel.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
        channel.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read README.md", kind: "read", status: "in_progress" });
        channel.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `done in ${sessionId}` } });
        return "end_turn";
      },
    });
    await client.initialize();
    const { sessionId } = await client.newSession("/work");
    const seen: string[] = [];
    const stop = await client.prompt(sessionId, [{ type: "text", text: "go" }], (update) => seen.push(update.sessionUpdate));
    expect(stop).toBe("end_turn");
    expect(seen).toEqual(["agent_thought_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);
    expect(unclaimed).toEqual([]);
  });

  test("a cancel reaches the agent, and the prompt answers cancelled", async () => {
    let release: (() => void) | undefined;
    const cancelled: string[] = [];
    const { client } = pair({
      prompt: () => new Promise((resolve) => (release = () => resolve("cancelled"))),
      cancel: (sessionId) => {
        cancelled.push(sessionId);
        release?.();
      },
    });
    await client.initialize();
    const running = client.prompt("s1", [{ type: "text", text: "a long job" }], () => {});
    await eventually(() => release !== undefined, 4_000, "the agent to start the prompt");
    client.cancel("s1");
    expect(await running).toBe("cancelled");
    expect(cancelled).toEqual(["s1"]);
  });

  test("one prompt a session at a time", async () => {
    const { client } = pair({ prompt: () => new Promise(() => {}) });
    await client.initialize();
    void client.prompt("s1", [], () => {});
    await expect(client.prompt("s1", [], () => {})).rejects.toThrow("already answering a prompt");
  });
});

describe("a permission the agent asks for mid-prompt", () => {
  test("reaches the caller with the tool call and options, and the agent gets the option chosen", async () => {
    const asked: RequestPermissionParams[] = [];
    let chosen: PermissionOutcome | undefined;
    const { client } = pair(
      {
        prompt: async (_params, channel) => {
          chosen = await channel.requestPermission({ toolCallId: "t9", title: "git push", kind: "execute" }, [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ]);
          return "end_turn";
        },
      },
      async (request) => {
        asked.push(request);
        return { outcome: "selected", optionId: "yes" };
      },
    );
    await client.initialize();
    await client.prompt("s1", [{ type: "text", text: "push it" }], () => {});
    expect(asked[0]?.toolCall.title).toBe("git push");
    expect(asked[0]?.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
    expect(chosen).toEqual({ outcome: "selected", optionId: "yes" });
  });

  test("a caller that fails answers cancelled — never an error the agent could read as a yes", async () => {
    let chosen: PermissionOutcome | undefined;
    const { client } = pair(
      {
        prompt: async (_params, channel) => {
          chosen = await channel.requestPermission({ toolCallId: "t1", title: "rm -rf build" }, [{ optionId: "ok", name: "Allow", kind: "allow_once" }]);
          return "end_turn";
        },
      },
      async () => {
        throw new Error("the gate is down");
      },
    );
    await client.initialize();
    await client.prompt("s1", [], () => {});
    expect(chosen).toEqual({ outcome: "cancelled" });
  });
});

describe("what the client never lends", () => {
  test("a file read or a terminal is refused with method-not-found, naming the agent's own folder", async () => {
    let client!: AcpClient;
    const agent = new AcpPeer({ send: (line) => later(() => client.receive(line)) });
    client = new AcpClient({ transport: { send: (line) => later(() => agent.receive(line)) }, permission: async () => ({ outcome: "cancelled" }) });
    await expect(agent.call("fs/read_text_file", { sessionId: "s1", path: "/etc/shadow" })).rejects.toThrow("work in the session's folder");
    await expect(agent.call("terminal/create", { sessionId: "s1", command: "sh" })).rejects.toThrow("neither its files nor a terminal");
  });
});

describe("the connection", () => {
  test("a peer that dies fails every call in flight at once, and every call after", async () => {
    const { client } = pair({ prompt: () => new Promise(() => {}) });
    await client.initialize();
    const running = client.prompt("s1", [], () => {});
    client.closed("exited with code 1");
    const error = await running.catch((err: unknown) => err);
    // -32099: the peer's own code for a connection that ended, outside JSON-RPC's reserved range.
    expect((error as AcpError).code).toBe(-32099);
    expect((error as Error).message).toContain("exited with code 1");
    await expect(client.newSession("/work")).rejects.toThrow("the connection is closed");
  });

  test("a call with a deadline fails when nothing answers", async () => {
    const silent = new AcpPeer({ send: () => {} });
    await expect(silent.call("initialize", {}, { timeoutMs: 10 })).rejects.toThrow("no answer in 0 s");
  });

  test("an update the caller throws on is dropped and said, and the prompt still ends (0.8.1)", async () => {
    // A throw here ended the reader of a CLI's stdout for good: its turn then waited forever on an answer nobody read.
    const failed: string[] = [];
    let server!: AcpServer;
    const client = new AcpClient({
      transport: { send: (line) => later(() => server.receive(line)) },
      permission: async () => ({ outcome: "cancelled" }),
      failed: (method) => failed.push(method),
    });
    server = new AcpServer({
      transport: { send: (line) => later(() => client.receive(line)) },
      agentInfo: { name: "test-agent", version: "1.0.0" },
      handlers: {
        newSession: async () => ({ sessionId: "s1" }),
        prompt: async (_params, channel) => {
          channel.update({ sessionUpdate: "plan" } as never);
          channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
          return "end_turn";
        },
        cancel: () => {},
      },
    });
    await client.initialize();
    const said: string[] = [];
    const stop = await client.prompt("s1", [], (update) => {
      if (update.sessionUpdate === "plan") throw new TypeError("entries is undefined");
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") said.push(update.content.text);
    });
    expect({ stop, said, failed }).toEqual({ stop: "end_turn", said: ["done"], failed: ["session/update"] });
  });

  test("a refusal to a peer already gone is not an error of its own", async () => {
    // Answering a call after the CLI died threw from the refusal's write too, unhandled, into the daemon's log.
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const peer = new AcpPeer({ send: () => { throw new Error("EPIPE"); } }, { request: async () => { throw new Error("no"); } });
      peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "fs/read_text_file", params: {} }));
      // A rejection nobody handles is said after the tick it happened in: nothing to wait on for what must not come.
      await sleep(20);
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
  });

  test("a banner on stdout is passed aside, and the conversation goes on", async () => {
    const { client, strays } = pair();
    client.receive("Claude Code ACP adapter starting…");
    client.receive("");
    expect((await client.initialize()).protocolVersion).toBe(1);
    expect(strays).toEqual(["Claude Code ACP adapter starting…"]);
  });

  test("the server refuses what it does not serve, and a call missing what it needs", async () => {
    let server!: AcpServer;
    const editor = new AcpPeer({ send: (line) => later(() => server.receive(line)) });
    server = new AcpServer({
      transport: { send: (line) => later(() => editor.receive(line)) },
      agentInfo: { name: "nouride", version: "0.8.1" },
      handlers: { newSession: async () => ({ sessionId: "s" }), prompt: async () => "end_turn", cancel: () => {} },
    });
    await expect(editor.call("session/load", { sessionId: "s", cwd: "/w", mcpServers: [] })).rejects.toThrow("does not reopen sessions");
    await expect(editor.call("session/prompt", { prompt: [] })).rejects.toThrow("sessionId is required");
    await expect(editor.call("terminal/create", {})).rejects.toThrow("is not supported");
  });
});

describe("the wire", () => {
  test("a line is read by what it is; what is not a message is null", () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}')).toEqual({ kind: "response", id: 3, result: { ok: true } });
    expect(parseMessage('{"jsonrpc":"2.0","id":"a","method":"session/request_permission","params":{}}')).toEqual({ kind: "request", id: "a", method: "session/request_permission", params: {} });
    expect(parseMessage('{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}')).toEqual({ kind: "notification", method: "session/update", params: { x: 1 } });
    expect(parseMessage('{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"auth"}}')).toEqual({ kind: "response", id: 4, error: { code: -32000, message: "auth" } });
    for (const line of ["not json", "[1,2]", "null", '{"jsonrpc":"2.0","id":5}', '{"jsonrpc":"2.0","id":{},"method":"x"}']) expect(parseMessage(line)).toBeNull();
  });
});
