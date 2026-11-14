/**
 * System → Files: what Nouride keeps on this machine, to look at, keep a copy of, and clear of what agents and chats
 * left behind.
 *
 * One column at every width: where you are, then either that folder's entries or the one file its path names. The
 * path is in the address (`?path=`), so a folder or a file has a link, the browser's Back goes back a folder, and a
 * path an agent wrote in a chat opens here on the file it names.
 *
 * From a laptop's width up the page is held to the window (`fillsViewport`): its title, its tabs and where you are
 * stay, and the list or the file scrolls inside the card. A folder of five hundred entries was a page five hundred
 * rows long, with the way back to its folder scrolled away. On a phone it scrolls as a document, as every page does.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { FILL_PAGE, ScrollArea } from "@/commons/components/ui/ScrollCard";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Crumbs } from "./components/Crumbs";
import { FileView } from "./components/FileView";
import { FolderList } from "./components/FolderList";
import { parentOf } from "./lib/paths";
import { useFileActions } from "./lib/use-file-actions";

export default function FilesPage({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const admin = isAdmin(useMe().data ?? null);
  const listing = useQuery({ queryKey: ["system", "files", path], queryFn: () => api.systemFiles(path), retry: false, enabled: admin });
  // An open file that is deleted leaves nothing to show: back to the folder it was in. A row's stays where it is.
  const actions = useFileActions((entry) => {
    if (entry.path === path) onOpen(parentOf(entry.path));
  });

  if (!admin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Files" />
        <Card>
          <EmptyState pose="searching" title="For an admin" description="The files Nouride keeps are an admin's to look at." />
        </Card>
      </div>
    );
  }

  const read = listing.data;
  return (
    <div className={FILL_PAGE}>
      <PageHeader title="Files" description="What Nouride keeps on this machine. What agents and chats left behind can be deleted here; the rest is to look at." />
      <Card className="lg:flex lg:min-h-[22rem] lg:flex-1 lg:flex-col" bodyClassName="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        <div className="flex min-h-0 flex-col gap-4 lg:flex-1">
          <div className="shrink-0">
            <Crumbs path={read?.path ?? path} onOpen={onOpen} />
          </div>
          {listing.error ? (
            <div className="space-y-3">
              <ErrorNote error={listing.error} />
              {path !== "" ? (
                <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-lg" onClick={() => onOpen("")}>
                  <ArrowLeft size={14} aria-hidden="true" /> Back to Nouride's files
                </button>
              ) : null}
            </div>
          ) : !read ? (
            <ListLoading />
          ) : read.file ? (
            <FileView key={read.file.path} entry={read.file} actions={actions} onBack={() => onOpen(parentOf(read.path))} />
          ) : (
            <ScrollArea fill className="lg:-mr-6 lg:pr-6">
              <FolderList listing={read} onOpen={onOpen} actions={actions} />
            </ScrollArea>
          )}
        </div>
      </Card>
      {actions.dialog}
    </div>
  );
}
