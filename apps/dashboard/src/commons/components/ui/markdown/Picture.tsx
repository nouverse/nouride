/**
 * A picture an agent's text names (`![what it shows](address)`).
 *
 * One whose address is the picture itself (`data:`, of a kind a browser draws as a picture and nothing else) is drawn
 * at once: nothing is asked of anywhere, and a picture drawn as a picture runs nothing it holds. So is one the page
 * around it vouches for (`OwnPictures`): a mission's report naming a picture among that mission's own result files,
 * which is asked of this daemon and nowhere else. One on the web is
 * drawn once the reader presses it: its address is the agent's to write, and a page or a mail the agent read can have
 * it write one that carries what it knows away in it, to whoever keeps that address, the moment the picture is asked
 * for. Until then it is a line that says where it is from. Anything else is its words.
 */

import { createContext, useContext, useState } from "react";
import { ImageIcon } from "lucide-react";

/** What a browser draws as a picture from a `data:` address. */
const DRAWN = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;

const PICTURE = "inline-block max-h-96 max-w-full rounded-lg border border-base-content/10 bg-white align-middle";

/** Where a picture on the web is from, as its reader would say it. */
function hostOf(address: string): string {
  try {
    return new URL(address).hostname;
  } catch {
    return "";
  }
}

/**
 * The pictures the page around a text holds itself, by the name the text gives them: the address to draw one from, or
 * null for a name it does not hold. None unless a page says so, which is every chat.
 */
export const OwnPictures = createContext<(name: string) => string | null>(() => null);

export function Picture({ src, alt }: { src: string; alt: string }) {
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const own = useContext(OwnPictures)(src);
  if (own) return <img src={own} alt={alt} title={alt || undefined} className={PICTURE} data-own-picture />;
  if (DRAWN.test(src)) return <img src={src} alt={alt} title={alt || undefined} className={PICTURE} />;
  const host = /^https:\/\//i.test(src) ? hostOf(src) : "";
  if (!host) return <span>{alt}</span>;
  if (shown && !failed) return <img src={src} alt={alt} title={alt || undefined} referrerPolicy="no-referrer" className={PICTURE} onError={() => setFailed(true)} />;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-base-content/10 bg-base-200/50 px-2.5 py-1.5 align-middle text-xs" data-picture="held">
      <ImageIcon size={14} aria-hidden="true" className="shrink-0 text-base-content/65" />
      <span className="min-w-0 break-words text-base-content/80">
        {failed ? "This picture could not be shown" : alt || "A picture"} <span className="text-base-content/65">from {host}</span>
      </span>
      {!failed && (
        <button type="button" className="btn btn-xs max-sm:btn-sm rounded-lg" onClick={() => setShown(true)}>
          Show picture
        </button>
      )}
      <a href={src} target="_blank" rel="noreferrer noopener" className="link link-hover inline-flex items-center text-base-content/70 max-sm:min-h-8">
        Open in a tab
      </a>
    </span>
  );
}
