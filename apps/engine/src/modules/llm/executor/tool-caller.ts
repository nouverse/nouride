/**
 * One tool call: the gate, the sandbox, the cap, and the two facts the turn needs afterwards.
 *
 * Its own object because of those two facts. `lastApprovalWaitMs` and `lastToolNotApproved` are read
 * by the loop immediately after each call. Fields are safe because no gated tool ever joins a parallel
 * group (the two conditions in `tool-batching.ts`), so only a call that runs alone can write them, and
 * the loop reads them only after a group of one. They are fields rather than a wider return type
 * because `run` returns a `ToolResult` that goes straight to the model, and neither of these is
 * something the model should see.
 */

import {
  buildApprovalPreview,
  createLogger,
  toUserMessage,
  type GateDecision,
  type SendsOut,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from "@nouride/shared";
import { statFile } from "@nouride/runtime";
import { autoApprovable, skipsApproval, type HardlineVerdict } from "@nouride/policy";
import { resolveToolPath } from "@/modules/tools/builtins/files.ts";
import { coerceArguments } from "@/modules/tools/arguments.ts";
import { logToolThrow } from "@/modules/tools/audited.ts";
import { resultCharsFor } from "@/modules/llm/spill.ts";
import { compactResult } from "@/modules/llm/output-by-kind.ts";
import { sendsShortenedArgument } from "@/modules/llm/context.ts";
import { scratchpadFor } from "@nouride/persona";
import { countFileLines, workspaceView } from "./workspace-view.ts";
import { arrivedEmpty, malformedArguments, withCutNote } from "./cut-off.ts";
import { STOPPED_CALL_GRACE_MS, untilStopped } from "./stopped-call.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import type { ExecutorDeps, ToolControl, TurnRequest } from "./types.ts";

const log = createLogger("llm.executor");

/**
 * How much of the turn's deadline is kept back when an approval is pending.
 *
 * One short provider call plus the message going out. Too small and the turn dies mid-sentence; too
 * large and it eats the operator's window to answer for no benefit.
 */
const APPROVAL_REPLY_RESERVE_MS = 45_000;

export class ToolCaller {
  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * Per turn, the tools whose results carried content from outside (`ToolResult.untrusted`), handed to every
   * later call of that turn as `ToolContext.untrustedRead` — a memory write after a fetched page is marked as
   * one. Keyed by the turn's request, so it ends with the turn.
   */
  private readonly untrustedRead = new WeakMap<TurnRequest, Set<string>>();

  /**
   * How long the last `run` call spent waiting on a human.
   *
   * The duration reported on a `tool_done` line was measured around the whole of `run`, and `run`
   * includes the approval gate — so a `write` the operator took thirteen seconds to approve was reported as
   * `write ok · 13319ms`. Thirteen seconds for a 5KB file write is alarming, and it sent them looking for a
   * performance problem in code that had taken four milliseconds.
   *
   * A field rather than a wider return type: `run` returns a `ToolResult` that goes straight to the
   * model, and timing is not something the model should see. Read immediately after the call, and safe
   * as a field only because a call that can reach the approval gate never runs in a parallel group —
   * see `tool-batching.ts` for the two conditions that guarantee it.
   */
  lastApprovalWaitMs = 0;

  /**
   * Did the tool that just ran fail to get past the approval gate?
   *
   * Same field-not-return-type reasoning as `lastApprovalWaitMs` above, and read on the same
   * sequential path. It exists so the turn's closing message can mention `nouride approvals` **only
   * when an approval is genuinely part of the story**. The version that assumed it — any turn with a
   * tool call in it — told a Discord channel an approval had timed out after twenty-two tool calls
   * that had all been approved, and sent the operator to an empty queue.
   */
  lastToolNotApproved = false;

  /**
   * Did the gate answer for the operator on the call that just ran?
   *
   * Read on the same sequential path as the two fields above, and for a reason worth stating: this
   * used to be an activity line of its own — a second `tool` step carrying the same command with
   * `(auto)` on the end. The dashboard pairs a call with the result that follows it, so a call whose
   * next step was another *call* never got closed: it span forever, and the duplicate underneath it
   * carried the outcome. One live turn showed eleven stranded spinners on eleven successful writes.
   *
   * The marker is not dropped — a gate that was skipped silently is a gate nobody can audit. It moved
   * to the result line, which is the one row that call now has.
   */
  lastAutoApproved = false;

  /**
   * Should this `ask` be answered for the operator?
   *
   * By the approval level, over the fixed list's class (`skipsApproval`): `careful` answers nothing, `balanced`
   * everything but `BALANCED_ASKS`, `trusted` everything. Logged, and marked `(auto)` on the call's result line, because
   * a gate that was skipped silently is a gate nobody can audit afterwards.
   *
   * On the class alone, never on the `hardline` flag: the flag says a question cannot be remembered, the class says
   * which level answers it, and a guard that read one for the other went wrong once already — a grantable question
   * carrying a class was taken for one without.
   */
  private autoApprove(
    agentId: string,
    call: ToolCall,
    decision: { hardlineClass?: HardlineVerdict["class"]; reason?: string },
  ): boolean {
    const level = this.deps.approvalLevel?.() ?? "careful";
    if (!skipsApproval(level, decision.hardlineClass)) return false;

    log.info("auto-approved", {
      agent_id: agentId,
      tool: call.name,
      // Which level let it through, because "why was I not asked" is the question this line answers.
      level,
      reason: decision.reason,
    });
    this.lastAutoApproved = true;
    return true;
  }

  /**
   * The second look (0.8.0): in work nobody watches that has read outside content, an action that
   * sends something off the machine is weighed against what the work is for — by a model that sees the goal and the
   * action, never the content, so the content cannot argue with it. It may add a question, never remove one: a call the
   * gate refuses, or that a person will be asked about anyway, is left as it is.
   *
   * A refusal for want of anyone to ask is looked at when the level would answer its question: otherwise the look was
   * skipped exactly when no person is around. Held, it stays refused — there is still nobody to ask.
   */
  private async secondLookAt(req: TurnRequest, call: ToolCall, tool: Tool, ctx: ToolContext, decision: GateDecision): Promise<GateDecision | null> {
    const look = this.deps.secondLook;
    if (!look || !req.unattended || !ctx.untrustedRead?.length) return null;
    const question = decision.action === "refuse" ? decision.unasked : decision.action === "ask" ? decision : undefined;
    if (decision.action === "refuse" && !question) return null;
    if (question && !skipsApproval(this.deps.approvalLevel?.() ?? "careful", question.hardlineClass)) return null;
    const action = tool.sendsOut?.(call.arguments, ctx);
    if (!action) return null;
    // Allowed always for this job (0.8.0): a person answered for exactly where it goes, so nothing is looked at again.
    if (action.to.length > 0 && action.to.every((key) => ctx.allowed?.includes(key))) return null;
    const held = await look({ goal: req.unattended.goal, action: `${call.name} (${action.what})` });
    if (held === null) return null;
    log.info("the second look held a call", { agent_id: req.agent.config.id, turn_id: req.turnId, tool: call.name });
    if (decision.action === "refuse") return { action: "refuse", reason: `${decision.reason}. ${held}` };
    return { action: "ask", grantable: false, hardline: true, hardlineClass: "unwatched", reason: held };
  }

  /**
   * One tool call, and the single place a result is capped before it reaches the context.
   *
   * `maxResultTokens` is applied here rather than in each tool for the reason every choke point exists:
   * a per-tool cap is a rule twenty tools have to remember, and the one that forgets is the one that
   * ends a turn. `exec` is the obvious offender and it is not the only one — `read` at its 256KB limit,
   * a `web_fetch` of a generated page, an MCP server that returns a whole table.
   */
  async run(
    req: TurnRequest,
    call: ToolCall,
    maxResultTokens: number,
    /** The reply carrying this call stopped at this output limit (`ChatResponse.cutAtLimit`) — see `cut-off.ts`. */
    cutAt?: number,
    /** A call an external agent's CLI made over MCP (`LentTools.call`): `ToolContext.lent`. */
    from?: { lent: true },
  ): Promise<ToolResult> {
    const result = await this.attempt(req, call, maxResultTokens, cutAt, from);
    return cutAt !== undefined && result.isError && arrivedEmpty(call) ? withCutNote(result, cutAt) : result;
  }

  private async attempt(
    req: TurnRequest,
    call: ToolCall,
    maxResultTokens: number,
    cutAt: number | undefined,
    from?: { lent: true },
  ): Promise<ToolResult> {
    this.lastApprovalWaitMs = 0;
    this.lastToolNotApproved = false;
    this.lastAutoApproved = false;
    const { toolset, agent } = req;
    const tool = toolset.get(call.name);

    if (!tool) {
      // Models invent tool names, especially ones they have seen elsewhere. Naming what is
      // actually available turns a dead end into a recoverable mistake.
      return {
        content: `Unknown tool "${call.name}". Available: ${toolset.definitions.map((d) => d.name).join(", ") || "none"}.`,
        isError: true,
      };
    }

    // Arguments that are not one JSON object are answered with what went wrong, before any gate or approval: run,
    // the tool said a field was missing, and the model resent the same call to the iteration cap (`argumentsError`).
    if (call.argumentsError) return malformedArguments({ ...call, argumentsError: call.argumentsError }, cutAt);

    // The arguments the gate, the approval and the tool all see. See `coerceArguments`.
    call = { ...call, arguments: coerceArguments(call.arguments, tool.definition.parameters) };

    // Arguments the tool can say are wrong — an MCP tool, against its server's schema — likewise before any gate:
    // asked first, a person approved a call that then failed, and was asked again for the corrected one.
    const malformed = tool.checkArguments?.(call.arguments);
    if (malformed) return { content: malformed, isError: true };
    // What an old call's text was shortened to (`trimToolResults`), sent back as text: run, it is what the file holds.
    if (tool.bulkArguments && sendsShortenedArgument(call.arguments, tool.bulkArguments)) {
      return {
        content: "Not run: that is the note left in place of an earlier call's text, not the text. Read the file to see what it holds, then send the text itself.",
        isError: true,
      };
    }

    // Built before the gate runs, not after: the decision needs the resolved workspace roots to
    // work out which directory a command would run in, and that is the same context `execute`
    // gets. Two constructions would be two chances for them to disagree about the cwd.
    const ctx: ToolContext = {
      agentId: agent.config.id,
      sessionId: req.sessionId,
      chatId: req.chatId,
      ...(req.turnId ? { turnId: req.turnId } : {}),
      callId: call.id,
      ...(req.deadlineAt === undefined ? {} : { deadlineAt: req.deadlineAt }),
      gateway: req.gateway,
      gatewayId: req.gatewayId,
      senderId: req.senderId,
      ...(req.senderName ? { senderName: req.senderName } : {}),
      chatType: req.chatType,
      // The same two values the prompt was built from. See `workspaceView`.
      workspaceDir: workspaceView(req).dir,
      agentDir: agent.dir,
      workspaceRoots: workspaceView(req).roots,
      ownFolders: workspaceView(req).own,
      ...(req.readOnlyRoots?.length ? { readOnlyRoots: req.readOnlyRoots } : {}),
      // Derived from the private directory rather than passed alongside it, so the path `exec` sets
      // as `TMPDIR` and the path the prompt names cannot drift apart.
      ...(req.privateDir ? { privateDir: req.privateDir, scratchpadDir: scratchpadFor(req.privateDir) } : {}),
      // Where a streaming tool puts an output too big to hold, so the spill below can name it instead
      // of writing it a second time. See `ToolContext.spoolPath`.
      ...(this.deps.spill
        ? { spoolPath: this.deps.spill.pathFor({ agentId: agent.config.id, sessionId: req.sessionId, callId: call.id }) }
        : {}),
      ...(this.deps.spill ? { resultChars: resultCharsFor(maxResultTokens) } : {}),
      // Outside content: what the prompt carried, then what the turn's tools brought.
      ...untrustedFor(req.outsideContent, this.untrustedRead.get(req)),
      ...(req.unattended?.sendsTo ? { sendsTo: req.unattended.sendsTo } : {}),
      ...(req.unattended?.allowed?.length ? { allowed: req.unattended.allowed } : {}),
      ...(req.unattended
        ? { unattended: { goal: req.unattended.goal, ...(req.unattended.jobId ? { jobId: req.unattended.jobId } : {}), level: this.deps.approvalLevel?.() ?? "careful" } }
        : {}),
      signal: req.signal ?? new AbortController().signal,
      ...(from?.lent ? { lent: true as const } : {}),
    };

    // What the gate decided — or, for work nobody watches that would send something out after reading outside content,
    // the question the second look puts in its place (0.8.0).
    const decided = toolset.gate(call.name, call.arguments, ctx);
    const decision = (await this.secondLookAt(req, call, tool, ctx, decided)) ?? decided;

    /**
     * Refused only because nobody could be asked — and nobody would have been: the approval level answers
     * the question by itself. "Never ask" means never, whether or not a chat or a dashboard happens to be
     * connected; a call the level does not cover is still refused. Found because an agent set to never ask
     * had a `sudo` refused while every chat was disconnected, and run the moment a dashboard was opened.
     */
    const answeredUnasked =
      decision.action === "refuse" && decision.unasked !== undefined && this.autoApprove(agent.config.id, call, decision.unasked);

    if (decision.action === "refuse" && !answeredUnasked) {
      // Refused outright — over the ceiling, or blocked. Deliberately *not* routed to a human:
      // asking about something that would be refused whatever the answer trains an operator to
      // click through prompts, which is how the gate stops working.
      log.info("tool call refused by policy", {
        agent_id: agent.config.id, turn_id: req.turnId,
        tool: call.name,
        reason: decision.reason,
      });
      return { content: `Refused: ${decision.reason}.`, isError: true };
    }

    /** The request a person's yes answered, when one did — handed to the tool with what it showed (0.8.13). */
    let approved: ToolContext["approved"];
    // The approval level answers what it answers, so an `ask` becomes a run — except for what the level
    // still asks (`skipsApproval`). Written as an extra condition
    // rather than a branch inside the block below, so the approval path itself is untouched: it is
    // the part that must keep working exactly as it did.
    if (answeredUnasked || (decision.action === "ask" && this.autoApprove(agent.config.id, call, decision))) {
      // Falls through to the execution below, as though the gate had said run.
    } else if (decision.action === "ask") {
      /**
       * How long this turn is willing to block, which is not how long the question stays open.
       *
       * A slice is held back so the model can still say something after a refusal. It could not
       * before: the approval and the turn both default to 300s and the turn starts first, so the turn
       * was aborted at the top of the next loop iteration and the "here is a tool result you can adapt
       * to" path never ran. Live, that read as an agent going silent for five minutes.
       */
      // Parked: asked, and not waited on — a mission's turn goes on with what does not depend on it (0.8.0).
      const parked = req.parkApprovalsMs !== undefined;
      const waitMs = parked ? 0 : req.deadlineAt ? req.deadlineAt - Date.now() - APPROVAL_REPLY_RESERVE_MS : undefined;
      if (!parked && waitMs !== undefined && waitMs <= 0) {
        // Not asked at all. A prompt with no time left to answer it is a question posted to nobody,
        // and the model is better served by a result it can still act on.
        log.info("skipped an approval with no turn left to wait in", {
          agent_id: agent.config.id, turn_id: req.turnId,
          tool: call.name,
        });
        this.lastToolNotApproved = true;
        return {
          content:
            `Not run: ${call.name} needs approval and this turn has no time left to wait for one. ` +
            `Say what you were about to do and let them ask again.`,
          isError: true,
        };
      }

      const approvalStartedAt = Date.now();
      const hint = this.deps.carefulHint?.();
      const jobGrant = jobGrantFor(req, decision, tool.sendsOut?.(call.arguments, ctx) ?? null);
      /** The approval this call is parked as, once the gate has one — what the parked call is told to wait on. */
      let parkedAs: string | undefined;
      const outcome = await this.deps.approvals.request({
        agentId: agent.config.id,
        chatId: req.chatId,
        gateway: req.gateway,
        gatewayId: req.gatewayId,
        senderId: req.senderId,
        ...(req.turnId ? { turnId: req.turnId } : {}),
        tool: call.name,
        params: call.arguments,
        // *Always* is on offer for a job's guard too: it allows this one destination for that job, not the agent (0.8.0).
        grantable: decision.grantable || jobGrant !== undefined,
        ...(jobGrant ? { jobGrant } : {}),
        // Computed here, where the class is still in hand, and stored with the row: `/approvals balanced` drains
        // what is already waiting, and by then the argv has become a JSON blob nobody should have to
        // re-classify.
        autoCoverable: autoApprovable(decision.hardlineClass),
        // And the class itself, with the row: who may answer reads it — a change to People is an admin's alone (0.8.9).
        ...(decision.hardlineClass ? { hardlineClass: decision.hardlineClass } : {}),
        reason: decision.reason,
        ...(hint ? { hint } : {}),
        // The turn's deadline goes with the question. The loop only checks `aborted` at the top of an
        // iteration, so without this the turn is unbounded for as long as a human takes to answer —
        // and it holds its conversation's queue for all of it.
        ...(req.signal ? { signal: req.signal } : {}),
        ...(waitMs !== undefined ? { waitMs } : {}),
        ...(parked ? { answerableMs: req.parkApprovalsMs } : {}),
        ...(decision.grant ? { grant: decision.grant } : {}),
        ...(decision.toolGrant ? { toolGrant: decision.toolGrant } : {}),
        /**
         * The `waiting` step, once the gate has a request for it to name (`approvalId`, stream 1.2) — and awaited by
         * the gate before the prompt goes out: see `onActivity`, the bubble is sealed above the question. Written
         * before the request existed, it could name the call and not the approval an editor answers.
         */
        asking: async (approvalId) => {
          parkedAs = approvalId;
          await this.deps.onActivity?.("waiting", `waiting for approval: ${call.name}`, { callId: call.id, name: call.name, approvalId });
        },
        // A tool's own, where the arguments' shape says too little — a persona change's diff (0.8.8).
        preview: tool.preview?.(call.arguments, ctx) ?? buildApprovalPreview(call.name, call.arguments, {
          // Resolved through the tool's own resolver, so the summary stats the file the write will
          // actually touch. A path that does not resolve is reported as a new file, which is the same
          // thing the write itself would refuse — and refusing is the tool's job, not the summary's.
          statFile: (path) => {
            try {
              const resolved = resolveToolPath(ctx, path, "path");
              const stat = statFile(resolved);
              if (!stat || stat.isDirectory) return null;
              return { lines: countFileLines(resolved, stat.size), bytes: stat.size };
            } catch {
              return null;
            }
          },
        }),
      });

      this.lastApprovalWaitMs = Date.now() - approvalStartedAt;

      if (outcome.status !== "approved") {
        const detail =
          outcome.status === "unavailable"
            ? outcome.reason
            : outcome.status === "denied"
              ? `A human denied this call${outcome.reason ? `: ${outcome.reason}` : "."}`
              : outcome.stillAnswerable && parked
                ? `Parked as approval #${parkedAs ?? "?"}: a person has been asked, and nobody waits for the answer. Go on ` +
                  `with what does not depend on this call, or end your turn. Do not check on it: nothing changes until ` +
                  `they answer, and their answer is the next turn of this mission. If they allow it, run the same call ` +
                  `again then.`
              : outcome.stillAnswerable
                ? // The useful case, and the one the model has never seen before. It is not a no —
                  // it is "not yet", and the right move is to get on with everything else and say so.
                  `Nobody has answered the approval for this yet, and I stopped waiting so this turn ` +
                  `could finish. It is still open: if they approve it, you will be asked to carry on ` +
                  `from here. Do whatever else the request needs, then say plainly what is waiting on ` +
                  `their approval and what you did without it.`
                : "The approval request expired without an answer.";
        log.info("tool call not approved", {
          agent_id: agent.config.id, turn_id: req.turnId,
          tool: call.name,
          outcome: outcome.status,
        });
        this.lastToolNotApproved = true;
        // Denial is a tool *result*, not an error: the model should adapt, and often can. A parked one says so, for the
        // rounds the turn has left after it (`index.ts`, `PARKED_ROUNDS`).
        return { content: detail, isError: true, ...(outcome.status === "expired" && outcome.stillAnswerable && parked ? { metadata: { parked: parkedAs ?? true } } : {}) };
      }
      // The request the yes answered, with what it showed, for a tool whose write depends on it (0.8.13): the persona tool.
      if (outcome.id) approved = { id: outcome.id, ...(this.deps.approvals.previewOf?.(outcome.id) ? { preview: this.deps.approvals.previewOf(outcome.id)! } : {}) };
    } else if (decision.action === "run" && decision.via === "grant") {
      // Counted so `nouride grants list` can distinguish a grant carrying daily work from one made
      // in a hurry and never used again — the only basis on which an operator can prune the list.
      this.deps.onGrantUsed?.(agent.config.id, decision.grantKey);
    }

    // The intent committed right before the tool runs — after the gate and any wait for a person — so a
    // crash can tell a call cut off while it ran from one that never began (`modules/turns/close.ts`).
    req.journal?.started([call.id]);
    const startedAt = Date.now();
    try {
      // Raced against the turn's stop: a tool that ignores its signal no longer holds the chat (`stopped-call.ts`).
      const result = await untilStopped(
        tool.execute(call.arguments, approved ? { ...ctx, approved } : ctx),
        req.signal,
        this.deps.stoppedCallGraceMs ?? STOPPED_CALL_GRACE_MS,
        { tool: call.name, agentId: agent.config.id, ...(req.turnId ? { turnId: req.turnId } : {}) },
      );
      if (result.untrusted) this.untrustedRead.set(req, (this.untrustedRead.get(req) ?? new Set()).add(call.name));

      log.debug("tool executed", {
        agent_id: agent.config.id, turn_id: req.turnId,
        tool: call.name,
        ms: Date.now() - startedAt,
        error: result.isError,
      });

      /**
       * The cap, applied to the one path that produces content worth capping.
       *
       * Not applied to the refusals and failures above: those are sentences, and a spill file holding
       * "Refused: …" would be a file per denied call for no reader. `isError` results from a tool that
       * *ran* do come through here — a failing build prints its log to stderr, and that log is the
       * whole reason anyone wants to see it.
       */
      if (!this.deps.spill) return result;
      const spill = this.deps.spill;
      // Smaller by kind first, its whole text kept in this conversation's folder as a cleared one is.
      const scope = { agentId: agent.config.id, sessionId: req.sessionId, callId: call.id };
      const byKind = compactResult(result, tool, (content) => spill.keepCleared(scope, content));
      const spilled = await spill.keep({
        ...scope,
        toolName: call.name,
        content: byKind.content,
        maxTokens: maxResultTokens,
        ...(result.spooled ? { spooled: result.spooled } : {}),
      });
      if (spilled.path) {
        // `note`, not `tool_done`: this arrives *before* the call's result, and a `tool_done` here
        // was read as the result — see the `note` kind in `commons/activity.ts`.
        this.deps.onActivity?.(
          "note",
          `${call.name} output was ${Math.round((result.spooled?.chars ?? byKind.content.length) / 1024)}KB: kept an excerpt, wrote the rest to a file`,
        );
      }
      if (spilled.content === byKind.content) return byKind;
      // The path rides in metadata so a delegated turn can hand it back: the helper's excerpt dies
      // with the helper, and "the full log is on disk" is worth nothing to a lead who is not told where.
      return {
        ...byKind,
        content: spilled.content,
        ...(spilled.path ? { metadata: { ...byKind.metadata, spilledTo: spilled.path } } : {}),
      };
    } catch (err) {
      logToolThrow(log, call.name, err, { agent_id: agent.config.id, turn_id: req.turnId });
      // Sanitized: the model gets a usable summary, the log keeps the detail (§17.2 item 5).
      return { content: `Tool "${call.name}" failed: ${toUserMessage(err)}`, isError: true };
    }
  }


}

/**
 * What *always for this job* would allow (0.8.0): a question one of a job's guards put — a send to another chat, an action
 * the second look held — on a run of that job, about a call that says where it goes. A call that cannot say where is
 * asked every time: an allowance must name its destination, or it would allow everything.
 */
function jobGrantFor(req: TurnRequest, decision: GateDecision, out: SendsOut | null): ApprovalAsk["jobGrant"] | undefined {
  const jobId = req.unattended?.jobId;
  if (!jobId || decision.action !== "ask" || decision.hardlineClass !== "unwatched" || !out?.to.length) return undefined;
  return { jobId, keys: [...out.to], label: out.what };
}

/** The outside content a call is handed (`ToolContext.untrustedRead`): absent while there is none. */
function untrustedFor(prompt: readonly string[] | undefined, tools: ReadonlySet<string> | undefined): { untrustedRead?: string[] } {
  const read = [...(prompt ?? []), ...(tools ?? [])];
  return read.length > 0 ? { untrustedRead: read } : {};
}

/** Where a result's full output was written, if it was spilled — for the step a handoff reports. */
export function spilledOf(result: ToolResult): { spilledTo?: string } {
  const path = result.metadata?.spilledTo;
  return typeof path === "string" ? { spilledTo: path } : {};
}

export function readToolControl(result: ToolResult): ToolControl | null {
  const control = result.metadata?.control;
  if (!control || typeof control !== "object") return null;
  const { finishTurn, note, reply } = control as Record<string, unknown>;
  if (finishTurn !== "wrap_up" && finishTurn !== "end") return null;
  return { finishTurn, ...(typeof note === "string" ? { note } : {}), ...(typeof reply === "string" ? { reply } : {}) };
}
