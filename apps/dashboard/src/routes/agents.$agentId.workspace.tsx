import { createFileRoute } from "@tanstack/react-router";
import AgentWorkspacePage from "@/modules/agents/workspace.page";

/** `?path=` is where you are in the agent's folder: a folder, or a file to open. */
export const Route = createFileRoute("/agents/$agentId/workspace")({
  validateSearch: (search: Record<string, unknown>): { path: string } => ({ path: typeof search.path === "string" ? search.path : "" }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agentId } = Route.useParams();
  const { path } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AgentWorkspacePage agentId={agentId} path={path} onOpen={(next) => void navigate({ search: { path: next } })} />;
}
