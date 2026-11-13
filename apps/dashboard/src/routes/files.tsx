import { createFileRoute } from "@tanstack/react-router";
import FilesPage from "@/modules/system/files.page";

/** `?path=` is where you are in the data folder: a folder, or a file to open. A link to either is this address. */
export const Route = createFileRoute("/files")({
  validateSearch: (search: Record<string, unknown>): { path: string } => ({ path: typeof search.path === "string" ? search.path : "" }),
  component: FilesRoute,
});

function FilesRoute() {
  const { path } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <FilesPage path={path} onOpen={(next) => void navigate({ search: { path: next } })} />;
}
