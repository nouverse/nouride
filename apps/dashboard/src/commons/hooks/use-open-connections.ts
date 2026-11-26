/**
 * Which connections are an agent's that is open to everyone: what the Access page, its count in the menu and Home's
 * count of requests leave out, from one place so the three never disagree.
 *
 * Known once the agents and the connections have both answered. Before that nobody can tell an open agent's row from
 * another's, and a page that drew its lists then showed an open agent's people for a moment; one that failed showed
 * them for good. `failed` says which rows are whose cannot be told at all.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";

export interface OpenConnections {
  /** Both the agents and the connections have answered. */
  known: boolean;
  /** One of them did not answer: whose rows are an open agent's cannot be told. */
  failed: boolean;
  /** The agents open to everyone, by id. */
  agents: ReadonlySet<string>;
  /** The agent a connection answers for, by the connections' own list. */
  agentOf: (gatewayId: string) => string | undefined;
  /** Whether a connection is an open agent's own. */
  onOpen: (gatewayId: string) => boolean;
}

export function useOpenConnections(): OpenConnections {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways });
  const agents = new Set((status.data?.agents ?? []).filter((agent) => agent.access === "open").map((agent) => agent.id));
  const agentOf = (gatewayId: string) => gateways.data?.gateways.find((gateway) => gateway.id === gatewayId)?.agent;
  return {
    known: Boolean(status.data && gateways.data),
    failed: Boolean((status.error && !status.data) || (gateways.error && !gateways.data)),
    agents,
    agentOf,
    onOpen: (gatewayId) => {
      const agent = agentOf(gatewayId);
      return agent !== undefined && agents.has(agent);
    },
  };
}
