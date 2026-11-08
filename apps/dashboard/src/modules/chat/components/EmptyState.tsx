/**
 * What a conversation looks like before anybody has said anything.
 *
 * Its own component because it is the one part of the page with no conversation in it — it reads a
 * name and a handful of suggestions, and nothing else on the screen. Left inline it was fifty lines
 * between the scroll container and the transcript, which is how a page stops being readable.
 */

import { Sparkles } from "lucide-react";
import type { Room } from "@/commons/lib/api";
import { Mascot } from "@/commons/components/brand/Mascot";
import { CatPortrait } from "@/commons/cat/CatPortrait";
import type { Look } from "@/commons/cat/look";

export interface EmptyStateProps {
  agentName: string | undefined;
  /** The agent's cat as the Office draws it; a room, or a chat with no agent yet, shows Nouride's own. */
  look?: Look | undefined;
  /** Suggestions are for a one-to-one chat: a room has no single agent to introduce. */
  room: Room | null;
  /** Greeted by name when the daemon knows who is signed in. */
  senderName: string | undefined;
  onPick: (prompt: string) => void;
}

/**
 * The three openers offered in a fresh chat.
 *
 * In English, deliberately. They were written in Indonesian — the language this daemon's operator
 * speaks — and baked into the component, so the first thing any other user saw was a language they
 * may not read. A default in the interface language, translated properly if this ever grows one.
 */
function openers(agentName: string): string[] {
  return [
    `Hi ${agentName}, introduce yourself and tell me what you can do.`,
    "Tell me how things are running, and what is at work right now.",
    "How do I connect WhatsApp or Telegram?",
  ];
}

export function EmptyState({ agentName, look, room, senderName, onPick }: EmptyStateProps) {
  const prompts = openers(agentName || "Agent");
  return (
      <div className="flex-1 flex flex-col justify-center items-center max-w-2xl mx-auto w-full text-center space-y-5 py-8 my-auto">
        <div className="p-3.5 rounded-2xl bg-base-100 border border-base-content/[0.08] shadow-lg shadow-primary/5">
          {look && !room ? (
            <CatPortrait look={look} scale={2} label={`${agentName ?? "The agent"}'s cat`} />
          ) : (
            <Mascot pose="head" decorative className="size-12" />
          )}
        </div>
        {/*
          A room's greeting is about the room. The one below names an agent and offers
          suggested questions to ask it, which in a room is a page inviting the reader to
          address somebody it has picked for them — and the name it picked came from whichever
          agent had answered last.
        */}
        {room ? (
          <div className="space-y-1">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-base-content">
              {room.title ?? room.members.map((member) => member.agentId).join(", ")}
            </h2>
            <p className="text-sm text-base-content/65 max-w-md mx-auto leading-relaxed">
              {room.members.length === 1
                ? "One agent is in this room."
                : `${room.members.length} agents are in this room.`}{" "}
              Type to talk to the room; nobody answers unless you tag them. Tag one with{" "}
              <code className="bg-base-200 px-1 py-0.5 rounded font-mono text-[11px]">@</code>{" "}
              and they read everything said since they last spoke.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-base-content">
              {agentName || "Nouride Agent"}
            </h2>
            <p className="text-sm text-base-content/65 max-w-md mx-auto leading-relaxed">
              {senderName ? (
                <>
                  Hello <b>{senderName}</b>!{" "}
                </>
              ) : null}
              Ask a question, and it can use tools and do work on this server.
            </p>
          </div>
        )}

        {/* One column on a phone, each opener whole: in a grid track sized by its content, a cut-off line held the track
            at its full width, past the screen's edge (0.8.12). */}
        <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 w-full text-left pt-1 ${room ? "hidden" : ""}`}>
          {prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPick(prompt)}
              className="p-3 rounded-xl bg-base-100/80 hover:bg-base-100 hover:border-primary/40 border border-base-content/[0.08] text-sm text-base-content/85 font-medium transition-all active:scale-[0.98] shadow-xs flex min-w-0 items-center justify-between text-left group gap-2 sm:text-xs"
            >
              <span className="min-w-0 sm:truncate">{prompt}</span>
              <Sparkles size={13} className="text-primary/40 group-hover:text-primary transition-colors shrink-0" />
            </button>
          ))}
        </div>
      </div>
  );
}
