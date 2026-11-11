import { createFileRoute } from "@tanstack/react-router";
import AutomationPage from "@/modules/automations/automation.page";

export const Route = createFileRoute("/automations/$id")({ component: AutomationRoute });

function AutomationRoute() {
  const { id } = Route.useParams();
  return <AutomationPage id={id} />;
}
