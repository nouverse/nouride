/**
 * The line under the title of an automation or a mission the reader only reads: whose it is, and that it is on their
 * page because it reports to a chat of theirs. It stands where the page's controls would start, so their absence
 * reads as meant.
 */

import { Eye } from "lucide-react";
import { readOnlyLine, type Owned } from "@/commons/lib/by-person";

export function ReadOnlyNote({ thing }: { thing: Owned }) {
  return (
    <p role="note" data-read-only className="flex items-start gap-2 rounded-[14px] bg-base-content/[0.04] px-3 py-2 text-sm text-base-content/80">
      <Eye size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-base-content/65" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{readOnlyLine(thing)}</span>
    </p>
  );
}
