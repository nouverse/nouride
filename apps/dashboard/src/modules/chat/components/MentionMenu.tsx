/**
 * Who you can address, offered while you type `@`.
 *
 * A tag is not a convenience in a room — it is the *only* way a message reaches a particular agent,
 * and the router matches an exact id or display name. So the thing a person needs from the composer
 * is the exact token, and a menu that inserts it is the difference between a room that works and one
 * where half the messages reach nobody. The engine's own prompt section makes the same point to the
 * agents: "Addressing one means writing that exact token in the message."
 *
 * Unlike a slash command, a mention is **not** anchored to the start of the message: "tolong cek ini
 * @nero" is how people write. So the token is read at the caret rather than from the first word, and
 * picking one replaces just that token.
 */

import type { Room } from "@/commons/lib/api";

export interface MentionCandidate {
  agentId: string;
  displayName: string;
  /**
   * Already working in this room, so tagging it now would be refused.
   *
   * Shown rather than hidden. A name that disappears from the list looks like an agent that left the
   * room, and the useful thing to say is "not yet" — it will answer again the moment it finishes.
   */
  busy?: boolean;
}

/**
 * The `@word` being typed at the end of the box, or null.
 *
 * Anchored to the end rather than to a caret position because the composer is a controlled textarea
 * whose caret this component does not own — and in practice a mention is typed where the cursor
 * already is, which is the end. Reading a caret we do not control would be a second source of truth
 * for "what is being typed".
 */
export function mentionToken(text: string): string | null {
  const match = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text);
  return match ? (match[1] ?? "") : null;
}

/**
 * Members whose id or display name starts with what has been typed, minus the ones already named.
 *
 * Tagging somebody twice is not a thing anybody means: the router matches a name once, and the
 * second `@nouva` is dead text that only makes the message harder to read. The menu kept offering an
 * agent that was already in the box, so picking from it twice produced `@nouva @nouva @` — which is
 * what happened, and the menu was the one suggesting it.
 *
 * The token being typed is excluded from that check, since a half-written `@no` is not yet a tag.
 */
export function matchMentions(
  room: Room,
  candidates: MentionCandidate[],
  token: string,
  /** The whole composer, so the tags already in it can be left out. */
  text = "",
): MentionCandidate[] {
  const members = new Set(room.members.map((member) => member.agentId));
  const needle = token.toLowerCase();
  const already = new Set(
    [...text.replace(/(?:^|\s)@[\p{L}\p{N}_-]*$/u, "").matchAll(/@([\p{L}\p{N}_-]+)/gu)].map(
      (match) => match[1]!.toLowerCase(),
    ),
  );
  return candidates
    .filter((candidate) => members.has(candidate.agentId))
    .filter(
      (candidate) =>
        !already.has(candidate.agentId.toLowerCase()) &&
        !already.has(candidate.displayName.toLowerCase()),
    )
    .filter(
      (candidate) =>
        !needle ||
        candidate.agentId.toLowerCase().startsWith(needle) ||
        candidate.displayName.toLowerCase().startsWith(needle),
    );
}

/**
 * The busy ones sort to the bottom, still visible.
 *
 * Keeping them in place would put an unpickable row under the highlight, which is the row Enter aims
 * at — so the most common keystroke in the menu would do nothing.
 */
export function orderMentions(candidates: MentionCandidate[]): MentionCandidate[] {
  return [...candidates].sort((a, b) => Number(a.busy ?? false) - Number(b.busy ?? false));
}

/**
 * The box after a name is chosen: the half-typed token replaced, and a trailing space.
 *
 * The space matters. Without it the next character typed extends the mention — `@nero` becomes
 * `@nerotolong` — and the router then matches nothing, which is the failure this menu exists to
 * prevent, reintroduced one keystroke later.
 */
export function applyMention(text: string, agentId: string): string {
  return `${text.replace(/(?:^|\s)@[\p{L}\p{N}_-]*$/u, (matched) =>
    matched.startsWith("@") ? `@${agentId}` : ` @${agentId}`,
  )} `;
}

export function MentionMenu({
  candidates,
  active,
  onPick,
  onHover,
}: {
  candidates: MentionCandidate[];
  active: number;
  onPick: (agentId: string) => void;
  onHover: (index: number) => void;
}) {
  if (candidates.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 max-h-56 overflow-y-auto rounded-2xl border border-base-content/[0.08] bg-base-100/95 p-1.5 shadow-lg backdrop-blur-xl">
      {candidates.map((candidate, index) => (
        <button
          key={candidate.agentId}
          type="button"
          disabled={candidate.busy}
          // `onMouseDown` rather than `onClick`: the textarea loses focus on mousedown, and a blur
          // handler that closes the menu would unmount this before a click could land.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(candidate.agentId);
          }}
          onMouseEnter={() => onHover(index)}
          className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors ${
            candidate.busy
              ? "cursor-not-allowed opacity-45"
              : index === active
                ? "bg-primary/10 text-primary"
                : "hover:bg-base-200/60"
          }`}
        >
          <span className="font-mono text-xs font-semibold">@{candidate.agentId}</span>
          <span className="truncate text-[11px] text-base-content/65">{candidate.displayName}</span>
          {candidate.busy ? (
            <span className="ml-auto shrink-0 text-[10px] font-medium text-base-content/65">
              working, ask again when it finishes
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
