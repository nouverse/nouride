import { createFileRoute } from "@tanstack/react-router";
import AgentLayoutPage from "@/modules/agents/layout.page";

export const Route = createFileRoute("/agents/$agentId")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentLayoutPage agentId={agentId} />;
}
