/**
 * What a `[[people]]` entry is: a key, a name, and the accounts they send from.
 *
 * The key is the person. It names their memory profile (`people/<key>.md`), it is what every writer —
 * the dashboard, Access's "Approve as", the CLI, the agents' tools — finds them by, and it is set once.
 * Their accounts are a list with no first among equals, and may be empty: a person can be added by
 * name and attached to their accounts later, when they pair.
 *
 * Until 0.7.0 the first account was the person (`id`, required). Nobody could be added before an id
 * for them was known, and every write had to take care never to lose that one id — the dashboard kept
 * the last original id from being removed, and a save from a person's second account once dropped
 * their first. 0.7.x rewrote such entries; 0.8.0 refuses an `id` at load, naming `ids`.
 */

import type { Person } from "@nouride/shared";
import { canonicalPersonId } from "./match.ts";

/** A key this daemon writes: lowercase letters and digits, words joined by "-". It becomes a file name. */
const NEW_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_MAX = 32;
/** `shared.md` is the household's shared knowledge, beside everyone's profile. */
const SHARED = "shared";

/**
 * What still holds a key nobody in `[[people]]` has: why, or null. Removing a person leaves their memory
 * and MCP tokens under their key (`people/<key>.md`, the conversations listing them, a token minted for
 * them), and a new person given that key would inherit all of it — so a new key steps around one that is
 * held, and taking one on is said out loud (`reattach`).
 */
export type KeyHeld = (key: string) => string | null;

/**
 * Why `key` cannot be a new person's, or null.
 *
 * Stricter than what is read: a key a file already holds may contain `_` (allowed until 0.7.0) and is
 * kept, since changing a key orphans the memory filed under it. One written from now on is a word or
 * words joined by "-", so it reads the same as a file name and in a sentence.
 */
export function refusePersonKey(key: string, people: readonly Pick<Person, "key" | "name">[], held?: KeyHeld): string | null {
  if (!key) return "a person key is required";
  if (key.length > KEY_MAX) return `person key "${key}" is longer than ${KEY_MAX} characters`;
  if (!NEW_KEY.test(key)) return `person key "${key}" must be lowercase letters and digits, words joined by "-", since it becomes a file name`;
  if (key === SHARED) return `person key "${SHARED}" is the household's shared knowledge. Choose another`;
  const holder = people.find((person) => person.key === key);
  if (holder) return `person key "${key}" is already ${holder.name}'s`;
  const left = held?.(key);
  if (left) {
    return `person key "${key}" still belongs to someone removed from People: ${left}. To give it to this person with all of that, say so (--reattach); to clear it, forget it first (nouride memory forget ${key}); or choose another key`;
  }
  return null;
}

/** A key from a name — `Kak Sam Wijaya` → `sam-wijaya` — that nobody holds yet: `-2`, `-3` after a taken one, or a held one. */
export function freeKey(people: readonly Pick<Person, "key">[], name: string, held?: KeyHeld): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/^(kak|mas|mbak|pak|bu|om|tante)\s+/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, KEY_MAX)
      .replace(/-+$/, "") || "person";
  const taken = new Set<string>([SHARED, ...people.map((person) => person.key).filter((key): key is string => Boolean(key))]);
  const free = (key: string) => !taken.has(key) && !held?.(key);
  if (free(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, KEY_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (free(candidate)) return candidate;
  }
}

/**
 * The accounts an entry was read with, as the file spelled them — so the validator can refuse one written with the
 * connection it came in on (`telegram:nouva:814`), naming the account, which today's spelling alone cannot tell.
 */
const spelled = new WeakMap<Person, string[]>();

/** The accounts as the file spelled them, or as they are for an entry that did not come from a file. */
export function accountsAsWritten(person: Person): string[] {
  return spelled.get(person) ?? (person.ids ?? []);
}

/** An entry as a file says it. An `id` from before 0.7.0 is refused at load (`config/global/index.ts`), not read. */
type Written = Partial<Person> & { ids?: unknown; morning_to?: unknown };

/**
 * `[[people]]` as the file says it, in today's shape.
 *
 * Every account in `ids`, in the platform's spelling, without blanks or repeats. A key for everyone: one made from the name for an entry written without one, avoiding
 * every key another entry holds. In file order, so the same file always gives the same keys; the boot
 * writes them into the file (`keyEveryone`) so they stop depending on that.
 *
 * Nothing is refused here. A missing name, a malformed id, a duplicate key are the validator's to name,
 * with the entry's position — this only reads.
 */
export function readPeople(raw: readonly unknown[]): Person[] {
  const entries = raw.filter((entry): entry is Written => typeof entry === "object" && entry !== null);
  const held = entries.map((entry) => (typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : undefined));
  const keys: Pick<Person, "key">[] = held.filter((key): key is string => key !== undefined).map((key) => ({ key }));

  return entries.map((entry, index) => {
    const written = (Array.isArray(entry.ids) ? entry.ids : [])
      .filter((id): id is string => typeof id === "string" && id.trim() !== "")
      .map((id) => id.trim());
    const ids = [...new Set(written.map(canonicalPersonId))];
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    let key = held[index];
    if (key === undefined) {
      key = freeKey(keys, name);
      keys.push({ key });
    }
    const { ids: _accounts, key: _key, name: _name, morning_to: morningTo, ...rest } = entry;
    // The one key of an entry spelled with two words: written `morning_to`, read `morningTo` (0.8.0).
    const person: Person = {
      ...(rest as Omit<Person, "key" | "name" | "ids">),
      key,
      name,
      ...(ids.length > 0 ? { ids } : {}),
      ...(morningTo !== undefined ? { morningTo: String(morningTo) } : {}),
    };
    spelled.set(person, written);
    return person;
  });
}
