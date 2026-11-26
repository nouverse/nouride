import { createFileRoute } from "@tanstack/react-router";
import OpenAgentsPage from "@/modules/access/open-agents.page";

/** The agent picked lives in the URL, so an agent's Access tab and the Access page can link straight to its people. */
export const Route = createFileRoute("/open-agents")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => (typeof search.agent === "string" && search.agent.trim() ? { agent: search.agent.trim() } : {}),
  component: OpenAgentsRoute,
});

function OpenAgentsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <OpenAgentsPage agent={search.agent} onAgent={(agent) => void navigate({ search: { agent }, replace: true })} />;
}
