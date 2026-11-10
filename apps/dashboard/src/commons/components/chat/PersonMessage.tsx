/**
 * What a person said in a conversation that lives on a chat app: on the left, under their name, beside their initials.
 * The right-hand bubble is the one reading's own words, and in a group on Telegram or a private chat on Discord the
 * one reading said none of them — drawn there, every person in the group read as "you".
 */

import type { ReactNode } from "react";
import { PersonAvatar } from "@/commons/components/chat/Avatars";
import { FACE_GAP } from "@/commons/components/chat/AgentReply";
import { TaggedText } from "@/commons/components/chat/AgentTag";

export function PersonMessage({
  name,
  text,
  files,
  children,
  motion = "",
}: {
  name: string | undefined;
  text: string;
  /** What they sent with it, above the words, as the reader's own bubble draws its files. */
  files?: ReactNode;
  /** Under the words: a mark that it was edited. */
  children?: ReactNode;
  motion?: string;
}) {
  const who = name?.trim() || "Someone";
  return (
    <div className={`flex w-full items-start ${FACE_GAP} origin-top-left ${motion}`} data-person={who}>
      <PersonAvatar name={who} />
      <div className="flex min-w-0 max-w-[85%] flex-col items-start gap-1 sm:max-w-[75%]">
        <span className="max-w-full truncate text-xs font-semibold text-base-content/80">{who}</span>
        {files}
        {text ? (
          <div className="max-w-full rounded-2xl rounded-tl-xs border border-base-content/[0.06] bg-base-200/70 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-base-content [overflow-wrap:anywhere]">
            <TaggedText text={text} />
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
