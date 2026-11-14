/**
 * A folder's entries: folders first, then files, each a row to press. A file that does not open (the database) says
 * so on its row instead of opening on a refusal. What agents and chats left behind has a button at its row's end that
 * deletes it, asked first. Under the rows, how many entries the list does not hold.
 */

import { Database, File, FileText, Film, Folder, Image, Music, Trash2 } from "lucide-react";
import type { SystemFileEntry, SystemFolderListing } from "@nouride/wire";
import { Spinner } from "@/commons/components/ui/Spinner";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ago, formatBytes } from "@/commons/lib/format";
import { isMarkdown, languageOf } from "../lib/paths";
import type { FileActions } from "../lib/use-file-actions";

function iconOf(entry: SystemFileEntry) {
  if (entry.kind === "folder") return Folder;
  if (entry.closed === "database") return Database;
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(entry.name)) return Image;
  if (/\.(mp4|m4v|webm|mov)$/i.test(entry.name)) return Film;
  if (/\.(mp3|wav|ogg|oga|opus|m4a)$/i.test(entry.name)) return Music;
  return isMarkdown(entry.name) || languageOf(entry.name) || /\.(txt|log|pdf)$/i.test(entry.name) ? FileText : File;
}

export function FolderList({ listing, onOpen, actions }: { listing: SystemFolderListing; onOpen: (path: string) => void; actions: FileActions }) {
  // Room for the button on every row once one row has it, so the sizes and dates stay in their columns; none where
  // nothing here can be deleted, which is most of what Nouride keeps.
  const deletes = listing.entries.some((entry) => entry.removable);
  return (
    <div className="space-y-3">
      {listing.entries.length === 0 ? (
        <EmptyState icon={Folder} title={listing.leftOut ? "Nothing here to show" : "This folder is empty"} className="py-8" />
      ) : (
        <ul className="divide-y divide-base-content/[0.06]">
          {listing.entries.map((entry) => {
            const Icon = iconOf(entry);
            const closed = entry.closed === "database";
            const deleting = actions.busy?.path === entry.path;
            const row = (
              <>
                <Icon size={16} className={`shrink-0 ${entry.kind === "folder" ? "text-secondary" : "text-base-content/50"}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 text-sm font-medium text-base-content/90 [overflow-wrap:anywhere]">{entry.name}</span>
                {closed ? <span className="shrink-0 text-xs text-base-content/65">The database: it does not open here</span> : null}
                <span className="w-16 shrink-0 text-right text-xs text-base-content/65">{entry.sizeBytes === null ? "" : formatBytes(entry.sizeBytes)}</span>
                <span className="w-24 shrink-0 text-right text-xs text-base-content/65 max-sm:hidden">{entry.modifiedAt === null ? "" : ago(entry.modifiedAt)}</span>
              </>
            );
            return (
              <li key={entry.path}>
                <div className="flex items-center gap-1">
                  {closed ? (
                    <div className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 px-1 py-2">{row}</div>
                  ) : (
                    <button
                      type="button"
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-2 text-left outline-none hover:bg-base-200/60 focus-visible:ring-2 focus-visible:ring-primary/50"
                      onClick={() => onOpen(entry.path)}
                    >
                      {row}
                    </button>
                  )}
                  {entry.removable ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-square shrink-0 rounded-lg text-base-content/65 hover:bg-error/10 hover:text-error"
                      aria-label={`Delete ${entry.name}`}
                      title="Delete"
                      disabled={actions.busy !== null}
                      onClick={() => void actions.remove(entry)}
                    >
                      {deleting ? <Spinner /> : <Trash2 size={15} aria-hidden="true" />}
                    </button>
                  ) : deletes ? (
                    <span className="size-8 shrink-0" aria-hidden="true" />
                  ) : null}
                </div>
                {actions.failed?.path === entry.path ? (
                  <div className="pb-2">
                    <ErrorNote error={actions.failed.error} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {listing.more > 0 ? <p className="text-xs text-base-content/65">And {listing.more.toLocaleString("en")} more here that this list does not show.</p> : null}
    </div>
  );
}
