/**
 * `[agent] access` and `[open]` in a pack: who this agent's connections take, and what strangers may cost it.
 *
 * Absent, `access` stays absent and the agent follows the install; a word that is not one of the four fails at load.
 * `open` fails there too beside `[external]`, since what makes an open agent safe is that the daemon decides its
 * tools and a coding CLI brings its own; and with no `[open]` limits, since an agent that answers anyone on its
 * owner's tokens is bounded by numbers its owner chose, and neither has a default.
 */

import { AGENT_ACCESS, ConfigError, isAgentAccess, type AgentAccess, type OpenLimits } from "@nouride/shared";

/** The two numbers, as the pack writes them: said in each refusal, so the one who reads it knows what to add. */
const LIMITS =
  "[open] max_daily_tokens (the most tokens this agent may use in a day) and max_daily_messages_per_person (the most messages one person may send it in a day)";

function wholeNumber(raw: unknown, where: string, key: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) throw new ConfigError(`${where} [open] ${key} must be a whole number of 1 or more, got ${JSON.stringify(raw)}`);
  return raw;
}

/** `[open]` as written. Read whether or not the agent is open now: a closed agent keeps its numbers for the next time. */
function limitsOf(raw: unknown, where: string): Partial<OpenLimits> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError(`${where} [open] must be a table`);
  const table = raw as { max_daily_tokens?: unknown; max_daily_messages_per_person?: unknown; closed_reply?: unknown };
  const maxDailyTokens = wholeNumber(table.max_daily_tokens, where, "max_daily_tokens");
  const maxDailyMessagesPerPerson = wholeNumber(table.max_daily_messages_per_person, where, "max_daily_messages_per_person");
  if (table.closed_reply !== undefined && (typeof table.closed_reply !== "string" || !table.closed_reply.trim())) {
    throw new ConfigError(`${where} [open] closed_reply must be a sentence, what a person is told once the day's tokens are used; take the line out for Nouride's own`);
  }
  return {
    ...(maxDailyTokens === undefined ? {} : { maxDailyTokens }),
    ...(maxDailyMessagesPerPerson === undefined ? {} : { maxDailyMessagesPerPerson }),
    ...(typeof table.closed_reply === "string" ? { closedReply: table.closed_reply.trim() } : {}),
  };
}

export function accessOf(raw: { access: unknown; open: unknown }, onCodingCli: boolean, where: string): { access?: AgentAccess; open?: OpenLimits } {
  const limits = limitsOf(raw.open, where);
  const { maxDailyTokens, maxDailyMessagesPerPerson } = limits;
  const whole = maxDailyTokens !== undefined && maxDailyMessagesPerPerson !== undefined ? { open: { ...limits, maxDailyTokens, maxDailyMessagesPerPerson } } : {};
  if (raw.access === undefined) return whole;
  if (!isAgentAccess(raw.access)) throw new ConfigError(`${where} [agent] access must be one of ${AGENT_ACCESS.join(", ")}, got ${JSON.stringify(raw.access)}`);
  if (raw.access === "open" && onCodingCli) {
    throw new ConfigError(
      `${where} [agent] access = "open": an agent on a coding CLI ([external]) is never open to everyone, since the CLI brings tools of its own that Nouride cannot take away. ` +
        "Open an agent that answers on a model, or keep this one to the people you let in",
    );
  }
  if (raw.access === "open" && !("open" in whole)) {
    throw new ConfigError(`${where} [agent] access = "open" needs ${LIMITS}. Neither has a default: an agent open to everyone spends its owner's tokens for anyone who finds it`);
  }
  return { access: raw.access, ...whole };
}
