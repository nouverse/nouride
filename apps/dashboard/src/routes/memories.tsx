import { createFileRoute } from "@tanstack/react-router";
import MemoriesPage, { MEMORY_TABS, type MemoryTab } from "@/modules/memories/index.page";

// `?tab=`: the tab a link opens it on, as Home's cards for a fact or a document waiting do (0.8.24).
export const Route = createFileRoute("/memories")({
  validateSearch: (search: Record<string, unknown>): { tab?: MemoryTab } =>
    MEMORY_TABS.some((one) => one.value === search.tab) ? { tab: search.tab as MemoryTab } : {},
  component: RouteComponent,
});

function RouteComponent() {
  const { tab } = Route.useSearch();
  return <MemoriesPage {...(tab ? { tab } : {})} />;
}
