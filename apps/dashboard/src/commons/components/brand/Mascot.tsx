/**
 * The mascot, one pose per state (0.8.24, the design rules § The mascot): the chibi cat in the helmet, as a picture
 * beside what it explains. Each pose means one thing and is used for that only, so a person learns them: waving is the
 * greeting, sleeping a list where nothing has happened yet, lost a page that is not there, sad with a broken plug an
 * error. `POSES` is the whole table, each pose with what it is for. At most one per view, never in a table, a form or a
 * dialog's body.
 *
 * The pictures are the 512px WebP files in `packages/shared/assets/mascot`, emitted beside the bundle and fetched only
 * by a page that draws one. Only the poses a page draws are there; the rest of the set waits in `docs/design/mascot`
 * until one is (`brand-assets.test.ts` holds every asset to code that names it). `offline` is the one built into the
 * bundle, for the screen shown while the daemon does not answer, when nothing more can be fetched from it.
 */

import wheelie from "@brand/mascot/riding/01-wheelie.webp";
import speeding from "@brand/mascot/riding/04-speeding.webp";
import delivery from "@brand/mascot/riding/08-delivery.webp";
import nightRide from "@brand/mascot/riding/09-night-ride.webp";
import coffeeBreak from "@brand/mascot/riding/11-coffee-break.webp";
import stuck from "@brand/mascot/riding/12-pushing.webp";
import turbo from "@brand/mascot/riding/19-turbo.webp";
import zoom from "@brand/mascot/riding/27-zoom.webp";
import waving from "@brand/mascot/standing/01-waving.webp";
import thumbsUp from "@brand/mascot/standing/02-thumbs-up.webp";
import ready from "@brand/mascot/standing/03-scooter-lean.webp";
import working from "@brand/mascot/standing/05-laptop.webp";
import sleeping from "@brand/mascot/standing/06-sleeping.webp";
import confused from "@brand/mascot/standing/07-confused.webp";
import coffee from "@brand/mascot/standing/09-coffee.webp";
import pointing from "@brand/mascot/standing/10-pointing.webp";
import box from "@brand/mascot/standing/11-box.webp";
import head from "@brand/mascot/standing/12-head.webp";
import coding from "@brand/mascot/standing/13-deep-work.webp";
import searching from "@brand/mascot/states/02-searching.webp";
import knowledge from "@brand/mascot/states/03-knowledge.webp";
import approved from "@brand/mascot/states/04-approved.webp";
import security from "@brand/mascot/states/05-security.webp";
import sent from "@brand/mascot/states/06-sent.webp";
import waiting from "@brand/mascot/states/07-waiting.webp";
import update from "@brand/mascot/states/08-update.webp";
import schedule from "@brand/mascot/states/09-schedule.webp";
import trophy from "@brand/mascot/states/10-trophy.webp";
import meditating from "@brand/mascot/states/11-voice.webp";
import goodNight from "@brand/mascot/states/12-good-night.webp";
import lost from "@brand/mascot/states/13-lost.webp";
import star from "@brand/mascot/states/14-star.webp";
import inspecting from "@brand/mascot/states/15-inspecting.webp";
import noSignal from "@brand/mascot/states/16-no-signal.webp";
import offline from "@brand/mascot/states/01-error.webp?inline";
import { cn } from "@/commons/lib/utils";

/**
 * Each pose, its picture and what it shows, said to whoever cannot see it. The comment over a group is what its poses
 * are for; a pose is not borrowed for something else because it looks nice there.
 */
const POSES = {
  // The greeting, by day and late at night.
  waving: [waving, "The Nouride cat, waving hello"],
  goodNight: [goodNight, "The Nouride cat, saying good night"],
  // What needs the person: an answer an agent is blocked on, and a mission that waits for one.
  pointing: [pointing, "The Nouride cat, pointing at what needs you"],
  waiting: [waiting, "The Nouride cat, holding a pocket watch"],
  // A list that fills by itself and has nothing in it yet, and one that waits for the person to make the first. Both
  // are among a quiet Home's moments too (`modules/home/moments.ts`).
  sleeping: [sleeping, "The Nouride cat, asleep"],
  ready: [ready, "The Nouride cat, standing by its scooter, ready to go"],
  // Not there: an address that leads nowhere, and something that was there and is gone.
  lost: [lost, "The Nouride cat, lost, turning a map around"],
  confused: [confused, "The Nouride cat, puzzled"],
  // An error, and a chat app not connected.
  offline: [offline, "The Nouride cat, sad beside an unplugged cable"],
  noSignal: [noSignal, "The Nouride cat, sitting under a crossed-out signal"],
  // It went well: a change saved, a mission done.
  thumbsUp: [thumbsUp, "The Nouride cat, giving a thumbs up"],
  trophy: [trophy, "The Nouride cat, holding up a trophy"],
  // It did not: a mission that failed or was stopped.
  stuck: [stuck, "The Nouride cat, pushing its scooter"],
  // Nothing waits for a yes; a search or a filter that finds nothing; a record nothing is written in yet.
  approved: [approved, "The Nouride cat, with an approval stamp"],
  searching: [searching, "The Nouride cat, searching with a magnifying glass"],
  inspecting: [inspecting, "The Nouride cat, looking closely through a magnifying glass"],
  // A page's own subject.
  knowledge: [knowledge, "The Nouride cat, reading a book"],
  security: [security, "The Nouride cat, holding a shield"],
  update: [update, "The Nouride cat, with a wrench, updating"],
  schedule: [schedule, "The Nouride cat, holding a calendar"],
  star: [star, "The Nouride cat, holding a star"],
  sent: [sent, "The Nouride cat, throwing a paper plane"],
  box: [box, "The Nouride cat, carrying a box"],
  delivery: [delivery, "The Nouride cat, delivering a box on its scooter"],
  coding: [coding, "The Nouride cat, at a laptop with headphones on"],
  // An agent at work on something long.
  working: [working, "The Nouride cat, typing on a laptop"],
  // On its way: the dashboard loading, and Home while missions move (`modules/home/moments.ts`).
  speeding: [speeding, "The Nouride cat, riding fast on its scooter"],
  wheelie: [wheelie, "The Nouride cat, doing a wheelie on its scooter"],
  turbo: [turbo, "The Nouride cat, riding at full speed"],
  zoom: [zoom, "The Nouride cat, riding past"],
  nightRide: [nightRide, "The Nouride cat, riding at night with its light on"],
  // A quiet Home, between one thing and the next (`modules/home/moments.ts`).
  meditating: [meditating, "The Nouride cat, sitting cross-legged with headphones on"],
  coffee: [coffee, "The Nouride cat, holding a coffee"],
  coffeeBreak: [coffeeBreak, "The Nouride cat, having a coffee on its scooter"],
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
