import { createFileRoute } from "@tanstack/react-router";
import AgentFilesPage from "@/modules/agents/files.page";

export const Route = createFileRoute("/agents/$agentId/")({ component: RouteComponent });

function RouteComponent() {
  const { agentId } = Route.useParams();
  return <AgentFilesPage agentId={agentId} />;
}
