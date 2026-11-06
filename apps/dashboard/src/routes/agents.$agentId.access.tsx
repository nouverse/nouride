import { createFileRoute } from "@tanstack/react-router";
import AgentAccessPage from "@/modules/agents/access.page";

export const Route = createFileRoute("/agents/$agentId/access")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentAccessPage agentId={agentId} />;
}
