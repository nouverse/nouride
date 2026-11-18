import { createFileRoute } from "@tanstack/react-router";
import MissionsPage from "@/modules/missions/index.page";

/**
 * `?agent=` narrows the board to one agent's — how an agent's page links to its missions. `?tab=` opens it on the column
 * that holds what a link named: one of the four, or a tab of the list the board replaced (`fromLink`).
 */
export const Route = createFileRoute("/missions/")({
  validateSearch: (search: Record<string, unknown>): { agent?: string; tab?: string } => ({
    ...(typeof search.agent === "string" && search.agent ? { agent: search.agent } : {}),
    ...(typeof search.tab === "string" && search.tab ? { tab: search.tab } : {}),
  }),
  component: MissionsRoute,
});

function MissionsRoute() {
  const { agent, tab } = Route.useSearch();
  return <MissionsPage {...(agent ? { agent } : {})} {...(tab ? { tab } : {})} />;
}
