/**
 * People, one file each (0.8.18, PLAN §2.1, REVIEW B2): `people/<key>.toml` beside `config.toml`. The move on a real
 * config's people and the block kept for the way back; the loader reading the folder and leaving a file that does not
 * load out by name; every write landing in the person's own file, patched from what is on disk so a hand edit stays;
 * two writers at once; an account claimed in two files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigText } from "@/modules/config/global/index.ts";
import {
  movePeopleToFiles,
  removePerson,
  savePerson,
  updatePersonNotes,
  writePersonMorning,
  type PeopleWriteDeps,
} from "@/modules/config/settings/people.ts";
import { readPeopleDir } from "@/modules/people/files.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";
import { VERSION } from "@/cli/version.ts";

/** A household as the live box's config holds it: comments, a person by name only, notes over lines, a morning line. */
const REAL = `[daemon]
name = "home"

# Who the agents talk to.
[[people]]
key = "gading"
name = "Gading"
ids = ["telegram:555", "web:usr_1"]
notes = """
Owner. Prefers Indonesian.
"""
morning = "07:00"
morning_to = "telegram:555"

[[people]]
key = "ani"
name = "Ani"
ids = ["whatsapp:62811@s.whatsapp.net"]
facts = "ask"
recall = false

[[people]]
key = "budi"
name = "Budi"
`;

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function install(text = REAL): PeopleWriteDeps & { dir: string } {
  dir = mkdtempSync(join(tmpdir(), "people-files-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, text);
  return { dir: join(dir, "people"), config: readConfigText(text, configPath), configPath } as PeopleWriteDeps & { dir: string };
}

const file = (deps: { dir: string }, key: string) => readFileSync(join(deps.dir, `${key}.toml`), "utf8");
/** As data, by key: the folder is read in key order, the block in the order it was written; nothing reads the order. */
const strip = (people: readonly { key: string }[]) => JSON.parse(JSON.stringify([...people].sort((a, b) => a.key.localeCompare(b.key))));

describe("the move", () => {
  test("writes one file per person, keeps the block marked for the way back, and reads back the same household", async () => {
    const deps = install();
    const before = strip(deps.config.people);
    expect(await movePeopleToFiles(deps)).toBe(3);
    expect(file(deps, "gading")).toContain('[person]\nname = "Gading"\nids = ["telegram:555", "web:usr_1"]');
    expect(file(deps, "ani")).toContain('facts = "ask"\nrecall = false');
    expect(file(deps, "budi")).toContain('name = "Budi"');
    // The running daemon's people, and a fresh read of the install, are the household as it was.
    expect(strip(deps.config.people)).toEqual(before);
    const text = readFileSync(deps.configPath, "utf8");
    expect(strip(readConfigText(text, deps.configPath).people)).toEqual(before);
    // The block is kept and marked: 0.8.17, with no people/ beside it, reads exactly the household that was moved.
    expect(text).toContain("# Moved to people/, one file each, by Nouride 0.8.18.");
    // And the file exactly as 0.8.17 left it, kept once before this start changed it.
    expect(readFileSync(`${deps.configPath}.before-${VERSION}`, "utf8")).toBe(REAL);
    expect(text).toContain('[[people]]\nkey = "gading"');
    const elsewhere = mkdtempSync(join(tmpdir(), "people-way-back-"));
    try {
      writeFileSync(join(elsewhere, "config.toml"), text);
      expect(strip(readConfigText(text, join(elsewhere, "config.toml")).people)).toEqual(before);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("runs once: a second start finds the folder and moves nothing", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    const text = readFileSync(deps.configPath, "utf8");
    expect(await movePeopleToFiles(deps)).toBe(0);
    expect(readFileSync(deps.configPath, "utf8")).toBe(text);
  });

  test("a block an older version changed after the move is moved again, each file it replaces kept beside it", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    // Added on 0.8.18 before a rollback: only the folder has this person.
    expect((await savePerson(deps, { person: { name: "Dedi", ids: ["telegram:888"] } })).ok).toBe(true);
    // Then 0.8.17, started by the rollback, writes its People changes into the block it reads.
    const rolledBack = readFileSync(deps.configPath, "utf8").replace('name = "Ani"', 'name = "Ani Lestari"') + '\n[[people]]\nkey = "citra"\nname = "Citra"\n';
    writeFileSync(deps.configPath, rolledBack);
    // 0.8.18 again: its loader reads the folder, and the move sees the block is not what it moved.
    const again = { ...deps, config: readConfigText(rolledBack, deps.configPath) } as PeopleWriteDeps & { dir: string };
    expect(await movePeopleToFiles(again)).toBe(4);
    expect(file(deps, "ani")).toContain('name = "Ani Lestari"');
    expect(readFileSync(join(deps.dir, "ani.toml.bak.1"), "utf8")).toContain('name = "Ani"\n');
    expect(file(deps, "citra")).toContain('name = "Citra"');
    expect(file(deps, "dedi")).toContain('name = "Dedi"');
    expect(again.config.people.map((person) => person.key).sort()).toEqual(["ani", "budi", "citra", "dedi", "gading"]);
    expect(again.config.people.find((person) => person.key === "ani")?.name).toBe("Ani Lestari");
    // Moved as it reads now: the next start has nothing to do.
    const marked = readFileSync(deps.configPath, "utf8");
    expect(marked.match(/^# moved as: [0-9a-f]{64}$/gm)).toHaveLength(1);
    expect(await movePeopleToFiles({ ...again, config: readConfigText(marked, deps.configPath) } as PeopleWriteDeps)).toBe(0);
  });

  test("a block laid out again without changing anyone is no change, and the folder's newer word stays", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    expect((await updatePersonNotes(deps, { key: "budi", edit: () => ({ ok: true, notes: "Plays chess." }) })).ok).toBe(true);
    const relaid = readFileSync(deps.configPath, "utf8").replace('name = "Budi"', 'name = "Budi"   # the brother').replace("[[people]]\nkey = \"ani\"", "\n\n[[people]]\nkey = \"ani\"");
    writeFileSync(deps.configPath, relaid);
    expect(await movePeopleToFiles({ ...deps, config: readConfigText(relaid, deps.configPath) } as PeopleWriteDeps)).toBe(0);
    expect(file(deps, "budi")).toContain("Plays chess.");
  });

  test("an install with nobody gets the folder, so the first person added is written there", async () => {
    const deps = install('[daemon]\nname = "home"\n');
    expect(await movePeopleToFiles(deps)).toBe(0);
    expect(existsSync(deps.dir)).toBe(true);
    const saved = await savePerson(deps, { person: { name: "Citra", ids: ["telegram:777"] } });
    expect(saved.ok).toBe(true);
    expect(file(deps, "citra")).toContain('name = "Citra"');
    expect(readFileSync(deps.configPath, "utf8")).not.toContain("[[people]]");
  });
});

describe("the loader, once people/ is there", () => {
  test("reads the folder, not the kept block, even when the block was edited past loading since", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    // A bare id, and the `id =` form 0.8.0 refuses before anything else is read: neither stops a load that does not read them.
    const broken = readFileSync(deps.configPath, "utf8").replace('ids = ["telegram:555", "web:usr_1"]', 'ids = ["555"]\nid = "telegram:555"');
    expect(readConfigText(broken, deps.configPath).people.map((person) => person.key)).toEqual(["ani", "budi", "gading"]);
  });

  test("a file that does not load is named and that person left out; everyone else loads", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    writeFileSync(join(deps.dir, "dewi.toml"), "[person\nname = ");
    const read = readPeopleDir(deps.dir)!;
    expect(read.people.map((person) => person.key)).toEqual(["ani", "budi", "gading"]);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]).toStartWith("people/dewi.toml: it is not TOML");
    expect(read.problems[0]).toEndWith("that person is left out until it loads");
    expect(readConfigText(readFileSync(deps.configPath, "utf8"), deps.configPath).people).toHaveLength(3);
  });

  test("an account claimed in two files: the second file in key order is left out, naming who holds it", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    writeFileSync(join(deps.dir, "zara.toml"), '[person]\nname = "Zara"\nids = ["telegram:555"]\n');
    const read = readPeopleDir(deps.dir)!;
    expect(read.people.map((person) => person.key)).not.toContain("zara");
    expect(read.problems).toEqual(['people/zara.toml: people/zara.toml id "telegram:555" is already claimed by Gading: one of the two would never match; that person is left out until it loads']);
  });

  test("a backup or a stray file beside the people is not a person", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    writeFileSync(join(deps.dir, "gading.toml.bak.1"), '[person]\nname = "Old"\n');
    writeFileSync(join(deps.dir, ".gading.toml.swp"), "x");
    mkdirSync(join(deps.dir, "notes"));
    expect(readPeopleDir(deps.dir)!.people.map((person) => person.key)).toEqual(["ani", "budi", "gading"]);
  });
});

describe("a write, once people/ is there", () => {
  test("lands in the person's own file, with the last version kept beside it, and config.toml untouched", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    const config = readFileSync(deps.configPath, "utf8");
    const saved = await savePerson(deps, { person: { key: "budi", name: "Budi", notes: "Plays chess." } });
    expect(saved.ok).toBe(true);
    expect(file(deps, "budi")).toContain('notes = "Plays chess."');
    expect(readFileSync(join(deps.dir, "budi.toml.bak.1"), "utf8")).not.toContain("Plays chess");
    expect(readFileSync(deps.configPath, "utf8")).toBe(config);
    expect(deps.config.people.find((person) => person.key === "budi")?.notes).toBe("Plays chess.");
  });

  test("patches what is on disk: a name and a comment edited by hand stay through the next save (REVIEW B2)", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    const running = deps.config.people;
    writeFileSync(join(deps.dir, "ani.toml"), file(deps, "ani").replace('name = "Ani"', '# her nickname at home\nname = "Ani Sari"'));
    const noted = await updatePersonNotes(deps, { key: "ani", edit: (notes) => ({ ok: true, notes: `${notes}Likes tea.`.trim() }) });
    expect(noted.ok).toBe(true);
    expect(file(deps, "ani")).toContain('# her nickname at home\nname = "Ani Sari"');
    expect(file(deps, "ani")).toContain('notes = "Likes tea."');
    // The running daemon follows the folder, in place.
    expect(deps.config.people).toBe(running);
    expect(deps.config.people.find((person) => person.key === "ani")?.name).toBe("Ani Sari");
  });

  test("two writers at once on one person: both land", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    const [notes, morning] = await Promise.all([
      updatePersonNotes(deps, { key: "ani", edit: () => ({ ok: true, notes: "Works nights." }) }),
      writePersonMorning(deps, "ani", { at: "06:30" }, "test"),
    ]);
    expect(notes.ok && morning.ok).toBe(true);
    expect(file(deps, "ani")).toContain('notes = "Works nights."');
    expect(file(deps, "ani")).toContain('morning = "06:30"');
  });

  test("an account another person's file holds is refused, also when that file was edited by hand", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    writeFileSync(join(deps.dir, "budi.toml"), '[person]\nname = "Budi"\nids = ["discord:42"]\n');
    const saved = await savePerson(deps, { person: { key: "ani", name: "Ani", ids: ["whatsapp:62811@s.whatsapp.net", "discord:42"] } });
    expect(saved).toEqual({ ok: false, field: "ids", error: "discord:42 already belongs to Budi" });
  });

  test("removing a person removes their file, its last version kept as a backup", async () => {
    const deps = install();
    await movePeopleToFiles(deps);
    const removed = await removePerson(deps as unknown as SettingsDeps, { person: "budi" });
    expect(removed.ok).toBe(true);
    expect(existsSync(join(deps.dir, "budi.toml"))).toBe(false);
    expect(readFileSync(join(deps.dir, "budi.toml.bak.1"), "utf8")).toContain('name = "Budi"');
    expect(deps.config.people.map((person) => person.key)).toEqual(["ani", "gading"]);
  });
});
