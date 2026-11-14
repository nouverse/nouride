/**
 * Where you are in the data folder: each folder on the way a press back to it, the last one where you are. A view held
 * to one folder (`root`) starts there and names it: nothing above it is on the way, so nothing above it is a press away.
 */

import { ChevronRight, FolderOpen } from "lucide-react";
import { crumbsUnder, type FilesRoot } from "@/commons/lib/files/paths";

export function Crumbs({ path, onOpen, root }: { path: string; onOpen: (path: string) => void; root?: FilesRoot | undefined }) {
  const crumbs = crumbsUnder(path, root);
  const top = root?.name ?? "Nouride's files";
  const step = "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:min-h-8";
  return (
    <nav aria-label="Where you are" className="flex flex-wrap items-center gap-x-0.5 gap-y-1">
      {crumbs.length === 0 ? (
        <span aria-current="page" className={`${step} font-semibold text-base-content`}>
          <FolderOpen size={15} aria-hidden="true" /> {top}
        </span>
      ) : (
        <button type="button" className={`${step} font-medium text-primary hover:bg-base-200/60`} onClick={() => onOpen(root?.path ?? "")}>
          <FolderOpen size={15} aria-hidden="true" /> {top}
        </button>
      )}
      {crumbs.map((crumb, index) => (
        <span key={crumb.path} className="inline-flex min-w-0 items-center gap-0.5">
          <ChevronRight size={14} className="shrink-0 text-base-content/40" aria-hidden="true" />
          {index === crumbs.length - 1 ? (
            <span aria-current="page" className={`${step} min-w-0 font-semibold text-base-content [overflow-wrap:anywhere]`}>
              {crumb.name}
            </span>
          ) : (
            <button type="button" className={`${step} min-w-0 font-medium text-primary hover:bg-base-200/60 [overflow-wrap:anywhere]`} onClick={() => onOpen(crumb.path)}>
              {crumb.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
