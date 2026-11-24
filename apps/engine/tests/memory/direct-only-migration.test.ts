/**
 * The migration that gives a fact its mark for being kept to direct chats (`094_fact_direct_only.sql`): the facts an
 * install already indexed are left as they were, none of them marked, and the index reads and writes them as before.
 */

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase, removePath } from "@nouride/runtime";
import { MIGRATIONS } from "@/db/migrations.ts";
import { MemoryIndexStore } from "@/modules/memory/memory-index.store.ts";
import { tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => removePath(dir)));

test("the facts of an install from before the mark keep their readers, and none is kept to direct chats", () => {
  const dir = tempDir("direct-only");
  dirs.push(dir);
  const db = openDatabase(join(dir, "nouride.db"));
  for (const migration of MIGRATIONS.filter((one) => one.version < 94)) db.exec(migration.sql);
  const insert = db.prepare("INSERT INTO memory_facts (id, subject, position, section, text, source, readers, readers_chat) VALUES (?, 'gading', ?, 'Vehicles', ?, NULL, ?, ?)");
  insert.run("f1", 0, "Said in a direct chat.", ",gading,", null);
  insert.run("f2", 1, "Said in the family group.", ",gading,sam,", "whatsapp:main:1203@g.us");
  insert.run("f3", 2, "Written by hand.", null, null);

  db.exec(MIGRATIONS.find((one) => one.version === 94)!.sql);

  const index = new MemoryIndexStore(db);
  expect(index.facts(["gading"]).map((fact) => ({ text: fact.text, readers: fact.readers }))).toEqual([
    { text: "Said in a direct chat.", readers: { people: ["gading"] } },
    { text: "Said in the family group.", readers: { people: ["gading", "sam"], chat: "whatsapp:main:1203@g.us" } },
    { text: "Written by hand.", readers: undefined },
  ]);
  db.close();
});
