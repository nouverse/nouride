import { createFileRoute } from "@tanstack/react-router";
import GraphPage from "@/modules/memories/graph/graph.page";
import type { GraphSearch } from "@/modules/memories/graph/search";
import { parseGraphSearch } from "@/modules/memories/graph/search";

/**
 * Memory as a graph — `/memories/graph`, beside Memory rather than inside it (`memories_`), so it has
 * the whole page. Its renderer and force layout (`@nouride/ui-graph`) arrive with it and with no other
 * page, as every route's component does now (`autoCodeSplitting` in `vite.config.ts`); this was the
 * one route split by hand, with `lazy()` and a `Suspense` of its own.
 *
 * The filter lives in the URL, so a view can be reloaded, shared, and gone back to.
 */
export const Route = createFileRoute("/memories_/graph")({
  validateSearch: (search: Record<string, unknown>): GraphSearch => parseGraphSearch(search),
  component: MemoryGraphRoute,
});

function MemoryGraphRoute() {
  const navigate = Route.useNavigate();
  return <GraphPage search={Route.useSearch()} onSearch={(next) => void navigate({ search: next, replace: true })} />;
}
