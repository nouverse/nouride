/**
 * Pictures opened large over the page: those sent in one message, as a gallery, or one drawn from a reply's block (an
 * `svg` block).
 *
 * Escape closes it, the backdrop closes it, and a picture is capped to the viewport: a 4000px screenshot that opens
 * larger than the window is a screenshot you cannot see. The full-size copy is one press further on, in a new tab.
 *
 * Several pictures, a carousel an agent made above all, are one set: the arrow keys, the two buttons beside the picture
 * and a swipe sideways go to the next and the one before, and the count says where in the set this one is. It stops
 * at either end rather than going round: a set of slides has a first and a last.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { overPage } from "@/commons/components/ui/OverPage";

export interface Picture {
  src: string;
  name: string;
}

/** How far a finger goes sideways, more than up or down, for a swipe to turn the picture. */
const SWIPE_PX = 48;

const SIDE = "absolute top-1/2 z-10 -translate-y-1/2 btn btn-circle bg-base-100/90 border-0 disabled:opacity-0 max-sm:btn-sm";

export function Lightbox({ pictures, at = 0, light = false, onClose }: { pictures: Picture[]; at?: number; /** Drawn on white whatever the theme: an SVG drawn for paper. */ light?: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(Math.min(Math.max(at, 0), pictures.length - 1));
  const picture = pictures[index]!;
  const many = pictures.length > 1;
  const go = (step: number) => setIndex((now) => Math.min(Math.max(now + step, 0), pictures.length - 1));
  const touch = useRef<{ x: number; y: number } | null>(null);
  /** A swipe just turned the picture: the click the finger's lift may still make is not a press on the backdrop. */
  const swiped = useRef(false);
  // A `data:` address (a picture drawn from a reply's own block) cannot be opened in a tab: the browser refuses a page
  // sent to one. It is saved; anything else is opened or saved.
  const opens = !picture.src.startsWith("data:");
  // A picture drawn from a block is a drawing with no pixels of its own: it is opened as wide as the window lets it,
  // where a photo is opened at its own size. At its own size a small diagram opened "large" was as small as before.
  const drawing = picture.src.startsWith("data:image/svg+xml");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `go` reads only the set's length, which a gallery keeps while it is open.
  }, [onClose, pictures.length]);

  return overPage(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 backdrop-blur-sm p-4 animate-fade touch-pan-y touch-pinch-zoom"
      role="dialog"
      aria-label={picture.name}
      onPointerDown={(event) => {
        swiped.current = false;
        touch.current = event.pointerType === "mouse" ? null : { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const from = touch.current;
        touch.current = null;
        if (!from || !many) return;
        const dx = event.clientX - from.x;
        if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(event.clientY - from.y)) {
          swiped.current = true;
          go(dx < 0 ? 1 : -1);
        }
      }}
      onPointerCancel={() => {
        touch.current = null;
      }}
    >
      {/* The backdrop is the close button, which is what everybody tries first. */}
      <button
        type="button"
        className="absolute inset-0 cursor-zoom-out"
        onClick={() => {
          if (swiped.current) swiped.current = false;
          else onClose();
        }}
        aria-label="Close"
      />

      <div className="relative z-10 max-w-[92vw] max-h-[88dvh] flex flex-col items-center gap-2 animate-enter">
        <img
          key={picture.src}
          src={picture.src}
          alt={picture.name}
          draggable={false}
          className={`max-w-full max-h-[80dvh] rounded-xl shadow-2xl object-contain select-none ${drawing ? "w-[min(92vw,64rem)]" : ""} ${light ? "bg-white p-4" : "bg-base-100"}`}
        />
        <div className="flex items-center gap-2 text-[11px] text-white/80 font-mono">
          {many && (
            <span className="shrink-0 tabular-nums" aria-live="polite">
              {index + 1} / {pictures.length}
            </span>
          )}
          <span className="truncate max-w-[60vw]">{picture.name}</span>
          {opens && (
            <a href={picture.src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-white">
              <ExternalLink size={12} /> open
            </a>
          )}
          <a href={picture.src} download={picture.name} className="inline-flex items-center gap-1 hover:text-white">
            <Download size={12} /> save
          </a>
        </div>
      </div>

      {many && (
        <>
          <button type="button" className={`${SIDE} left-3`} onClick={() => go(-1)} disabled={index === 0} aria-label="The picture before">
            <ChevronLeft size={18} />
          </button>
          <button type="button" className={`${SIDE} right-3`} onClick={() => go(1)} disabled={index === pictures.length - 1} aria-label="The next picture">
            <ChevronRight size={18} />
          </button>
        </>
      )}

      <button type="button" onClick={onClose} className="absolute top-4 right-4 z-10 btn btn-sm btn-circle bg-base-100/90 border-0" aria-label="Close">
        <X size={16} />
      </button>
    </div>,
  );
}
