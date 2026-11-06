import { createFileRoute } from "@tanstack/react-router";
import SchedulePage from "@/modules/schedule/index.page";
import { parseScheduleSearch, type ScheduleSearch } from "@/modules/schedule/search";

export const Route = createFileRoute("/schedule")({
  staticData: { fillsViewport: true },
  validateSearch: (search: Record<string, unknown>): ScheduleSearch => parseScheduleSearch(search),
  component: RouteComponent,
});

function RouteComponent() {
  const { job } = Route.useSearch();
  return <SchedulePage {...(job ? { job } : {})} />;
}
