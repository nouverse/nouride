/**
 * A folder of what Nouride keeps, to walk: where you are, then that folder's entries or the one file the path names,
 * with a file's download and what may be deleted. One component wherever files are shown: System's Files over all of
 * it, an agent's Workspace tab over that agent's own folder, the Workspace tab over the agents' workspace.
 *
 * `root` holds the view to one folder: it opens there, its way back ends there, and a path outside it is shown as the
 * folder itself. The server holds it too (`?root=`). `only` names the entries shown at the root alone: the Workspace
 * tab goes into `private` and `shared` and lists nothing else that happens to be kept beside them.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "@/commons/lib/api";
import { ErrorNote } from "@/commons/components/ui/ui";
import { ScrollArea } from "@/commons/components/ui/ScrollCard";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { heldTo, parentOf, type FilesRoot } from "@/commons/lib/files/paths";
import { useFileActions } from "@/commons/lib/files/use-file-actions";
import { Crumbs } from "./Crumbs";
import { FileView } from "./FileView";
import { FolderList } from "./FolderList";

export function FilesBrowser({ path: asked, onOpen, root, only }: { path: string; onOpen: (path: string) => void; root?: FilesRoot | undefined; only?: readonly string[] | undefined }) {
  const path = heldTo(asked, root);
  const listing = useQuery({ queryKey: ["system", "files", path, root?.path ?? ""], queryFn: () => api.systemFiles(path, root?.path), retry: false });
  // An open file that is deleted leaves nothing to show: back to the folder it was in. A row's stays where it is.
  const actions = useFileActions((entry) => {
    if (entry.path === path) onOpen(parentOf(entry.path));
  });
  const read = listing.data;
  const top = root?.path ?? "";
  // At the folder the view is held to, only the entries it names; below it, everything there.
  const shown = read && only && read.path === top ? { ...read, entries: read.entries.filter((entry) => only.includes(entry.name)), more: 0 } : read;
  return (
    <div className="flex min-h-0 flex-col gap-4 lg:flex-1" data-files-browser>
      <div className="shrink-0">
        <Crumbs path={read?.path ?? path} onOpen={onOpen} root={root} />
      </div>
      {listing.error ? (
        <div className="space-y-3">
          <ErrorNote error={listing.error} />
          {path !== top ? (
            <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-lg" onClick={() => onOpen(top)}>
              <ArrowLeft size={14} aria-hidden="true" /> Back to {root?.name ?? "Nouride's files"}
            </button>
          ) : null}
        </div>
      ) : !shown ? (
        <ListLoading />
      ) : shown.file ? (
        <FileView key={shown.file.path} entry={shown.file} actions={actions} onBack={() => onOpen(parentOf(shown.path))} />
      ) : (
        <ScrollArea fill className="lg:-mr-6 lg:pr-6">
          <FolderList listing={shown} onOpen={onOpen} actions={actions} />
        </ScrollArea>
      )}
      {actions.dialog}
    </div>
  );
}
