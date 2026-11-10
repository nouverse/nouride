/**
 * Where a conversation lives when it is not the dashboard's, said in words: "Telegram", "WhatsApp", "Discord". After a
 * row's name in the same pill as "Orchestrator" (`RowTag`), and in a header's outlined tags. Never a small mark on an
 * avatar's corner: those read as noise, and a word says which app in both themes without being learnt.
 */

import { RowTag } from "@/commons/components/chat/ConversationRow";
import { platformName } from "@/commons/lib/platform";

/** After a row's name: the app, and for a private chat there that it is read here, not written. */
export function PlatformRowTag({ platform, readOnly = false }: { platform: string; readOnly?: boolean }) {
  return <RowTag>{readOnly ? `${platformName(platform)} · read-only` : platformName(platform)}</RowTag>;
}

/** A tag beside a header's name: where it lives, and that it is read here, not written. */
export function PlatformTag({ children }: { children: string }) {
  return <span className="inline-flex shrink-0 items-center rounded-full border border-base-content/15 px-2 py-0.5 text-[11px] font-semibold leading-none whitespace-nowrap text-base-content/80">{children}</span>;
}
