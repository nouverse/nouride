/**
 * The index sync reads a stub folder again only when a stub in it changed (M10). It read every tag and
 * group stub on every sync — at boot, before each pass, after each tidy — like it stats every episode,
 * but with no record of what it had read.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { readTextFileIfExists, writeTextFile } from "@nouride/runtime";
import { ensureStubs } from "@/modules/memory/graph.ts";
import { household, type Household } from "./fixture.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
});

afterEach(() => h.close());

const stub = (alias: string) => `---\ntype: tag\naliases: [${alias}]\n---\n`;
const aliases = () => h.db.prepare<{ alias: string; tag: string }>("SELECT alias, tag FROM memory_tag_aliases").all();

test("a tag folder whose stubs are as they were is not read again; one stub changed, and it is", async () => {
  const file = h.vault.tag("laptop");
  // A whole second, so the time written back below is exactly the one read.
  const mtime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  await writeTextFile(file, stub("notebook"));
  utimesSync(file, mtime, mtime);
  await h.memory.sync();
  expect(aliases()).toEqual([{ alias: "notebook", tag: "laptop" }]);

  // The same size and the same time: to the sync, the same file — so it is not read, and what it says now is not seen.
  await writeTextFile(file, stub("netbooks"));
  utimesSync(file, mtime, mtime);
  await h.memory.sync();
  expect(aliases()).toEqual([{ alias: "notebook", tag: "laptop" }]);

  utimesSync(file, mtime, new Date(mtime.getTime() + 5_000));
  await h.memory.sync();
  expect(aliases()).toEqual([{ alias: "netbooks", tag: "laptop" }]);
});

test("a stub added or removed is read, the folder whole", async () => {
  await writeTextFile(h.vault.tag("laptop"), stub("notebook"));
  await h.memory.sync();
  await writeTextFile(h.vault.tag("phone"), stub("handphone"));
  await h.memory.sync();
  expect(aliases().map((row) => row.alias).sort()).toEqual(["handphone", "notebook"]);
});

test("a stub a person edited is never written over by the next conversation that needs it", async () => {
  // `ensureStubs` writes a stub once, when first needed. With that check deleted every stub was rewritten
  // whenever a conversation linked to it — a renamed group, a tag's aliases, gone — and no test noticed.
  const episode = { agents: ["nouva"], chat: "telegram:nouva:-1001", group: "family", tags: ["laptop"] };
  await ensureStubs(h.vault, episode, () => true);
  await writeTextFile(h.vault.tag("laptop"), stub("notebook"));
  await writeTextFile(h.vault.group("family"), "---\ntype: group\nchat: telegram:nouva:-1001\n---\nThe Nasution family.\n");

  await ensureStubs(h.vault, episode, () => true);

  expect(await readTextFileIfExists(h.vault.tag("laptop"))).toBe(stub("notebook"));
  expect(await readTextFileIfExists(h.vault.group("family"))).toContain("The Nasution family.");
});
