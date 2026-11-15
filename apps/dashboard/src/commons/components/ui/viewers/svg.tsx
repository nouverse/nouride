/**
 * An `svg` block drawn as the picture it is.
 *
 * Through `<img>` with a `data:` address, never as markup in the page: an SVG drawn as an image runs no script, loads
 * nothing from elsewhere and reaches nothing of the dashboard, by the browser's own rule for images, and the
 * dashboard's policy already allows `data:` pictures (`img-src 'self' data: blob:`). The text an agent wrote is never
 * handed to the page to parse.
 *
 * On a white card whatever the theme: an SVG is drawn for paper, its strokes black on nothing, and would vanish on
 * the dark one. A press opens it large, as a picture sent in the chat opens. One the browser cannot draw is the code
 * it was (`onFail`).
 */

import { useMemo, useState } from "react";
import { Leaving } from "@/commons/components/ui/OverPage";
import { Lightbox } from "@/commons/components/ui/Lightbox";
import type { ViewerProps } from "@/commons/components/ui/viewers";

function svgAddress(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text.trim())}`;
}

export default function SvgPicture({ text, onFail }: ViewerProps) {
  const src = useMemo(() => svgAddress(text), [text]);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block max-w-full cursor-zoom-in rounded-lg border border-base-content/10 bg-white p-3 transition-colors hover:border-primary/40"
        aria-label="Open the picture large"
      >
        <img src={src} alt="A picture drawn from SVG" onError={onFail} className="block h-auto max-h-96 max-w-full" />
      </button>
      <Leaving value={open && src}>{(picture) => <Lightbox pictures={[{ src: picture, name: "picture.svg" }]} light onClose={() => setOpen(false)} />}</Leaving>
    </>
  );
}
