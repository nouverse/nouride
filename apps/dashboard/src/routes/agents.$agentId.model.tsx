import { createFileRoute } from "@tanstack/react-router";
import AgentModelPage from "@/modules/agents/model.page";

export const Route = createFileRoute("/agents/$agentId/model")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentModelPage agentId={agentId} />;
}
