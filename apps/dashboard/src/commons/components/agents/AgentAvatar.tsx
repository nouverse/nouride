/**
 * An agent's face (0.8.24): its own pixel cat, the Look it wears in the Office, head and shoulders in a soft rounded
 * tile. Every agent keeps its Look (the owner, 2026-11-08); the soft mascot is Nouride's, not an agent's.
 */

import { CatPortrait } from "@/commons/cat/CatPortrait";
import type { Look } from "@/commons/cat/look";
import { cn } from "@/commons/lib/utils";

/** The tile's tint by size: a row's 40px or a card's 56px. */
const SIZES = { sm: { tile: "size-10 rounded-[12px]", scale: 1.25 }, md: { tile: "size-14 rounded-[16px]", scale: 1.75 } } as const;

export function AgentAvatar({ look, name, size = "md", className }: { look: Look; name: string; size?: keyof typeof SIZES; className?: string }) {
  const { tile, scale } = SIZES[size];
  return (
    <span className={cn("grid shrink-0 place-items-center overflow-hidden bg-secondary/10", tile, className)}>
      <CatPortrait look={look} scale={scale} label={name} />
    </span>
  );
}
