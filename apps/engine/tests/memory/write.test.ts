/**
 * Every write to the vault comes through `write.ts`, and each keeps the promises a write here makes: it waits for
 * the file's lock, so no two writers lose each other's change; the index says what the file says the moment it is
 * written, so a search after it finds it; a profile keeps the text it replaced, for Undo. Each call site used to keep
 * these by hand, and each kept a different part — a tag tidy indexed after letting go of the lock, and compaction
 * wrote its archive copy before taking it.
 *
 * What a change to a fact records is `changes.test.ts`'s, writer by writer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { withFileLock } from "@/commons/file-lock.ts";
import type { Episode } from "@/modules/memory/episode.ts";
import { memoryFileVersions } from "@/modules/memory/history.ts";
import { compactEpisodes } from "@/modules/memory/maintain.ts";
import { MemoryIndexStore } from "@/modules/memory/memory-index.store.ts";
import { MemoryStateStore } from "@/modules/memory/memory-state.store.ts";
import { changeEpisode, editProfile, removeEpisode, removeProfile, rewriteProfile, undoProfile, writeEpisode, writeSide, type ProfileWrites } from "@/modules/memory/write.ts";
import { sleep } from "../helpers.ts";
import { household, type Household } from "./fixture.ts";

let h: Household;
let deps: ProfileWrites & { index: MemoryIndexStore };

beforeEach(async () => {
  h = await household();
  deps = { vault: h.vault, index: new MemoryIndexStore(h.db), state: new MemoryStateStore(h.db), now: () => h.clock.now };
});

afterEach(() => h.close());

const ID = "2026-09-25-0900-nouva";
const episode: Episode = {
  id: ID,
  status: "summarized",
  kind: "dm",
  chat: "telegram:nouva:814",
  started: "2026-09-25T09:00:00+07:00",
  ended: "2026-09-25T09:05:00+07:00",
  day: "2026-09-25",
  agents: ["nouva"],
  people: ["gading"],
  mentions: [],
  tags: ["laptop"],
  related: [],
  summary: "Gading uses a MacBook.",
  transcript: "09:00 · Gading\nPakai MacBook\n",
};
const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null);
const add = (text: string) => ({ operations: [{ op: "add" as const, section: "Work", text }], provenance: { readers: { people: ["gading"] } }, cause: "agent" as const });

/** `write` run while another writer holds `file`'s lock: the file as it was while it waited, and after. */
async function whileHeld(file: string, write: () => Promise<unknown>): Promise<{ during: string | null; after: string | null }> {
  let release!: () => void;
  const held = withFileLock(file, () => new Promise<void>((resolve) => (release = resolve)));
  const writing = write();
  // A fixed sleep: what it shows is a write that did not happen, which no condition can wait for.
  await sleep(20);
  const during = read(file);
  release();
  await held;
  await writing;
  return { during, after: read(file) };
}

describe("each write waits for the file's lock", () => {
  test("an episode: written, changed, removed", async () => {
    const file = h.vault.episode(ID);
    expect(await whileHeld(file, () => writeEpisode(deps, episode))).toMatchObject({ during: null, after: expect.stringContaining("Gading uses a MacBook.") });
    const changed = await whileHeld(file, () => changeEpisode(deps, ID, (current) => ({ ...current, summary: "Gading uses a ThinkPad." })));
    expect(changed.during).toContain("Gading uses a MacBook.");
    expect(changed.after).toContain("Gading uses a ThinkPad.");
    expect(await whileHeld(file, () => removeEpisode(deps, ID))).toMatchObject({ during: expect.stringContaining("ThinkPad"), after: null });
  });

  test("a profile: edited, rewritten, undone, removed", async () => {
    const file = h.vault.person("gading");
    const edited = await whileHeld(file, () => editProfile(deps, "gading", add("Uses a MacBook.")));
    expect(edited).toMatchObject({ during: null, after: expect.stringContaining("Uses a MacBook.") });
    const rewritten = await whileHeld(file, () => rewriteProfile(deps, "gading", (existing) => ({ text: existing.replace("MacBook", "ThinkPad") })));
    expect(rewritten.during).toContain("MacBook");
    expect(rewritten.after).toContain("ThinkPad");
    const undone = await whileHeld(file, () => undoProfile(deps, "gading"));
    expect(undone.during).toContain("ThinkPad");
    expect(undone.after).toContain("MacBook");
    expect(await whileHeld(file, () => removeProfile(deps, "gading"))).toMatchObject({ during: expect.stringContaining("MacBook"), after: null });
  });

  test("a file beside them", async () => {
    const file = h.vault.tag("laptop");
    expect(await whileHeld(file, () => writeSide(file, () => "a stub\n"))).toEqual({ during: null, after: "a stub\n" });
  });

  test("compaction makes its archive copy under the episode's lock — made before it, a delete in between left the transcript behind", async () => {
    await writeEpisode(deps, episode);
    const archive = h.vault.archive(ID);
    let release!: () => void;
    const held = withFileLock(h.vault.episode(ID), () => new Promise<void>((resolve) => (release = resolve)));
    const compacting = compactEpisodes({ ...deps, before: Date.parse("2026-10-01T00:00:00Z"), archive: true });
    // A fixed sleep, as above: a copy not made while the lock is held.
    await sleep(20);
    expect(existsSync(archive)).toBe(false);
    release();
    await held;
    expect(await compacting).toMatchObject({ compacted: 1 });
    expect(existsSync(archive)).toBe(true);
  });
});

describe("the index says what the file says, with no sync between", () => {
  test("an episode written, changed and removed", async () => {
    await writeEpisode(deps, episode);
    expect(deps.index.episodesById([ID]).map((found) => found.summary)).toEqual(["Gading uses a MacBook."]);
    await changeEpisode(deps, ID, (current) => ({ ...current, summary: "Gading uses a ThinkPad." }));
    expect(deps.index.episodesById([ID]).map((found) => found.summary)).toEqual(["Gading uses a ThinkPad."]);
    await removeEpisode(deps, ID);
    expect(deps.index.episodesById([ID])).toEqual([]);
  });

  test("a profile's facts edited, undone and removed", async () => {
    const facts = () => deps.index.facts(["gading"]).map((fact) => fact.text);
    await editProfile(deps, "gading", add("Uses a MacBook."));
    await editProfile(deps, "gading", add("Likes coffee."));
    expect(facts()).toEqual(["Uses a MacBook.", "Likes coffee."]);
    expect(await undoProfile(deps, "gading")).toBe(true);
    expect(facts()).toEqual(["Uses a MacBook."]);
    await removeProfile(deps, "gading");
    expect(facts()).toEqual([]);
  });
});

describe("what a write keeps, and what it leaves alone", () => {
  test("a profile keeps the text each change replaced; one that changes nothing writes nothing and records nothing", async () => {
    const file = h.vault.person("gading");
    await editProfile(deps, "gading", add("Uses a MacBook."));
    await editProfile(deps, "gading", add("Likes coffee."));
    expect(memoryFileVersions(h.vault, file)).toHaveLength(1);
    const before = { text: read(file), changes: h.memory.changes({ limit: 10 }).length };
    expect(await editProfile(deps, "gading", add("Likes coffee."))).toMatchObject({ status: "unchanged", applied: 0 });
    expect(memoryFileVersions(h.vault, file)).toHaveLength(1);
    expect({ text: read(file), changes: h.memory.changes({ limit: 10 }).length }).toEqual(before);
  });

  test("a change that must not be undone keeps no version", async () => {
    const file = h.vault.person("gading");
    await editProfile(deps, "gading", add("Uses a MacBook."));
    await rewriteProfile(deps, "gading", (existing) => ({ text: existing.replace("- Uses a MacBook.", "") }), { keepVersion: false });
    expect(memoryFileVersions(h.vault, file)).toEqual([]);
  });

  test("a one-line change that leaves no episode behind is not written", async () => {
    await writeEpisode(deps, episode);
    const before = read(h.vault.episode(ID));
    expect(await changeEpisode(deps, ID, (_current, text) => text.replace("status: summarized", "status: lost"))).toMatchObject({ status: "summarized" });
    expect(read(h.vault.episode(ID))).toBe(before);
  });
});
