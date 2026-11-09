/**
 * "Nouride's Docker image has a new name": for a container still started from a name that stops getting updates. The
 * image says so itself, and the daemon passes it on in `/health` (`imageMovedTo`), which every page reads.
 *
 * Dismissed for the session, not for good: the move is still to be made, and the next visit says it again. The image
 * name is the one technical word on it, because it is what they have to type.
 */

import { useState } from "react";
import { X } from "lucide-react";
import { tabStorage } from "@/commons/lib/new-build";

const KEY = "nouride:image-moved-dismissed";

function dismissedFor(): string | null {
  try {
    return tabStorage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function ImageMovedBanner({ to }: { to: string }) {
  const [dismissed, setDismissed] = useState(() => dismissedFor() === to);
  if (dismissed) return null;
  const dismiss = () => {
    try {
      tabStorage()?.setItem(KEY, to);
    } catch {
      // Nowhere to remember it: gone from this page all the same.
    }
    setDismissed(true);
  };
  return (
    <div role="status" className="alert alert-info bg-info/10 text-info border-0 border-b border-info/20 rounded-none px-4 py-2 text-xs flex flex-wrap items-center gap-2 shrink-0">
      <span className="font-medium flex-1 min-w-0 [overflow-wrap:anywhere]">
        Nouride's Docker image has a new name: <span className="font-mono">{to}</span>. Switch to it before version 0.9: the old
        name stops getting updates then.
      </span>
      <button type="button" className="btn btn-ghost btn-xs btn-square text-info" onClick={dismiss} aria-label="Dismiss">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
