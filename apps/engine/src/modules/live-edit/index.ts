/**
 * Live edit: an agent changes what a person has open on a dashboard page, in place.
 *
 * A person has an automation open, half changed, and asks the agent in the chat over that page to change it some
 * more. Before this the agent had one way: propose a change to the saved job, which was not what the page showed, and
 * which the page then refused to draw until the person's own changes were saved or thrown away.
 *
 * Three steps, the same for every kind of thing a page may hold open:
 *
 * 1. The page sends what it holds with each message written from it (`LiveEdit`, on `MessageEnvelope.page`).
 * 2. The turn is told so, with the thing in the words of the tool that writes it (`note`), once for each form it
 *    takes: the page sends it with every message, and said again each time a long conversation would hold it over
 *    and over.
 * 3. The tool, asked to change it, hands its change here (`propose`) where it would have stored one. The change is
 *    held in memory, its id goes out on the call's `tool_done`, and the page fetches it, draws it over what it holds,
 *    and waits for the person to apply it. Nothing is stored and nothing is turned on: what the page holds is the
 *    browser's, and saving it is the person's own act with their own rights.
 *
 * A kind is what one sort of thing needs said (`LiveEditKind`). Automations are the first, declared where they live
 * (`cron/open-automation.ts`) and handed in at boot: this module knows no kind of its own.
 */

import { sha256Text } from "@nouride/runtime";
import { newId, type ChatMessage, type LiveEdit } from "@nouride/shared";

/** One sort of thing a page may hold open for an agent to change. */
export interface LiveEditKind {
  /** The tool that writes a change to it, by name. */
  tool: string;
  /** What it is called in a sentence: "automation". */
  noun: string;
  /**
   * What is open, as the tool that writes it would take it: read by the turn, and written back whole with the change
   * made. Null where the page's value is not one of this kind at all.
   */
  said: (open: LiveEdit, who: { agentId: string }) => Record<string, unknown> | null;
  /** How the tool is told that a call changes what is open, and not something else: a sentence of the note. */
  how: string;
}

/** A change an agent wrote to what a page holds open, as the page is handed it. */
export interface LiveEditOffer {
  id: string;
  kind: string;
  /** Which one it changes, by its id; null for one being made. */
  target: string | null;
  /** The thing as it would be with the change made, in the shape its page draws. */
  value: unknown;
  /** The agent that wrote it. */
  by: string;
  /** The conversation it was asked in, and who asked: whose it is to fetch. */
  gatewayId: string;
  chatId: string;
  senderId: string;
  at: number;
}

/**
 * The most of a thing that is said to a model, in characters of its JSON: about twelve thousand tokens, an estimate.
 * An automation of fifteen steps with a script in each is well under it; a page that holds more is said to be too
 * long, never cut, since a thing cut is written back cut.
 */
export const LIVE_EDIT_MAX_CHARS = 48_000;

/**
 * How many changes are held, and for how long. Starting bounds, not measured: a change is fetched the moment its call
 * ends, and held on so its card in the chat can draw it again while the person looks at something else.
 */
const HELD_MAX = 100;
const HELD_FOR_MS = 24 * 60 * 60_000;

/** Where a note says which form of the thing it showed, so the next message with the same one does not show it again. */
const SHOWN = (print: string) => `[shown ${print}]`;

const NOT_SAVED = "It is NOT saved: this is the page's own copy, as it stands now, with whatever they have changed on it.";

export class LiveEdits {
  private readonly held = new Map<string, LiveEditOffer>();

  constructor(
    private readonly kinds: Readonly<Record<string, LiveEditKind>>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a page's kind is one an agent can change in place here. */
  knows(kind: string): boolean {
    return Object.hasOwn(this.kinds, kind);
  }

  /**
   * What a turn is told of what its message's page holds open: the thing in its tool's words and how to change it, or,
   * where this conversation already holds that very form of it, one line saying it is unchanged. Null for a page that
   * holds nothing an agent changes in place.
   */
  note(open: LiveEdit | undefined, history: readonly ChatMessage[], who: { agentId: string }): string | null {
    if (!open || !this.knows(open.kind)) return null;
    const kind = this.kinds[open.kind]!;
    const which = open.id === null ? `a new ${kind.noun}, not made yet` : `this ${kind.noun}`;
    if (open.tooLong !== undefined) {
      return (
        `(On that page the person has ${which} open and is changing it. It is too long to show here (${open.tooLong} characters, ` +
        `the most is ${LIVE_EDIT_MAX_CHARS}), so you cannot change it from this chat. Say so in one line: they change it on the page itself.)`
      );
    }
    const said = kind.said(open, who);
    if (!said) return null;
    const text = JSON.stringify(said, null, 1);
    const print = sha256Text(`${open.kind}\n${open.id ?? ""}\n${text}`).slice(0, 10);
    const told = history.some((message) => message.role === "user" && textOf(message.content).includes(SHOWN(print)));
    if (told) return `(On that page the person still has ${which} open, as it was shown to you above ${SHOWN(print)}. ${kind.how})`;
    return [
      `(On that page the person has ${which} open and is changing it. ${NOT_SAVED} ${SHOWN(print)}`,
      kind.how,
      "```json",
      text,
      "```)",
    ].join("\n");
  }

  /**
   * A tool's change to what is open, held for its page: the id its `tool_done` carries. What a tool calls where it
   * would otherwise store what it wrote.
   */
  propose(offer: Omit<LiveEditOffer, "id" | "at">): string {
    this.sweep();
    const id = newId("edit");
    this.held.set(id, { ...offer, id, at: this.now() });
    // The oldest goes once there are too many: a `Map` keeps the order they were put in.
    while (this.held.size > HELD_MAX) this.held.delete(this.held.keys().next().value!);
    return id;
  }

  /** A change by its id, for the page that draws it; null once it is forgotten, or was never here. */
  offered(id: string): LiveEditOffer | null {
    this.sweep();
    return this.held.get(id) ?? null;
  }

  private sweep(): void {
    const before = this.now() - HELD_FOR_MS;
    for (const [id, offer] of this.held) if (offer.at < before) this.held.delete(id);
  }
}

/** A message's words, whichever way it holds them. */
function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("") : "";
}

/**
 * A page's `liveEdit` as a message's body gave it, to hand on with the message, or nothing where it names none. A kind
 * nobody knows and a value that is no object are no live edit, never a refusal: a message is not lost for what its
 * page sent beside it. One too long to say is kept as its length alone, so the turn can say that it is.
 */
export function liveEditOf(raw: unknown, knows: (kind: string) => boolean): { liveEdit?: LiveEdit } {
  const given = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof given.kind !== "string" || !knows(given.kind)) return {};
  if (typeof given.value !== "object" || given.value === null || Array.isArray(given.value)) return {};
  const id = typeof given.id === "string" && given.id.trim() ? given.id.trim().slice(0, 80) : null;
  const length = JSON.stringify(given.value).length;
  if (length > LIVE_EDIT_MAX_CHARS) return { liveEdit: { kind: given.kind, id, value: null, tooLong: length } };
  return { liveEdit: { kind: given.kind, id, value: given.value } };
}
