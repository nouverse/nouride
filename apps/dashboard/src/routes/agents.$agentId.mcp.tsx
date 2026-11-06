import { createFileRoute } from "@tanstack/react-router";
import AgentMcpPage from "@/modules/agents/mcp.page";

export const Route = createFileRoute("/agents/$agentId/mcp")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentMcpPage agentId={agentId} />;
}
