/**
 * Saying who an identity belongs to — a dashboard account, or a Telegram / WhatsApp / Discord sender
 * being approved — so an agent knows it is the same person everywhere.
 *
 * An identity is an id `[[people]]` understands: `web:<account id>` for a dashboard account, the
 * platform form (`telegram:814…`) for a sender. Linking adds it to one person's `ids` and takes it off
 * anybody else, since one identity is one person; the person is found by key or by any id, or made.
 * Somebody added by name with no account yet is where an account is meant to land, at pairing.
 *
 * Linking is an admin's everywhere it is offered, because it is not only a name: an identity linked to
 * a person gets that person's memory in its DM. Nothing here guesses — a person is whoever an admin
 * says they are.
 */

import type { Person } from "@nouride/shared";
import { canonicalPersonId, idsOf } from "@/modules/people/match.ts";
import { holdingConfigFile } from "./file.ts";
import { personByHandle, savePersonHeld } from "./people.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

/** The identity a dashboard account is, as `[[people]]` writes it. */
export function accountIdentity(userId: string): string {
  return `web:${userId}`;
}

/** The person an identity already is, if any. */
export function personOf(people: readonly Person[], identity: string): Person | undefined {
  const wanted = canonicalPersonId(identity);
  return people.find((person) => idsOf(person).includes(wanted));
}

export type LinkTarget = { person: string } | { name: string };

export type LinkResult = (SaveResult & { ok: true; person: Person }) | (SaveResult & { ok: false });

/**
 * Take `identity` off whoever holds it — a dashboard account that was deleted. Its `web:<id>` stayed in
 * config.toml and on the person's row, counted as one of their accounts, for an account that no longer
 * exists. The person keeps everything else. Done when nobody holds it.
 */
export async function unlinkIdentity(deps: SettingsDeps, params: { identity: string; actor?: string }): Promise<SaveResult> {
  const identity = canonicalPersonId(params.identity);
  return await holdingConfigFile(deps, async (file): Promise<SaveResult> => {
    const holder = personOf(deps.config.people, identity);
    if (!holder) return { ok: true, restartRequired: false };
    const saved = await savePersonHeld(deps, file, { person: { key: holder.key, name: holder.name, ids: idsOf(holder).filter((id) => id !== identity) }, ...(params.actor ? { actor: params.actor } : {}) });
    return saved.ok ? { ok: true, restartRequired: false } : saved;
  });
}

/** Make `identity` one of `target`'s ids — an existing person by key or id, or a new one by name. */
export async function linkIdentity(
  deps: SettingsDeps,
  params: { identity: string; target: LinkTarget; actor?: string },
): Promise<LinkResult> {
  const identity = canonicalPersonId(params.identity);
  // Holding the file for the whole of it: the person and the current holder are read as they are when the writes
  // land, and the two writes — off one, onto the other — are one change, not two another save can fall between.
  return await holdingConfigFile(deps, async (file): Promise<LinkResult> => {
    const people = deps.config.people;
    const existing = "person" in params.target ? personByHandle(people, params.target.person) : undefined;
    if ("person" in params.target && !existing) return { ok: false, error: `no person "${params.target.person}"` };
    const name = existing?.name ?? ("name" in params.target ? params.target.name.trim() : "");
    if (!name) return { ok: false, error: "a name is required for a new person" };
    const actor = params.actor ? { actor: params.actor } : {};

    /**
     * Off whoever holds it now: one identity, one person.
     *
     * Even when it is all they have. Until 0.7.0 that was refused ("remove them instead"), because a
     * person was their first account and one with none could not be written. A person is their key now,
     * and keeps their name, notes and memory with no account at all — which is also what somebody added
     * by name looks like until they pair.
     */
    const holder = personOf(people, identity);
    if (holder && holder !== existing) {
      const off = await savePersonHeld(deps, file, { person: { key: holder.key, name: holder.name, ids: idsOf(holder).filter((id) => id !== identity) }, ...actor });
      if (!off.ok) return off;
    }

    const saved = existing
      ? await savePersonHeld(deps, file, { person: { key: existing.key, name, ids: [...idsOf(existing).filter((id) => id !== identity), identity] }, ...actor })
      : await savePersonHeld(deps, file, { person: { name, ids: [identity] }, create: true, ...actor });
    if (!saved.ok) return saved;
    return { ok: true, restartRequired: false, person: saved.person };
  });
}
