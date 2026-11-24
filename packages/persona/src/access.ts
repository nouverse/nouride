/**
 * `[agent] access` in a pack: who this agent's connections take. Absent stays absent, and the agent follows the
 * install; a word that is not one of the four fails at load. `open` beside `[external]` fails there too: what makes an
 * open agent safe is that the daemon decides its tools, and a coding CLI brings its own.
 */

import { AGENT_ACCESS, ConfigError, isAgentAccess, type AgentAccess } from "@nouride/shared";

export function accessOf(raw: unknown, onCodingCli: boolean, where: string): { access?: AgentAccess } {
  if (raw === undefined) return {};
  if (!isAgentAccess(raw)) throw new ConfigError(`${where} [agent] access must be one of ${AGENT_ACCESS.join(", ")}, got ${JSON.stringify(raw)}`);
  if (raw === "open" && onCodingCli) {
    throw new ConfigError(
      `${where} [agent] access = "open": an agent on a coding CLI ([external]) is never open to everyone, since the CLI brings tools of its own that Nouride cannot take away. ` +
        "Open an agent that answers on a model, or keep this one to the people you let in",
    );
  }
  return { access: raw };
}
