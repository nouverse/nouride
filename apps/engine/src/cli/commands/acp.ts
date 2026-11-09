/**
 * `nouride acp [--agent <id>]` — Nouride's agents in Zed and the editors that copied it. The editor
 * starts this as a subprocess and speaks ACP on its stdin and stdout; this speaks to the daemon as every command does.
 *
 * An adapter, not a second runtime: the agent runs where it always runs — in the daemon, with its workspace, sandbox,
 * approvals and audit — and the editor is one more place its turns are watched from. A session is a conversation on
 * the local connection, chat `acp-<uuid>`; a prompt is `POST /message`, and what the turn does arrives on that chat's
 * event stream, opened before the message is sent so nothing between the two is lost, and mapped to `session/update`s
 * (`acp-updates.ts`). A parked call is the editor's permission prompt, answered at `/approvals/:id/:decision`; a cancel
 * is `/stop`. The editor's files and terminal are not borrowed: the agent works in its own roots, and a session whose
 * folder is none of them is refused, naming the fix.
 *
 * stdout is the protocol's: everything said for a person goes to stderr.
 */

import { AcpError, AcpServer, INTERNAL_ERROR, INVALID_PARAMS, type ContentBlock, type PermissionOption, type SessionChannel, type SessionUpdate } from "@nouride/acp";
import { randomUuid, resolve } from "@nouride/runtime";
import { connect, type Client } from "@/cli/client.ts";
import { flagValue } from "@/cli/args.ts";
import { VERSION } from "@/cli/version.ts";
import { readFrames } from "@/cli/commands/events.ts";
import { TurnUpdates, type EventRow, type WaitingCall } from "@/cli/acp-updates.ts";
import type { ApprovalsResponse, MessageResponse, StatusResponse } from "@/cli/wire.ts";
import { LOCAL_GATEWAY_ID } from "@/modules/gateways/local.ts";

/** How long a turn's end may trail `/message`'s answer on the stream before the prompt is answered without it. */
const SETTLE_MS = 3_000;
const SETTLE_TICK_MS = 20;
/** How long the stream may take to say it is open before the message goes anyway. */
const OPEN_MS = 5_000;
/**
 * How often a running prompt asks for the pending approvals. The local connection counts as someone to ask only while
 * something polls them (`tools/reachability.ts`, a 30-second window): without it, every call that needs a person was
 * refused "nobody to ask" in an editor on a box with no chat connected — found running it against a sandbox daemon.
 */
const WATCH_MS = 10_000;

type Daemon = Pick<Client, "softGet" | "softPost" | "open">;

interface Session {
  running?: { cancelled: boolean };
}

export async function acp(args: string[]): Promise<void> {
  const agent = flagValue(args, "--agent");
  let client: Client;
  try {
    client = await connect({ soft: true });
  } catch (err) {
    process.stderr.write(`nouride acp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const server = serveAcp({ daemon: client, ...(agent ? { agent } : {}), send: (line) => void process.stdout.write(`${line}\n`) });
  let buffer = "";
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) server.receive(line);
      }
    } catch (err) {
      // One line the adapter could not take is said, and the session goes on.
      process.stderr.write(`nouride acp: ${String(err)}\n`);
    }
  });
  // The editor closed its end: the session is over, and so is this.
  await new Promise<void>((done) => process.stdin.on("end", () => done()));
}

/** The adapter itself, on any daemon and any line transport — what `acp` runs on stdio. */
export function serveAcp(deps: { daemon: Daemon; agent?: string; send: (line: string) => void; settleMs?: number }): AcpServer {
  const sessions = new Map<string, Session>();
  const { daemon } = deps;
  const settleMs = deps.settleMs ?? SETTLE_MS;

  const server = new AcpServer({
    transport: { send: deps.send },
    agentInfo: { name: "nouride", title: deps.agent ? `Nouride · ${deps.agent}` : "Nouride", version: VERSION },
    stray: (line) => void process.stderr.write(`nouride acp: a line that is not ACP was ignored: ${line.slice(0, 200)}\n`),
    handlers: {
      newSession: async ({ cwd }) => {
        await refuseOutsideRoots(daemon, deps.agent, cwd);
        const sessionId = `acp-${randomUuid()}`;
        sessions.set(sessionId, {});
        return { sessionId };
      },
      loadSession: async ({ sessionId, cwd }, channel) => {
        await refuseOutsideRoots(daemon, deps.agent, cwd);
        sessions.set(sessionId, {});
        await replay(daemon, sessionId, channel);
      },
      prompt: async ({ sessionId, prompt }, channel) => {
        const session = sessions.get(sessionId) ?? {};
        sessions.set(sessionId, session);
        const running = { cancelled: false };
        session.running = running;
        try {
          return await promptTurn({ daemon, ...(deps.agent ? { agent: deps.agent } : {}), sessionId, text: textOf(prompt), channel, running, settleMs });
        } finally {
          session.running = undefined;
        }
      },
      cancel: (sessionId) => {
        const running = sessions.get(sessionId)?.running;
        if (!running) return;
        running.cancelled = true;
        // The route the dashboard's stop button and `/stop` use.
        void daemon.softPost("/stop", { chatId: sessionId, gateway: LOCAL_GATEWAY_ID, ...(deps.agent ? { agent: deps.agent } : {}) }).catch((err: unknown) => process.stderr.write(`nouride acp: could not stop the turn: ${String(err)}\n`));
      },
    },
  });
  return server;
}

/** The editor's prompt as the one message the agent reads: text, and an embedded file as fenced context. */
function textOf(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      const resource = (block as { resource?: { uri?: string; text?: string } }).resource;
      if (resource?.text !== undefined) return `${resource.uri ?? "a file"}:\n\`\`\`\n${resource.text}\n\`\`\``;
      const link = (block as { uri?: string }).uri;
      return link ? `(${link})` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A session's folder is one the agent works in — its roots are the truth, not the editor's. The agent named, or the
 * orchestrator, which answers the local connection when none is.
 */
async function refuseOutsideRoots(daemon: Daemon, agent: string | undefined, cwd: string): Promise<void> {
  const status = await daemon.softGet<StatusResponse>("/status");
  const id = agent ?? status.orchestrator;
  const found = status.agents.find((entry) => entry.id === id);
  if (!found) throw new AcpError(INVALID_PARAMS, agent ? `no agent "${agent}" on this daemon` : "this daemon has no orchestrator to answer the editor: run nouride acp --agent <id>");
  const folder = resolve(cwd);
  const roots = found.workspaceRoots.map((root) => resolve(root.path));
  if (roots.some((root) => folder === root || folder.startsWith(`${root}/`))) return;
  throw new AcpError(
    INVALID_PARAMS,
    `${folder} is not a folder ${found.displayName} works in${roots.length ? ` (its roots: ${roots.join(", ")})` : ""}. Add it to [workspace] roots in its pack's config.toml`,
  );
}

async function promptTurn(input: { daemon: Daemon; agent?: string; sessionId: string; text: string; channel: SessionChannel; running: { cancelled: boolean }; settleMs: number }): Promise<"end_turn" | "cancelled"> {
  const { daemon, channel, running } = input;
  const turn = new TurnUpdates();
  let ended: { status: string; error?: string } | null = null;
  const follow = followChat(daemon, input.sessionId, (row) => {
    const out = turn.read(row);
    for (const update of out.updates) channel.update(update);
    if (out.waiting) void askEditor(daemon, out.waiting, channel);
    if (out.ended) ended = out.ended;
  });
  const watch = () => void daemon.softGet("/approvals").catch(() => {});
  watch();
  const watching = setInterval(() => {
    try {
      watch();
    } catch {
      // A poll that could not be made is the next one's to make.
    }
  }, WATCH_MS);
  try {
    await follow.open;
    let answer: MessageResponse;
    try {
      answer = await daemon.softPost<MessageResponse>("/message", { text: input.text, chatId: input.sessionId, ...(input.agent ? { agent: input.agent } : {}) });
    } catch (err) {
      throw new AcpError(INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
    }
    // The turn's end, which carries how it ended, may trail the answer on the stream by a moment.
    const until = Date.now() + input.settleMs;
    while (!ended && Date.now() < until) await new Promise((wake) => setTimeout(wake, SETTLE_TICK_MS));
    for (const update of turn.finish(answer.replies.join("\n\n"))) channel.update(update);
    if (!answer.answered && answer.note) channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer.note } } satisfies SessionUpdate);
    const end = ended as { status: string; error?: string } | null;
    if (running.cancelled || end?.status === "cancelled" || end?.status === "interrupted") return "cancelled";
    if (end?.status === "failed" && answer.replies.length === 0) throw new AcpError(INTERNAL_ERROR, end.error ?? "the turn failed");
    return "end_turn";
  } finally {
    clearInterval(watching);
    follow.stop();
  }
}

/**
 * The chat's event stream from now: `open` settles once the daemon says it is following (its `hello`), or once it has
 * said it will not — the message goes either way, and the answer still arrives through `/message`. A dropped stream
 * is opened again from where it was.
 */
function followChat(daemon: Daemon, chatId: string, take: (row: EventRow) => void): { open: Promise<void>; stop(): void } {
  let stopped = false;
  let last: number | null = null;
  let reader: { cancel(): Promise<void> } | null = null;
  let opened!: () => void;
  const open = new Promise<void>((done) => (opened = done));
  const timer = setTimeout(() => {
    try {
      opened();
    } catch {
      // Settling a promise cannot fail; the wrap is the timers rule's, which cannot see that.
    }
  }, OPEN_MS);
  void (async () => {
    while (!stopped) {
      const params = new URLSearchParams({ chat: chatId, gateway: LOCAL_GATEWAY_ID });
      if (last === null) params.set("tail", "1");
      else params.set("since", String(last));
      try {
        const body = await daemon.open(`/events/stream?${params.toString()}`);
        const current = body.getReader();
        reader = current;
        const readable = new ReadableStream<Uint8Array>({ pull: async (controller) => { const next = await current.read(); if (next.done) controller.close(); else controller.enqueue(next.value); }, cancel: () => current.cancel() });
        for await (const item of readFrames(readable)) {
          if (stopped) return;
          if (item.row) {
            last = item.row.seq;
            take(item.row);
          } else if (item.frame.event === "hello") {
            if (last === null) last = item.frame.data.latest;
            opened();
          }
        }
      } catch (err) {
        const status = (err as { status?: number }).status;
        // Refused rather than dropped: asking again would ask the same question for the rest of the turn.
        if (stopped || (status !== undefined && status >= 400 && status < 500)) return void opened();
      }
      if (!stopped) await new Promise((wake) => setTimeout(wake, 1_000));
    }
  })().catch(() => opened());
  return {
    open,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      opened();
      void reader?.cancel().catch(() => {});
    },
  };
}

/** Nouride's decisions, as the editor's options; `reject_always` is not offered — Nouride keeps no standing no. */
const DECISIONS = new Set(["allow-once", "allow-always", "deny"]);

async function askEditor(daemon: Daemon, waiting: WaitingCall, channel: SessionChannel): Promise<void> {
  try {
    const request = (await daemon.softGet<ApprovalsResponse>("/approvals").catch(() => null))?.pending.find((entry) => entry.id === waiting.approvalId);
    const options: PermissionOption[] = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      // Offered only where it would remember something: an always on a call that cannot be granted runs once.
      ...(request?.grantable ? [{ optionId: "allow-always", name: "Always allow", kind: "allow_always" as const }] : []),
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ];
    const outcome = await channel.requestPermission({ toolCallId: waiting.callId ?? waiting.approvalId, title: waiting.text, ...(request ? { rawInput: request.params } : {}) }, options);
    // Cancelled — the prompt ended, or the editor closed the question: left pending, it expires as a denial.
    if (outcome.outcome !== "selected" || !DECISIONS.has(outcome.optionId)) return;
    await daemon.softPost(`/approvals/${waiting.approvalId}/${outcome.optionId}`);
  } catch (err) {
    process.stderr.write(`nouride acp: could not put approval ${waiting.approvalId} to the editor: ${String(err)}\n`);
  }
}

/** A session reopened: what was asked and answered in it, from the stream's record, as the editor's history. */
async function replay(daemon: Daemon, chatId: string, channel: SessionChannel): Promise<void> {
  let since = 0;
  const delegated = new Set<string>();
  for (;;) {
    const page = await daemon.softGet<{ events: (EventRow & { seq: number })[]; next: number }>(`/events?${new URLSearchParams({ chat: chatId, gateway: LOCAL_GATEWAY_ID, kinds: "turn", since: String(since), limit: "500" }).toString()}`);
    for (const row of page.events) {
      const { data } = row;
      if (data.phase === "start" && row.turnId && typeof data.via === "string") delegated.add(row.turnId);
      if (row.turnId && delegated.has(row.turnId)) continue;
      if (data.phase === "start" && typeof data.prompt === "string") channel.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: data.prompt } });
      if (data.phase === "end" && typeof data.reply === "string" && data.reply) channel.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: data.reply } });
    }
    if (page.events.length === 0 || page.next <= since) return;
    since = page.next;
  }
}
