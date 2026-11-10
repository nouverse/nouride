import { BOLD, DIM, RESET, YELLOW, say, usageError } from "@nouride/cli-kit";
import type { Client, StatusResponse } from "@nouride/cli-kit";
import { saidSaved } from "@/cli/saved.ts";

/**
 * `nouride turn-budget` — how long one reply may take, in seconds.
 *
 * The clock's half of `nouride tool-budget`, and a separate command rather than a flag on that one
 * because they are separate questions measured in different units. An agent can burn its clock
 * waiting inside three calls, or burn its round-trips on twenty that each return instantly; a
 * research agent that polls needs seconds, one that reads and edits files needs iterations.
 *
 * Two scopes, same contract as the tool budget: a bare number is the daemon default, `--agent` is
 * one pack's, and `follow` removes the key rather than freezing that agent at today's global.
 */
export async function turnBudget(client: Client, args: string[]): Promise<void> {
  const global = await client.get<{
    turnSeconds: number;
    queueSeconds: number;
    min: number;
    max: number;
    editable: boolean;
  }>("/policy/turn-seconds");

  const agentFlag = args.indexOf("--agent");
  const rest = agentFlag < 0 ? args : [...args.slice(0, agentFlag), ...args.slice(agentFlag + 2)];

  if (agentFlag >= 0) {
    const id = args[agentFlag + 1];
    if (!id) usageError("Which agent?", "Usage: nouride turn-budget --agent <id> <seconds|follow>");
    const value = rest[0];
    if (!value) usageError("Set it to what?", `Usage: nouride turn-budget --agent ${id} <seconds|follow>`);

    const seconds = value === "follow" ? null : Number(value);
    if (seconds !== null && !Number.isFinite(seconds)) {
      usageError(`"${value}" is not a number.`, `Give ${global.min}-${global.max}, or \`follow\` for the daemon default.`);
    }

    const answer = await client.post<{ restartRequired?: boolean }>(`/agents/${id}/turn-seconds`, { turnSeconds: seconds });
    saidSaved(
      seconds === null
        ? `${id} follows the daemon again ${DIM}(${global.turnSeconds}s)${RESET}`
        : `${id} may spend ${BOLD}${seconds}s${RESET} on one reply`,
      answer,
    );
    return warnIfSlow(seconds, global.queueSeconds);
  }

  if (rest.length > 0) {
    const seconds = Number(rest[0]);
    if (!Number.isFinite(seconds)) usageError(`"${rest[0]}" is not a number.`, `Give ${global.min}-${global.max}.`);
    const answer = await client.post<{ restartRequired?: boolean }>("/policy/turn-seconds", { turnSeconds: seconds });
    saidSaved(`daemon default is now ${BOLD}${seconds}s${RESET} per reply`, answer);
    return warnIfSlow(seconds, global.queueSeconds);
  }

  const status = await client.get<StatusResponse>("/status");
  say(`${BOLD}${global.turnSeconds}s${RESET} per reply ${DIM}(the daemon default)${RESET}`);
  say(`${DIM}${global.min}-${global.max} allowed; the queue drops anything waiting past ${global.queueSeconds}s${RESET}`);
  for (const agent of status.agents) {
    const own = agent.maxTurnSeconds;
    say(own === null || own === undefined
      ? `  ${DIM}${agent.id.padEnd(16)} follows${RESET}`
      : `  ${agent.id.padEnd(16)} ${BOLD}${own}s${RESET}`);
  }
  say("");
  say(`${DIM}nouride turn-budget <seconds>                       set the daemon default${RESET}`);
  say(`${DIM}nouride turn-budget --agent <id> <seconds|follow>   set one agent's${RESET}`);
}

/**
 * Said where the number is chosen, because the cost is paid by somebody who is not in this turn.
 *
 * The queue is per chat. A reply allowed four minutes is four minutes of silence for whoever
 * messages next, and past the queue's own timeout their message is not delayed — it is dropped.
 */
function warnIfSlow(seconds: number | null, queueSeconds: number): void {
  if (seconds !== null && seconds > queueSeconds / 2) {
    say(
      `${YELLOW}!${RESET} ${DIM}the queue is per chat: at ${seconds}s, the next message in a busy ` +
        `chat waits that long, and is dropped past ${queueSeconds}s${RESET}`,
    );
  }
}
