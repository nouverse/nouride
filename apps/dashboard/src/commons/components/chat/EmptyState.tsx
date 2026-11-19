/**
 * What a conversation looks like before anybody has said anything.
 *
 * Its own component because it is the one part of the page with no conversation in it — it reads a
 * name and a handful of suggestions, and nothing else on the screen. Left inline it was fifty lines
 * between the scroll container and the transcript, which is how a page stops being readable.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import type { Room } from "@nouride/wire";
import { Mascot } from "@/commons/components/brand/Mascot";
import { CatPortrait } from "@/commons/cat/CatPortrait";
import type { Look } from "@/commons/cat/look";
import { api } from "@/commons/lib/api";
import { openers, type CarriedSkill } from "./openers";

export interface EmptyStateProps {
  /** The agent the chat is with: its name in the greeting, its skills for the openers (read while this is shown). */
  agent: { id: string; displayName?: string | undefined } | undefined;
  /** The agent's cat as the Office draws it; a room, or a chat with no agent yet, shows Nouride's own. */
  look?: Look | undefined;
  /** Suggestions are for a one-to-one chat: a room has no single agent to introduce. */
  room: Room | null;
  /** Greeted by name when the daemon knows who is signed in. */
  senderName: string | undefined;
  /**
   * In a panel a phone's width at any window's (the floating chat): the openers in one column, each whole, and less air
   * around a smaller cat, so all of it is seen in the panel's height without scrolling.
   */
  narrow?: boolean;
  /** The skills themselves, given rather than read; none until they are read. */
  skills?: readonly CarriedSkill[];
  /** Which of them this chat offers first (`openers`): a new pair each time a chat opens, unless given. */
  seed?: number;
  onPick: (prompt: string) => void;
}

/** An opener as its button reads: one left for the person to finish says so. */
const shown = (prompt: string) => (prompt.endsWith(": ") ? `${prompt}…` : prompt);

export function EmptyState({ agent, look, room, senderName, narrow = false, skills, seed, onPick }: EmptyStateProps) {
  const agentName = agent?.displayName;
  const reading = !skills && !room ? agent?.id : undefined;
  const carried = useQuery({ queryKey: ["agent-skills", reading], queryFn: () => api.agentSkills(reading!), enabled: Boolean(reading), retry: false, staleTime: 60_000 });
  const [drawn] = useState(() => Math.floor(Math.random() * 1_000));
  const prompts = openers(agentName || "Agent", skills ?? carried.data?.skills ?? [], seed ?? drawn);
  return (
      // The air around it, measured in a browser with four openers: at the spacing three had, the floating panel's
      // 443 px held 452, and a phone 640 px tall scrolled 63 px on the Chats page. A wide page keeps its own.
      <div className={`flex-1 flex flex-col justify-center items-center max-w-2xl mx-auto w-full text-center my-auto ${narrow ? "space-y-3 py-3" : "space-y-3.5 py-4 sm:space-y-5 sm:py-8"}`}>
        <div className="p-3.5 rounded-2xl bg-base-100 border border-base-content/[0.08] shadow-lg shadow-primary/5">
          {look && !room ? (
            <CatPortrait look={look} scale={narrow ? 1.5 : 2} label={`${agentName ?? "The agent"}'s cat`} />
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
        <div className={`grid grid-cols-1 w-full text-left pt-1 ${narrow ? "gap-1.5" : "gap-2 sm:grid-cols-2"} ${room ? "hidden" : ""}`}>
          {prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPick(prompt)}
              className={`p-3 rounded-xl bg-base-100/80 hover:bg-base-100 hover:border-primary/40 border border-base-content/[0.08] text-sm text-base-content/85 font-medium transition-all active:scale-[0.98] shadow-xs flex min-w-0 items-center justify-between text-left group gap-2 ${narrow ? "" : "sm:text-xs"}`}
            >
              <span className={`min-w-0 ${narrow ? "" : "sm:truncate"}`}>{shown(prompt)}</span>
              <Sparkles size={13} className="text-primary/40 group-hover:text-primary transition-colors shrink-0" />
            </button>
          ))}
        </div>
      </div>
  );
}
