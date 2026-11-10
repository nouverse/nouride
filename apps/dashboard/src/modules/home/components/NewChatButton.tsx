/**
 * "+ Chat" on a phone (0.8.24): the main action under the thumb, floating above the tab bar, where the greeting's New
 * chat button is hidden. Only on Home: a page with a composer would have it over the composer.
 */

import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";

/** What Home leaves under its last card for the button, below a laptop's width: its height and a little air. */
export const CHAT_BUTTON_ROOM = "max-lg:pb-14";

export function NewChatButton() {
  return (
    <Link to="/chat" className="btn btn-primary fixed right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-30 h-12 gap-1.5 px-5 lg:hidden">
      <Plus size={18} aria-hidden="true" />
      Chat
    </Link>
  );
}
