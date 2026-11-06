import { createFileRoute } from "@tanstack/react-router";
import AgentSkillsPage from "@/modules/agents/skills.page";

export const Route = createFileRoute("/agents/$agentId/skills")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentSkillsPage agentId={agentId} />;
}
