/**
 * The conversation's own lifecycle: start a new one, summarize this one, throw it away, and pause
 * or resume the agent that is having it.
 *
 * `/new` and `/reset` differ in one thing and it is the thing people get wrong: `/new` keeps the
 * memory vault and the persona as loaded, `/reset` re-reads both from disk.
 */

import { plural } from "@nouride/shared";
import { describeStatus } from "@/modules/pipeline/agent-status.ts";
import { editionLabel } from "@/commons/build.ts";
import type { Hook } from "../types.ts";
import { clearedSize, failed, formatDuration, formatTokens, memoryNote, sessionKey } from "../format.ts";
import { cliStatusLines } from "../cli-status.ts";

export const sessionHooks: Hook[] = [
    {
      command: "/new",
      description: "Start a new conversation",
      handler: async (ctx) => {
        const key = sessionKey(ctx);
        const existing = ctx.deps.sessions.load(key);
        if (existing.messages.length === 0) {
          return { handled: true, reply: "Already fresh, nothing to clear." };
        }
        // What `/new` clears is decided where every ending is (`pipeline/conversation-end.ts`), not here.
        const ended = await ctx.deps.endConversation(key, "new");
        // Kept, and said so: the work goes on past the conversation it was talked about in.
        const kept = ctx.deps.notes?.tasks(key).length ?? 0;
        return {
          handled: true,
          reply:
            `New conversation started. Cleared ${clearedSize(existing.messages)}.` +
            (kept > 0 ? ` Work notes kept (${kept} ${plural(kept, "task")}); /notes clear empties them.` : "") +
            memoryNote(ended.cut),
        };
      },
    },

    {
      command: "/compact",
      description: "Summarize the conversation so far, keeping the recent turns",
      handler: async (ctx) => {
        if (!ctx.deps.compactSession) {
          return { handled: true, reply: "Compaction is not available in this process." };
        }

        // Unlike the automatic pass, this one does not wait for a threshold: someone typing the command
        // has decided the history is long enough, and a command that answers "not yet" reads as broken.
        const result = await ctx.deps.compactSession(ctx.agent.config.id, ctx);

        if (result.status === "empty") {
          return { handled: true, reply: "Nothing to compact: this conversation is empty." };
        }
        if (result.status === "nothing_to_do") {
          return {
            handled: true,
            reply: "Nothing to compact: the conversation is short enough to keep verbatim.",
          };
        }
        if (result.status === "over_budget") {
          // The summary is a model call like any other, and today's cap is reached: said, rather than spent anyway.
          return { handled: true, reply: `Not compacting now: ${result.refusal ?? "today's cap is reached."}` };
        }
        if (result.status === "failed") {
          // The history is untouched, which is the safe outcome. Said plainly rather than reported as
          // success, because a summary nobody can see is indistinguishable from one that never ran.
          return { handled: true, reply: "Could not summarize just now. The conversation is unchanged." };
        }

        const saved = Math.max(0, result.before - result.after);
        return {
          handled: true,
          reply:
            `Compacted ${result.turns} earlier turn(s) into a summary. ` +
            `Context went from about ${result.before} to ${result.after} tokens, freeing ${saved}.`,
        };
      },
    },

    {
      command: "/reset",
      description: "Hard reset: clear conversation, expire approvals, reload config",
      worksWhilePaused: true,
      handler: async (ctx) => {
        // `/new`, and the session-level state with it: a `/model` override — or the chat stays on a model the config
        // never mentioned — and this agent's pending approvals (`pipeline/conversation-end.ts`).
        const before = ctx.deps.sessions.load(sessionKey(ctx)).messages;
        const ended = await ctx.deps.endConversation(sessionKey(ctx), "reset");
        const cleared = before.length === 0 ? "Context was already empty" : `Context cleared (${clearedSize(before)})`;
        const expired = ended.expired;

        // §9.4 SPEC: a reset also un-pauses. Someone typing /reset wants a working agent,
        // and leaving it paused would make the command look like it failed.
        const wasPaused = ctx.deps.registry.isPaused(ctx.agent.config.id);
        if (wasPaused) ctx.deps.registry.resume(ctx.agent.config.id);

        // Said only when it happened: a failed reload used to read "config reloaded" and "reload failed" at once.
        let failure = "";
        try {
          await ctx.deps.registry.reload(ctx.agent.config.id);
        } catch (err) {
          failure = ` ${failed("The config reload", err, ctx)}`;
        }

        return {
          handled: true,
          reply:
            `Reset. ${cleared}${ended.tasks > 0 ? `, ${ended.tasks} work-notes task(s) cleared` : ""}${failure ? "" : ", config reloaded"}${expired > 0 ? `, ${expired} approval(s) expired` : ""}${wasPaused ? ", resumed" : ""}.${failure}` +
            memoryNote(ended.cut),
        };
      },
    },

    {
      command: "/sleep",
      description: "Put this agent to sleep: it takes no work until /wake",
      handler: async (ctx) => {
        // Asleep (0.8.0): a turn it is in stops at its next step, never mid-call; its jobs keep running and report when it
        // wakes; its missions wait. `/stop` is the harder word — it cancels what is running now as well.
        const asleep = ctx.deps.registry.pause(ctx.agent.config.id);
        return {
          handled: true,
          reply: asleep
            ? "Asleep. I take no work from anywhere until /wake, and a restart does not wake me. What I was doing stops at its next step; jobs in the background keep running and report when I wake."
            : "Already asleep.",
        };
      },
    },

    {
      command: "/wake",
      description: "Wake this agent",
      worksWhilePaused: true,
      handler: async (ctx) => {
        const woke = ctx.deps.registry.resume(ctx.agent.config.id);
        return { handled: true, reply: woke ? "Awake." : "I wasn't asleep." };
      },
    },

    {
      command: "/stop",
      description: "Stop what this agent is doing, and put it to sleep",
      handler: async (ctx) => {
        const paused = ctx.deps.registry.pause(ctx.agent.config.id);
        // Interrupt the turn in flight too. Pausing only future messages left whatever was
        // already running to finish, which is the opposite of what someone typing /stop wants.
        const cancelled = ctx.deps.cancelTurn?.(ctx.agent.config.id, ctx.chatId);
        // And what it handed to helpers in the background from here (0.7.15), and the agents it asked whose answers are
        // still to come (0.7.19): "stop" means the work, not only the turn.
        const { helpers, asked } = ctx.deps.stopBackground?.(ctx.agent.config.id, ctx.chatId) ?? { helpers: 0, asked: [] };
        const stoppedHelpers =
          (helpers === 0 ? "" : ` Stopped ${helpers === 1 ? "the helper" : `the ${helpers} helpers`} working in the background too.`) +
          (asked.length === 0 ? "" : ` Stopped what ${asked.join(" and ")} ${asked.length === 1 ? "was" : "were"} doing in the background for me too.`);

        // "Until /start" says what changed in 0.7.11 (D15): a restart, a nightly update included, no longer resumes it.
        return {
          handled: true,
          reply: !paused
            ? stoppedHelpers
              ? `Already asleep.${stoppedHelpers}`
              : "Already asleep."
            : cancelled
              ? `Asleep, and cancelled what I was doing.${stoppedHelpers} I stay asleep until /wake, through a restart too.`
              : stoppedHelpers
                ? `Asleep.${stoppedHelpers} I'll stay connected but won't reply until /wake. A restart does not wake me.`
                : "Asleep. I'll stay connected but won't reply until /wake. A restart does not wake me.",
        };
      },
    },

    {
      command: "/start",
      description: "Wake this agent (as /wake)",
      worksWhilePaused: true,
      handler: async (ctx) => {
        const woke = ctx.deps.registry.resume(ctx.agent.config.id);
        return { handled: true, reply: woke ? "Awake." : "I wasn't asleep." };
      },
    },

    {
      command: "/status",
      description: "Show agent status",
      worksWhilePaused: true,
      handler: async (ctx) => {
        const key = sessionKey(ctx);
        const session = ctx.deps.sessions.load(key);
        const override = ctx.deps.modelOverrides.get(session.id);
        const uptimeSeconds = Math.round((Date.now() - ctx.deps.daemon.startedAt) / 1000);
        // A coding CLI answers it: what answers, its context and its tokens are the CLI's, never the pack's `[llm]` (0.8.8).
        const cli = ctx.agent.config.external ? ctx.deps.answering?.(ctx.agent, ctx.gatewayId, ctx.chatId) : null;
        const usage = ctx.deps.sessionUsage?.(session.id, session.startedAt, cli ? true : undefined);
        const head = [
          `**${ctx.agent.config.displayName}** ${ctx.agent.config.emoji ?? ""}`.trim(),
          // What it is doing, not only whether its pack loaded — "running" read the same mid-answer and idle (0.7.18).
          `State: ${ctx.deps.agentStatus ? describeStatus(ctx.deps.agentStatus(ctx.agent.config.id)) : ctx.deps.registry.status(ctx.agent.config.id)}`,
        ];

        const lines = cli ? [...head, ...cliStatusLines(cli, ctx.agent.config.llm, session.messages.length, usage)] : [
          ...head,
          `Model: ${override ?? ctx.agent.config.llm.model}${override ? " (overridden for this chat)" : ""}`,
          `Provider: ${ctx.agent.config.llm.provider}`,
          /**
           * The count without the estimate beside it.
           *
           * It used to read "11 (~490 tokens)", and that number is `estimateMessagesTokens` over the
           * transcript alone — the system prompt is not in it. On a real agent the prompt is the
           * overwhelming majority of every request, so the line said ~490 next to a session total of
           * 133.6k and the two looked like they should agree. Somebody reading that concludes the
           * billing is wrong. The honest per-reply number is measured, not estimated, and it is on
           * the line below.
           */
          `Messages: ${session.messages.length} in context`,
        ];
        if (usage && !cli) {
          /**
           * Session totals, and what one reply costs now.
           *
           * Totals are cumulative since `startedAt` — what this conversation has cost, which is the
           * question worth asking and which `/new` resets. The last reply's input is what predicts
           * the next one: it grows every turn as the transcript does, and it is the number that says
           * when a conversation has become expensive to continue.
           */
          const last = usage.lastInputTokens > 0 ? ` · ${formatTokens(usage.lastInputTokens)} last reply` : "";
          /**
           * Three states, not two, because the column is nullable on purpose.
           *
           * A figure means the provider reported it. `null` means **no request said anything about
           * caching**, which is not the same as "nothing was cached" — Gemini behind a gateway that
           * never maps `cachedContentTokenCount` is caching or not and this daemon cannot tell. A
           * static "(some may be cached)" would be worse than either: unfalsifiable on the provider
           * that cannot answer, and wrong on the two that can.
           */
          const cached =
            usage.cachedInputTokens === null
              ? " (cache not reported)"
              : usage.cachedInputTokens > 0
                ? ` (${formatTokens(usage.cachedInputTokens)} cached)`
                : "";
          lines.push(
            `Tokens: ${formatTokens(usage.inputTokens)} in${cached} / ${formatTokens(usage.outputTokens)} out${last}`,
          );
        }
        // No tools or skills here. Twenty-three tool names and thirty skill names, wrapped over fifteen
        // lines on a phone, for a command whose job is to answer "is this thing working". They are the
        // same on every call and they are what `nouride agents` and the Skills page are for — a status
        // readout nobody scrolls to the end of has stopped being one.
        /**
         * Version and edition together, because neither is the answer on its own.
         *
         * Two boxes on `v0.4.5` can differ in whether WhatsApp is compiled in and whether they can
         * update themselves at all — `/health` has carried the edition for that reason since the
         * update work, and this line is where a person actually looks. A source checkout says so
         * rather than being labelled, since it is not any edition and cannot replace itself.
         */
        const edition = editionLabel();
        const build = edition
          ? `v${ctx.deps.daemon.version} ${edition}`
          : `v${ctx.deps.daemon.version}, source checkout`;
        lines.push(`Daemon uptime: ${formatDuration(uptimeSeconds)} (${build})`);

        return { handled: true, reply: lines.join("\n") };
      },
    },
];
