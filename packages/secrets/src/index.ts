/**
 * `@nouride/secrets` — credentials wherever the daemon meets them: by name in its config (`store.ts`), and in text —
 * the shapes they take (`patterns.ts`, read through `scan.ts` and `redact.ts`) and the exact values it holds
 * (`mask.ts`) — and the ones a person sent in a message, held for an hour under a handle (`transient.ts`).
 */

export { containsSecret, maskSecrets, SecretMasker } from "./mask.ts";
export { redact } from "./redact.ts";
export { findSecrets } from "./scan.ts";
export { PrintedCredentials, type PrintedKind } from "./printed.ts";
export { assertSecretName, envNamesFor, looksLikeCredential, SecretError, type SecretDescription, type SecretPart, SecretStore, type StoreLock } from "./store.ts";
export type { FieldChange } from "./fields.ts";
export { secretsOf, type StoredSecret } from "./store-file.ts";
export { installKeyLayout, KEY_FILE_VARIABLE, KEY_VARIABLE, type KeyLevel, SYSTEM_KEY_FILE } from "./store-key.ts";
export { handlesIn, type HeldSecret, TransientSecrets } from "./transient.ts";
