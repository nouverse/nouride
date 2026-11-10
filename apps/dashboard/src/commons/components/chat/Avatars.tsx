/**
 * The faces of a conversation with more than one agent in it, in the same tiles as one agent's (`AgentAvatar`): a room's
 * members stacked in one tile's square, a group's agents in a short row, and a group's own face, its initials. Which app
 * a group lives on is said in words beside its name (`PlatformTag`), not marked on its face.
 */

import type { Look } from "@/commons/cat/look";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { cn } from "@/commons/lib/utils";

export interface Face {
  id: string;
  name: string;
  look: Look;
}

/** Where each of up to three faces sits in a 40px square: one alone, two across the diagonal, three as a triangle. */
const STACK: Record<number, string[]> = {
  2: ["left-0 top-0", "right-0 bottom-0"],
  3: ["left-0 top-0", "right-0 top-2", "left-1.5 bottom-0"],
};

/** A room's members in one tile's place: the first three, each ringed in the list's own surface so they read apart. */
export function StackedAvatars({ faces, className }: { faces: Face[]; className?: string }) {
  const shown = faces.slice(0, 3);
  if (shown.length <= 1) {
    const only = shown[0];
    return only ? <AgentAvatar look={only.look} name={only.name} size="sm" className={className} /> : <span className={cn("size-10 shrink-0 rounded-[12px] bg-base-200", className)} />;
  }
  return (
    <span role="img" aria-label={faces.map((face) => face.name).join(", ")} className={cn("relative size-10 shrink-0", className)}>
      {shown.map((face, at) => (
        <span key={face.id} aria-hidden="true" className={cn("absolute rounded-[9px] bg-base-100 ring-2 ring-base-100", STACK[shown.length]![at])}>
          <AgentAvatar look={face.look} name="" size="xxs" />
        </span>
      ))}
    </span>
  );
}

/** A group's agents, small and overlapping, after its last line: three at most, and how many more. */
export function MiniAvatars({ faces }: { faces: Face[] }) {
  const shown = faces.slice(0, 3);
  const more = faces.length - shown.length;
  return (
    <span role="img" aria-label={`Agents here: ${faces.map((face) => face.name).join(", ")}`} className="flex shrink-0 items-center">
      {shown.map((face, at) => (
        <span key={face.id} aria-hidden="true" className={cn("rounded-[9px] bg-base-100 ring-2 ring-base-100", at > 0 && "-ml-2")}>
          <AgentAvatar look={face.look} name="" size="xxs" />
        </span>
      ))}
      {more > 0 ? (
        <span aria-hidden="true" className="-ml-2 grid h-6 min-w-6 place-items-center rounded-[9px] bg-base-200 px-1 text-[10px] font-bold text-base-content/80 ring-2 ring-base-100">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/** A name's initials: the first letters of its first two words, or a channel's `#`. */
function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith("#")) return "#";
  const words = trimmed.split(/[\s·_-]+/).filter((word) => /\p{L}|\p{N}/u.test(word));
  const letters = words.slice(0, 2).map((word) => [...word.replace(/[^\p{L}\p{N}]/gu, "")][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

/** A person in a conversation on a chat app: their initials in a circle, where an agent has its cat. */
export function PersonAvatar({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-base-200 font-display text-xs font-medium text-base-content/80 sm:size-8">
      {initials(name)}
    </span>
  );
}

/** A group's own face: its initials in a tile. */
export function GroupAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("grid size-10 shrink-0 place-items-center rounded-[12px] bg-base-200 font-display text-sm font-medium text-base-content/80", className)}>
      {initials(name)}
    </span>
  );
}
