/**
 * A turn's brain: the executor — or its agent's coding CLI (`brain.ts`) — built with every sink the turn has: the meter
 * its calls are charged to, who writes its summaries, the approval level it asks at, the record, the bubble, the
 * opening line and the typing indicator. A phase of `TurnRunner.runTurn` (`turn.ts`).
 */

import { changesSharedTools } from "@/modules/toolchain/shared-tools.ts";
import { dirname, join } from "@nouride/runtime";
import { createLogger, type LoadedAgent } from "@nouride/shared";
import type { HearingCheck } from "@/modules/attachments/hearing.ts";
import type { ContextLine } from "@/modules/llm/executor/context-line.ts";
import type { TurnBrain } from "@/modules/llm/executor/types.ts";
import type { HookRegistry, ModelOverrides } from "@/modules/hooks/registry.ts";
import { meter } from "@/modules/llm/metered.ts";
import { summarizerFor } from "@/modules/llm/summarizer.ts";
import { secondLookFor } from "@/modules/tools/second-look.ts";
import { alertOnFallback } from "./fallback-alert.ts";
import { brainFor } from "./brain.ts";
import { chatTurnLevel } from "./job-turns.ts";
import type { TurnContext } from "./turn-context.ts";
import type { TurnState } from "./turn-state.ts";

const log = createLogger("pipeline.turn");

export function turnBrain(
  ctx: TurnContext,
  turn: TurnState,
  with_: {
    /** Where a route that refused audio is recorded, so it is not sent any for a week. */
    hearing: Pick<HearingCheck, "recordRejection">;
    /** The chat's `/model`, read when audio is refused: the model switched mid-conversation is the one recorded. */
    modelOverrides: Pick<ModelOverrides, "get">;
    /** The slash commands a person may type, named in the prompt. */
    hooks: Pick<HookRegistry, "list">;
  },
): { executor: TurnBrain; summarize: ReturnType<typeof summarizerFor> } {
  const { agent, envelope, session, record, person, clock, progress, preamble, voiceGateway } = turn;
  // The turn's own calls — and the compaction its executor runs first, which says so (`purpose`).
  const charge = meter(ctx.deps.usage, {
    agentId: agent.config.id,
    provider: agent.config.llm.provider,
    purpose: "turn",
    sessionId: session.id,
    ...(record ? { turnId: record.id } : {}),
  });
  // Who writes a compaction summary, before the answer and after it alike — `[memory]`'s pass model when set.
  const summarize = summarizerFor(ctx.deps, { agentId: agent.config.id, profile: agent.config.llm.provider, sessionId: session.id, tiers: agent.config.llm, ...(record ? { turnId: record.id } : {}) });
  // Three layers, resolved fresh per call: the agent's own posture, then this person's — keyed by the person and not
  // the conversation, because pairing establishes that *they* are trusted and scoping it to a chat meant re-saying it
  // after every `/new` — then the daemon default. A scheduled job's turn here is never `trusted` (`chatTurnLevel`).
  const level = () => chatTurnLevel(envelope, ctx.approvalLevel(agent, person));
  const executor = brainFor(ctx.deps.externalAgents, agent, {
    summarizer: summarize,
    maxImageBytes: ctx.deps.config.media.maxImageBytes,
    // A route that refused audio is not sent any for a week. Read at call time, so a `/model`
    // switched mid-conversation is the one recorded.
    onAudioRefused: () => with_.hearing.recordRejection(agent.config.llm.provider, with_.modelOverrides.get(session.id) ?? agent.config.llm.model),
    onFallback: alertOnFallback(ctx.outages, ctx.deps.notifier, agent),
    windowOf: (model) => ctx.deps.providers?.catalog?.windowNow(agent.config.llm.provider, model) ?? null,
    ...(ctx.deps.spill ? { spill: ctx.deps.spill } : {}),
    tokenScales: ctx.tokenScales,
    llm: ctx.deps.config.llm,
    approvals: ctx.deps.approvals,
    approvalLevel: level,
    // The second look at what work nobody watches sends out (0.8.0), charged with this turn's calls.
    secondLook: secondLookFor({
      agent: agent.config,
      install: () => ctx.deps.config,
      level,
      provider: () => ctx.deps.providers.get(agent.config.llm.provider),
      onUsage: (usage, model) => charge(usage, model, "second_look"),
    }),
    carefulHint: () => ctx.carefulHint(agent, person),
    onBatch: (lines) => progress?.batch(lines),
    group: (write) => ctx.atomically(write),
    onActivity: (kind, text, detail) => {
      clock.stillWorking();
      // Two sinks, one callback: the record — the stream every reader follows, `thinking` said to them and kept
      // nowhere — and the bubble in the chat itself.
      record?.step(kind, text, detail);
      progress?.show(kind, text, detail);
      if (kind === "waiting") {
        /**
         * Sealed, and **returned** so the executor waits for it.
         *
         * Two things go wrong without this. The bubble keeps being edited after the approval prompt
         * lands below it, so the numbers climb somewhere the reader has already scrolled past — and
         * after approving, the turn looks like it stopped dead. And because progress is throttled,
         * a tool that needs approval fires `tool` and `waiting` milliseconds apart: the bubble had
         * not been posted yet, so it appeared *below* the prompt instead of above it.
         *
         * Sealing flushes immediately and awaiting it fixes the order.
         */
        return progress?.seal("waiting for you");
      }
    },
    onGrantUsed: (agentId, grantKey) => {
      if (!grantKey) return;
      // Both stores, because the gate hands back a key without saying which kind it is — and both
      // `touch` calls are no-ops for a key they do not hold. Asking the gate to label it would put
      // knowledge of the two tables somewhere that does not need it.
      ctx.deps.grants?.touch(agentId, grantKey);
      ctx.deps.toolGrants?.touch(grantKey);
    },
    // The answer as it is written. Only the record reads its words — a chat platform gets the finished
    // message, for the reasons in `§6.5` and on `ExecutorDeps.onText`; the bubble only that it is being written.
    onText: (delta: string) => {
      record?.delta(delta);
      progress?.wrote();
    },
    ...(record ? { onRequest: (line: ContextLine) => record.context(line) } : {}),
    ...(preamble ? { onPreamble: (words: string, said?: { own?: boolean }) => preamble.offer(words, said) } : {}),
    execPolicy: (agentId) => ({
      grantsHeld: ctx.deps.grants?.liveKeys(agentId).size ?? 0,
    }),
    timezone: ctx.deps.config.daemon.timezone,
    ...(ctx.deps.credentialsDir ? { credentialsDir: ctx.deps.credentialsDir } : {}),
    // The install root, derived the same way the diagnostic `renderPrompt` does it: grandparent of
    // the data directory. Wired here since 2026-08-23 — before this, the executor never passed it,
    // so the "MY OWN CLI" harness section was silently absent on every real turn.
    installDir: dirname(dirname(ctx.deps.config.daemon.dataDir)),
    binDir: join(dirname(ctx.deps.config.daemon.dataDir), "bin"),
    changesSharedTools: (agentId: string) => changesSharedTools(ctx.deps.config, ctx.deps.registry.get(agentId)),
    ...(ctx.deps.projectSkills
      ? { projectSkills: (a: LoadedAgent) => ctx.deps.projectSkills!.forAgent(a) }
      : {}),

    commands: with_.hooks.list().filter((hook) => !hook.hidden).map((hook) => hook.command),
    // Refreshed from inside the turn, so the indicator stays alive across tool calls instead
    // of expiring after the first one. Omitted entirely when the config turns it off —
    // passing a no-op would still start the 5s refresh timer.
    ...(ctx.deps.config.llm.streaming.typingIndicator
      ? {
          // The agent's own connection, like everything else it emits. On the inbound one the chat
          // showed "Nouva is typing…" while Nexa was the one working — the fourth place this rule
          // had to be applied, and the one a person notices first.
          onTyping: () => void voiceGateway?.setTyping(envelope.chatId),
          ...(ctx.deps.typingRefreshMs ? { typingRefreshMs: ctx.deps.typingRefreshMs } : {}),
        }
      : {}),
    onUsage: (usage) => {
      log.debug("llm usage", {
        agent_id: usage.agentId,
        model: usage.model,
        input: usage.inputTokens,
        output: usage.outputTokens,
        estimated: usage.estimated ?? false,
      });
      charge(usage, usage.model, usage.purpose, usage.provider);
    },
    onCompacted: (history) => void (turn.upkept = history),
  });
  return { executor, summarize };
}
