import { createFileRoute } from "@tanstack/react-router";
import JobsPage from "@/modules/jobs/index.page";

/** `?agent=` narrows the list to one agent's, as Missions does. */
export const Route = createFileRoute("/jobs/")({
  staticData: { fillsViewport: true },
  validateSearch: (search: Record<string, unknown>): { agent?: string } => (typeof search.agent === "string" && search.agent ? { agent: search.agent } : {}),
  component: JobsRoute,
});

function JobsRoute() {
  const { agent } = Route.useSearch();
  return <JobsPage {...(agent ? { agent } : {})} />;
}
