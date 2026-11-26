import { createFileRoute } from "@tanstack/react-router";
import OpenAgentsPage from "@/modules/access/open-agents.page";
import { parseOpenAgentsSearch, type OpenAgentsSearch } from "@/modules/access/search";

/** The agent picked and its tab live in the URL, so an agent's Access tab and the Access page can link straight to its people. */
export const Route = createFileRoute("/open-agents")({
  validateSearch: (search: Record<string, unknown>): OpenAgentsSearch => parseOpenAgentsSearch(search),
  component: OpenAgentsRoute,
});

function OpenAgentsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <OpenAgentsPage search={search} onSearch={(next) => void navigate({ search: next, replace: true })} />;
}
