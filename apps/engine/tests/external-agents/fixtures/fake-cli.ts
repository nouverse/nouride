/**
 * A coding CLI that speaks ACP on stdin/stdout, for the external-agent tests: started as a real process, as an agent's
 * CLI is. `FAKE_MODE` picks how it behaves:
 *
 * - (unset) a turn: a thought, a tool call, a permission for `git push` that decides whether its call completes, a
 *   plan, and a reply that repeats the prompt;
 * - `auth` — refuses to open a session, as a CLI that is not signed in does; so does any mode on a profile
 *   (`FAKE_HOME`) holding a `signed-out` file, as a real CLI's sign-in lives in its profile;
 * - `slow` — a prompt that says it started, then runs until it is cancelled (`cancel:<session>` on stderr);
 * - `deaf` — a prompt that says it started, then runs whatever is said to it: a cancel too;
 * - `badplan` — a turn that first sends a plan without its entries, which no reader can take;
 * - `overloaded` — says on stderr, as a session opens, that an MCP server was "not found", then refuses every prompt;
 * - `usage` — as the default, its prompt's answer reporting the tokens it spent (0.8.7) — the cache read and written
 *   beside the input, as claude-agent-acp sends them — and its context said first (`usage_update`, 0.8.8);
 * - `explain` — a turn as Claude Code writes one: its explanation in two chunks, a command announced while its input
 *   still streams, then a closing line (0.8.7);
 * - `look` — answers with the prompt's blocks as it got them, JSON, so a test reads what reached it (0.8.7);
 * - `script` — the updates in `FAKE_SCRIPT`, JSON, sent in order, `{"sleep": ms}` a pause between them (0.8.7);
 * - `steer` (0.8.10) — offers `_session/steering` (`_meta.steering.supported` in its handshake) and answers it with
 *   `FAKE_STEER`: `injected` puts the words into the running prompt, which then answers "Steered: <words>" — or, with no
 *   prompt running, `promptRequired`, as claude-agent-acp does with `idleBehavior`; `promptRequired`, `failed` and
 *   `startedNewTurn` as said. A prompt says "Working.", then — 50 ms on — holds a tool call open for `FAKE_TOOL_MS` where set —
 *   `FAKE_TOOLS` of them back to back, 5 ms apart, as Codex runs its steps — and waits for a steer up to
 *   `FAKE_STEER_WAIT_MS` (3 s), then answers "Done: <prompt>". Each steer goes to stderr as `steer:<words>`.
 *   `FAKE_STEER_OFFER=no`: the same CLI, not offering the extension.
 * - `background` — a prompt that answers "Started it." and, a moment after its end (`FAKE_LATER_MS`), goes on by itself
 *   with no prompt running, as Claude Code does when a command it left running ends: a step, then — 50 ms on, as a busy
 *   machine reads them apart — "Finished: …", and `went-on:<session>` on stderr once it has. A session it reopens replays
 *   its history first;
 * - `mcp` — a prompt that lists the tools of the `nouride` MCP server its session was given, calls `notes` with the
 *   prompt and `exec`, and replies with what each answered. Its headers' `${VAR}`s are filled from its environment, as
 *   Claude Code fills them, and each session's headers as given go to stderr.
 *
 * `FAKE_TAKES`, JSON, is what it says at its handshake it takes in a prompt (`{"image":true}`); unset, text alone.
 *
 * `FAKE_EFFORTS`, JSON of each model's efforts (`{"small":["low","high"]}`), adds an effort option filed under ACP's
 * `thought_level` with an id of its own, `reasoning`, whose values follow the model as Claude Code's do: a model change
 * sets the effort back to the model's first. Unset, the CLI offers no effort. An option or value it did not offer is
 * refused, as a real CLI refuses it.
 *
 * Each session's folder, each mode, model and effort it is set to, and each session reopened or closed goes to stderr,
 * which the connection keeps. A closed session refuses a prompt, as claude-agent-acp does ("Session not found"), until
 * it is reopened.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { AcpServer, authRequired, type ContentBlock, type McpServer, type SessionConfigOption } from "@nouride/acp";
import { sleep } from "../../wait.ts";

const mode = process.env.FAKE_MODE ?? "";
let sessions = 0;
const waiting = new Map<string, () => void>();
const servers = new Map<string, McpServer[]>();
const efforts = JSON.parse(process.env.FAKE_EFFORTS ?? "{}") as Record<string, string[]>;
const settings = new Map<string, { model: string; effort?: string }>();
const closed = new Set<string>();
/** `steer` mode: each running prompt's ear for the words a steer brings. */
const steered = new Map<string, (words: string) => void>();
/** The handshake's request ids — answered with the steering extension in `steer` mode. */
const handshakes = new Set<unknown>();
const text = (blocks: ContentBlock[]) => blocks.map((block) => (block.type === "text" ? block.text : "")).join("");

const server = new AcpServer({
  transport: {
    send: (line) => {
      if (mode === "steer" && process.env.FAKE_STEER_OFFER !== "no") {
        // The handshake's answer says it takes a message mid-prompt, as both installed adapters do.
        const message = JSON.parse(line) as { id?: unknown; result?: Record<string, unknown> };
        if (message.result && handshakes.delete(message.id)) message.result._meta = { steering: { supported: true } };
        return void process.stdout.write(`${JSON.stringify(message)}\n`);
      }
      process.stdout.write(`${line}\n`);
    },
  },
  agentInfo: { name: "fake-cli", version: "9.9.9" },
  mcpCapabilities: { http: true },
  promptCapabilities: JSON.parse(process.env.FAKE_TAKES ?? "{}") as { image?: boolean; audio?: boolean },
  handlers: {
    newSession: async ({ cwd, mcpServers }) => {
      if (mode === "auth" || existsSync(join(process.env.FAKE_HOME ?? "/nonexistent", "signed-out"))) throw authRequired("Authentication required");
      sessions += 1;
      process.stderr.write(`cwd:${cwd}\n`);
      if (mode === "overloaded") process.stderr.write("[mcp] server 'github' not found\n");
      servers.set(`s${sessions}`, mcpServers);
      for (const given of mcpServers) if ("headers" in given) process.stderr.write(`mcp-headers:${given.headers.map((header) => header.value).join(" ")}\n`);
      return {
        sessionId: `s${sessions}`,
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Ask" }, { id: "yolo", name: "Free" }] },
        configOptions: optionsOf(`s${sessions}`),
      };
    },
    loadSession: async ({ sessionId }, channel) => {
      process.stderr.write(`loaded:${sessionId}\n`);
      closed.delete(sessionId);
      if (mode === "background") channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Said long ago." } });
    },
    setMode: async (_sessionId, modeId) => void process.stderr.write(`mode:${modeId}\n`),
    setConfigOption: async (sessionId, configId, value) => {
      const option = optionsOf(sessionId).find((entry) => entry.id === configId);
      if (!option) throw new Error(`Unknown config option: ${configId}`);
      if (!option.options?.some((entry) => entry.value === value)) throw new Error(`Invalid value for config option ${configId}: ${value}`);
      const set = settings.get(sessionId)!;
      if (configId === "model") settings.set(sessionId, { model: value, ...(efforts[value]?.[0] ? { effort: efforts[value][0] } : {}) });
      else set.effort = value;
      process.stderr.write(`${configId}:${value}\n`);
      return { configOptions: optionsOf(sessionId) };
    },
    prompt: async ({ sessionId, prompt }, channel) => {
      if (closed.has(sessionId)) throw new Error(`Session not found: ${sessionId}`);
      if (mode === "mcp") {
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: await useNouride(servers.get(sessionId) ?? [], text(prompt)) } });
        return "end_turn";
      }
      if (mode === "steer") {
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working." } });
        const toolMs = Number(process.env.FAKE_TOOL_MS ?? 0);
        const tool = (left: number) => {
          const id = `s${sessions}-${left}`;
          channel.update({ sessionUpdate: "tool_call", toolCallId: id, title: "bun test", kind: "execute", name: "Bash", status: "in_progress" });
          setTimeout(() => {
            process.stderr.write("tool-done\n");
            channel.update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
            if (left > 1) setTimeout(() => tool(left - 1), 5);
          }, toolMs);
        };
        // 50 ms after "Working.", as a busy machine reads the two apart: a test sends its words once the call is open.
        if (toolMs > 0) setTimeout(() => tool(Number(process.env.FAKE_TOOLS ?? 1)), 50);
        const words = await new Promise<string | null>((resolve) => {
          steered.set(sessionId, resolve);
          setTimeout(() => resolve(null), Number(process.env.FAKE_STEER_WAIT_MS ?? 3_000));
        });
        steered.delete(sessionId);
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: words ? `Steered: ${words}` : `Done: ${text(prompt)}` } });
        return "end_turn";
      }
      if (mode === "slow" || mode === "deaf") {
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it." } });
        return await new Promise((resolve) => waiting.set(sessionId, () => mode === "slow" && resolve("cancelled")));
      }
      if (mode === "background") {
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Started it." } });
        setTimeout(() => {
          channel.update({ sessionUpdate: "usage_update", used: 1, size: 10 });
          channel.update({ sessionUpdate: "tool_call", toolCallId: `b${sessions}`, title: "cat out.log", kind: "read", name: "Read", status: "in_progress" });
          channel.update({ sessionUpdate: "tool_call_update", toolCallId: `b${sessions}`, status: "completed" });
          setTimeout(() => {
            channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Finished: ${text(prompt)}` } });
            process.stderr.write(`went-on:${sessionId}\n`);
          }, 50);
        }, Number(process.env.FAKE_LATER_MS ?? 100));
        return "end_turn";
      }
      if (mode === "script") {
        for (const entry of JSON.parse(process.env.FAKE_SCRIPT ?? "[]") as Record<string, unknown>[]) {
          // Fixed: the CLI's own pace between its updates, which is what a test using this mode is about.
          if (typeof entry.sleep === "number") await sleep(entry.sleep);
          // The prompt as it came, said back: what a test reads a note in.
          else if (entry.echo === true) channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: text(prompt) } });
          else channel.update(entry as never);
        }
        return "end_turn";
      }
      if (mode === "look") {
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(prompt) } });
        return "end_turn";
      }
      if (mode === "explain") {
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The build failed on step two: the cache " } });
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "held an old lockfile, so I clear it and run it again." } });
        channel.update({ sessionUpdate: "tool_call", toolCallId: "e1", title: "Terminal", kind: "execute", name: "Bash", status: "pending", rawInput: {} });
        channel.update({ sessionUpdate: "tool_call_update", toolCallId: "e1", title: "rm -rf .cache && bun run build", rawInput: { command: "rm -rf .cache && bun run build" } });
        channel.update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "in_progress" });
        channel.update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", content: [{ type: "content", content: { type: "text", text: "built" } }] });
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Green now." } });
        return "end_turn";
      }
      if (mode === "badplan") channel.update({ sessionUpdate: "plan" } as never);
      if (mode === "usage") channel.update({ sessionUpdate: "usage_update", used: 42_000, size: 200_000 });
      if (mode === "overloaded") throw new Error("the model is overloaded, try again later");
      channel.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Looking first." } });
      channel.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "echo hi", kind: "execute", name: "Bash", status: "in_progress" });
      channel.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] });
      channel.update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "git push", kind: "execute", name: "Bash", status: "pending", rawInput: { command: "git push" } });
      const answer = await channel.requestPermission({ toolCallId: "t2", title: "git push", kind: "execute", name: "Bash", rawInput: { command: "git push" } }, [
        { optionId: "ok", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ]);
      const allowed = answer.outcome === "selected" && answer.optionId === "ok";
      channel.update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: allowed ? "completed" : "failed" });
      channel.update({ sessionUpdate: "plan", entries: [{ content: "push it", priority: "high", status: allowed ? "completed" : "pending" }] });
      channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Done: ${text(prompt)}` } });
      // `usage`: what the turn spent, as ACP's unstable `PromptResponse.usage` says it (0.8.7).
      return mode === "usage" ? { stopReason: "end_turn", usage: { totalTokens: 1234, inputTokens: 100, outputTokens: 234, cachedReadTokens: 800, cachedWriteTokens: 100 } } : "end_turn";
    },
    cancel: (sessionId) => {
      process.stderr.write(`cancel:${sessionId}\n`);
      waiting.get(sessionId)?.();
    },
    closeSession: async (sessionId) => {
      closed.add(sessionId);
      process.stderr.write(`closed:${sessionId}\n`);
    },
  },
});

/** A session's options: its model, and its effort where `FAKE_EFFORTS` gives its model any. */
function optionsOf(sessionId: string): SessionConfigOption[] {
  if (!settings.has(sessionId)) settings.set(sessionId, { model: "small", ...(efforts.small?.[0] ? { effort: efforts.small[0] } : {}) });
  const set = settings.get(sessionId)!;
  const levels = efforts[set.model] ?? [];
  return [
    { id: "model", category: "model", type: "select", currentValue: set.model, options: [{ value: "small" }, { value: "big" }] },
    ...(levels.length > 0 ? [{ id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", currentValue: set.effort, options: levels.map((value) => ({ value })) }] : []),
  ];
}

/** What the CLI would do with Nouride's MCP server: list its tools, call two, and say what came back. */
async function useNouride(given: McpServer[], prompt: string): Promise<string> {
  const server = given.find((entry) => entry.name === "nouride");
  if (!server || !("url" in server)) return "no nouride server";
  const filled = (value: string) => value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
  const headers = { "content-type": "application/json", ...Object.fromEntries(server.headers.map((header) => [header.name, filled(header.value)])) };
  let id = 0;
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return ((await response.json()) as { result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } }).result;
  };
  const listed = (await rpc("tools/list", {})).tools?.map((tool) => tool.name).join(",");
  const notes = await rpc("tools/call", { name: "notes", arguments: { text: prompt } });
  const exec = await rpc("tools/call", { name: "exec", arguments: { command: "ls" } });
  return `listed=${listed} notes=${notes.content?.[0]?.text}/${notes.isError} exec=${exec.content?.[0]?.text}/${exec.isError}`;
}

/** `steer` mode: the extension `AcpServer` does not know, answered here — true where the line was it. */
function steering(line: string): boolean {
  const message = JSON.parse(line) as { id?: unknown; method?: string; params?: { sessionId?: string; prompt?: ContentBlock[] } };
  if (message.method === "initialize") handshakes.add(message.id);
  if (message.method !== "_session/steering") return false;
  const words = text(message.params?.prompt ?? []);
  process.stderr.write(`steer:${words}\n`);
  let outcome = process.env.FAKE_STEER ?? "injected";
  const ear = steered.get(message.params?.sessionId ?? "");
  if (outcome === "injected") {
    if (ear) ear(words);
    else outcome = "promptRequired";
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome } })}\n`);
  return true;
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (mode === "steer" && steering(line)) continue;
    server.receive(line);
  }
});
process.stdin.on("end", () => process.exit(0));
