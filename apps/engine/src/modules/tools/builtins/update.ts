/**
 * `update` — tell me whether this daemon is out of date, and replace it if I say so.
 *
 * ## Two actions, and only one of them is a decision
 *
 * `check` reads a version number and changes nothing, so it is not gated at all. An agent
 * that has to interrupt somebody to answer "are we current?" is one nobody asks, and that
 * is the question you most want answered unprompted — in a scheduled turn, in a morning
 * summary, on the way past.
 *
 * `apply` downloads an executable and puts it where this process is started from next.
 * It is on the fixed list as `replace` (SIMPLIFY RFC §1, item 3):
 *
 * - asked every time under `careful`; `balanced` and `trusted` answer it themselves
 * - never grantable, so `allow-always` cannot make it a standing permission
 * - refused when there is nobody to ask and the level does not answer it, because the gate
 *   returning `unavailable` is a refusal and this tool does not have a path around it
 *
 * The gate lives here rather than in `packages/update` on purpose. A plugin edit could
 * otherwise widen the one check standing in front of replacing the binary, and nothing in
 * the build would notice.
 *
 * ## Why it does not restart
 *
 * It does, but through `nouride restart`'s own machinery rather than by exiting: the
 * follow-up turn has to exist **before** the process ends, or a daemon that does not come
 * back is one nobody is told about. The tool schedules the wake-up, applies the update,
 * and then asks the daemon to exit — in that order, and it says so in what it returns so
 * the model knows the conversation is about to stop.
 */

import { createLogger, type GateDecision, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import type { UpdateCheck } from "@/modules/update/index.ts";

const log = createLogger("tools.update");

/**
 * The floor on the follow-up delay.
 *
 * Not arbitrary: the clock starts when the swap finishes, and what has to fit inside it is
 * the shutdown, systemd's `RestartSec=5`, and the new process reaching the point where it
 * runs jobs. Measured on a Raspberry Pi that is about eight seconds, so anything under ten
 * is a turn that fires into a daemon still starting.
 */
const MIN_WAKE_SECONDS = 10;

export interface UpdateToolOptions {
  /** Ask the plugin what is available. Throws when this build has no update provider. */
  check(): Promise<UpdateCheck>;
  /**
   * Do it: swap the files, then schedule the follow-up and end the process.
   *
   * One call rather than three because the *ordering* is the safety property and it must
   * not be reassembled by a caller — see `cli/wake-up.ts` for why a wake-up that depends
   * on somebody remembering is a wake-up that is missing on the run that needed it.
   */
  apply(wake: {
    message: string;
    delaySeconds: number;
    agentId: string;
    gatewayId: string;
    chatId: string;
  }): Promise<{ note: string; to: string }>;
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: false, ...(metadata ? { metadata } : {}) };
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}

/** What the model is shown for a check. Written as sentences because it reads them to somebody. */
function describe(check: UpdateCheck): string {
  // A newer release that needs a newer version first: say what to take, never only that it is up to date.
  const floor = check.floor ? ` ${check.floor.release} cannot be taken from here yet: ${check.floor.message}.` : "";
  if (!check.newer && floor) return `Running ${check.current}.${floor}`;
  if (!check.newer) {
    /**
     * "Newest for this edition", not "newest". A release built for cloud and not mirrored for
     * the free build is one this install can never have, and saying so is the difference
     * between an honest answer and one that looks like the check is broken.
     */
    const elsewhere = check.latestElsewhere
      ? ` ${check.latestElsewhere} has been released and is not an update here: ${check.blockedReason ?? "it carries no build for this edition"}.`
      : "";
    return `Up to date: running ${check.current}, and ${check.latest} is the newest release for this edition.${elsewhere}`;
  }

  const lines = [`An update is available: ${check.current} → ${check.latest}.${floor}`];
  if (check.publishedAt) lines.push(`Published ${check.publishedAt}.`);
  if (check.notesUrl) lines.push(`Notes: ${check.notesUrl}`);

  const plan = check.plan;
  if (!plan) return lines.join(" ");

  if (!plan.can) {
    lines.push(`This install cannot take it by itself: ${plan.reason}.`);
    lines.push(`What is needed instead:\n  ${plan.instead.join("\n  ")}`);
    return lines.join("\n");
  }
  lines.push(`This install can take it: ${plan.artifact}. Run this tool again with action "apply".`);
  return lines.join("\n");
}

export function createUpdateTool(options: UpdateToolOptions): Tool {
  return {
    definition: {
      name: "update",
      description:
        "Check whether a newer Nouride has been released, and install it. " +
        "`check` is free and changes nothing. `apply` replaces this daemon's own binary and restarts it. " +
        "It always asks a human first, and it ends the current conversation, so say what you are doing before you call it. " +
        "It does the same as `nouride update --start`; use this tool, not the CLI.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["check", "apply"],
            description: "check: is there a newer release, and could this install take it. apply: take it.",
          },
          then: {
            type: "string",
            description:
              "For apply: what you will do when you come back. A turn is scheduled with this before the restart, " +
              "so you are the one who reports whether it worked. Required for apply: the call is refused without it.",
          },
          in_seconds: {
            type: "number",
            description: `For apply: how long to wait before that turn. Default 20, min ${MIN_WAKE_SECONDS}, max 600.`,
          },
        },
        required: ["action"],
      },
    },

    requiresApproval: false,

    /**
     * `check` runs; `apply` always asks.
     *
     * A tool with its own gate owns the whole decision, including whether the agent's
     * `approval_required` list would have said otherwise — which is what makes this
     * unconditional rather than a default somebody can configure away.
     */
    gate(args): GateDecision {
      const action = typeof args.action === "string" ? args.action : "";
      if (action !== "apply") return { action: "run", via: "ceiling" };
      return {
        action: "ask",
        grantable: false,
        hardline: true,
        hardlineClass: "replace",
        reason:
          "replaces this daemon's own binary with one downloaded from the release channel, and restarts it",
      };
    },

    async execute(args, ctx: ToolContext) {
      const action = typeof args.action === "string" ? args.action : "";

      if (action === "check") {
        try {
          const check = await options.check();
          return ok(describe(check), {
            current: check.current,
            latest: check.latest,
            newer: check.newer,
            can: check.plan?.can ?? false,
          });
        } catch (err) {
          return fail(`Could not check for updates: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (action !== "apply") {
        return fail(`Unknown action "${action}". Use "check" or "apply".`);
      }

      const then = typeof args.then === "string" ? args.then.trim() : "";
      if (!then) {
        /**
         * Refused rather than defaulted, and the same rule `nouride restart` enforces.
         * This call ends the conversation it was made in; a generic follow-up written
         * here would arrive saying nothing about what the agent had been doing, which is
         * the half of the wake-up that makes it useful.
         */
        return fail(
          'An update ends this conversation, so `then` is required: say what you will check when you come back. ' +
            'For example: then="confirm the version is the new one and every gateway reconnected".',
        );
      }

      const raw = typeof args.in_seconds === "number" ? args.in_seconds : 20;
      const delaySeconds = Math.min(600, Math.max(MIN_WAKE_SECONDS, Math.floor(raw)));

      try {
        const result = await options.apply({
          message: then,
          delaySeconds,
          // The conversation this was asked in, so the follow-up lands in it rather than in a
          // private history nobody reads — the same target `nouride restart --then` takes.
          agentId: ctx.agentId,
          gatewayId: ctx.gatewayId,
          chatId: ctx.chatId,
        });
        log.info("update applied through the tool", { to: result.to });
        return ok(
          `Updated to ${result.to}. ${result.note}\n` +
            `A turn is scheduled in ${delaySeconds}s to pick this up again. This conversation stops here.`,
          { to: result.to, wake_in_seconds: delaySeconds },
        );
      } catch (err) {
        return fail(`The update did not happen: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
