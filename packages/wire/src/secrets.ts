/**
 * The secret store (`routes/secrets.ts`): names, locks and what changed, and never a value.
 */

/** One credential as the dashboard sees it: a name, where it comes from, and what needs it. */
export interface SecretEntry {
  name: string;
  /**
   * Where the value actually resolves from.
   *
   * `missing` is the one worth having: something in the configuration references this name and
   * nothing sets it. Without it a missing credential shows up as a gateway that will not connect,
   * which says nothing about which secret is absent.
   */
  origin: "env" | "store" | "missing";
  /** Where this name is referenced from — a provider, a gateway, sign-in. Empty for an orphan. */
  usedBy: string[];
  /**
   * Stored, and an environment variable of the same name wins anyway.
   *
   * Resolution reads the environment first, so the stored value does nothing. Saying so is the
   * difference between a puzzling no-op and a fact.
   */
  shadowed: boolean;
  /** What is said about it (0.8.19): free fields, a name and a text each. Never secret; the value is never sent. */
  fields?: Record<string, string>;
  addedBy?: string;
  addedAt?: string;
  changedAt?: string;
}

/** Whether the store is encrypted, and how far its key is from the data (0.8.19). Where the key is, never the key. */
export interface SecretLock {
  encrypted: boolean;
  key?: { where: string; level: "outside" | "install" | "data" };
}

/** A change to what is said about a secret: names to texts to set (an empty text removes), names to remove. */
export interface FieldChange {
  set?: Record<string, string>;
  remove?: string[];
}
