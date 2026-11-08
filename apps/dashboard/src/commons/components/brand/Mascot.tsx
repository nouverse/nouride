/**
 * The mascot, one pose per state (0.8.24, the design rules § The mascot): the chibi cat in the helmet, as a picture
 * beside what it explains. Each pose means one thing and is used for that only, so a person learns them: waving is the
 * greeting, sleeping an empty list, confused a page that is not there, sad with a broken plug an error. At most one per
 * view, never in a table, a form or a dialog's body.
 *
 * The pictures are the 512px WebP files in `packages/shared/assets/mascot`, emitted beside the bundle and fetched only
 * by a page that draws one. Only the poses a page draws are there; the rest of the set waits in `docs/design/mascot`
 * until one is (`brand-assets.test.ts` holds every asset to code that names it). `offline` is the one built into the bundle, for the screen shown while the daemon does not
 * answer, when nothing more can be fetched from it.
 */

import waving from "@brand/mascot/standing/01-waving.webp";
import thumbsUp from "@brand/mascot/standing/02-thumbs-up.webp";
import sleeping from "@brand/mascot/standing/06-sleeping.webp";
import confused from "@brand/mascot/standing/07-confused.webp";
import pointing from "@brand/mascot/standing/10-pointing.webp";
import head from "@brand/mascot/standing/12-head.webp";
import searching from "@brand/mascot/states/02-searching.webp";
import knowledge from "@brand/mascot/states/03-knowledge.webp";
import approved from "@brand/mascot/states/04-approved.webp";
import security from "@brand/mascot/states/05-security.webp";
import update from "@brand/mascot/states/08-update.webp";
import schedule from "@brand/mascot/states/09-schedule.webp";
import goodNight from "@brand/mascot/states/12-good-night.webp";
import offline from "@brand/mascot/states/01-error.webp?inline";
import { cn } from "@/commons/lib/utils";

/** Each pose, its picture and what it shows, said to whoever cannot see it. */
const POSES = {
  waving: [waving, "The Nouride cat, waving hello"],
  goodNight: [goodNight, "The Nouride cat, saying good night"],
  pointing: [pointing, "The Nouride cat, pointing at what needs you"],
  sleeping: [sleeping, "The Nouride cat, asleep"],
  confused: [confused, "The Nouride cat, puzzled"],
  offline: [offline, "The Nouride cat, sad beside an unplugged cable"],
  thumbsUp: [thumbsUp, "The Nouride cat, giving a thumbs up"],
  approved: [approved, "The Nouride cat, with an approval stamp"],
  searching: [searching, "The Nouride cat, searching with a magnifying glass"],
  knowledge: [knowledge, "The Nouride cat, reading a book"],
  security: [security, "The Nouride cat, holding a shield"],
  update: [update, "The Nouride cat, with a wrench, updating"],
  schedule: [schedule, "The Nouride cat, holding a calendar"],
  head: [head, "Nouride"],
} as const;

export type Pose = keyof typeof POSES;

/**
 * A pose, sized by `className` (a width; the pictures are square). `decorative` where the words beside it already say
 * everything, so a screen reader does not read the picture as well.
 */
export function Mascot({ pose, className, decorative = false }: { pose: Pose; className?: string; decorative?: boolean }) {
  const [src, alt] = POSES[pose];
  return (
    <img
      src={src}
      alt={decorative ? "" : alt}
      aria-hidden={decorative || undefined}
      width={512}
      height={512}
      draggable={false}
      loading={pose === "offline" ? undefined : "lazy"}
      className={cn("pointer-events-none aspect-square h-auto shrink-0 select-none object-contain", className)}
    />
  );
}
