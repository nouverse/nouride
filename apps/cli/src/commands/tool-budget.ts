import { TOOL_ITERATIONS_ADVISED } from "@nouride/shared";
import { BOLD, DIM, RESET, YELLOW, say, usageError } from "@nouride/cli-kit";
import type { Client, StatusResponse } from "@nouride/cli-kit";
import { saidSaved } from "../saved.ts";

/**
 * `nouride tool-budget` — how many tool round-trips one reply may spend.
 *
 * It was reachable from the dashboard and from a hand-edited `config.toml` and from nowhere else,
 * which put it out of reach of the only party that ever hits the cap: the agent spending it. Every
 * agent that holds the `nouride` tool holds the daemon's control surface, so a verb here is the whole
 * capability — no tool schema to grow, no second copy of the bounds, and `nouride help` finds it.
 *
 * Two scopes, because they mean different things. The daemon default is the ceiling on what one
 * message may cost anywhere on the install; a per-agent number overrides it for that agent alone, and
 * `follow` removes the key rather than writing today's default into a file that would then stop
 * tracking tomorrow's.
 */
export async function toolBudget(client: Client, args: string[]): Promise<void> {
  const global = await client.get<{ maxToolIterations: number; min: number; max: number; editable: boolean }>(
    "/policy/tool-iterations",
  );

  const agentFlag = args.indexOf("--agent");
  const rest = agentFlag < 0 ? args : [...args.slice(0, agentFlag), ...args.slice(agentFlag + 2)];

  if (agentFlag >= 0) {
    const id = args[agentFlag + 1];
    if (!id) usageError("Which agent?", 'Usage: nouride tool-budget --agent <id> <number|follow>');
    const value = rest[0];
    if (!value) usageError("Set it to what?", `Usage: nouride tool-budget --agent ${id} <number|follow>`);

    // `follow` is the word because `null` is not typeable and `0` reads like a limit of zero.
    const iterations = value === "follow" ? null : Number(value);
    if (iterations !== null && !Number.isFinite(iterations)) {
      usageError(`"${value}" is not a number.`, `Give ${global.min}-${global.max}, or \`follow\` to use the daemon default.`);
    }

    const answer = await client.post<{ restartRequired?: boolean }>(`/agents/${id}/tool-iterations`, { maxToolIterations: iterations });
    saidSaved(
      iterations === null
        ? `${id} follows the daemon again ${DIM}(${global.maxToolIterations})${RESET}`
        : `${id} may spend ${BOLD}${iterations}${RESET} tool round-trips per reply`,
      answer,
    );
    return warnIfSteep(iterations);
  }

  if (rest.length > 0) {
    const iterations = Number(rest[0]);
    if (!Number.isFinite(iterations)) {
      usageError(`"${rest[0]}" is not a number.`, `Give ${global.min}-${global.max}.`);
    }
    const answer = await client.post<{ restartRequired?: boolean }>("/policy/tool-iterations", { maxToolIterations: iterations });
    saidSaved(`daemon default is now ${BOLD}${iterations}${RESET} tool round-trips per reply`, answer);
    return warnIfSteep(iterations);
  }

  const status = await client.get<StatusResponse>("/status");
  say(`${BOLD}${global.maxToolIterations}${RESET} tool round-trips per reply ${DIM}(the daemon default)${RESET}`);
  say(`${DIM}${global.min}-${global.max} allowed; ${TOOL_ITERATIONS_ADVISED.from}-${TOOL_ITERATIONS_ADVISED.to} covers almost everything${RESET}`);
  for (const agent of status.agents) {
    const own = agent.maxToolIterations;
    say(
      own === null || own === undefined
        ? `  ${DIM}${agent.id.padEnd(16)} follows${RESET}`
        : `  ${agent.id.padEnd(16)} ${BOLD}${own}${RESET}`,
    );
  }
  say("");
  say(`${DIM}nouride tool-budget <n>                       set the daemon default${RESET}`);
  say(`${DIM}nouride tool-budget --agent <id> <n|follow>   set one agent's${RESET}`);
}

/**
 * Said at the moment the number is chosen, not in a doc nobody reads at that moment.
 *
 * Each round-trip resends the entire conversation, so this is the one setting on the daemon that
 * multiplies a bill rather than changing a behaviour — and the effect is invisible until an invoice.
 */
function warnIfSteep(iterations: number | null): void {
  const steep = TOOL_ITERATIONS_ADVISED.to;
  if (iterations !== null && iterations > steep) {
    say(`${YELLOW}!${RESET} ${DIM}above ${steep} each reply can resend the whole conversation ${steep}+ times, so watch the spend${RESET}`);
  }
}
