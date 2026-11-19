/**
 * The way out to Nouride Home's own screen from a page that has no header: the sign-in, the welcome, the setup and a
 * connector's sign-in coming back. Inside the app only (`home-app.ts`), and nothing outside it.
 *
 * These pages are gates: until each is done the dashboard sends every other page back to it, so there is no page
 * before them to go back to. It is therefore a named button, not a bare back chevron, and it is a row of the page's own
 * content: the first row of the page's card, or the top of the setup's column. A chevron held to the window's corner
 * stood over nothing and beside nothing, and lay over the page when it scrolled.
 */

import { ChevronLeft } from "lucide-react";
import { HOME_APP_BACK, inHomeApp } from "@/commons/lib/home-app";
import { cn } from "@/commons/lib/utils";

export function HomeAppLeave({ className }: { className?: string }) {
  if (!inHomeApp()) return null;
  return (
    // Pulled left by its own padding, so its chevron stands on the card's edge of text and not a button's width in.
    <a href={HOME_APP_BACK} data-home-app-leave className={cn("btn btn-ghost btn-sm -ml-2.5 flex w-fit gap-1 px-2.5 font-medium text-base-content/65 hover:text-base-content", className)} aria-label="Back to Nouride Home">
      <ChevronLeft size={16} aria-hidden="true" />
      Nouride Home
    </a>
  );
}
