/**
 * Show the prompt without running a turn — the `/prompt` hook and `nouride doctor`.
 *
 * Built through the same `buildSystemPrompt` the executor uses. A second rendering path would drift
 * and then lie about what the agent is actually running, which is worse than not offering the
 * diagnostic at all.
 */

import { agentCommandsHaveOwnUsers, dirname, join } from "@nouride/runtime";
import { agentBins } from "@/modules/toolchain/env.ts";
import { resolveToolIterations, resolveTurnDurationMs, type MessageEnvelope } from "@nouride/shared";
import { buildSystemPrompt, workFacts } from "@/modules/llm/prompt/index.ts";
import type { BuiltPrompt } from "@/modules/llm/prompt/types.ts";
import { idFormsFor } from "@/modules/people/match.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import type { HookRegistry, ModelOverrides } from "@/modules/hooks/registry.ts";
import { isSystemEvent } from "./deps.ts";
import type { TurnContext } from "./turn-context.ts";

/**
 * The system prompt an agent would get for this chat right now, minus the parts Nouride wrote.
 *
 * Built through the same `buildSystemPrompt` the executor uses — a second rendering path would
 * drift and then lie about what the agent is actually running.
 *
 * `operatorText` rather than `text`: the operator's own material is printed verbatim, and the
 * harness block — the product's own instructions, shipped in the binary — is replaced by a note
 * saying how large it is. The section boundaries stay, so the diagnostic still shows *where* it
 * sits, which is usually what somebody is checking.
 *
 * This is the only surface that prints a prompt. Adding another means deciding this question
 * again, and `Section.origin` is where the answer lives.
 */
export async function renderPrompt(
ctx: TurnContext,
hooks: HookRegistry,
modelOverrides: ModelOverrides,
agentId: string,
envelope: MessageEnvelope,
): Promise<BuiltPrompt | string> {
  const agent = ctx.deps.registry.get(agentId);
  if (!agent) return `No such agent: ${agentId}`;
  // Read the same way `turn.ts` reads it, so `/prompt` shows what the agent is actually told it
  // remembers — "does my agent know me" is the question it is opened to answer.
  const recall = await ctx.recallFor(agentId, envelope);

  const toolset = resolveToolset(
    agent,
    ctx.tools,
    ctx.deps.config.security,
    ctx.toolsetDeps(),
  );
  const session = ctx.deps.sessions.load({
    agentId,
    chatId: envelope.chatId,
    gatewayId: envelope.gatewayId,
  });

  return buildSystemPrompt({
    agent,
    tools: toolset.definitions,
    harness: {
      approvalRequired: toolset.definitions
        .map((t) => t.name)
        .filter((name) => toolset.requiresApproval(name)),
      approvalAvailable: ctx.deps.approvals.available,
      // From the same resolver a turn uses. Third field this file has had to be taught, and the reason
      // is always the same: it assembles the facts separately, so anything added to a turn has to be
      // added here too or the diagnostic quietly answers "no" about a live behaviour.
      approvals: ctx.approvalLevel(agent, { gatewayId: envelope.gatewayId, senderId: envelope.senderId }),
      execPolicy: {
        grantsHeld: ctx.deps.grants?.liveKeys(agent.config.id).size ?? 0,
      },
      // A chat's prompt, as a turn's: where `mission` can start one, the rule for when (0.8.5).
      ...(toolset.definitions.some((t) => t.name === "mission") ? { startsMissions: true } : {}),
      // What the toolset was resolved with, as a turn's prompt has it: the background lines and the machine.
      ...workFacts(toolset),
      /**
       * The same two directories a turn actually gets, from the same place a turn gets them.
       *
       * This said `dir: agent.dir` — the *pack* directory — with no `privateDir` at all, so `/prompt`
       * reported that the agent works in `agents/<id>/` and never mentioned `workspace/shared` or
       * `workspace/private/<id>` in its life. Every real turn was correct; only the diagnostic was
       * wrong, which is the worst place for it to be: the operator opens `/prompt` precisely to check
       * whether the agent has been told something, and it answered no about a capability the harness
       * has always given.
       *
       * Second time in this file for the same class of bug — see `otherAgents` below. The header's
       * claim that sharing `buildSystemPrompt` prevents drift is true about rendering and false about
       * the facts, and this is the second field to prove it.
       */
      workspace: (() => {
        const { shared, own } = ctx.workspaceFor(agent.config.id);
        return {
          dir: shared,
          privateDir: own,
          // The same order and the same members `workspaceView` assembles for a turn: shared, private,
          // the pack, then whatever the operator opted into.
          roots: [shared, own, agent.dir, ...agent.config.workspaceRoots],
        };
      })(),
      // The install root, which is the grandparent of the data directory (`<root>/.nouride/data`).
      // Derived rather than configured: it is already implied by a path the daemon must know, and a
      // second setting for the same fact is one more thing that can disagree with reality.
      installDir: dirname(dirname(ctx.deps.config.daemon.dataDir)),
      ...agentBins(join(dirname(ctx.deps.config.daemon.dataDir), "bin"), ctx.workspaceFor(agent.config.id).own, agentCommandsHaveOwnUsers()),
      maxToolIterations: resolveToolIterations(
        agent.config.llm.maxToolIterations,
        ctx.deps.config.llm.limits.maxToolIterations,
      ),
      maxTurnDurationMs: resolveTurnDurationMs(
        agent.config.llm.maxTurnDurationMs,
        ctx.deps.config.llm.limits.maxTurnDurationMs,
      ),
      commands: hooks.list().filter((hook) => !hook.hidden).map((hook) => hook.command),
      truncates: ctx.deps.config.llm.context.truncationStrategy === "sliding_window",
      /**
       * Assembled exactly as `turn.ts` does it, because it was not assembled at all.
       *
       * This file's own header says a second rendering path would drift and lie — and it did, in the
       * one way sharing `buildSystemPrompt` cannot prevent: the *facts* are gathered here separately,
       * and this one was simply missing. So `/prompt` showed no OTHER AGENTS block whatever the chat
       * was, which is precisely the section you open the diagnostic to check when an agent is not
       * handing work over. Found on a live box, looking for a different bug.
       */
      ...(() => {
        const otherAgents = ctx.otherAgentsFor(agentId, envelope);
        return otherAgents ? { otherAgents } : {};
      })(),
    },
    gateway: envelope.gateway,
    ...ctx.formattingFor(envelope.gatewayId),
    chatId: envelope.chatId,
    chatType: envelope.chatType,
    ...ctx.roomNameOf(envelope),
    sessionId: session.id,
    model: modelOverrides.get(session.id) ?? agent.config.llm.model,
    now: new Date(),
    timezone: ctx.deps.config.daemon.timezone,
    /**
     * Who the agent would be told it is talking to. The fourth field this file has had to be taught.
     *
     * It was absent, so `/prompt` rendered *no identity line at all* — not the matched person, not
     * the signed-in account, not the hedged handle, not even "you do not know who is speaking". Which
     * makes the diagnostic silently wrong about the one question an operator opens it to answer:
     * "does my agent know who I am?" Found while trying to verify exactly that, on the box, with a
     * `[[people]]` entry that was in fact matching correctly the whole time.
     *
     * Same shape as `turn.ts`, deliberately including the DM rule: an unverified display name is
     * withheld one-to-one, and a verified one is not.
     */
    ...(isSystemEvent(envelope) ? { systemEvent: true } : {}),
    ...(envelope.chatType !== "dm" || envelope.senderVerified
      ? envelope.senderName
        ? { senderName: envelope.senderName }
        : {}
      : {}),
    ...(envelope.senderVerified ? { senderVerified: true } : {}),
    ...(() => {
      const person = ctx.personFor(envelope);
      return person ? { person } : {};
    })(),
    ...(recall ? { recall } : {}),
    ...(ctx.deps.config.people.length > 0 ? { peopleConfigured: true } : {}),
    ...(() => {
      if (!envelope.senderId) return {};
      const [qualified, onPlatform] = idFormsFor(envelope);
      return {
        ...(qualified ? { personRef: qualified } : {}),
        ...(onPlatform ? { personRefPlatform: onPlatform } : {}),
      };
    })(),
    gatewayId: envelope.gatewayId,
  });
}

/**
 * What `/prompt` prints: the operator's own files, and a note where this repository's prose was.
 *
 * Next to the builder rather than in the pipeline, because it is the same decision as
 * `Section.origin` and belongs with it. The pipeline asks for a prompt; what a display surface may
 * show is not the pipeline's question.
 */
export async function renderPromptForOperator(
  ctx: TurnContext,
  hooks: HookRegistry,
  modelOverrides: ModelOverrides,
  agentId: string,
  envelope: MessageEnvelope,
): Promise<string> {
  const built = await renderPrompt(ctx, hooks, modelOverrides, agentId, envelope);
  return typeof built === "string" ? built : built.operatorText;
}
