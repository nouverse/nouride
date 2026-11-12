import { createFileRoute } from "@tanstack/react-router";
import AutomationsPage from "@/modules/automations/index.page";
import { parseStart, type StartFilter } from "@/modules/automations/lib/list";

/** `?start=` narrows the list to how an automation starts: what the old Webhooks address opens on. */
export const Route = createFileRoute("/automations/")({
  validateSearch: (search: Record<string, unknown>): { start?: Exclude<StartFilter, "all"> } => {
    const start = parseStart(search.start);
    return start === "all" ? {} : { start };
  },
  component: AutomationsRoute,
});

function AutomationsRoute() {
  const { start } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AutomationsPage start={start ?? "all"} onStart={(next) => void navigate({ search: next === "all" ? {} : { start: next }, replace: true })} />;
}
