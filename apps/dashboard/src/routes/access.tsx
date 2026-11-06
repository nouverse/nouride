import { createFileRoute } from "@tanstack/react-router";
import AccessPage from "@/modules/access/index.page";
import { parseAccessSearch, type AccessSearch } from "@/modules/access/search";

/** The tab and the agent filter live in the URL, so an agent's Access tab can link here filtered to it. */
export const Route = createFileRoute("/access")({
  validateSearch: (search: Record<string, unknown>): AccessSearch => parseAccessSearch(search),
  component: AccessRoute,
});

function AccessRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AccessPage search={search} onSearch={(next) => void navigate({ search: next, replace: true })} />;
}
