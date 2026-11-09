/**
 * Where the box to write in would be, for a conversation that lives on a chat app: a calm note that it is read here and
 * answered there. In place of the composer rather than a composer turned off, so nothing invites a message that could
 * not be sent.
 */

import { Lock } from "lucide-react";
import { platformName } from "@/commons/lib/platform";

/** `kind`: "chat" for a private chat, which one agent answers; else what the app calls a group ("group", "channel"). */
export function ReadOnlyNote({ platform, kind }: { platform: string; kind: string }) {
  const app = platformName(platform);
  return (
    // Its foot clear of a phone's home indicator, as the composer's is.
    <div className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      <div role="note" className="mx-auto flex max-w-3xl items-center gap-3 rounded-[20px] border border-dashed border-base-content/15 bg-base-100/60 px-4 py-3.5 text-sm text-base-content/70">
        <Lock size={16} className="shrink-0 text-base-content/65" aria-hidden="true" />
        <span>
          Read-only here. This {kind} lives on {app}: write there, and {kind === "chat" ? "the agent answers" : "the agents answer"} there.
        </span>
      </div>
    </div>
  );
}
