/**
 * A page an agent wrote, looked at: the `html` block of a reply or an `.html` file, in a frame over the page.
 *
 * The frame's address is the daemon's preview route, which serves the page under a policy of its own
 * (`routes/preview.ts` in the engine): it reaches nothing, reads nothing of the dashboard and cannot move the page
 * around it. The frame is sandboxed here too, so the same holds whatever answers at that address.
 *
 * Opened by a press and never by itself: a page somebody else wrote does not run because a message was scrolled
 * past. On white whatever the theme, as a page with no colours of its own is in any browser.
 */

import { useEffect } from "react";
import { ExternalLink, X } from "lucide-react";
import { overPage } from "@/commons/components/ui/OverPage";

const BUTTON = "btn btn-ghost h-10 min-h-10 gap-1.5 rounded-xl px-3 text-[13px] font-semibold text-base-content/80";

export function HtmlPreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return overPage(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-2 backdrop-blur-sm animate-fade sm:p-4" role="dialog" aria-label={`Preview of ${name}`}>
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close" onClick={onClose} />
      <div className="relative z-10 flex h-[90dvh] w-full max-w-[76rem] flex-col overflow-hidden rounded-2xl border border-base-content/10 bg-base-100 shadow-2xl animate-enter">
        <div className="flex shrink-0 items-center gap-1 border-b border-base-content/[0.08] py-1.5 pr-1.5 pl-4">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-base-content/70">{name}</span>
          {/* In a tab it is under the same policy: the daemon sends it with the page, whatever frames it. */}
          <a href={src} target="_blank" rel="noopener noreferrer" className={BUTTON}>
            <ExternalLink size={15} aria-hidden="true" />
            <span className="max-sm:hidden">Open in a tab</span>
            <span className="sr-only sm:hidden">Open in a tab</span>
          </a>
          <button type="button" className={`${BUTTON} w-10 px-0`} aria-label="Close the preview" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <iframe src={src} title={`Preview of ${name}`} sandbox="allow-scripts" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" />
      </div>
    </div>,
  );
}
