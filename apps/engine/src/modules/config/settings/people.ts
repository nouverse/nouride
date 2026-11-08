/**
 * The `[[people]]` block: who the agents are told about by name.
 *
 * A person is their key (`modules/people/entry.ts`): every write here finds them by it, and a new one is
 * given one — from their name, or the one the operator chose. Their accounts are a list that may be
 * empty, attached when they are known.
 */

import { ConfigError, createLogger } from "@nouride/shared";
import { ensureDir, parseToml, readTextFileIfExists, sha256Text } from "@nouride/runtime";
import { keepBefore } from "@/commons/backups.ts";
import { VERSION } from "@/cli/version.ts";
import type { FactsMode, Person } from "@nouride/shared";
import { addMissingPeopleKeys, removePerson as removePersonFromToml, upsertPerson } from "@/modules/config/edit-blocks.ts";
import { canonicalPersonId, idsOf, refusePersonId } from "@/modules/people/match.ts";
import { freeKey, readPeople, refusePersonKey } from "@/modules/people/entry.ts";
import { validatePeople } from "@/modules/config/global/validate-people.ts";
import { holdingConfigFile } from "./file.ts";
import type { Edited, HeldConfig } from "@/modules/config/config-file.ts";
import { patchPersonFile, peopleDirOf, personFileText, readPeopleDir, type PersonFields } from "@/modules/people/files.ts";
import type { AuditEntry } from "@/commons/audit.store.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

/**
 * What writing a person actually needs: the file, the in-memory copy, and the audit row.
 *
 * Narrower than `SettingsDeps` because `person_record` is a *tool*, and a tool holding the full
 * settings deps would hold the secret store, the provider registry and the live gateway map — enough
 * to rewrite every connection on the box in order to write down a name. `SettingsService` still
 * satisfies this by passing its own deps through unchanged.
 */
export type PeopleWriteDeps = Pick<SettingsDeps, "config" | "configPath" | "audit" | "keyHeld">;

/** A save that went through, with the person as they now are. */
export type SavedPerson = { ok: true; restartRequired: boolean; person: Person } | Extract<SaveResult, { ok: false }>;

/*
 * Every write here holds the config file for its whole length (`holdingConfigFile`): its checks read the household,
 * then the file is patched, then the running copy — with waits in between. Two at once were likely since
 * `person_notes`: an agent changing a line of somebody's notes while the operator saves the same notes from the
 * dashboard, each reading them as they were, the later write erasing the earlier without a word. They used to be
 * taken in turn by a queue of their own, which held nothing against the other writers of the same file — the access
 * mode saved beside a person was lost in nineteen trials of twenty. Held by the file's one lock, a check is still
 * true when its write lands, whoever else is writing.
 */

/** A person by key, or by an account they hold — what the CLI, Access and the dashboard name them by. */
export function personByHandle(people: readonly Person[], handle: string): Person | undefined {
  const wanted = handle.trim();
  return people.find((person) => person.key === wanted) ?? people.find((person) => idsOf(person).includes(canonicalPersonId(wanted)));
}

/**
 * The household as a write finds it, holding the file (0.8.18): from `people/`, each person's own file read now, once
 * that folder is there, so a hand edit is what a write is checked against and what it patches, never what it undoes
 * (REVIEW B2: a name and a notes line edited by hand were put back by the next People save). Before the move, and in a
 * config with no such folder, the `[[people]]` block as the daemon read it.
 */
function peopleNow(deps: Pick<PeopleWriteDeps, "config" | "configPath">): { dir: string | null; people: readonly Person[] } {
  const dir = peopleDirOf(deps.configPath);
  const read = readPeopleDir(dir);
  return read ? { dir, people: read.people } : { dir: null, people: deps.config.people };
}

/** One person written where they live: their own file, patched, or their `[[people]]` block. */
function writeTo(file: HeldConfig, dir: string | null, fields: PersonFields & { key: string }, held: readonly string[]): Promise<Edited> {
  if (dir) return file.editPerson(fields.key, (text) => patchPersonFile(text, fields));
  return file.edit((source) => upsertPerson(source, fields, held));
}

export async function savePerson(
  deps: PeopleWriteDeps,
  params: {
    /**
     * `key` names who this is: somebody already in `[[people]]`, or the key a new person is given.
     * Without one, they are found by `account`, and a new person's key is made from their name.
     *
     * `ids` and `notes` follow three cases: absent keeps what is there, empty clears it, a value sets
     * it. `ids` replaces the whole list — which is how an address is removed — and may leave none.
     */
    person: { key?: string; name: string; ids?: string[]; notes?: string };
    /**
     * The account a message came from, when that is all a caller knows: `person_record`, and
     * `nouride people set <account>`. Finds whoever holds it; a new person is given it.
     */
    account?: string;
    /** A new person is meant: a key somebody already has is refused, never saved over them. */
    create?: boolean;
    /**
     * The key named is given on purpose to this person, though someone removed from People still holds it
     * — their profile, conversations or MCP tokens (`SettingsDeps.keyHeld`) — and those become this
     * person's. Refused without it; a key made from a name steps around a held one instead.
     */
    reattach?: boolean;
    actor?: string;
    /**
     * The notes this save was made against: what the dashboard's notes dialog opened with. When the
     * person's notes no longer read that way — they had an agent change a line meanwhile — the save is
     * refused with `conflict` instead of putting the old text back over the change.
     */
    expectedNotes?: string;
    /**
     * The accounts this save was made against: what the dialog opened with. Its list replaces theirs, so when they
     * no longer read that way — an account paired, or moved to them, while it was open — the save is refused with
     * `conflict` instead of taking the new account away again.
     */
    expectedIds?: string[];
  },
): Promise<SavedPerson> {
  return await holdingConfigFile(deps, (file) => writePerson(deps, file, params));
}

/**
 * `savePerson` for a caller already holding the file (`holdingConfigFile`): `linkIdentity`, whose two writes — off one
 * person, onto another — are one change, made against the household as it is when the first one lands.
 */
export function savePersonHeld(
  deps: PeopleWriteDeps,
  file: HeldConfig,
  params: Parameters<typeof savePerson>[1],
): Promise<SavedPerson> {
  return writePerson(deps, file, params);
}

async function writePerson(
  deps: PeopleWriteDeps,
  file: HeldConfig,
  params: Parameters<typeof savePerson>[1],
  audit?: AuditEntry,
): Promise<SavedPerson> {
  const { actor } = params;
  const name = params.person.name?.trim() ?? "";
  if (!name) return { ok: false, error: "person name is required" };
  const { dir, people } = peopleNow(deps);

  /** Every address in today's spelling, without blanks or repeats — and each one an address. */
  const ids = params.person.ids === undefined ? undefined : [...new Set(params.person.ids.map(canonicalPersonId).filter(Boolean))];
  const account = params.account?.trim() ? canonicalPersonId(params.account) : undefined;
  for (const id of [...(ids ?? []), ...(account ? [account] : [])]) {
    const refusal = refusePersonId(id);
    if (refusal) return { ok: false, error: `id "${id}" ${refusal}` };
  }

  /**
   * Who this is: by key when the caller names one, by the account otherwise.
   *
   * A key nobody holds is a new person with that key — checked as one, so an operator's typo is a
   * refusal naming the rule rather than a file name nobody can read. And a create that names a key
   * somebody already holds is refused: saving over them would hand a new person a stranger's notes,
   * accounts and memory, which is what a duplicate key means.
   */
  const wantedKey = params.person.key?.trim();
  const target = wantedKey
    ? people.find((person) => person.key === wantedKey)
    : account
      ? people.find((person) => idsOf(person).includes(account))
      : undefined;
  if (params.create && target) {
    return { ok: false, error: `person key "${target.key}" is already ${target.name}'s: choose another` };
  }
  if (wantedKey && !target) {
    const refusal = refusePersonKey(wantedKey, people, params.reattach ? undefined : deps.keyHeld);
    if (refusal) return { ok: false, error: refusal };
  }
  const key = target?.key ?? wantedKey ?? freeKey(people, name, deps.keyHeld);
  const reattached = !target && params.reattach === true ? (deps.keyHeld?.(key) ?? null) : null;

  if (params.expectedNotes !== undefined && params.person.notes !== undefined && (target?.notes ?? "") !== params.expectedNotes) {
    return {
      ok: false,
      conflict: true,
      error: `${target?.name ?? name}'s notes changed since you opened them. Reload them, then make your change again.`,
    };
  }

  if (params.expectedIds !== undefined && ids !== undefined) {
    const now = [...new Set((target ? idsOf(target) : []).map(canonicalPersonId))].sort();
    const opened = [...new Set(params.expectedIds.map(canonicalPersonId))].sort();
    if (now.length !== opened.length || now.some((id, index) => id !== opened[index])) {
      return {
        ok: false,
        conflict: true,
        error: `${target?.name ?? name}'s accounts changed since you opened them. Reload them, then make your change again.`,
      };
    }
  }

  // The accounts they will hold: the list sent, or theirs as they are, with a new account added.
  const held = target ? idsOf(target) : [];
  const accounts = ids ?? (account && !held.includes(account) ? [...held, account] : held);

  /**
   * An account that belongs to somebody else is refused rather than written.
   *
   * Two people claiming one account is a config the matcher resolves to whichever comes first, so the
   * second is never recognised there. It is also the honest answer to the mistake being made: that
   * address is already spoken for, and the fix is to decide by whom — Access's "Approve as" and the
   * account links move one deliberately.
   */
  const clash = people.find((person) => person !== target && idsOf(person).some((id) => accounts.includes(id)));
  if (clash) {
    const taken = idsOf(clash).filter((id) => accounts.includes(id));
    return { ok: false, error: `${taken.join(", ")} already belongs to ${clash.name}` };
  }

  const notes = params.person.notes;
  const { ids: _held, notes: _notes, ...rest } = target ?? ({} as Partial<Person>);
  const kept = notes === undefined ? target?.notes : notes;
  const next: Person = { ...rest, key, name, ...(accounts.length > 0 ? { ids: accounts } : {}), ...(kept ? { notes: kept } : {}) };

  // The loader's own rules over the household as it would be, so a key saved here is one the next boot takes.
  const household = target ? people.map((person) => (person === target ? next : person)) : [...people, next];
  try {
    validatePeople(household);
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, error: err.message };
    throw err;
  }

  const changedAccounts = ids !== undefined || accounts.length !== held.length;
  const saved = await writeTo(
    file,
    dir,
    {
      key,
      name,
      // Only when the list was sent or grew: a save that says nothing about accounts leaves the line as written.
      ...(changedAccounts || !target ? { ids: accounts } : {}),
      ...(notes === undefined ? {} : { notes }),
    },
    held,
  );
  if (!saved.ok) return saved;

  // The running config's `[[people]]` is what the loader makes of the file now (`config/follow.ts`) — the operator
  // reads the file and the agent reads the memory, and the two cannot disagree. The person said back is that one.
  const saidBack = deps.config.people.find((person) => person.key === key) ?? next;

  log.info("person saved", { key, name, actor, ...(reattached ? { reattached } : {}) });
  // A key taken on with what it held is said in the record, beside who did it.
  deps.audit?.record(audit ?? { action: "person_saved", actor, details: { key, name, ...(reattached ? { reattached } : {}) } });
  return { ok: true, restartRequired: false, person: saidBack };
}

/**
 * Change one person's notes from what they read now — how an agent writes them.
 *
 * In turn with every other `[[people]]` write, so the notes `edit` is handed are the notes its result
 * replaces: a dashboard save cannot land in between, and neither can a second change from the same
 * turn. `edit` decides what changes; this only finds the person and writes.
 */
export async function updatePersonNotes(
  deps: PeopleWriteDeps,
  params: {
    key: string;
    edit: (notes: string) => { ok: true; notes: string } | { ok: false; error: string };
    actor?: string;
    /** The audit row for this change, in place of `person_saved` — asked for once `edit` has run. */
    audit?: () => AuditEntry;
  },
): Promise<{ ok: true; person: Person } | { ok: false; error: string }> {
  return await holdingConfigFile(deps, async (file) => {
    const person = peopleNow(deps).people.find((candidate) => candidate.key === params.key);
    if (!person) return { ok: false, error: "they are not in People" };
    const edited = params.edit(person.notes ?? "");
    if (!edited.ok) return edited;
    if (edited.notes === (person.notes ?? "").trim()) return { ok: true, person };
    const saved = await writePerson(
      deps,
      file,
      { person: { key: person.key, name: person.name, notes: edited.notes }, ...(params.actor ? { actor: params.actor } : {}) },
      params.audit?.(),
    );
    return saved.ok ? { ok: true, person: saved.person } : { ok: false, error: saved.error };
  });
}

/**
 * Take a person out of `[[people]]`, named by key or by an account they hold. Their memory stays under
 * their key, and the one who was removed is said back, so the caller can revoke what they held.
 */
export async function removePerson(deps: SettingsDeps, params: { person: string; actor?: string }): Promise<SavedPerson> {
  return await holdingConfigFile(deps, async (file): Promise<SavedPerson> => {
    const { actor } = params;
    if (!params.person?.trim()) return { ok: false, error: "a person key is required" };
    const { dir, people } = peopleNow(deps);
    const person = personByHandle(people, params.person);
    if (!person) return { ok: false, error: `nobody in People is "${params.person.trim()}"` };

    // Their file goes with its last version kept as a backup beside it; their block before the move.
    const saved = dir
      ? await file.editPerson(person.key, () => null)
      : await file.edit((source) => removePersonFromToml(source, { key: person.key, ...(person.ids ? { ids: person.ids } : {}) }));
    if (!saved.ok) return saved;

    log.info("person removed", { key: person.key, actor });
    deps.audit?.record({ action: "person_removed", actor, details: { key: person.key, name: person.name } });
    return { ok: true, restartRequired: false, person };
  });
}

/** A person's own memory setting over `[memory]`'s, and its value; null follows `[memory]` again. */
export type PersonMemorySetting = { field: "facts"; value: FactsMode | null } | { field: "recall"; value: boolean | null };

/**
 * One person's own memory setting written — the Memory page's, beside the rest of their entry and in turn with every
 * other `[[people]]` write.
 */
export async function writePersonMemory(
  deps: PeopleWriteDeps,
  key: string,
  setting: PersonMemorySetting,
): Promise<{ ok: true; previous: FactsMode | boolean | null } | { ok: false; error: string }> {
  return await holdingConfigFile(deps, async (file) => {
    // Looked up holding the file, not handed in: a person object read before the wait may be one a save has since
    // replaced — written back with its old name, and changed where the daemon no longer reads.
    const { dir, people } = peopleNow(deps);
    const person = people.find((candidate) => candidate.key === key);
    if (!person) return { ok: false, error: `nobody has the memory key "${key}"` };
    const previous = person[setting.field] ?? null;
    if (previous === setting.value) return { ok: true, previous };
    const change = setting.field === "facts" ? { facts: setting.value ?? "" } : { recall: setting.value };
    const saved = await writeTo(file, dir, { key: person.key, name: person.name, ...change }, idsOf(person));
    if (!saved.ok) return saved;
    return { ok: true, previous };
  });
}

/**
 * One person's morning line (0.8.0): its time, `"07:00"`, or null for none, and where it goes — one of their chat
 * accounts, or null for wherever they last wrote from; `to` left out keeps what was set. Beside the rest of their entry,
 * in turn with every other `[[people]]` write. The daemon reads the file again, so the next minute's look sees it.
 */
export async function writePersonMorning(
  deps: PeopleWriteDeps,
  key: string,
  line: { at: string | null; to?: string | null },
  actor: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { at } = line;
  if (at !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return { ok: false, error: `"${at}" is a time of day, HH:MM, such as "07:00"` };
  return await holdingConfigFile(deps, async (file) => {
    const { dir, people } = peopleNow(deps);
    const person = people.find((candidate) => candidate.key === key);
    if (!person) return { ok: false, error: `nobody has the key "${key}"` };
    // Off takes where it went with it: turned on again, it goes where they last wrote from until somebody picks.
    const to = at === null ? null : line.to === undefined ? (person.morningTo ?? null) : line.to;
    if (to !== null && (!idsOf(person).includes(to) || to.startsWith("web:"))) {
      return { ok: false, error: `"${to}" is not one of ${person.name}'s chat accounts: a telegram, discord or whatsapp one of their ids` };
    }
    if ((person.morning ?? null) === at && (person.morningTo ?? null) === to) return { ok: true };
    const saved = await writeTo(file, dir, { key: person.key, name: person.name, morning: at ?? "", morningTo: to ?? "" }, idsOf(person));
    if (!saved.ok) return saved;
    log.info(at ? "a morning line set" : "a morning line turned off", { key, at, to, actor });
    deps.audit?.record({ action: "person_morning_line", actor, details: { key, at, to } });
    return { ok: true };
  });
}

/**
 * The keys entries were read without, written into the file — once, at boot.
 *
 * Every entry has a key since 0.7.0: `readPeople` makes one from the name for an entry written without
 * one, in file order. Until it is in the file it depends on that order and on the name, and a person
 * whose key moved would lose their memory. A 0.5 entry has none, and neither does one an operator writes
 * by hand. By position, because a person added by name has no account to find their block by.
 *
 * A file that cannot be written — a read-only mount — is logged and left: the daemon still boots, and
 * the same keys are made again on the next read.
 */
export async function keyEveryone(deps: PeopleWriteDeps): Promise<number> {
  return await holdingConfigFile(deps, async (file) => {
    // A person in their own file is keyed by its name: there is nothing to write.
    if (peopleNow(deps).dir) return 0;
    try {
      let keyed = 0;
      // Kept once, before this start writes the keys in (REVIEW B2): only when it will.
      const current = (await readTextFileIfExists(deps.configPath)) ?? "";
      if (addMissingPeopleKeys(current, deps.config.people.map((person) => person.key)) !== current) await keepBefore(deps.configPath, VERSION);
      const saved = await file.edit((source) => {
        const written = addMissingPeopleKeys(source, deps.config.people.map((person) => person.key));
        keyed = written.split("\n").length - source.split("\n").length;
        return written;
      });
      if (!saved.ok) throw new Error(saved.error);
      if (!saved.changed) return 0;
      log.info("people written without a key were given one", { keyed });
      return keyed;
    } catch (err) {
      log.warn("people could not be given keys in the file: the config file was not written", { error: String(err) });
      return 0;
    }
  });
}

/** The comment the move puts above the `[[people]]` block it keeps (0.8.18): once, and found again by its first words. */
const MOVED = "# Moved to people/, one file each, by Nouride 0.8.18. Kept for the way back to 0.8.17, which reads it;";
const NOT_READ = "# not read while people/ exists, unless a version before 0.8.18 changes it: then the next start moves it again.";
/** Under the comment: what the block said when it was moved, as a print, so a change an older version makes is seen. */
const PRINT = "# moved as: ";

/**
 * The people a block says, as a print: each as the file the move writes for them, in key order. Their words, not the
 * file's layout: a version that lays `config.toml` out again without changing anyone is no change.
 */
function printOf(people: readonly Person[]): string {
  return sha256Text([...people].sort((a, b) => a.key.localeCompare(b.key)).map((person) => personFileText(person)).join("\n"));
}

/** The `[[people]]` block as `config.toml` holds it now, and the print the last move left under its comment. */
function keptBlock(source: string): { people: Person[]; print: string | null } {
  let raw: Record<string, unknown> = {};
  try {
    raw = parseToml<Record<string, unknown>>(source);
  } catch {
    // A file that does not parse is the loader's to refuse; here it is a block with nothing to move.
  }
  const people = Array.isArray(raw.people) ? readPeople(raw.people) : [];
  const print = source.split("\n").find((line) => line.startsWith(PRINT))?.slice(PRINT.length).trim() ?? null;
  return { people, print };
}

/**
 * The move (0.8.18, PLAN §2.1), at the first start that finds `[[people]]` and no `people/`: one file per person, then
 * the block marked as moved and kept, not deleted, so 0.8.17 started again by `nouride update --rollback` still reads it
 * and has its people, missing only what changed since. While `people/` exists the block is not read (the loader,
 * `configFrom`), and 0.9.0 refuses one left in `config.toml`. A folder made with nobody in it is the same answer for an
 * install with no people: from now on they are written there.
 *
 * And again whenever the block no longer says what it said when it was moved: a version before 0.8.18, started by a
 * rollback, wrote its People changes there, and the folder, untouched since, would hide them for good once this
 * version came back. Its people are then the newer and are written over their files, each replaced file kept in its
 * own backups; a person only the folder has is kept, since nothing says whether the block lost them or never had them.
 *
 * A file that cannot be written leaves the block as the source and the daemon booting: the next start tries again.
 */
export async function movePeopleToFiles(deps: PeopleWriteDeps): Promise<number> {
  return await holdingConfigFile(deps, async (file) => {
    const moved = peopleNow(deps).dir !== null;
    let people: Person[] = [...deps.config.people];
    if (moved) {
      const block = keptBlock((await readTextFileIfExists(deps.configPath)) ?? "");
      if (block.people.length === 0 || block.print === printOf(block.people)) return 0;
      people = block.people;
      const only = deps.config.people.filter((person) => !people.some((other) => other.key === person.key)).map((person) => person.key);
      log.warn("config.toml's people changed since they were moved, as a version before 0.8.18 writes them: moved again", {
        people: people.length,
        keptFromTheFolder: only,
        hint: "each person's file it replaced is kept beside it as <key>.toml.bak.1",
      });
    }
    try {
      ensureDir(peopleDirOf(deps.configPath), 0o750);
      for (const person of people) {
        const written = await file.editPerson(person.key, () => personFileText(person));
        if (!written.ok) throw new Error(`${person.key}: ${written.error}`);
      }
      if (people.length > 0) {
        // The file as 0.8.17 left it, kept once, before this start changes it (REVIEW B2).
        if (!moved) await keepBefore(deps.configPath, VERSION);
        const print = printOf(people);
        const marked = await file.edit((source) => markPeopleMoved(source, print));
        if (!marked.ok) throw new Error(marked.error);
      }
    } catch (err) {
      log.warn("people could not be moved to their own files: they stay in config.toml until the next start", { error: String(err) });
      return 0;
    }
    if (!moved) log.info("people moved to people/, one file each", { moved: people.length });
    return people.length;
  });
}

/** `source` with the moved-and-kept comment above its first `[[people]]`, and under it the print of what was moved. */
function markPeopleMoved(source: string, print: string): string {
  const lines = source.split("\n");
  const kept = lines.filter((line) => line !== MOVED && !line.startsWith("# not read while people/ exists") && !line.startsWith(PRINT));
  const at = kept.findIndex((line) => /^\[\[people\]\]/.test(line));
  if (at === -1) return source;
  kept.splice(at, 0, MOVED, NOT_READ, `${PRINT}${print}`);
  return kept.join("\n");
}

