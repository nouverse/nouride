/**
 * People, one file each (0.8.18, PLAN §2.1): `people/<key>.toml` beside `config.toml`, the person's key its file name,
 * as an agent is `agents/<id>/config.toml`.
 *
 * ```toml
 * [person]
 * name = "Gading"
 * ids = ["telegram:555", "web:usr_1"]
 * notes = "…"
 * ```
 *
 * `[[people]]` lived in the daemon's config.toml: every People write rewrote the file that runs the daemon and rotated
 * its five backups (on the live box all five were from one minute, 2026-11-01, so a setting changed a week before had
 * none left), and a model's tool wrote it. A person's file has backups of its own.
 *
 * Read whole at every load and at every write, under the config's lock (`config-file.ts`), so a hand edit is what the
 * next write patches rather than what it undoes. A file that does not load is named with its reason and that person
 * left out; the daemon starts. Not the memory vault's `people/<key>.md`, their profile: the two stay apart.
 */

import { ConfigError, createLogger, type Person } from "@nouride/shared";
import { dirname, join, listDir, parseToml, readTextFileSync, statFile } from "@nouride/runtime";
import { removeTomlKey, upsertTomlTable, type TomlScalar } from "@/modules/config/edit.ts";
import { validatePeople } from "@/modules/config/global/validate-people.ts";
import { readPeople } from "./entry.ts";

const log = createLogger("people");

/** The one table of a person's file. */
const PERSON_TABLE = "person";
/** A person's file: their key, then `.toml`. A backup (`gading.toml.bak.1`) or an editor's swap file is not one. */
const PERSON_FILE = /^([a-z0-9][a-z0-9_-]{0,63})\.toml$/;

/** Where a config's people live: `people/` beside it. */
export function peopleDirOf(configPath: string): string {
  return join(dirname(configPath), "people");
}

/** A person's file in `dir`. */
export function personFile(dir: string, key: string): string {
  return join(dir, `${key}.toml`);
}

export interface PeopleRead {
  people: Person[];
  /** One line per file left out: its name and why. */
  problems: string[];
}

/**
 * Everyone in `dir`, in key order, each checked as a `[[people]]` entry is (`validatePeople`) against those before
 * them, so an account claimed in two files is the later file's problem; null when there is no such folder.
 * `override` reads one key's file as that text instead (a write checked before it lands), or as removed (null).
 */
export function readPeopleDir(dir: string, override?: { key: string; text: string | null }): PeopleRead | null {
  if (!statFile(dir)?.isDirectory) return null;
  const names = new Set(listDir(dir).filter((entry) => !entry.isDirectory).map((entry) => entry.name));
  if (override) {
    if (override.text === null) names.delete(`${override.key}.toml`);
    else names.add(`${override.key}.toml`);
  }
  const people: Person[] = [];
  const problems: string[] = [];
  for (const name of [...names].sort()) {
    const key = PERSON_FILE.exec(name)?.[1];
    if (!key) continue;
    const where = `people/${name}`;
    try {
      const text = override?.key === key && override.text !== null ? override.text : readTextFileSync(join(dir, name));
      const person = personFrom(text, key);
      validatePeople([...people, person], (index) => (index === people.length ? where : `people/${people[index]!.key}.toml`));
      people.push(person);
    } catch (err) {
      problems.push(`${where}: ${err instanceof Error ? err.message : String(err)}; that person is left out until it loads`);
    }
  }
  return { people, problems };
}

/** Everyone in `dir`, its problems said once in the log; null when there is no such folder. */
export function loadPeopleDir(dir: string): Person[] | null {
  const read = readPeopleDir(dir);
  if (!read) return null;
  for (const problem of read.problems) log.warn("a person's file did not load", { problem });
  return read.people;
}

/** One file's person, keyed by its name whatever a `key` inside says. Throws a `ConfigError` naming what is wrong. */
function personFrom(text: string, key: string): Person {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml<Record<string, unknown>>(text);
  } catch (err) {
    throw new ConfigError(`it is not TOML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const table = raw[PERSON_TABLE];
  if (typeof table !== "object" || table === null || Array.isArray(table)) throw new ConfigError("it has no [person] table");
  return readPeople([{ ...(table as Record<string, unknown>), key }])[0]!;
}

/** What a write sets: `upsertPerson`'s cases. A value sets it, `undefined` keeps what is there, `""` or `[]` drops it. */
export interface PersonFields {
  name: string;
  ids?: string[];
  notes?: string;
  facts?: string;
  /** `null` drops it: the person follows `[memory] recall` again. */
  recall?: boolean | null;
  morning?: string;
  morningTo?: string;
}

const NEW_FILE = "# One person: their key is this file's name. Read by the daemon at start and at every People write.\n";

/** `text` (a person's file, or "" for a new one) with `fields` patched in: never rebuilt, so comments and hand edits stay. */
export function patchPersonFile(text: string, fields: PersonFields): string {
  let next = text.trim() ? text : NEW_FILE;
  const set: Record<string, TomlScalar> = { name: fields.name };
  const drop: string[] = [];
  const optional: [string, string | string[] | undefined][] = [
    ["ids", fields.ids],
    ["notes", fields.notes],
    ["facts", fields.facts],
    ["morning", fields.morning],
    ["morning_to", fields.morningTo],
  ];
  for (const [key, value] of optional) {
    if (value === undefined) continue;
    if (value.length === 0) drop.push(key);
    else set[key] = value;
  }
  if (fields.recall === null) drop.push("recall");
  else if (fields.recall !== undefined) set.recall = fields.recall;
  next = upsertTomlTable(next, PERSON_TABLE, set);
  for (const key of drop) next = removeTomlKey(next, PERSON_TABLE, key);
  return next;
}

/** A person as their own file: what the move writes for each `[[people]]` entry. */
export function personFileText(person: Person): string {
  return patchPersonFile("", {
    name: person.name,
    ...(person.ids?.length ? { ids: person.ids } : {}),
    ...(person.notes ? { notes: person.notes } : {}),
    ...(person.facts ? { facts: person.facts } : {}),
    ...(person.recall !== undefined ? { recall: person.recall } : {}),
    ...(person.morning ? { morning: person.morning } : {}),
    ...(person.morningTo ? { morningTo: person.morningTo } : {}),
  });
}
