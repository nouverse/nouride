/**
 * The checks every person passes, wherever they are written: the `[[people]]` block of `config.toml`, where a failure
 * stops the load as it always has, and `people/<key>.toml` (0.8.18), where it leaves that one person out and names the
 * file (`modules/people/files.ts`). One list of checks, so the two cannot drift; `where` says the person's place in
 * each, and the messages are the ones `[[people]]` has always given.
 */

import { ConfigError, type Person } from "@nouride/shared";
import { CONFIG_ENUMS } from "@/modules/config/schema.ts";
import { SHARED } from "@/modules/memory/index.ts";
import { canonicalPersonId, refusePersonId } from "@/modules/people/match.ts";
import { accountsAsWritten } from "@/modules/people/entry.ts";

/** A morning line's time of day: `07:00`, `21:30`. */
const MORNING_AT = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A person key becomes a file name under `[memory] dir`: a slug and nothing else. */
const PERSON_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type PersonPlace = (index: number, person: Person) => string;

/** `[[people]] #3`, as the block has always been named. */
const BLOCK_PLACE: PersonPlace = (index) => `[[people]] #${index + 1}`;

/**
 * Throws the first problem among `people`, in order. People checked at load because a mistyped id is invisible at
 * runtime: the agent simply never recognises anyone, and nothing anywhere says why (invariant 7). An entry with no
 * account at all is a person added by name, attached to one when they pair: legal since 0.7.0.
 */
export function validatePeople(people: readonly Person[], place: PersonPlace = BLOCK_PLACE): void {
  const seen = new Map<string, { name: string }>();
  const keys = new Map<string, string>();
  const modes: readonly string[] = CONFIG_ENUMS["memory.facts"];
  for (const [index, person] of people.entries()) {
    const where = place(index, person);
    if (!person.name?.trim()) throw new ConfigError(`${where} (${person.key}) needs a \`name\``);
    // Their morning line (0.8.0): a time read every minute, so a wrong one would simply never come.
    if (person.morning !== undefined && !MORNING_AT.test(String(person.morning))) {
      throw new ConfigError(`${where} (${person.key}) morning = "${String(person.morning)}" is a time of day, HH:MM, such as "07:00"`);
    }

    const mine = new Set<string>();
    for (const written of accountsAsWritten(person).map((id) => id.trim()).filter(Boolean)) {
      const refusal = refusePersonId(written);
      if (refusal) throw new ConfigError(`${where} id "${written}" ${refusal}`);
      // The connection an account wrote in on is not part of it: 0.7.x rewrote such ids in every file, and 0.8.0 reads
      // only the account — `discord:214`, not `discord:nero:214`.
      const id = canonicalPersonId(written);
      if (id !== written) {
        throw new ConfigError(`${where} id "${written}" names the connection it came in on. Write it as "${id}": an account is the person's on every bot`);
      }
      if (mine.has(id)) continue;
      mine.add(id);
      // Across every person's every id, not per entry: two entries claiming one id is silent at runtime — the first
      // match wins, so the second person's notes are never used — and the message names who it collides with.
      const owner = seen.get(id);
      if (owner) throw new ConfigError(`${where} id "${id}" is already claimed by ${owner.name}: one of the two would never match`);
      seen.set(id, { name: person.name });
    }
    // Where their morning line goes (0.8.0): one of their own chat accounts, or the line would go nowhere, or to someone else.
    if (person.morningTo !== undefined) {
      const to = String(person.morningTo);
      const refusal = !mine.has(to) ? "is not one of their accounts (ids)" : to.startsWith("web:") ? "is a dashboard account, which no message reaches" : null;
      if (refusal) throw new ConfigError(`${where} (${person.key}) morning_to = "${to}" ${refusal}: name a telegram, discord or whatsapp one of theirs`);
    }

    // The key becomes their profile's file name: two people on one key share a memory, one keyed `shared` reads the
    // household's knowledge as their own.
    if (person.key !== undefined) {
      const named = `${where} (${person.name})`;
      if (!PERSON_KEY.test(person.key)) {
        throw new ConfigError(
          `${named} key "${person.key}" must be a lowercase slug (letters, digits, "-" and "_", starting ` +
            "with a letter or digit), because it becomes the name of their profile",
        );
      }
      if (person.key === SHARED) throw new ConfigError(`${named} key "${SHARED}" is taken by the household's shared knowledge: choose another`);
      const holder = keys.get(person.key);
      if (holder) throw new ConfigError(`${named} key "${person.key}" is already ${holder}'s: two people would share one memory`);
      keys.set(person.key, person.name);
    }
    if (person.facts !== undefined && !modes.includes(person.facts)) {
      throw new ConfigError(`${where} (${person.name}) facts must be one of ${modes.join(", ")}, got "${person.facts}"`);
    }
    if (person.recall !== undefined && typeof person.recall !== "boolean") {
      throw new ConfigError(`${where} (${person.name}) recall must be true or false, got ${JSON.stringify(person.recall)}`);
    }
  }
}
