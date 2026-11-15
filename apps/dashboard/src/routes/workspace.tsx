import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePage } from "@/modules/agents/workspace.page";

/** `?path=` is where you are in the workspace: a folder, or a file to open. */
export const Route = createFileRoute("/workspace")({
  staticData: { fillsViewport: true },
  validateSearch: (search: Record<string, unknown>): { path: string } => ({ path: typeof search.path === "string" ? search.path : "" }),
  component: RouteComponent,
});

function RouteComponent() {
  const { path } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <WorkspacePage path={path} onOpen={(next) => void navigate({ search: { path: next } })} />;
}
