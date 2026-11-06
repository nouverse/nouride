import { createFileRoute } from "@tanstack/react-router";
import ModelsPage from "@/modules/models/index.page";

export const Route = createFileRoute("/models")({
  staticData: { fillsViewport: true },
  // `?tab=clis` opens on the coding CLIs — where the New Agent form sends a person to add an account.
  validateSearch: (search: Record<string, unknown>): { tab?: "clis" } => (search.tab === "clis" ? { tab: "clis" } : {}),
  component: RouteComponent,
});

function RouteComponent() {
  const { tab } = Route.useSearch();
  return <ModelsPage tab={tab} />;
}
