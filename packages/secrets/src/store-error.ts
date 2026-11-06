/**
 * The store's refusal, in a file of its own so the store's key and file modules can throw it without importing the
 * store.
 */

import { NourideError } from "@nouride/shared";

export class SecretError extends NourideError {
  override name = "SecretError";
  constructor(message: string) {
    super("secret_error", message, "A credential is missing or misconfigured.");
  }
}
