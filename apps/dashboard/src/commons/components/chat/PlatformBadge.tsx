/**
 * Where a conversation lives when it is not the dashboard's: a small round mark on its avatar's corner, and a tag beside
 * its name. Drawn in the theme's own colours, never a platform's brand ones: what tells Telegram from Discord is the
 * mark's shape and the word, which a person reads in both themes.
 */

import { Gamepad2, MessageCircle, Phone, Send, type LucideIcon } from "lucide-react";
import { platformName } from "@/commons/lib/platform";
import { cn } from "@/commons/lib/utils";

/** A mark per chat app, as people picture it: Telegram's paper plane, a phone for WhatsApp, Discord's controller. */
const MARKS: Record<string, LucideIcon> = { telegram: Send, whatsapp: Phone, discord: Gamepad2 };

function markOf(platform: string): LucideIcon {
  return MARKS[platform.split(":")[0] ?? platform] ?? MessageCircle;
}

/** The round mark on an avatar's lower right corner, ringed in the surface under it so it reads as on top. */
export function PlatformMark({ platform, className }: { platform: string; className?: string }) {
  const Icon = markOf(platform);
  return (
    <span
      role="img"
      aria-label={platformName(platform)}
      className={cn("grid size-[18px] place-items-center rounded-full bg-base-100 text-base-content ring-2 ring-base-200 shadow-xs", className)}
    >
      <Icon size={10} strokeWidth={2.5} aria-hidden="true" />
    </span>
  );
}

/** A tag beside a name: where it lives, and that it is read here, not written. */
export function PlatformTag({ children }: { children: string }) {
  return <span className="inline-flex shrink-0 items-center rounded-full border border-base-content/15 px-2 py-0.5 text-[11px] font-semibold leading-none text-base-content/80">{children}</span>;
}
