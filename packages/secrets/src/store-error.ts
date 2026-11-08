/**
 * The store's refusal, in a file of its own so the store's key and file modules can throw it without importing the
 * store.
 */

import { NourideError } from "@nouride/shared";

/** The part of a secret a refusal is about, where it is one: its name, its value, or what is said about it (its fields). */
export type SecretPart = "name" | "value" | "fields";

export class SecretError extends NourideError {
  override name = "SecretError";
  /**
   * `part` (0.8.23): which part of what was sent was refused, so a form that sends all three can say which to fix; a
   * store that cannot be read or written refuses no part.
   */
  constructor(message: string, readonly part?: SecretPart) {
    super("secret_error", message, "A credential is missing or misconfigured.");
  }
}
