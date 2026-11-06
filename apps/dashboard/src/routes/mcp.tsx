import { createFileRoute } from "@tanstack/react-router";
import McpLibraryPage from "@/modules/mcp/index.page";

export const Route = createFileRoute("/mcp")({
  staticData: { fillsViewport: true },
  component: RouteComponent,
  // `?install=<registry name>&agent=<id>`: the link `mcp_search` gives — Explore opened on that server's form, the
  // agent that found it ticked to switch it on.
  validateSearch: (search: Record<string, unknown>): { install?: string; agent?: string } => ({
    ...(typeof search.install === "string" && search.install ? { install: search.install } : {}),
    ...(typeof search.agent === "string" && search.agent ? { agent: search.agent } : {}),
  }),
});

function RouteComponent() {
  const { install, agent } = Route.useSearch();
  return <McpLibraryPage {...(install ? { install } : {})} {...(agent ? { agent } : {})} />;
}
