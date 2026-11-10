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
 * budget, and the person, who could not talk to the asking agent meanwhile. Now it waits for the answer for 45 seconds,
 * then the peer's turn carries on as a job of the asking agent's (`pipeline/background-ask.ts`), the call returns saying
 * so, and the answer wakes the asking agent in this chat when it comes — the wait and the move `delegate`'s helpers in
 * the foreground have too (`wait-then-move.ts`). `background: true` returns at once. Only where the turn asking may hold
 * work in the background — its own chat turn, with `[delegate] max_background` above 0, the one limit helpers and asks
 * share: a helper's ask, and a scheduled turn's, wait to the end (`waitingForm`). A peer has no `ask_agent` at all.
 *
 * ## Several agents in one call
 *
 * Asking three agents was three calls, and a model that made them a reply apart waited for each in turn. With `asks`,
 * one call starts them together and brings every answer back in one result, each under its agent: the shape `delegate`
 * has for helpers. Each ask is the single ask it would have been, checked by the same rules and started through the same
 * door, so the hop limit, the waiting form, the one background limit and a busy or sleeping agent hold for each on its
 * own. One that fails or is refused is said in its place, beside the others' answers. The single call is as it was: its
 * arguments and its result's words are what models know and stored transcripts hold.
 */

import { clip, createLogger, type LoadedAgent, type ModelTier, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import { isHandoffError, renderHandoff, type SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { describePeers } from "@/modules/router/agent-mentions.ts";
import { duration } from "@/modules/jobs/wake-text.ts";
import { runningList } from "./delegate.ts";
import { BRIEF_SCOPE } from "./delegate-brief.ts";
import { FOREGROUND_WAIT_MS, limitReached, stayed, within, withWaiting, type MovableRun, type Moved, type MoveRefusal } from "./wait-then-move.ts";
import { tierArg, tierParameter } from "./tier-arg.ts";
import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";

const log = createLogger("tools.ask_agent");

const MAX_TASK_CHARS = 4000;

/** The most agents one call asks: the fan-out one `delegate` call has. */
const MAX_ASKS = 4;

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

/** Started — or, asked for in the background, refused before anything of it ran. */
export type AskStart = { run: MovableRun } | { refused: MoveRefusal };

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
  /** How long an ask waits before it moves: `FOREGROUND_WAIT_MS`. A test's is shorter. */
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
          asks: {
            type: "array",
            description: `Several agents at once, in place of \`agent\` and \`task\`: up to ${MAX_ASKS}, each with its own task. They work at the same time, and every answer comes back in this result under its agent.`,
            items: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" } }, required: ["agent", "task"] },
          },
          tier: tierParameter("their"),
        },
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
              "you know is long: a deploy, an audit. Without it you wait up to 45 seconds, then the same.",
          },
        },
      },
    },
    execute: (args, ctx) => ask(options, args, ctx, true),
  };
  // A turn that may hold no work in the background is offered `waiting` (`waitingForm`). A peer — a background ask's own
  // turn included — has no `ask_agent` at all (`pipeline/peer-turn.ts`).
  return withWaiting(detachable, waiting);
}

/** Who an ask reaches and what it carries, once its name and its task pass — or why it does not go, and the name it gave. */
function checked(options: AskAgentToolOptions, asking: { agent?: unknown; task?: unknown }, ctx: ToolContext): { to: string; task: string } | { refused: string; named: string } {
  const to = typeof asking.agent === "string" ? asking.agent.trim().replace(/^@/, "") : "";
  const task = typeof asking.task === "string" ? asking.task.trim() : "";
  const refused = (why: string) => ({ refused: why, named: to });

  const reachable = options.peers(ctx.agentId);
  const naming = availableLines(reachable, options.about?.(reachable) ?? {});

  if (!to) return refused(`Name the agent to ask. ${naming}`);
  // Worth its own message rather than falling into "unknown agent": a model that asks itself is
  // usually about to loop, and telling it the shape of the mistake is what stops the retry.
  if (to === ctx.agentId) return refused("That is you. Do the work yourself, or ask a different agent.");
  // Compared case-insensitively, then resolved to the real id: the prompt lists ids, but a model
  // writing a sentence capitalises names.
  const match = reachable.find((id) => id.toLowerCase() === to.toLowerCase());
  if (!match) return refused(`There is no agent called "${to}". ${naming}`);
  if (!task) return refused(`Say what you want ${match} to do.`);
  if (task.length > MAX_TASK_CHARS) return refused(`That task is ${task.length} characters; the limit is ${MAX_TASK_CHARS}. Send the essentials and let them ask.`);
  // The other agent works in English whatever the person speaks; a person's words quoted in the task stay as they were.
  if (!workTextIsEnglish(task)) return refused(writeWorkInEnglish("The task"));
  return { to: match, task };
}

/**
 * Whether a parameter was sent. Some models write every parameter a schema has, the ones they do not use as null, an
 * empty string or an empty list: read as sent, an empty `asks` beside `agent` refused the call every model already makes.
 */
const sent = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);

/** One call: several asks where `asks` is sent, else the one — checked, then answered, waited on, or moved to the background where it may be. */
async function ask(options: AskAgentToolOptions, args: Record<string, unknown>, ctx: ToolContext, mayDetach: boolean): Promise<ToolResult> {
  // An empty list with no agent beside it is still the several shape, said as the list it should have been.
  const several = sent(args.asks) || (Array.isArray(args.asks) && !sent(args.agent));
  const one = several ? null : checked(options, args, ctx);
  if (one && "refused" in one) return { content: one.refused, isError: true };

  const tier = tierArg(args.tier);
  if ("error" in tier) return { content: tier.error, isError: true };
  if (!one) return askSeveral(options, args, ctx, mayDetach, tier.tier);

  const { to: match, task } = one;
  const background = mayDetach && args.background === true;
  log.info("agent asking agent", { from: ctx.agentId, to: match, tier: tier.tier, ...(background ? { background: true } : {}) });
  const request: PeerTurnRequest = { to: match, from: ctx.agentId, task, ctx, tier: tier.tier };
  if (!mayDetach || !options.start) return answered(ctx.agentId, await options.run(request));

  const started = options.start(request, background);
  if ("refused" in started) return { content: notStarted(match, started.refused), isError: true };
  const { run } = started;
  const waitMs = options.waitMs ?? FOREGROUND_WAIT_MS;
  if (!background) {
    const first = await within(run.answer, waitMs);
    if (first) return answered(ctx.agentId, first);
  }
  const moved = run.detach();
  if ("job" in moved) return inTheBackground(match, moved.job, background ? null : waitMs);
  // Answered as it was about to move, or no room for it: waited on to the end, as an ask always was.
  return answered(ctx.agentId, await run.answer, "refused" in moved ? stayed(moved.refused, waitMs) : undefined);
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
function notStarted(agent: string, refused: MoveRefusal): string {
  if (refused.why === "unavailable") return `Not started in the background: ${refused.reason} Leave \`background\` off to wait for ${agent}'s answer.`;
  return (
    `Not started: ${limitReached(refused)}: ${runningList(refused.running)}. Wait for one to finish (its result comes ` +
    `to you as a message), stop one with \`nouride jobs kill <id>\`, or leave \`background\` off to wait for ${agent}'s answer.`
  );
}

/** One of several asks at its end: its answer, with why it was waited on past the wait if it was; its job, once it moved; or why it never went. */
type AskEnd = { agent: string; task: string } & ({ handoff: PeerTurnResult; stayed?: string } | { job: string } | { refused: string });

/** One of several asks under way, or refused before it began. */
type Begun = { agent: string; task: string } & ({ run: MovableRun } | { refused: string });

/** Why `asks` cannot be read as a list of asks, or null when it can. */
function shapeRefusal(args: Record<string, unknown>): string | null {
  if (sent(args.agent) || sent(args.task)) return "Send `asks` for several agents, or `agent` and `task` for one: not both.";
  if (!Array.isArray(args.asks) || args.asks.length === 0) return `\`asks\` is a list of up to ${MAX_ASKS} asks, each an \`agent\` and its \`task\`.`;
  if (args.asks.length > MAX_ASKS) return `That is ${args.asks.length} asks; one call asks at most ${MAX_ASKS} agents. Send the rest in a second call.`;
  return null;
}

/** An ask that could not run, as its answer: one agent failing is not the others failing. */
function failedToRun(agent: string, err: unknown): PeerTurnResult {
  return { agentId: agent, status: "failed", summary: "", files: [], spills: [], metrics: { toolCalls: 0, steps: 0, ms: 0 }, reason: String(err instanceof Error ? err.message : err) };
}

/** One of several started as a single ask is: so it can move, where this turn may hold work in the background; else run to its end. */
function begin(options: AskAgentToolOptions, request: PeerTurnRequest, mayDetach: boolean, background: boolean): Begun {
  const said = { agent: request.to, task: request.task };
  const failed = (err: unknown) => failedToRun(request.to, err);
  try {
    if (mayDetach && options.start) {
      const started = options.start(request, background);
      if ("refused" in started) return { ...said, refused: notStarted(request.to, started.refused) };
      return { ...said, run: { answer: started.run.answer.catch(failed), detach: () => started.run.detach() } };
    }
    return { ...said, run: { answer: options.run(request).catch(failed), detach: () => ({ answered: true }) } };
  } catch (err) {
    return { ...said, run: { answer: Promise.resolve(failed(err)), detach: () => ({ answered: true }) } };
  }
}

/** One ask's end, once it was asked to move or never was: its job, or its answer. */
async function endOf(begun: Begun, moved: Moved | null, waitMs: number): Promise<AskEnd> {
  const { agent, task } = begun;
  if ("refused" in begun) return { agent, task, refused: begun.refused };
  if (moved && "job" in moved) return { agent, task, job: moved.job };
  return { agent, task, handoff: await begun.run.answer, ...(moved && "refused" in moved ? { stayed: stayed(moved.refused, waitMs) } : {}) };
}

/**
 * Every ask at once. With `background` each moves as it starts, one after another, so the limit counts the ones this
 * call moved; without it all are waited on together, and past the wait each still working moves the same way. A turn
 * that may hold no work in the background waits for every answer to the end.
 */
async function askSeveral(options: AskAgentToolOptions, args: Record<string, unknown>, ctx: ToolContext, mayDetach: boolean, tier: ModelTier): Promise<ToolResult> {
  const shape = shapeRefusal(args);
  if (shape) return { content: shape, isError: true };
  const background = mayDetach && args.background === true;
  const waitMs = options.waitMs ?? FOREGROUND_WAIT_MS;
  const entries = (args.asks as unknown[]).map((entry) => (entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {}));
  log.info("agent asking agents", { from: ctx.agentId, asks: entries.length, tier, ...(background ? { background: true } : {}) });

  const moved: (Moved | null)[] = entries.map(() => null);
  const begun = entries.map((entry, index): Begun => {
    const one = checked(options, entry, ctx);
    if ("refused" in one) return { agent: one.named || "(no agent named)", task: typeof entry.task === "string" ? entry.task.trim() : "", refused: `Not asked: ${one.refused}` };
    const started = begin(options, { to: one.to, from: ctx.agentId, task: one.task, ctx, tier }, mayDetach, background);
    if (background && "run" in started) moved[index] = started.run.detach();
    return started;
  });
  if (!background && mayDetach && options.start) {
    const answers = Promise.all(begun.map((one) => ("run" in one ? one.run.answer : null)));
    // Each still working moves, one after another, so the limit counts the ones this call moved too.
    if ((await within(answers, waitMs)) === null) for (const [index, one] of begun.entries()) if ("run" in one) moved[index] = one.run.detach();
  }
  const ends = await Promise.all(begun.map((one, index) => endOf(one, moved[index] ?? null, waitMs)));
  return severalResult(ends, background ? null : waitMs, ctx);
}

/** What the model reads of several asks: each answer under its agent, each agent still at work, and what to do then. */
function severalResult(ends: AskEnd[], waitedMs: number | null, ctx: ToolContext): ToolResult {
  const rendered = ends
    .map((end) => {
      const said =
        "refused" in end
          ? end.refused
          : "job" in end
            ? waitedMs === null
              ? `Working on it in the background, as ${end.job}.`
              : `No answer after ${duration(waitedMs)}: still working on it, now in the background, as ${end.job}.`
            : [renderHandoff(end.handoff), end.stayed].filter(Boolean).join("\n");
      // The agent, and the ask it answers: two asks of one agent are told apart by it.
      return [`── ${end.agent}: ${clip(end.task.split("\n", 1)[0] ?? "", 80)}`, said].join("\n");
    })
    .join("\n\n");
  const answers = ends.flatMap((end) => ("handoff" in end ? [end.handoff] : []));
  const working = ends.flatMap((end) => ("job" in end ? [end] : []));
  const failed = ends.filter((end) => "refused" in end || ("handoff" in end && end.handoff.status === "failed")).length;
  log.info("handoffs returned", { from: ctx.agentId, answered: answers.length, moved: working.length, failed });
  return {
    content: working.length > 0 ? `${rendered}\n\n${stillWorking(working, answers.length > 0)}` : rendered,
    // An error only when nobody answered and nobody is working on it: three answers of four are three to work with.
    isError: failed === ends.length,
    metadata: {
      asks: ends.length,
      agents: ends.map((end) => end.agent),
      failed,
      statuses: ends.map((end) => ("job" in end ? "background" : "refused" in end ? "refused" : end.handoff.status)),
      toolCalls: answers.reduce((sum, handoff) => sum + handoff.metrics.toolCalls, 0),
      // The turn ends, as a single ask's does once it moved: another round would only poke at work it will hear about.
      ...(working.length > 0 ? { background: true, moved: working.map((end) => end.job), control: { finishTurn: "wrap_up", note: "ask_in_background" } } : {}),
    },
  };
}

/**
 * The agents still at work: where they are, and where their answers will come from. The asking agent has not seen those,
 * so the one thing its reply must not do is say what they will be; what the others said it can say now.
 */
function stillWorking(working: { agent: string; job: string }[], someAnswered: boolean): string {
  return [
    `Still working, now in the background: ${working.map((end) => `${end.agent} as ${end.job}`).join("; ")}.`,
    "Your turn ends now, so the person can talk to you meanwhile. Each answer comes to you as a message of its own when " +
      "that agent finishes: you have not seen it, so do not say what it will be. " +
      (someAnswered
        ? "Tell the person what the agents that answered said, and that the others are still on it and you will pass each answer on when it comes."
        : "Tell the person who is on what, and that you will pass each answer on when it comes."),
    "Stop one with `nouride jobs kill <id>` if the person asks.",
  ].join("\n");
}
