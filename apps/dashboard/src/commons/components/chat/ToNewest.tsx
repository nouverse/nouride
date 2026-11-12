/**
 * The way back to the newest message, over the foot of a conversation its reader has scrolled up in.
 *
 * On the Chats page, where a conversation is months long and its end a long way down. Not in the chat that floats over
 * a page: it is a few messages tall, and a button over them would cover what is being read.
 */

import { ArrowDown } from "lucide-react";

export function ToNewest({ onPress }: { onPress: () => void }) {
  return (
    // Drawn after the conversation's box and taking no room: the button stands over the box's foot, above whatever
    // is under it (the plan, the composer), however tall that is.
    <div className="relative">
      <button
        type="button"
        onClick={onPress}
        aria-label="Go to the newest message"
        title="Newest message"
        className="btn btn-circle btn-sm absolute bottom-3 left-1/2 z-10 -translate-x-1/2 border border-base-content/[0.08] bg-base-100 text-base-content/70 shadow-soft animate-fade hover:text-base-content max-sm:size-11"
      >
        <ArrowDown size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
