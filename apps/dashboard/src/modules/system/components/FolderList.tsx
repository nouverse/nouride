/**
 * A folder's entries: folders first, then files, each a row to press. A file that does not open (the database) says
 * so on its row instead of opening on a refusal. Under the rows, what the list does not hold and why: entries past its
 * length, and the credentials and secrets that are never shown.
 */

import { Database, File, FileText, Folder, Image, KeyRound } from "lucide-react";
import type { SystemFolderListing } from "@nouride/wire";
import { EmptyState } from "@/commons/components/ui/ui";
import { ago, formatBytes } from "@/commons/lib/format";
import { isMarkdown, languageOf } from "../lib/paths";

function iconOf(entry: SystemFolderListing["entries"][number]) {
  if (entry.kind === "folder") return Folder;
  if (entry.closed === "database") return Database;
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(entry.name)) return Image;
  return isMarkdown(entry.name) || languageOf(entry.name) || /\.(txt|log)$/i.test(entry.name) ? FileText : File;
}

export function FolderList({ listing, onOpen }: { listing: SystemFolderListing; onOpen: (path: string) => void }) {
  return (
    <div className="space-y-3">
      {listing.entries.length === 0 ? (
        <EmptyState icon={Folder} title={listing.leftOut ? "Nothing here to show" : "This folder is empty"} className="py-8" />
      ) : (
        <ul className="divide-y divide-base-content/[0.06]">
          {listing.entries.map((entry) => {
            const Icon = iconOf(entry);
            const closed = entry.closed === "database";
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
                {closed ? (
                  <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 px-1 py-2">{row}</div>
                ) : (
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-1 py-2 text-left outline-none hover:bg-base-200/60 focus-visible:ring-2 focus-visible:ring-primary/50"
                    onClick={() => onOpen(entry.path)}
                  >
                    {row}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {listing.more > 0 ? <p className="text-xs text-base-content/65">And {listing.more.toLocaleString("en")} more here that this list does not show.</p> : null}
      {listing.leftOut ? (
        <p className="flex items-start gap-2 rounded-xl bg-base-200/50 px-3 py-2 text-xs text-base-content/65">
          <KeyRound size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          Credentials and secrets are kept private: what holds one is not listed here.
        </p>
      ) : null}
    </div>
  );
}
