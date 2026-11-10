/**
 * Where a conversation lives when it is not the dashboard's, said in words: "Telegram", "WhatsApp", "Discord", each in
 * its app's own colour (`platformTint`), a soft tint of it behind coloured words. One tag for every place an app is
 * named: after a row's name, as small as Orchestrator's pill, and beside a header's name. Never a small mark on an
 * avatar's corner: those read as noise, and a word says which app in both themes without being learnt.
 *
 * What has no app colour stays neutral: an app without one, and the words that are not an app (Read-only, Dashboard).
 *
 * A row's tag is the app alone. History's private chats said "Telegram · read-only", and on a phone the tag took the
 * room the title needed ("sip tul…"); the line under the name already says it is a private chat there, and opening it
 * says it is read-only.
 */

import type { CSSProperties } from "react";
import { platformName, platformTint } from "@/commons/lib/platform";
import { cn } from "@/commons/lib/utils";

/** After a row's name, the size of Orchestrator's pill (`RowTag`); or beside a header's name, a step larger. */
const SIZES = {
  row: "px-2 py-0.5 text-[10px] font-bold",
  header: "border px-2 py-0.5 text-[11px] font-semibold",
} as const;

/** No colour of its own. A header's keeps its outline, so Read-only reads as a note beside the app's colour. */
const NEUTRAL = {
  row: "bg-base-content/[0.07] text-base-content/75",
  header: "border-base-content/15 text-base-content/80",
} as const;

/** The app's colour on the words and a tint of it behind them; a header's outline is kept, unseen, for its height. */
const TINTED = "border-transparent text-[color:var(--tag)] [background:color-mix(in_oklab,var(--tag)_14%,transparent)]";

/** The app's name, or the words given (a header's "WhatsApp group"); with no `platform`, a neutral tag of the words. */
export function PlatformTag({ platform, size = "header", children }: { platform?: string; size?: keyof typeof SIZES; children?: string }) {
  const tint = platform ? platformTint(platform) : undefined;
  return (
    <span
      style={tint ? ({ "--tag": tint } as CSSProperties) : undefined}
      // `leading-none` after the size: merged before it, a font size takes the line height with it and the pill grows.
      className={cn("inline-flex shrink-0 items-center rounded-full whitespace-nowrap", SIZES[size], "leading-none", tint ? TINTED : NEUTRAL[size])}
    >
      {children ?? (platform ? platformName(platform) : "")}
    </span>
  );
}
