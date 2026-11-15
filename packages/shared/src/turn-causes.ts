/** What a turn's cause says of it, where both the daemon and a reader of its record ask. */

/**
 * The causes of a delegate's own turn (`pipeline/delegated-turn.ts`, 0.7.26): a helper `delegate` started in the
 * background, an agent `ask_agent` asked once its turn moved there. Recorded in the chat they work for, and no turn of
 * its conversation.
 */
export const DELEGATED = ["delegate", "ask_agent"] as const;

/** Whether a turn is a delegate's own, by its cause. */
export function isDelegated<C extends { via: string }>(cause: C | undefined): cause is C & { via: (typeof DELEGATED)[number] } {
  return (DELEGATED as readonly string[]).includes(cause?.via ?? "");
}

/** The cause of a turn answering a person's edit (`pipeline/edits.ts`): `of` is the message edited. */
export const EDITED = "edit";

/**
 * The cause of the turn that keeps an asked agent's answer where it was also said, in the room it was asked in
 * (`pipeline/peer-shown.ts`): `asked` is the agent that asked it, `parent` that agent's turn. A turn of the
 * conversation, unlike a delegate's own: it is what that agent said there.
 */
export const SHOWN_ANSWER = "shown answer";
