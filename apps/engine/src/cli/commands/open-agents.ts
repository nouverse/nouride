/**
 * What `config check` and `doctor` say of the agents open to everyone: which are, on which connections, bounded by
 * which numbers, and what of their pack is not used while they are.
 *
 * Said because nothing else on a terminal does. An open agent answers anyone on its owner's account, and the one
 * place that lists who may talk to the install, `nouride access`, has nobody of theirs in it: they were never asked
 * for a code. Its pack may list a shell and it holds none, which is the point, and reads as a fault to whoever reads
 * the pack. And one that owns no connection is open to nobody, which is nearly always a step somebody forgot.
 */

import type { StatusResponse } from "@nouride/cli-kit";
import { OPEN_AGENT_TOOLS } from "@/modules/tools/open-agent.ts";
import type { Check } from "./doctor-checks.ts";

/** One open agent, as the packs or the running daemon say it. */
export interface OpenAgentFacts {
  id: string;
  /** The enabled connections it owns: where strangers reach it. */
  connections: readonly string[];
  limits: { maxDailyTokens: number; maxDailyMessagesPerPerson: number } | null;
  /** What its pack lists under `[tools] enabled`. */
  packTools: readonly string[];
  /** The running daemon's count of its day, where one was asked. */
  today?: { tokens: number; people: number };
}

/** The open ones among a running daemon's agents, as its `/status` says them: what `doctor` reads. */
export function openFromStatus(agents: readonly Pick<StatusResponse["agents"][number], "id" | "access" | "open" | "tools">[]): OpenAgentFacts[] {
  return agents
    .filter((agent) => agent.access === "open")
    .map((agent) => ({ id: agent.id, connections: agent.open?.connections ?? [], limits: agent.open?.limits ?? null, packTools: agent.tools, ...(agent.open?.today ? { today: agent.open.today } : {}) }));
}

/** The tools of its pack an open agent does not hold. */
export function unusedWhileOpen(packTools: readonly string[]): string[] {
  return packTools.filter((name) => !OPEN_AGENT_TOOLS.includes(name));
}

export function openAgentChecks(agents: readonly OpenAgentFacts[]): Check[] {
  return agents.map((agent): Check => {
    const bounds = agent.limits
      ? `at most ${agent.limits.maxDailyTokens.toLocaleString("en-US")} tokens a day, and ${agent.limits.maxDailyMessagesPerPerson.toLocaleString("en-US")} ${agent.limits.maxDailyMessagesPerPerson === 1 ? "message" : "messages"} a person`
      : "with no limits";
    const today = agent.today ? ` (today: ${agent.today.tokens.toLocaleString("en-US")} tokens, ${agent.today.people} ${agent.today.people === 1 ? "person" : "people"})` : "";
    const unused = unusedWhileOpen(agent.packTools);
    const tools = unused.length > 0 ? ` Its pack's other tools are not used while it is open: ${unused.join(", ")}.` : "";
    if (agent.connections.length === 0) {
      return {
        level: "warn",
        message: `${agent.id} is open to everyone, and owns no connection: nobody can reach it`,
        hint: `Give it a bot or a number of its own on its Connections tab in the dashboard, or close it on its Access tab.${tools}`,
      };
    }
    return {
      level: "ok",
      message: `${agent.id} is open to everyone on ${agent.connections.join(", ")}: ${bounds}${today}`,
      hint: `Anyone who finds it is answered with no code, from the documents opened to everyone. Who wrote to it is on its page in the dashboard, not under \`nouride access\`.${tools}`,
    };
  });
}
