/**
 * An agent's face (0.8.24): its own pixel cat, the Look it wears in the Office, head and shoulders in a soft rounded
 * tile. Every agent keeps its Look; the soft mascot is Nouride's, not an agent's.
 *
 * With `platform`, the conversation it stands for lives on that chat app, and its mark sits on the tile's corner — the
 * same mark a group's avatar carries (`PlatformMark`).
 */

import { CatPortrait } from "@/commons/cat/CatPortrait";
import type { Look } from "@/commons/cat/look";
import { PlatformMark } from "@/commons/components/chat/PlatformBadge";
import { cn } from "@/commons/lib/utils";

/**
 * The tile by size: a stack's 24px, a chip's 32px, a row's 40px or a card's 56px. The smallest shows the middle of the
 * cat at its own pixels rather than the whole cat shrunk, where a pixel would be lost every few.
 */
const AVATAR_SIZES = {
  xxs: { tile: "size-6 rounded-[8px]", scale: 1 },
  xs: { tile: "size-8 rounded-[10px]", scale: 1 },
  sm: { tile: "size-10 rounded-[12px]", scale: 1.25 },
  md: { tile: "size-14 rounded-[16px]", scale: 1.75 },
} as const;

export function AgentAvatar({
  look,
  name,
  size = "md",
  platform,
  className,
}: {
  look: Look;
  name: string;
  size?: keyof typeof AVATAR_SIZES;
  platform?: string;
  className?: string;
}) {
  const { tile, scale } = AVATAR_SIZES[size];
  const face = (
    <span className={cn("grid shrink-0 place-items-center overflow-hidden bg-secondary/10", tile, className)}>
      <CatPortrait look={look} scale={scale} label={name} />
    </span>
  );
  if (!platform) return face;
  return (
    <span className="relative inline-grid shrink-0">
      {face}
      <PlatformMark platform={platform} className="absolute -right-1 -bottom-1" />
    </span>
  );
}
