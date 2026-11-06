/**
 * The MCP servers one agent uses (0.7.19): the install's library, each a switch here, with the credential this agent
 * uses for it. Servers are added and changed on Configure → MCP; this page only says which this agent has.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Plug } from "lucide-react";
import { api } from "@/commons/lib/api";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { AgentMcpRow } from "./components/AgentMcpRow";

export default function AgentMcpPage({ agentId }: { agentId: string }) {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const queryClient = useQueryClient();
  // Polled while a server it uses is not up yet — a switch reloads the agent, which connects in the background — and,
  // slower, while one waits for a login, which finishes in another tab.
  const mcp = useQuery({
    queryKey: ["mcp", agentId],
    queryFn: () => api.agentMcp(agentId),
    refetchInterval: (query) => {
      const on = (query.state.data?.servers ?? []).filter((server) => server.on);
      return on.some((server) => !server.running) ? 2_000 : on.some((server) => server.needsLogin) ? 5_000 : false;
    },
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["mcp", agentId] });
    void queryClient.invalidateQueries({ queryKey: ["mcp-library"] });
  };
  const servers = mcp.data?.servers ?? [];
  const on = servers.filter((server) => server.on);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-base-content/65 max-w-xl text-sm leading-relaxed">
          The connectors this agent uses: tools from other services, like GitHub or Notion. Switch one on here. They are
          added, with their shared key and login, in Configure → Connectors. For other apps using Nouride, see Integrations.
        </p>
        <Link to="/mcp" className="btn btn-ghost btn-sm rounded-xl gap-1.5 border border-base-content/15">
          Manage connectors <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>
      {mcp.data?.error ? (
        <div className="space-y-1 text-xs text-error">
          <p>The connectors' settings have a mistake, so no agent has them until it is fixed.</p>
          <Details>
            <p>agents/mcp.toml does not load: {mcp.data.error}</p>
          </Details>
        </div>
      ) : null}
      <ErrorNote error={mcp.error} />

      {mcp.isPending ? (
        <div className="flex justify-center py-16">
          <span className="loading loading-spinner loading-lg text-primary opacity-60" />
        </div>
      ) : servers.length === 0 ? (
        <Card>
          <EmptyState icon={Plug} title="No connectors yet" description="Add one in Configure → Connectors (from the catalog, or by hand) and switch it on here." />
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-base-content/65">
            {on.length} of {servers.length} on
          </p>
          {servers.map((server) => (
            <AgentMcpRow key={server.name} agentId={agentId} server={server} admin={admin} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}
