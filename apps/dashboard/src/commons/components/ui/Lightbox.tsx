/**
 * A picture opened large over the page: one sent in a chat, or one drawn from a reply's block (an `svg` block).
 */

import { useEffect } from "react";
import { Download, ExternalLink, X } from "lucide-react";
import { overPage } from "@/commons/components/ui/OverPage";

/**
 * The popup.
 *
 * Escape closes it, the backdrop closes it, and the image is capped to the viewport — a 4000px
 * screenshot that opens larger than the window is a screenshot you cannot see. The full-size copy is
 * one click further on, in a new tab.
 */
export function Lightbox({ src, name, light = false, onClose }: { src: string; name: string; /** Drawn on white whatever the theme: an SVG drawn for paper. */ light?: boolean; onClose: () => void }) {
  // A `data:` address (a picture drawn from a reply's own block) cannot be opened in a tab: the browser refuses a page
  // sent to one. It is saved; anything else is opened or saved.
  const opens = !src.startsWith("data:");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return overPage(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 backdrop-blur-sm p-4 animate-fade"
      role="dialog"
      aria-label={name}
    >
      {/* The backdrop is the close button, which is what everybody tries first. */}
      <button type="button" className="absolute inset-0 cursor-zoom-out" onClick={onClose} aria-label="Close" />

      <div className="relative z-10 max-w-[92vw] max-h-[88dvh] flex flex-col items-center gap-2 animate-enter">
        <img
          src={src}
          alt={name}
          className={`max-w-full max-h-[80dvh] rounded-xl shadow-2xl object-contain ${light ? "bg-white p-4" : "bg-base-100"}`}
        />
        <div className="flex items-center gap-2 text-[11px] text-white/80 font-mono">
          <span className="truncate max-w-[60vw]">{name}</span>
          {opens && (
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-white"
            >
              <ExternalLink size={12} /> open
            </a>
          )}
          <a href={src} download={name} className="inline-flex items-center gap-1 hover:text-white">
            <Download size={12} /> save
          </a>
        </div>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-10 btn btn-sm btn-circle bg-base-100/90 border-0"
        aria-label="Close"
      >
        <X size={16} />
      </button>
    </div>
  );
}
