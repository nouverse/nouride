/**
 * System → Files: what Nouride keeps on this machine, to look at.
 *
 * One column at every width: where you are, then either that folder's entries or the one file its path names. The
 * path is in the address (`?path=`), so a folder or a file has a link, the browser's Back goes back a folder, and a
 * path an agent wrote in a chat opens here on the file it names. Nothing on the page changes anything: there is no
 * button to press that could.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Crumbs } from "./components/Crumbs";
import { FileView } from "./components/FileView";
import { FolderList } from "./components/FolderList";
import { parentOf } from "./lib/paths";

export default function FilesPage({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const admin = isAdmin(useMe().data ?? null);
  const listing = useQuery({ queryKey: ["system", "files", path], queryFn: () => api.systemFiles(path), retry: false, enabled: admin });

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
    <div className="space-y-6">
      <PageHeader title="Files" description="What Nouride keeps on this machine, to look at. Nothing here can be changed from this page." />
      <Card>
        <div className="space-y-4">
          <Crumbs path={read?.path ?? path} onOpen={onOpen} />
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
            <div className="space-y-3">
              <button type="button" className="btn btn-ghost btn-sm -ml-2 gap-1.5 rounded-lg" onClick={() => onOpen(parentOf(read.path))}>
                <ArrowLeft size={14} aria-hidden="true" /> Back to its folder
              </button>
              <FileView key={read.file.path} entry={read.file} />
            </div>
          ) : (
            <FolderList listing={read} onOpen={onOpen} />
          )}
        </div>
      </Card>
    </div>
  );
}
