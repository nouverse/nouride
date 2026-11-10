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
