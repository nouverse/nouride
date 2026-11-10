/**
 * The cat's second picture on Home, the one beside what is going on: a different one each visit, so the page a person
 * opens many times a day is not the same picture every time. The greeting's cat stays as it is; this is the one in the
 * quiet card, and the one beside what is moving.
 *
 * A moment is picked when Home is opened and held while it is: the page polls every few seconds, and a cat that
 * changed with each answer would be a slideshow. The one shown last is remembered in this browser so the next visit
 * shows another; where the browser keeps nothing, any of them.
 */

import type { Pose } from "@/commons/components/brand/Mascot";

/** With nothing waiting and nothing moving: what the cat is doing meanwhile, and the line that says so. */
export const QUIET: readonly { pose: Pose; line: string }[] = [
  { pose: "sleeping", line: "Your agents nap until something comes in." },
  { pose: "meditating", line: "All quiet. Your agents are listening for the next message." },
  { pose: "coffee", line: "A calm stretch. Nothing needs an answer." },
  { pose: "parked", line: "Parked and ready. The next message starts the ride." },
  { pose: "coffeeBreak", line: "Between rides. Your agents start again when something comes in." },
];

/** While missions move: the cat on its way, with its light on late in the evening. */
export function movingPoses(night: boolean): readonly Pose[] {
  return night ? ["nightRide", "speeding", "zoom"] : ["speeding", "wheelie", "turbo", "zoom"];
}

/**
 * Which of `count` moments to show, given the one shown last (`null` when none is remembered) and a roll in [0, 1):
 * any but the last, each as likely as another.
 */
export function nextMoment(count: number, last: number | null, roll: number): number {
  if (count <= 1) return 0;
  const repeat = last !== null && Number.isInteger(last) && last >= 0 && last < count ? last : null;
  const at = Math.min(Math.floor(roll * (repeat === null ? count : count - 1)), count - 1);
  return repeat !== null && at >= repeat ? at + 1 : at;
}

/** The moment for this visit to Home, from the set kept under `key`: picked now, and remembered as the last shown. */
export function pickMoment(key: string, count: number): number {
  const kept = `nouride.home.${key}`;
  let last: number | null = null;
  try {
    const raw = localStorage.getItem(kept);
    last = raw === null ? null : Number(raw);
  } catch {
    // A browser that keeps nothing: any moment.
  }
  const at = nextMoment(count, last, Math.random());
  try {
    localStorage.setItem(kept, String(at));
  } catch {
    // Not kept: the next visit may show this one again.
  }
  return at;
}
