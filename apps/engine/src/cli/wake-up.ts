/**
 * Scheduling the turn that comes after the restart.
 *
 * A restart ends the conversation that asked for it. That was the whole reason the prompt said
 * *"Never run `stop`, `restart`, or anything that restarts the service … a change that turns out to
 * be wrong cannot be fixed by an agent that is no longer running"* — a rule that solved the problem
 * by removing the capability, so an agent that needed a gateway restarted could only describe it and
 * hand the job back.
 *
 * The one-shot cron job is what answers the objection properly. It is created **before** the
 * restarting command runs, so if the daemon never comes back the job is still there to fire when it
 * does; and it is `at now+N`, in the target conversation, with `session: "chat"` so the follow-up
 * lands in the thread it belongs to rather than in a private history nobody reads.
 *
 * Why it is mechanical rather than advice: the codebase already learned this once. `harness-tools.ts`
 * records that a batching *preference* was ignored — "a model told 'batch your calls' has a
 * preference it can weigh against its own habit — and it did" — and only a stated cost changed the
 * measured behaviour. A wake-up that depends on the model remembering to schedule it is a wake-up
 * that will be missing on the run that needed it, which is the run where the daemon did not come
 * back.
 */

import type { CronJobRow } from "@/cli/wire.ts";
import { BOLD, DIM, GREEN, RESET, say, usageError } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { flagValue } from "@/cli/args.ts";

/** Long enough for the service to be listening again, short enough to feel like the same breath. */
const DEFAULT_DELAY_SECONDS = 10;

export interface WakeUpRequest {
  /** What the agent should do when it comes back. Becomes the job's prompt. */
  message: string;
  gatewayId: string;
  chatId: string;
  agentId: string;
  delaySeconds: number;
  /** Named in the job so a run history reads as "why did this fire" rather than "what is this". */
  because: string;
}

/**
 * Read `--then`, `--in` and the target from an argv tail.
 *
 * Returns `null` when `--then` is absent, which the caller turns into a refusal — the flag is not
 * optional for a command that ends the conversation.
 */
export function parseWakeUp(args: string[], because: string): WakeUpRequest | null {
  const flag = (key: string): string | undefined => flagValue(args, `--${key}`);

  const message = flag("then");
  if (!message) return null;

  const seconds = Number(flag("in") ?? DEFAULT_DELAY_SECONDS);
  const gatewayId = flag("gateway") ?? process.env.NOURIDE_GATEWAY_ID ?? "";
  const chatId = flag("chat") ?? process.env.NOURIDE_CHAT_ID ?? "";
  const agentId = flag("agent") ?? process.env.NOURIDE_AGENT_ID ?? "";

  if (!gatewayId || !chatId || !agentId) {
    usageError(
      "`--then` needs to know where to come back to.",
      "Pass --gateway, --chat and --agent. Your own values are in your prompt under `Gateway instance`.",
    );
  }
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
    usageError("`--in` must be between 1 and 3600 seconds.");
  }

  return { message, gatewayId, chatId, agentId, delaySeconds: Math.floor(seconds), because };
}

/**
 * Create the follow-up, and return its id.
 *
 * Fails the whole command if it cannot be created. That ordering is the point: a restart that
 * happened with no way back is worse than a restart that did not happen, and the only moment this
 * can be checked is before the service goes down.
 */
export async function scheduleWakeUp(client: Client, wake: WakeUpRequest): Promise<string> {
  const { job } = await client.post<{ job: CronJobRow }>("/cron", {
    agentId: wake.agentId,
    name: `wake-up: ${wake.because}`,
    at: `${wake.delaySeconds}s`,
    payload: {
      kind: "agentTurn",
      message:
        `${wake.message}\n\n` +
        `(You scheduled this before ${wake.because}. The daemon has restarted since, so this is a ` +
        `fresh turn: check the outcome yourself rather than assuming it worked, and report what you find.)`,
    },
    target: { gatewayId: wake.gatewayId, chatId: wake.chatId },
    delivery: { mode: "announce" },
    // The conversation's own history, so the follow-up reads as a continuation rather than arriving
    // from nowhere — this is the one case where `chat` is exactly right.
    session: "chat",
    // A reminder that already fired is a row nobody reads.
    keepAfterRun: false,
  });

  say(
    `${GREEN}✓${RESET} wake-up scheduled ${BOLD}+${wake.delaySeconds}s${RESET} ${DIM}${job.id}${RESET}`,
  );
  return job.id;
}

/** The help text every command that ends the conversation prints. One wording, one place. */
export function wakeUpUsage(command: string, example: string): string {
  return (
    `${DIM}${command} --then "<what to do when you are back>"\n` +
    `  --in <seconds>       when to wake up (default ${DEFAULT_DELAY_SECONDS}, max 3600)\n` +
    `  --gateway --chat --agent   where to come back to; defaults to this conversation\n\n` +
    `\`--then\` is required. This command ends the conversation it was run from, and a change\n` +
    `that turns out to be wrong cannot be fixed by an agent that is no longer running. The\n` +
    `follow-up is created BEFORE the restart, so it fires even if the daemon takes a while.\n\n` +
    `  e.g. ${example}${RESET}`
  );
}
