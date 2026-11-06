import { createFileRoute } from "@tanstack/react-router";
import AgentLookPage from "@/modules/agents/look.page";

export const Route = createFileRoute("/agents/$agentId/look")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentLookPage agentId={agentId} />;
}
