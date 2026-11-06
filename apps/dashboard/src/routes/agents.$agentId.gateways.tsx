import { createFileRoute } from "@tanstack/react-router";
import AgentGatewaysPage from "@/modules/agents/gateways.page";

export const Route = createFileRoute("/agents/$agentId/gateways")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentGatewaysPage agentId={agentId} />;
}
