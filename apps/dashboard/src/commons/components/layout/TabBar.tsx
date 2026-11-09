/**
 * The phone's tab bar (0.8.24): Home, Chats, Work and Agents under a thumb, and More for the rest, where a phone had
 * only a menu button at the top and a drawer. It floats above the page's foot, inside the home indicator's inset, and
 * each tab is a finger's size (44px). Work carries the count of what waits for an answer, as it does in the sidebar.
 * Under it the page's own ground runs to the screen's foot, so a scrolled page does not show in the strip below the
 * bar, where a phone's browser draws its own toolbar.
 */

import { Link } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import { DAILY, isCurrent } from "@/commons/components/layout/nav";
import { useNeedsYou } from "@/commons/hooks/use-needs-you";
import { cn } from "@/commons/lib/utils";

/** How far the bar reaches up from the screen's foot: what a page or a composer stays above. */
export const TAB_BAR_SPACE = "max-lg:pb-[calc(4.75rem+env(safe-area-inset-bottom))]";
/** The same while a conversation is the whole of a phone's screen and the bar steps aside: only a tablet keeps it. */
export const PHONE_CHAT_SPACE = "md:max-lg:pb-[calc(4.75rem+env(safe-area-inset-bottom))]";

const TAB = "relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl text-xs font-medium transition-colors active:scale-95";

/** `phoneChat`: a conversation is open on a phone, the whole screen with its own way back, so the bar is not drawn there. */
export function TabBar({ pathname, more, onMore, phoneChat = false }: { pathname: string; more: boolean; onMore: () => void; phoneChat?: boolean }) {
  const { approvals, missions } = useNeedsYou();
  const waiting = approvals + missions;
  return (
    <>
    <div aria-hidden="true" className={cn("bg-app-foot pointer-events-none fixed inset-x-0 bottom-0 z-40 h-[calc(2.75rem+env(safe-area-inset-bottom))] lg:hidden", phoneChat && "max-md:hidden")} />
    <nav
      aria-label="Tabs"
      className={cn("fixed inset-x-3 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 grid grid-cols-5 gap-1 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft lg:hidden", phoneChat && "max-md:hidden")}
    >
      {DAILY.map((item) => {
        const current = !more && isCurrent(item, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            aria-current={current ? "page" : undefined}
            className={cn(TAB, current ? "bg-secondary/10 text-secondary" : "text-base-content/70")}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{item.label}</span>
            {item.to === "/work" && waiting > 0 && (
              <span className="badge badge-xs absolute top-0.5 left-1/2 ml-1.5 border-0 bg-accent px-1.5 font-mono font-semibold text-accent-content" title={`${waiting} waiting for your answer`}>
                {waiting}
              </span>
            )}
          </Link>
        );
      })}
      <button type="button" aria-expanded={more} onClick={onMore} className={cn(TAB, more ? "bg-secondary/10 text-secondary" : "text-base-content/70")}>
        <Ellipsis size={20} aria-hidden="true" />
        <span>More</span>
      </button>
    </nav>
    </>
  );
}
