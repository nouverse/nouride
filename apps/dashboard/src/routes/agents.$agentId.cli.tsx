import { createFileRoute } from "@tanstack/react-router";
import AgentCliPage from "@/modules/agents/cli.page";

export const Route = createFileRoute("/agents/$agentId/cli")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentCliPage agentId={agentId} />;
}
