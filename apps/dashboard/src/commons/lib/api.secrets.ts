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
