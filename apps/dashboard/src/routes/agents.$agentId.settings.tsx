import { createFileRoute } from "@tanstack/react-router";
import AgentSettingsPage from "@/modules/agents/agent-settings.page";

export const Route = createFileRoute("/agents/$agentId/settings")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentSettingsPage agentId={agentId} />;
}
