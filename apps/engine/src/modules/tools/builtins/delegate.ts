/**
 * Ephemeral helpers: in the foreground, run in parallel and waited for; in the background, a job each.
 *
 * Not the multi-agent model, and the distinction is the whole design. A *permanent* agent is a persona
 * pack someone wrote — Nouva, Nox — with its own identity, memory and conversations. A *subagent* is a
 * blank one: no persona, no memory, no history, spawned by a permanent agent to do one piece of work
 * and discarded. Nouva has subagents; so does Nox; they are not each other's.
 *
 * Two shapes, for two needs:
 *
 * - **Foreground** is parallelism. Four questions that do not depend on each other — "what does this
 *   config do", "what is in these logs", "which of these hosts is unhealthy" — are four turns' worth of
 *   round-trips done serially, or one call done at once. The turn waits for every answer: it is for
 *   work the agent needs before it can answer.
 * - **Background** (0.7.15) is staying free. A task that takes a while goes to a helper that works as a
 *   job of its own; the turn ends at once, the person can talk to the agent meanwhile, and each helper's
 *   result wakes the agent as it arrives — the first to finish is reported first, with no barrier
 *   (owner, 2026-10-18: "kalau selesai 1 ya proses 1, lalu menunggu lagi").
 *
 * ## What a subagent inherits
 *
 * Everything except who it is. It runs **as its parent's agent id**, which is not a shortcut: exec
 * grants, tool grants and the approval gate are all keyed on that id, so a command the operator has
 * already allowed for Nouva is already allowed for work Nouva delegated. The alternative — a distinct
 * id — would ask the human again for permissions they have already given, on a call they did not
 * initiate, and that is how an approval prompt becomes noise.
 *
 * So: same tools, same policy, same grants, same model, same workspace, its skills' index and its MCP
 * servers' tools. Not the persona, not the memory, not the conversation.
 *
 * ## What it cannot do
 *
 * Speak as its parent. It writes no memory — the tools whose writes every later prompt reads, by the
 * same mark S13 holds them at — and sends nothing into the chat: what is kept and what is said is the
 * parent's call, from the handoff. And it cannot delegate: its toolset has this tool removed, so the
 * tree is one level deep. Recursion here would be an unbounded fan-out of provider calls started by a
 * model, which is the shape of a bill nobody meant to run up.
 */

import { createLogger, type ModelTier, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import { renderHandoff, type SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { goalLine, parseBriefs, type HelperBrief } from "./delegate-brief.ts";
import { duration } from "@/modules/jobs/wake-text.ts";
import { tierArg, tierParameter } from "./tier-arg.ts";

const log = createLogger("tools.delegate");

/**
 * How many run at once in the foreground, and how many briefs one call takes.
 *
 * Four is a judgement, not a measurement: enough for the fan-out to be worth the complexity, few
 * enough that a model that decides to check twenty things does not open twenty provider connections
 * and spend twenty turns' worth of budget in one call.
 */
const MAX_PARALLEL = 4;

export interface SubagentRequest {
  brief: HelperBrief;
  ctx: ToolContext;
  /** Which of the parent's models it runs on (0.8.0). Absent: `default`, the parent's own. */
  tier?: ModelTier;
  /** Only the tools that read (`tools/read-only.ts`) — a mission's reviewer, which checks and never redoes (0.8.0). */
  readOnly?: true;
}

/**
 * The same envelope `ask_agent` returns — see `tools/handoff.ts`.
 *
 * A helper is not a permanent agent, but the two lie in exactly the same way: a subagent that hit a
 * refused approval or ran out of iterations still writes a closing paragraph that reads like a
 * finished answer, and a batch of four of those is four chances for the parent to report work that did
 * not happen. `agentId` here is the *parent's* id, because that is who a subagent runs as.
 */
export type SubagentResult = SubAgentHandoff;

/** A helper running in the background, as the agent is told about it. */
export interface HelperView {
  id: string;
  goal: string;
  startedAt: number;
  /** Started from this conversation. One from another is counted, not described: its goal is that chat's business. */
  here: boolean;
}

/** One brief started in the background — or why not, and what is running instead. */
export type BackgroundStart =
  | { started: HelperView; running: HelperView[] }
  | { refused: "off" }
  | { refused: "limit"; limit: number; running: HelperView[] }
  | { refused: "duplicate"; running: HelperView }
  | { refused: "unavailable"; reason: string };

export interface DelegateToolOptions {
  /**
   * Runs one subagent to completion.
   *
   * Injected rather than built here: constructing a turn needs the provider registry, the toolset and
   * the approval gate, and a tool that could reach all of those could reach anything.
   */
  run: (request: SubagentRequest) => Promise<SubagentResult>;
  /**
   * Starts one helper as a job, and returns at once. Absent where this process runs no jobs — then `background` is
   * refused with what to do instead.
   */
  background?: (request: SubagentRequest) => BackgroundStart;
  /**
   * A worktree of its own for a helper that writes, inside a mission's (MISSIONS §8): where it works and the branch it
   * hands back — or why it cannot have one. Absent where this process runs no missions.
   */
  isolate?: (ctx: ToolContext) => Promise<{ path: string; branch: string } | { refused: string }>;
}

export function createDelegateTool(options: DelegateToolOptions): Tool {
  return {
    // Not gated. Every tool the subagent then calls is gated exactly as it would be in the parent's
    // own turn — approving the delegation as well would be asking twice for one decision, and the
    // second prompt is the one people stop reading.
    requiresApproval: false,
    definition: {
      name: "delegate",
      description:
        "Hand work to helpers, each with a brief written in English. A helper starts with no memory of this " +
        "conversation; it has your tools and workspace, but writes no memory, sends nothing to the chat and cannot " +
        "delegate further. It is not another agent: to reach one, use `ask_agent`.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: `Up to ${MAX_PARALLEL} briefs, one per helper.`,
            items: {
              type: "object",
              properties: {
                goal: { type: "string", description: "What it is to achieve, in one sentence." },
                context: {
                  type: "string",
                  description: "What it needs and cannot know: paths, hosts, decisions made, what was tried. An empty one is refused.",
                },
                constraints: { type: "string", description: "What it must not do, or must keep to." },
                deliverable: { type: "string", description: "What it hands back, and in what shape." },
              },
              required: ["goal", "context", "deliverable"],
            },
          },
          background: {
            type: "boolean",
            description:
              "Each brief becomes a helper job: your turn ends now, and each helper's result comes to you as a message " +
              "when it finishes. Over your limit is refused, with what is running. Off: you wait for every answer.",
          },
          tier: tierParameter("your"),
          isolated: {
            type: "boolean",
            description:
              "Each helper gets a worktree of the mission's, on a branch of its own, so helpers that write do not write " +
              "over each other. Merge the branches you keep into the mission's.",
          },
        },
        required: ["tasks"],
      },
    },

    async execute(args, ctx): Promise<ToolResult> {
      const parsed = parseBriefs(args.tasks, MAX_PARALLEL);
      if ("error" in parsed) return { content: parsed.error, isError: true };
      const tier = tierArg(args.tier);
      if ("error" in tier) return { content: tier.error, isError: true };
      let briefs = parsed.briefs;
      const branches: string[] = [];
      if (args.isolated === true) {
        if (!options.isolate) return { content: "`isolated` is not available in this process. Run the helpers without it.", isError: true };
        const isolated: HelperBrief[] = [];
        // One after another: each takes the next free folder and branch.
        for (const brief of briefs) {
          const place = await options.isolate(ctx);
          if ("refused" in place) return { content: place.refused, isError: true };
          branches.push(place.branch);
          isolated.push(inWorktree(brief, place));
        }
        briefs = isolated;
      }
      const result = args.background === true ? inBackground(options, briefs, ctx, tier.tier) : await inForeground(options, briefs, ctx, tier.tier);
      if (branches.length === 0) return result;
      const said = branches.map((branch, index) => `task ${index + 1}: ${branch}`).join(", ");
      return { ...result, content: `${result.content}\n\nEach helper's work is on its own branch (${said}). Merge the ones you keep into the mission's branch, in the mission's folder.` };
    },
  };
}

async function inForeground(options: DelegateToolOptions, briefs: HelperBrief[], ctx: ToolContext, tier: ModelTier): Promise<ToolResult> {
  log.info("delegating", { agent_id: ctx.agentId, tasks: briefs.length, tier });

  // All at once. Running them in sequence would make this a loop the model could have written
  // itself, and the parallelism is the entire reason it exists.
  const results = await Promise.all(
    briefs.map(async (brief, index) => {
      try {
        return { index, brief, handoff: await options.run({ brief, ctx, tier }) };
      } catch (err) {
        // One helper failing is not the others failing. Reported in place so the model sees which
        // question went unanswered rather than losing the whole batch.
        return {
          index,
          brief,
          handoff: {
            agentId: ctx.agentId,
            status: "failed" as const,
            summary: "",
            files: [],
            spills: [],
            metrics: { toolCalls: 0, steps: 0, ms: 0 },
            reason: String(err instanceof Error ? err.message : err),
          },
        };
      }
    }),
  );

  // The task line stays: with four running at once, a status without the question it answers is
  // not attributable to anything. The envelope's own header names the agent; this names the job.
  const rendered = results
    .map(({ index, brief, handoff }) => [`── task ${index + 1}: ${goalLine(brief)}`, renderHandoff(handoff)].join("\n"))
    .join("\n\n");

  const failed = results.filter((r) => r.handoff.status === "failed").length;
  return {
    content: rendered,
    // Not an error unless every one failed: a batch where three of four answered is a batch the
    // model can work with, and flagging it as failed would invite it to throw away the three.
    isError: failed === results.length,
    metadata: {
      tasks: results.length,
      failed,
      // Every status, not just the failures. `requires_human` on one of four is the fact an
      // operator reading the audit log needs, and it is not visible in a count of failures.
      statuses: results.map((r) => r.handoff.status),
      toolCalls: results.reduce((sum, r) => sum + r.handoff.metrics.toolCalls, 0),
    },
  };
}

/**
 * Each brief a job of its own, started one after another so the limit counts the ones this call started too.
 *
 * The turn ends once one has started (`helper_started`): another round would only invite the model to poke at work it
 * has just been told it will hear about. What was refused is said in the same result, with what to do instead.
 */
function inBackground(options: DelegateToolOptions, briefs: HelperBrief[], ctx: ToolContext, tier: ModelTier): ToolResult {
  if (!options.background) {
    return {
      content: "Background helpers are not available in this process. Leave `background` off to run them in the foreground, where you wait for the answers.",
      isError: true,
    };
  }
  const outcomes = briefs.map((brief) => ({ brief, outcome: options.background!({ brief, ctx, tier }) }));
  const started = outcomes.flatMap(({ outcome }) => ("started" in outcome ? [outcome] : []));
  const lines = outcomes.map(({ brief, outcome }) => said(brief, outcome));
  const latest = started.at(-1);
  if (latest) {
    lines.push(
      "",
      "Your turn ends now, so the person can talk to you meanwhile. Each helper's result comes to you as a message of " +
        "its own when that helper finishes. Report each as it arrives. You have not seen any result yet: do not say " +
        "what it found.",
      `Running in the background now: ${runningList(latest.running)}.`,
      `Stop one with \`nouride jobs kill <id>\` if the person asks.`,
    );
  }
  log.info("started background helpers", { agent_id: ctx.agentId, started: started.length, refused: outcomes.length - started.length, tier });
  return {
    content: lines.join("\n"),
    isError: started.length === 0,
    metadata: {
      background: true,
      started: started.map((outcome) => outcome.started.id),
      refused: outcomes.flatMap(({ outcome }) => ("refused" in outcome ? [outcome.refused] : [])),
      ...(started.length > 0 ? { control: { finishTurn: "wrap_up", note: "helper_started" } } : {}),
    },
  };
}

/** One brief's outcome, as a line the model can act on. */
function said(brief: HelperBrief, outcome: BackgroundStart): string {
  const goal = `"${goalLine(brief)}"`;
  if ("started" in outcome) return `Started in the background as ${outcome.started.id}: ${goal}.`;
  switch (outcome.refused) {
    case "off":
      return (
        `Not started: ${goal}. Background helpers are off for this agent (\`[delegate] max_background = 0\`). ` +
        `Leave \`background\` off to run it in the foreground, where you wait for the answer, or do it yourself.`
      );
    case "limit":
      // Helpers and asks share the one limit (0.7.19): an agent asked with `ask_agent` that is still at work in the
      // background is one of what is running.
      return (
        `Not started: ${goal}. You already have ${outcome.running.length} ${outcome.running.length === 1 ? "job" : "jobs"} ` +
        `working in the background (helpers and asks), the most this agent may have (\`[delegate] max_background = ${outcome.limit}\`): ` +
        `${runningList(outcome.running)}. Wait for one to finish (its result comes to you as a message), stop one ` +
        `with \`nouride jobs kill <id>\`, or run this one in the foreground (leave \`background\` off).`
      );
    case "duplicate":
      return (
        `Not started: ${goal} is already running as ${outcome.running.id} (${since(outcome.running.startedAt)}). ` +
        `Its result comes to you as a message when it finishes.`
      );
    case "unavailable":
      return `Not started: ${goal}. ${outcome.reason}`;
  }
}

/** What is running, by id and goal — those from another conversation counted, not described. `ask_agent`'s refusal says it too. */
export function runningList(running: HelperView[]): string {
  const here = running.filter((job) => job.here).map((job) => `${job.id} "${job.goal}" (${since(job.startedAt)})`);
  const elsewhere = running.length - here.length;
  return [...here, ...(elsewhere > 0 ? [`${elsewhere} in another conversation`] : [])].join("; ") || "none";
}

function since(startedAt: number): string {
  return `${duration(Math.max(0, Date.now() - startedAt))} so far`;
}

/**
 * The system prompt a subagent gets in place of a persona.
 *
 * Deliberately not the parent's. A helper answering "what is in these logs" does not need Nouva's
 * personality, her memory, or the conversation that led here — it needs the job and the tools, and
 * everything else is budget spent on being someone.
 */
export function helperRole(mode: { background: boolean }): string {
  return [
    "You are a helper doing one piece of work for another agent.",
    "",
    "You have no memory of any conversation and nobody is reading your output but the agent that asked.",
    ...(mode.background
      ? [
          "You work in the background: the agent that asked is talking to the person meanwhile, and reads your answer when you finish.",
          "Every command you run is in the foreground and you read what it prints. A long one (a build, a slow check) may",
          "run up to thirty minutes: give it `timeout_ms`.",
        ]
      : ["Every command you run is in the foreground, up to four minutes each; work that needs longer is for the agent that asked."]),
    "Your brief comes in parts: GOAL, CONTEXT, CONSTRAINTS, DELIVERABLE. Do the work with your tools, then answer",
    "with exactly what DELIVERABLE asks for, in English, and nothing else: no preamble, no offer to help further.",
    "If you could not do it, say what stopped you. If a call you need is refused or not approved, stop there and",
    "say what is left undone and why.",
    "You cannot write memory or record people: say in your answer what is worth keeping, and the agent that asked",
    "decides. Do not ask questions: nobody can answer them.",
    "Where the instructions below speak of 'the person', read 'the agent that asked'.",
  ].join("\n");
}

/** A brief, told where its worktree is and that its work is a branch to commit to. */
function inWorktree(brief: HelperBrief, place: { path: string; branch: string }): HelperBrief {
  return {
    ...brief,
    context: `${brief.context}\n\nWork in ${place.path}, a worktree of the mission's repository, on the branch ${place.branch}. Commit your work there; the mission merges it.`,
    constraints: [brief.constraints, `Change nothing outside ${place.path}.`].filter(Boolean).join(" "),
  };
}
