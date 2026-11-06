/**
 * Handing work to another *permanent* agent, behind the chat.
 *
 * The counterpart to `delegate`, and the distinction is the same one that file draws from the other
 * side. A subagent is a blank helper running as its parent: no persona, no memory, the parent's id
 * and the parent's grants. This runs **somebody else** — Nox, with Nox's skills, Nox's memory, Nox's
 * tools and Nox's permissions — and gives their answer back to the caller as a tool result.
 *
 * ## Why it exists
 *
 * Agents already hand work to each other by @mention, and in a channel that is the right shape: every
 * bot in the room sees the tag, the exchange happens in front of the people in it, and the hop budget
 * bounds it. A one-to-one chat has none of that. Each bot has its own private conversation with the
 * person, so a tag written there reaches nobody at all — and the engine's workaround, re-injecting the
 * message internally, put a second agent inside a DM the person had opened with the first. Two agents
 * answering the same question under one name, one of them narrating tool calls nobody asked it for.
 *
 * So in a DM the mention is not delivered and this is the path instead. Same handover, different
 * transport: the peer works behind the chat, and the agent the person is talking to reports back.
 *
 * ## What it does not decide
 *
 * Permissions. The peer runs under its own id, so its exec grants, tool grants and approval gate are
 * *its* — an agent cannot borrow another's authority by asking it for something, and an approval the
 * peer needs is asked for in this conversation, in the peer's name. That is the same authority an
 * @mention already confers in a channel; what changes here is only where the message travels.
 *
 * ## An ask that does not hold the asking turn hostage (0.7.19)
 *
 * It ran the peer's whole turn inside the asking agent's tool call. A deploy or an audit then held that turn — its time
 * budget, and the person, who could not talk to the asking agent meanwhile. Now it waits for the answer as it always
 * did, up to `ASK_WAIT_MS`; past that, the peer's turn carries on as a job of the asking agent's
 * (`pipeline/background-ask.ts`), the call returns saying so, and the answer wakes the asking agent in this chat when it
 * comes. `background: true` returns at once. Only where the turn asking may hold work in the background — its own chat
 * turn, with `[delegate] max_background` above 0, the one limit helpers and asks share: a helper's ask, and a scheduled
 * turn's, wait to the end (`waitingAsk`). A peer has no `ask_agent` at all.
 */

import { createLogger, type LoadedAgent, type ModelTier, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import { isHandoffError, renderHandoff, type SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { describePeers } from "@/modules/router/agent-mentions.ts";
import { duration } from "@/modules/jobs/wake-text.ts";
import { runningList, type HelperView } from "./delegate.ts";
import { BRIEF_SCOPE } from "./delegate-brief.ts";
import { tierArg, tierParameter } from "./tier-arg.ts";
import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";

const log = createLogger("tools.ask_agent");

const MAX_TASK_CHARS = 4000;

/**
 * How long an ask waits for its answer before the other agent's turn moves to the background (0.7.19).
 *
 * Long enough for an answer the other agent gives from what it knows, or from a command or two, to come back inside the
 * asking turn as it always did. Short enough that a deploy or an audit does not hold the asking turn, its time budget
 * and the person with it: past this, the person hears that the other agent is on it, and can talk to the asking agent
 * meanwhile.
 */
const ASK_WAIT_MS = 60_000;

export interface PeerTurnRequest {
  /** The agent being asked. */
  to: string;
  /** The agent doing the asking — `ctx.agentId`, passed explicitly so the peer can be told. */
  from: string;
  task: string;
  ctx: ToolContext;
  /** Which of the asked agent's models it answers on (0.8.0). Absent: `default`, its own. */
  tier?: ModelTier;
}

/**
 * What comes back. A typed envelope, not a string — see `tools/handoff.ts` for why the fields the
 * worker could be wrong about are derived from what the harness watched it do rather than asked for.
 */
export type PeerTurnResult = SubAgentHandoff;

/** Why an ask did not move to the background: no room under the asking agent's limit, or no way to run one here. */
export type AskRefusal = { why: "limit"; limit: number; running: HelperView[] } | { why: "unavailable"; reason: string };

/** Moving one to the background: the job it now runs as — or it stays waited on, answered already or refused. */
export type AskDetached = { job: string } | { answered: true } | { refused: AskRefusal };

/** An ask under way that need not hold the asking turn (`pipeline/background-ask.ts`): its answer, and its way out. */
export interface AskRun {
  answer: Promise<PeerTurnResult>;
  detach(): AskDetached;
}

/** Started — or, asked for in the background, refused before anything of it ran. */
export type AskStart = { run: AskRun } | { refused: AskRefusal };

export interface AskAgentToolOptions {
  /**
   * Runs one peer turn to completion.
   *
   * Injected rather than built here, for the same reason `delegate` takes its runner: constructing a
   * turn needs the provider registry, the toolset and the approval gate, and a tool that could reach
   * all of those could reach anything.
   */
  run: (request: PeerTurnRequest) => Promise<PeerTurnResult>;
  /**
   * Starts one that may move to the background — at once with `background`, else after the wait. Absent where this
   * process runs no jobs: then every ask waits for its answer, and the schema offers no `background`.
   */
  start?: (request: PeerTurnRequest, background: boolean) => AskStart;
  /** How long an ask waits before it moves: `ASK_WAIT_MS`. A test's is shorter. */
  waitMs?: number;
  /**
   * Who can be asked right now, excluding the caller.
   *
   * A function, not a list: agents are created, paused and reloaded while the daemon runs, and a set
   * captured when the tool was built would name agents that have since gone and miss the ones added
   * after. It is also what the error message enumerates, so a wrong name is one recoverable step
   * rather than a dead end.
   */
  peers: (callerId: string) => string[];
  /**
   * Agent id → its capability line (`describePeers`: display name, and what its IDENTITY.md says it is for).
   *
   * Used where the tool names who can be asked — a wrong or missing name — so the list the model picks again from
   * says what each one does, as OTHER AGENTS does, rather than offering bare ids to guess between. Absent: ids alone.
   */
  about?: (ids: string[]) => Record<string, string>;
}

/**
 * Who can be asked, read from the live registry each time: every enabled agent but the caller — none while mentions
 * are off — each with the line OTHER AGENTS gives it. One builder for boot and the test bench, so they cannot drift.
 *
 * `enabled()` because a disabled agent cannot be reached by a mention either — naming one would send the model back
 * to try it again.
 */
export function peersFrom(
  registry: { enabled(): LoadedAgent[]; get(id: string): LoadedAgent | undefined },
  mentionsEnabled: () => boolean,
): Pick<AskAgentToolOptions, "peers" | "about"> {
  return {
    peers: (callerId) => (mentionsEnabled() ? registry.enabled().map((agent) => agent.config.id).filter((id) => id !== callerId) : []),
    about: (ids) => describePeers(ids, (id) => registry.get(id)),
  };
}

/** Who can be asked, one per line with what each is for where it is known. */
function availableLines(ids: string[], about: Record<string, string>): string {
  if (ids.length === 0) return "There are none.";
  if (!ids.some((id) => about[id])) return `Available: ${ids.join(", ")}.`;
  return ["Available:", ...ids.map((id) => (about[id] ? `- ${id}: ${about[id]}` : `- ${id}`))].join("\n");
}

/** What a turn that may hold no background work is offered, by the tool every other turn is offered — `waitingAsk`. */
const WAITING = new WeakMap<Tool, Tool>();

/**
 * `ask_agent` as a turn that may hold no work in the background has it: no `background`, and every ask waits for its
 * answer however long it takes. `resolveToolset` gives it to a helper's turn, a scheduled turn and wherever
 * `[delegate] max_background` is 0 — the turns whose toolset is resolved with no background helpers.
 *
 * Not ping-pong, said where it is decided: a helper working in the background that could move an ask behind itself
 * would leave a turn nobody watches waiting on nothing, with a second job's answer bound for a conversation the helper
 * is not in. A peer — a background ask's own turn included — has no `ask_agent` at all (`pipeline/peer-turn.ts`).
 */
export function waitingAsk(tool: Tool): Tool {
  return WAITING.get(tool) ?? tool;
}

export function createAskAgentTool(options: AskAgentToolOptions): Tool {
  const waiting: Tool = {
    // Not gated, and for the reason `delegate` is not: every tool the peer then calls is gated in the
    // peer's own turn, against the peer's own permissions. Approving the ask as well would be asking
    // twice for one decision, and the second prompt is the one people stop reading.
    requiresApproval: false,
    /**
     * Two agents asked in one batch work at the same time.
     *
     * This is what made the tool worth having: the model already emits `ask_agent(nix)` and
     * `ask_agent(nexa)` in one message, and running them one after the other made a thirty-second
     * question cost ninety. What the chat showed was two peers "in progress" while only one was.
     *
     * Two peers cannot interfere the way two `write` calls can — separate turns, separate executors,
     * separate ids, separate grants. The thing they *do* share is the person: a peer turn can stop
     * for approval one level down, somewhere `canParallelise` cannot see, and two prompts racing into
     * one chat is a question nobody can answer. That is handled where it belongs, in
     * `tools/approval-floor.ts`: the work runs in parallel and the asking is serialized.
     *
     * An operator who names `ask_agent` in `approval_required` still gets the old behaviour — the
     * batching rule's second condition is unchanged — and a peer that writes to a shared workspace
     * is the peer's own business, gated by the peer's own tools.
     *
     * **`delegate` is deliberately not marked**, and the difference is the one above. A subagent runs
     * as its parent, in its parent's workspace, with its parent's grants — two of them in one batch
     * can write the same file, which is the interference `parallelSafe` exists to keep apart.
     */
    parallelSafe: true,
    definition: {
      name: "ask_agent",
      description:
        "Hand a piece of work to another agent on this daemon and get their answer back. They run " +
        "with their own skills, tools and permissions, and their reply comes back to you. It does " +
        "not appear in the chat. Use this when a mention would not reach them, which is always the " +
        "case in a one-to-one conversation. You are the one who reports the result.",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description:
              "The agent's id, exactly as OTHER AGENTS lists it beside its name and what it is for. Ask the one whose work it is.",
          },
          task: {
            type: "string",
            description:
              "What you want done, in full. They start with no memory of this conversation, so " +
              "include the context they need: what was asked, what you have already done, and what " +
              "you want back from them. " +
              BRIEF_SCOPE,
          },
          tier: tierParameter("their"),
        },
        required: ["agent", "task"],
      },
    },
    execute: (args, ctx) => ask(options, args, ctx, false),
  };
  if (!options.start) return waiting;
  const { properties } = waiting.definition.parameters as { properties: Record<string, unknown> };
  const detachable: Tool = {
    ...waiting,
    definition: {
      ...waiting.definition,
      parameters: {
        ...waiting.definition.parameters,
        properties: {
          ...properties,
          background: {
            type: "boolean",
            description:
              "Return at once instead of waiting: they keep working and their answer comes to you as a message. For work " +
              "you know is long: a deploy, an audit. Without it you wait up to a minute, then the same.",
          },
        },
      },
    },
    execute: (args, ctx) => ask(options, args, ctx, true),
  };
  WAITING.set(detachable, waiting);
  return detachable;
}

/** One ask: the name and the task checked, then the answer — waited on, or moved to the background where it may be. */
async function ask(options: AskAgentToolOptions, args: Record<string, unknown>, ctx: ToolContext, mayDetach: boolean): Promise<ToolResult> {
  const to = typeof args.agent === "string" ? args.agent.trim().replace(/^@/, "") : "";
  const task = typeof args.task === "string" ? args.task.trim() : "";

  const reachable = options.peers(ctx.agentId);
  const naming = availableLines(reachable, options.about?.(reachable) ?? {});

  if (!to) return { content: `Name the agent to ask. ${naming}`, isError: true };
  if (to === ctx.agentId) {
    // Worth its own message rather than falling into "unknown agent": a model that asks itself is
    // usually about to loop, and telling it the shape of the mistake is what stops the retry.
    return {
      content: "That is you. Do the work yourself, or ask a different agent.",
      isError: true,
    };
  }
  // Compared case-insensitively, then resolved to the real id: the prompt lists ids, but a model
  // writing a sentence capitalises names.
  const match = reachable.find((id) => id.toLowerCase() === to.toLowerCase());
  if (!match) return { content: `There is no agent called "${to}". ${naming}`, isError: true };
  if (!task) return { content: `Say what you want ${match} to do.`, isError: true };
  if (task.length > MAX_TASK_CHARS) {
    return {
      content: `That task is ${task.length} characters; the limit is ${MAX_TASK_CHARS}. Send the essentials and let them ask.`,
      isError: true,
    };
  }
  // The other agent works in English whatever the person speaks; a person's words quoted in the task stay as they were.
  if (!workTextIsEnglish(task)) return { content: writeWorkInEnglish("The task"), isError: true };

  const tier = tierArg(args.tier);
  if ("error" in tier) return { content: tier.error, isError: true };

  const background = mayDetach && args.background === true;
  log.info("agent asking agent", { from: ctx.agentId, to: match, tier: tier.tier, ...(background ? { background: true } : {}) });
  const request: PeerTurnRequest = { to: match, from: ctx.agentId, task, ctx, tier: tier.tier };
  if (!mayDetach || !options.start) return answered(ctx.agentId, await options.run(request));

  const started = options.start(request, background);
  if ("refused" in started) return { content: notStarted(match, started.refused), isError: true };
  const { run } = started;
  const waitMs = options.waitMs ?? ASK_WAIT_MS;
  if (!background) {
    const first = await within(run.answer, waitMs);
    if (first) return answered(ctx.agentId, first);
  }
  const moved = run.detach();
  if ("job" in moved) return inTheBackground(match, moved.job, background ? null : waitMs);
  // Answered as it was about to move, or no room for it: waited on to the end, as an ask always was.
  return answered(ctx.agentId, await run.answer, "refused" in moved ? stayed(moved.refused, waitMs) : undefined);
}

/** The answer, or null once `ms` have passed without one — the wait an ask gives before it moves. */
async function within<T>(answer: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The envelope goes to the model as it is, status line included.
 *
 * Including the statuses that are not failures. `requires_human` and `incomplete` are the ones
 * that matter most: they are the cases where the worker's own summary reads like a finished
 * report, and the caller is one step away from relaying it to a person as done.
 */
function answered(from: string, handoff: PeerTurnResult, note?: string): ToolResult {
  log.info("handoff returned", {
    from,
    to: handoff.agentId,
    status: handoff.status,
    tool_calls: handoff.metrics.toolCalls,
    files: handoff.files.length,
  });
  return {
    content: note ? `${renderHandoff(handoff)}\n\n${note}` : renderHandoff(handoff),
    isError: isHandoffError(handoff),
    metadata: {
      agent: handoff.agentId,
      status: handoff.status,
      toolCalls: handoff.metrics.toolCalls,
      ...(handoff.files.length > 0 ? { files: handoff.files } : {}),
    },
  };
}

/**
 * Moved to the background: the asking turn ends now (`ask_in_background`), so the person can talk to it meanwhile, and
 * the answer comes to it as a message of its own. It has not seen that answer — the one thing this reply must not do is
 * say what it will be.
 */
function inTheBackground(agent: string, job: string, waitedMs: number | null): ToolResult {
  return {
    content: [
      waitedMs === null
        ? `${agent} is working on it in the background, as ${job}.`
        : `${agent} has not answered after ${duration(waitedMs)} and is still working on it, now in the background, as ${job}.`,
      `Their answer comes to you as a message of its own when they finish: you have not seen it, so do not say what it ` +
        `will be. Tell the person ${agent} is on it, and that you will pass the answer on when it comes.`,
      `Stop it with \`nouride jobs kill ${job}\` if the person asks.`,
    ].join("\n"),
    isError: false,
    metadata: { agent, background: true, job, control: { finishTurn: "wrap_up", note: "ask_in_background" } },
  };
}

/** `background` asked for, and no room: nothing started — what is running instead, and what to do. */
function notStarted(agent: string, refused: AskRefusal): string {
  if (refused.why === "unavailable") return `Not started in the background: ${refused.reason} Leave \`background\` off to wait for ${agent}'s answer.`;
  return (
    `Not started: ${limitReached(refused)}: ${runningList(refused.running)}. Wait for one to finish (its result comes ` +
    `to you as a message), stop one with \`nouride jobs kill <id>\`, or leave \`background\` off to wait for ${agent}'s answer.`
  );
}

/** Waited on past the wait because it could not move: said, so the time it took is not taken for a stuck agent. */
function stayed(refused: AskRefusal, waitMs: number): string {
  const why = refused.why === "limit" ? limitReached(refused) : refused.reason.replace(/\.$/, "");
  return `(This took longer than ${duration(waitMs)} and stayed in the foreground: ${why}.)`;
}

/** The limit, named — the one helpers and asks share. */
function limitReached(refused: Extract<AskRefusal, { why: "limit" }>): string {
  const n = refused.running.length;
  return (
    `you already have ${n} ${n === 1 ? "job" : "jobs"} working in the background (helpers and asks), the most this ` +
    `agent may have (\`[delegate] max_background = ${refused.limit}\`)`
  );
}
