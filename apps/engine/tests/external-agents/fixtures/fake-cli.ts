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
 *   `FAKE_STEER_OFFER=no`: the same CLI, not offering the extension. `FAKE_TOOL_HELPER=1`: the tool call is a
 *   helper's the CLI started itself, marked in its `_meta` as `{ fake: { startedBy: "agent-1" } }`.
 * - `byprompt` — takes a message mid-prompt as a second `session/prompt`, as Antigravity does (seen on the live box):
 *   a prompt says "Working." 50 ms on, and only then is running; a prompt that comes into a running one answers that
 *   one at once, with no usage, and goes on: "Steered: <words>", its usage 20 (`byprompt:<words>` on stderr). With none,
 *   "Done: <prompt>" after `FAKE_STEER_WAIT_MS`, usage 10. `FAKE_ASK=1`: the prompt first asks permission for a
 *   command, and a prompt that comes while it waits is refused as Antigravity refuses it (`refused:<words>`).
 * - `held` — a CLI that starts a helper of its own in the background and keeps the prompt open for it, as Claude
 *   Code's connector does: the first prompt of a session says "Started.", opens the helper's call (marked in its
 *   `_meta` as `{ fake: { startedBy: "agent-1" } }`), says its own turn ended with a usage update that carries `cost`,
 *   and does not answer. It answers once the helper has ended (`FAKE_HELPER_MS`) or the session's next prompt comes,
 *   which is answered "Done: <prompt>" while the helper goes on. When the helper ends, its call is closed and the CLI
 *   says "Helper done." by itself. `held-working`: the same, and the agent goes on working itself after its turn
 *   "ended", as one a message was steered into does: "Still at it." a moment later (`FAKE_WORK_MS`), then, eight
 *   times as long after, the answer.
 * - `background` — a prompt that answers "Started it." and, a moment after its end (`FAKE_LATER_MS`), goes on by itself
 *   with no prompt running, as Claude Code does when a command it left running ends: a step, then — 50 ms on, as a busy
 *   machine reads them apart — "Finished: …", and `went-on:<session>` on stderr once it has. A session it reopens replays
 *   its history first;
 * - `mcp` — a prompt that lists the tools of the `nouride` MCP server its session was given, calls `notes` with the
 *   prompt and `exec`, and replies with what each answered. Its headers' `${VAR}`s are filled from its environment, as
 *   Claude Code fills them, and each session's headers as given go to stderr.
 *
 * `FAKE_LIMITED`, a list of tokens: started with one of them in `FAKE_TOKEN`, as a shared account's token reaches a real
 * CLI, every prompt is refused as an account at its limit is: the limit said as a message, then a refusal whose data is
 * `{ errorKind: "rate_limit" }`, with `rateLimit.resetsAt` where `FAKE_LIMIT_RESETS` says it, in seconds. `FAKE_LIMITED_AFTER=step`: after one step of work. Each prompt goes to stderr as
 * `prompted-as:<token> in <the profile folder's name>`.
 *
 * `FAKE_USE`, JSON by token (`{"tok-first":0.93}`): started with that token, each prompt says how much of its account's
 * limits is used, beside the context's size as claude-agent-acp says it: `_meta["fake/use"].windows`, a short one at
 * that share starting again in an hour, and a long one at a tenth.
 *
 * `FAKE_TAKES`, JSON, is what it says at its handshake it takes in a prompt (`{"image":true}`); unset, text alone.
 *
 * `FAKE_AUTH=hangs` or `refuses`: told a method signed out, it never answers, or refuses it at once.
 * `FAKE_AUTH_METHODS`, a list of ids: the sign-in methods its handshake offers. `FAKE_NEEDS_TOLD`: one of them, which
 * it must be told (`authenticate`) before it opens a session, as Cursor's and Grok Build's CLIs must; each method it is
 * told goes to stderr as `told:<id>`.
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
import { basename, join } from "node:path";
import { AcpError, AcpServer, authRequired, type ContentBlock, type McpServer, type PromptUsage, type SessionChannel, type SessionConfigOption, type StopReason } from "@nouride/acp";
import { sleep } from "../../wait.ts";

const mode = process.env.FAKE_MODE ?? "";
let sessions = 0;
const waiting = new Map<string, () => void>();
const servers = new Map<string, McpServer[]>();
const efforts = JSON.parse(process.env.FAKE_EFFORTS ?? "{}") as Record<string, string[]>;
const settings = new Map<string, { model: string; effort?: string }>();
const closed = new Set<string>();
/** `held` mode: each session whose first prompt is held for its helper, and what answers it when the next prompt comes. */
const heldSessions = new Map<string, () => void>();
/** `steer` mode: each running prompt's ear for the words a steer brings. */
const steered = new Map<string, (words: string) => void>();
/** `byprompt` mode: each running prompt's end, by session, and the sessions waiting on a permission. */
const byPrompt = new Map<string, () => void>();
const asking = new Set<string>();
/** The handshake's request ids — answered with the steering extension in `steer` mode. */
const handshakes = new Set<unknown>();
const text = (blocks: ContentBlock[]) => blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
/** The sign-in method it was told, where it must be told one (`FAKE_NEEDS_TOLD`). */
let told: string | null = null;

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
  authMethods: (process.env.FAKE_AUTH_METHODS?.split(",") ?? []).map((id) => ({ id, name: id })),
  handlers: {
    authenticate: async (methodId) => {
      process.stderr.write(`told:${methodId}\n`);
      // Signed out: one CLI never answers the method (Grok Build's), another refuses it at once (Cursor's).
      if (process.env.FAKE_AUTH === "hangs") await new Promise(() => {});
      if (process.env.FAKE_AUTH === "refuses") throw new Error("Failed to open browser for login");
      told = methodId;
    },
    newSession: async ({ cwd, mcpServers }) => {
      if (mode === "auth" || existsSync(join(process.env.FAKE_HOME ?? "/nonexistent", "signed-out"))) throw authRequired("Authentication required");
      if (process.env.FAKE_NEEDS_TOLD && told !== process.env.FAKE_NEEDS_TOLD) throw authRequired("Authentication required: no auth method id provided");
      sessions += 1;
      process.stderr.write(`cwd:${cwd}\n`);
      if (mode === "overloaded") process.stderr.write("[mcp] server 'github' not found\n");
      servers.set(`s${sessions}`, mcpServers);
      for (const given of mcpServers) if ("headers" in given) process.stderr.write(`mcp-headers:${given.headers.map((header) => header.value).join(" ")}\n`);
      return {
        sessionId: `s${sessions}`,
        // `FAKE_MODES` (0.8.24): the modes a stand-in for a real CLI offers, for the weekly handshake check's tests.
        modes: { currentModeId: "default", availableModes: (process.env.FAKE_MODES?.split(",") ?? ["default", "yolo"]).map((id) => ({ id, name: id })) },
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
      // A model's change puts the level back to the new model's first, as Claude Code's follows its model; `keepeffort`
      // keeps the level where the new model offers it, as Codex does.
      const keeps = mode === "keepeffort" && set.effort !== undefined && efforts[value]?.includes(set.effort);
      if (configId === "model") settings.set(sessionId, { model: value, ...(keeps ? { effort: set.effort } : efforts[value]?.[0] ? { effort: efforts[value][0] } : {}) });
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
          const helpers = process.env.FAKE_TOOL_HELPER === "1" ? { _meta: { fake: { startedBy: "agent-1" } } } : {};
          channel.update({ sessionUpdate: "tool_call", toolCallId: id, title: "bun test", kind: "execute", name: "Bash", status: "in_progress", ...helpers });
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
      if (mode === "byprompt") return await byPromptAnswer(sessionId, prompt, channel);
      if (mode === "held" || mode === "held-working") {
        const said = (words: string) => channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: words } });
        if (heldSessions.has(sessionId)) {
          // The session's next prompt: the one held for the helper answers now, and this one is answered for itself.
          heldSessions.get(sessionId)!();
          said(`Done: ${text(prompt)}`);
          return "end_turn";
        }
        const helpers = { _meta: { fake: { startedBy: "agent-1" } } };
        said("Started.");
        channel.update({ sessionUpdate: "tool_call", toolCallId: "h1", title: "bun test", kind: "execute", name: "Bash", status: "in_progress", ...helpers });
        channel.update({ sessionUpdate: "usage_update", used: 1_000, size: 200_000, cost: { amount: 0.01, currency: "USD" } } as never);
        if (mode === "held-working") {
          const work = Number(process.env.FAKE_WORK_MS ?? 150);
          return await new Promise<"end_turn">((resolve) => {
            setTimeout(() => {
              said(" Still at it.");
              // Then quiet for longer than it was before its word: nothing of its own, the helper's call open all the while.
              setTimeout(() => {
                channel.update({ sessionUpdate: "tool_call_update", toolCallId: "h1", status: "completed", ...helpers });
                said(" All done.");
                resolve("end_turn");
              }, work * 8);
            }, work);
          });
        }
        const movedOn = new Promise<"moved on">((resolve) => heldSessions.set(sessionId, () => resolve("moved on")));
        const helperEnded = new Promise<"helper ended">((resolve) => setTimeout(() => resolve("helper ended"), Number(process.env.FAKE_HELPER_MS ?? 400)));
        const ended = await Promise.race([helperEnded, movedOn]);
        const finish = () => {
          channel.update({ sessionUpdate: "tool_call_update", toolCallId: "h1", status: "completed", ...helpers });
          // One more step of the helper's, then the agent's own word of what came of it.
          channel.update({ sessionUpdate: "tool_call", toolCallId: "h2", title: "cat report", kind: "read", name: "Read", status: "in_progress", ...helpers });
          channel.update({ sessionUpdate: "tool_call_update", toolCallId: "h2", status: "completed", ...helpers });
          said("Helper done.");
          process.stderr.write(`helper-done:${sessionId}\n`);
        };
        if (ended === "helper ended") finish();
        // Handed off to the next prompt: the helper goes on, and what comes of it is said with no prompt running.
        else setTimeout(finish, Number(process.env.FAKE_HELPER_MS ?? 400));
        process.stderr.write(`held-answered:${ended}\n`);
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
      if (process.env.FAKE_TOKEN) process.stderr.write(`prompted-as:${process.env.FAKE_TOKEN} in ${basename(process.env.FAKE_HOME ?? "")}\n`);
      const share = (JSON.parse(process.env.FAKE_USE ?? "{}") as Record<string, number>)[process.env.FAKE_TOKEN ?? "-"];
      if (share !== undefined) {
        const seconds = Math.floor(Date.now() / 1000);
        const windows = { short: { share, starts: seconds + 3_600 }, long: { share: 0.1, starts: seconds + 86_400 } };
        channel.update({ sessionUpdate: "usage_update", used: 1_000, size: 200_000, _meta: { "fake/use": { windows } } } as never);
      }
      if ((process.env.FAKE_LIMITED ?? "").split(",").includes(process.env.FAKE_TOKEN ?? "-")) {
        if (process.env.FAKE_LIMITED_AFTER === "step") {
          channel.update({ sessionUpdate: "tool_call", toolCallId: "l1", title: "git status", kind: "execute", name: "Bash", status: "in_progress" });
          channel.update({ sessionUpdate: "tool_call_update", toolCallId: "l1", status: "completed", content: [{ type: "content", content: { type: "text", text: "clean" } }] });
        }
        channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You have hit your limit." } });
        const resets = process.env.FAKE_LIMIT_RESETS;
        throw new AcpError(-32603, "Internal error: You have hit your limit.", { errorKind: "rate_limit", ...(resets ? { rateLimit: { resetsAt: Number(resets) } } : {}) });
      }
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

/** `byprompt` mode's prompt: one into a running prompt ends that one and goes on, refused while it waits on a permission. */
async function byPromptAnswer(sessionId: string, prompt: ContentBlock[], channel: SessionChannel): Promise<StopReason | { stopReason: StopReason; usage: PromptUsage }> {
  const said = (words: string) => channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: words } });
  const running = byPrompt.get(sessionId);
  if (running && asking.has(sessionId)) {
    process.stderr.write(`refused:${text(prompt)}\n`);
    throw new Error(`Can't add this prompt to session ${sessionId}: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again`);
  }
  if (running) {
    byPrompt.delete(sessionId);
    running();
    process.stderr.write(`byprompt:${text(prompt)}\n`);
    said(`Steered: ${text(prompt)}`);
    return { stopReason: "end_turn", usage: { totalTokens: 20, inputTokens: 15, outputTokens: 5, cachedReadTokens: null, cachedWriteTokens: null } };
  }
  await sleep(50);
  said("Working.");
  const ended = new Promise<"steered" | "done">((resolve) => {
    byPrompt.set(sessionId, () => resolve("steered"));
    setTimeout(() => resolve("done"), Number(process.env.FAKE_STEER_WAIT_MS ?? 3_000));
  });
  if (process.env.FAKE_ASK === "1") {
    asking.add(sessionId);
    const toolCall = { toolCallId: `a${sessions}`, title: "touch b.txt", kind: "execute" as const, name: "Bash", status: "pending" as const, rawInput: { command: "touch b.txt" } };
    channel.update({ sessionUpdate: "tool_call", ...toolCall });
    await channel.requestPermission(toolCall, [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]);
    asking.delete(sessionId);
    channel.update({ sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: "completed" });
  }
  if ((await ended) === "steered") return "end_turn";
  byPrompt.delete(sessionId);
  said(`Done: ${text(prompt)}`);
  return { stopReason: "end_turn", usage: { totalTokens: 10, inputTokens: 8, outputTokens: 2, cachedReadTokens: null, cachedWriteTokens: null } };
}
