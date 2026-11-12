/**
 * Whose an automation or a mission is, as the pages say it: the list set apart by person for an admin who reads
 * everyone's, and the words for one the reader only reads.
 *
 * The daemon says both of each row: `person`, who it is for in People (none is nobody's), and `changeable`, whether
 * the reader may change it. One they may not change is theirs to read because it reports to a chat of theirs: there
 * is no other way to see what is another person's.
 */

/** What a row says of whose it is and whether the reader may change it. */
export interface Owned {
  person?: { key: string; name: string } | undefined;
  /** Absent from a daemon older than the field, where everyone changed everything. */
  changeable?: boolean | undefined;
}

/** What is nobody's: its heading on a list set apart by person, and the last choice of the picker on the same pages. */
export const NOBODYS = "Nobody's";

/** Whether the reader only reads it: said by the daemon, and by nothing else. */
export const readsOnly = (thing: Owned): boolean => thing.changeable === false;

/** Whose it is in a word or two: "Rina's", or "Nobody's". */
export const whoseWords = (thing: Owned): string => (thing.person ? `${thing.person.name}'s` : NOBODYS);

/** The line under the title of one the reader only reads: whose it is, and why it is on their page at all. */
export const readOnlyLine = (thing: Owned): string =>
  `This is ${thing.person ? `${thing.person.name}'s` : "nobody's"}. It reports to a chat of yours, so you can read it here but not change it.`;

/**
 * Who answers what it waits for, where that is not the reader: its person, or an admin for what is nobody's. None for
 * one the reader may change, which waits for them.
 */
export const answeredBy = (thing: Owned): string | undefined => (readsOnly(thing) ? (thing.person?.name ?? "an admin") : undefined);

/** A heading of a list set apart by person, and what is under it. */
export interface PersonGroup<T> {
  key: string;
  label: string;
  items: T[];
}

const NOBODY = "nobody";

/**
 * A list set apart by person: the reader's own first (`mine`, their key in People, where they are someone there),
 * every other person by name, and what is nobody's last. Within each, the order the list came in.
 */
export function byPerson<T>(items: readonly T[], personOf: (item: T) => Owned["person"], mine: string | undefined): PersonGroup<T>[] {
  const people = new Map<string, PersonGroup<T>>();
  const nobodys: T[] = [];
  for (const item of items) {
    const person = personOf(item);
    if (!person) {
      nobodys.push(item);
      continue;
    }
    const group = people.get(person.key) ?? { key: `person:${person.key}`, label: person.name, items: [] };
    group.items.push(item);
    people.set(person.key, group);
  }
  const own = mine === undefined ? undefined : people.get(mine);
  const others = [...people.entries()].filter(([key]) => key !== mine).map(([, group]) => group).sort((a, b) => a.label.localeCompare(b.label));
  return [...(own ? [own] : []), ...others, ...(nobodys.length > 0 ? [{ key: NOBODY, label: NOBODYS, items: nobodys }] : [])];
}
