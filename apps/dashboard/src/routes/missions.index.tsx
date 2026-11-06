import { createFileRoute } from "@tanstack/react-router";
import MissionsPage from "@/modules/missions/index.page";

/** `?agent=` narrows the list to one agent's — how an agent's page links to its missions. */
export const Route = createFileRoute("/missions/")({
  staticData: { fillsViewport: true },
  validateSearch: (search: Record<string, unknown>): { agent?: string } => (typeof search.agent === "string" && search.agent ? { agent: search.agent } : {}),
  component: MissionsRoute,
});

function MissionsRoute() {
  const { agent } = Route.useSearch();
  return <MissionsPage {...(agent ? { agent } : {})} />;
}
