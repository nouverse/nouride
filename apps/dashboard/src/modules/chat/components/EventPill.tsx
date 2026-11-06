/**
 * Something that happened *to* the conversation, drawn the way a chat app draws it: centred, small,
 * and clearly not anybody's message.
 *
 * WhatsApp's version of this — "Gading added Nero", "you changed the group name" — is the reference,
 * and the shape is the point. Most of what changes about a room is not something anybody typed, and
 * rendering it as a message is a lie about who said it. The dashboard already had one of these for a
 * background job waking the agent (`SystemNote` in `Turn.tsx`); this is the general case.
 *
 * The `kind` comes from the daemon rather than being guessed from the sentence, which is the one real
 * improvement over `SystemNote`: that one matches the daemon's exact wording with regexes, and its
 * own comment records why — a loose `/failed/` labelled a green test run as a failure, because the
 * text contained `0 failed`. A heading that lies about an outcome is worse than a generic one.
 */

import {
  CircleSlash,
  Hash,
  KeyRound,
  LogIn,
  Forward,
  LogOut,
  MessageSquareOff,
  MoveRight,
  RotateCw,
  StickyNote,
  Users,
} from "lucide-react";
import type { ChatEvent } from "@/commons/lib/api";
import { Markdown } from "@/commons/components/ui/Markdown";

const ICONS: Record<ChatEvent["kind"], typeof Hash> = {
  joined: LogIn,
  left: LogOut,
  topic: Hash,
  moved: MoveRight,
  dropped: MessageSquareOff,
  ambiguous: Users,
  hop_budget: CircleSlash,
  delegated: Forward,
  restart: RotateCw,
  secret: KeyRound,
  note: StickyNote,
};

/** Past this, or with a line break, an event is a card, not a pill. */
const PILL_CHARS = 160;

export function EventPill({ event }: { event: ChatEvent }) {
  const Icon = ICONS[event.kind] ?? StickyNote;
  const told = event.audience === "agents" ? <AgentsTold /> : null;

  // A line or two stays a pill. Anything longer — a mission's notice with its report — is a card with its lines and its
  // markdown kept: in a pill, a paragraph ran out past the rounded ends, its line breaks gone and its backticks shown.
  if (event.text.includes("\n") || event.text.length > PILL_CHARS) {
    return (
      <div className="flex justify-center w-full">
        <div
          className="flex w-full max-w-2xl items-start gap-2 rounded-2xl border border-base-content/[0.08] bg-base-200/60 px-4 py-3 text-base-content/75"
          data-event-kind={event.kind}
          data-shape="card"
        >
          <Icon size={13} className="mt-0.5 shrink-0 opacity-70" />
          {/* A branch name or a path is one long word: broken anywhere rather than run out of the card. */}
          <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <Markdown source={event.text} compact />
          </div>
          {told}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center w-full">
      <div
        className="inline-flex max-w-xl items-start gap-1.5 rounded-full border border-base-content/[0.08] bg-base-200/60 px-3 py-1 text-[11px] leading-snug text-base-content/65"
        // The kind is on the element rather than only in the icon, so the reason a pill looks the way
        // it does is inspectable without cross-referencing this file.
        data-event-kind={event.kind}
      >
        <Icon size={12} className="mt-0.5 shrink-0 opacity-70" />
        <span className="break-words">{event.text}</span>
        {/*
          Marked when the agents were told too, because the two are genuinely different facts about
          the same line and the difference matters to whoever is debugging a room: "did the agent
          know this?" is otherwise unanswerable from the transcript.
        */}
        {told}
      </div>
    </div>
  );
}

function AgentsTold() {
  return (
    <span
      className="shrink-0 self-center rounded-full bg-base-content/[0.06] px-1.5 text-[9px] font-semibold uppercase tracking-wider text-base-content/65 font-mono"
      title="The agents in this room were told this too, with the next message they read."
    >
      agents
    </span>
  );
}
