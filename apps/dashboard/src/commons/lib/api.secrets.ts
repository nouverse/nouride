/**
 * The secret store: three calls, and **not one of them returns a value.**
 *
 * That is the design, not an oversight. The store exists so a config file can name a credential
 * instead of holding one, and a route that read one back would hand every authenticated caller — the
 * dashboard, the CLI, and through the CLI an *agent* — a way to take every token on the box in a
 * single request. There is no such route on the daemon and there is no such call here, so the screen
 * shows dots because dots are all that exists on this side.
 *
 * Its own module rather than more lines in `api.ts`, for the reason that file's budget note gives: a
 * new endpoint group belongs in a module of its own.
 */

import { control, request } from "./api.client";
import type { FieldChange, SecretEntry, SecretLock } from "@nouride/wire";

export const secretsApi = {
  /** `sealedInSnapshots`: whether the config snapshots hold the store, sealed to the backup passphrase (0.8.18). */
  secrets: () => request<{ secrets: SecretEntry[]; sealedInSnapshots?: boolean; lock?: SecretLock }>(`${control}/secrets`),

  /**
   * Add or replace, which are the same call.
   *
   * The store has no separate update: writing a name that exists overwrites it. Deliberate, so a
   * rotated key can be put in without a delete-then-add window where nothing resolves.
   */
  secretSet: (name: string, value: string, fields?: FieldChange) =>
    request<{ ok: true; name: string; shadowedByEnv: boolean }>(
      `${control}/secrets/${encodeURIComponent(name)}`,
      { method: "PUT", body: JSON.stringify({ value, ...(fields ? { fields } : {}) }) },
    ),

  /** What is said about a stored secret, changed; its value untouched (0.8.19). Admin. */
  secretFields: (name: string, change: FieldChange) =>
    request<{ ok: true; fields: Record<string, string> }>(`${control}/secrets/${encodeURIComponent(name)}/fields`, {
      method: "PATCH",
      body: JSON.stringify(change),
    }),

  /**
   * The backup password (0.8.19, from the page; 0.8.18 had the CLI only): sent once to the route the CLI uses, which
   * keeps only the public half derived from it. `null` turns it off. Admin.
   */
  backupPassword: (password: string | null) =>
    request<{ ok: true; sealedInSnapshots: boolean; snapshot?: string; skipped?: string }>(`${control}/secrets/seal`, {
      method: "POST",
      body: JSON.stringify(password === null ? { off: true } : { passphrase: password }),
    }),

  secretDelete: (name: string) =>
    request<{ deleted: boolean }>(`${control}/secrets/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
};
