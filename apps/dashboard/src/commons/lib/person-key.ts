/**
 * Person keys, as the daemon writes them (`modules/people/entry.ts`): lowercase letters and digits,
 * words joined by "-", at most 32, never `shared`. The key is the person, and the name of their memory
 * file — `people/<key>.md`.
 *
 * Mirrored here for the form only: a suggestion while the name is typed, and why a key will not do
 * before Save is pressed. The daemon decides, and checks again — a key somebody took meanwhile is
 * refused there too.
 */

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_MAX = 32;
const SHARED = "shared";

/** Lowercase, accents dropped, anything that is not a letter or a digit as one "-". */
function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

/** A key from a name — `Kak Sam Wijaya` → `sam-wijaya` — that nobody in `taken` holds: `-2`, `-3` after one. */
export function suggestKey(name: string, taken: ReadonlySet<string>): string {
  const base =
    slug(name.trim().replace(/^(kak|mas|mbak|pak|bu|om|tante)\s+/i, ""))
      .replace(/^-+|-+$/g, "")
      .slice(0, KEY_MAX)
      .replace(/-+$/, "") || "person";
  if (!taken.has(base) && base !== SHARED) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, KEY_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What is typed into the key box, kept to what a key can be — a "-" may end it while typing. */
export function typedKey(input: string): string {
  return slug(input).replace(/^-+/, "").replace(/-{2,}/g, "-").slice(0, KEY_MAX);
}

/** Why `key` cannot be a new person's, or null. */
export function keyProblem(key: string, people: readonly { key: string; name: string }[]): string | null {
  if (!key) return "A person key is required.";
  if (!KEY.test(key)) return 'Lowercase letters and digits, words joined by "-", no "-" at either end.';
  if (key === SHARED) return '"shared" is the household\'s shared knowledge. Choose another.';
  const holder = people.find((person) => person.key === key);
  if (holder) return `Already ${holder.name}'s person key. Choose another.`;
  return null;
}
