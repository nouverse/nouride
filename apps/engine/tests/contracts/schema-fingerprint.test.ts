/**
 * The rule "never edit an applied migration", enforced rather than remembered.
 *
 * `user_version` records how many migrations have run and never what they said, which is what makes
 * forward-only cheap — and what makes editing an applied one silent. Every existing install keeps
 * the old schema, every fresh one gets the new, nothing notices, and the two diverge until a query
 * fails somewhere unrelated.
 *
 * That was a note in a doc while every install was one box somebody could ssh into. It stops being
 * survivable the moment this ships: a rented container or a sold device is a database at some
 * version applied by some earlier build, and a binary whose migrations disagree with what that file
 * actually had applied will query a schema it is wrong about.
 *
 * In `application_id` rather than a checksum table, which keeps TD-005's reasoning instead of
 * working around it — and a table would be circular anyway, since introducing it is itself a
 * migration that cannot verify itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { MIGRATIONS } from "@/db/migrations.ts";
import {
  adoptSchema,
  assertSchemaMatches,
  migrate,
  schemaFingerprint,
  SchemaDriftError,
} from "@/db/index.ts";

/**
 * What the installs in the field hold, written down rather than computed.
 *
 * Every other check here computes the expected fingerprint from this build's own migrations, so editing an applied
 * one — a stale comment in it looks like a fair target for a sweep — changes both sides together and stays green,
 * while every install upgrading to that build refuses to start. Comments count: the SQL is the file as written.
 * 69 is what 0.8.0 stamped on every database it ran on — a new one, or one it brought from 0.7.28's 68 — computed from
 * 0.8.0's own chain (`068_baseline.sql` at 1737727765, then `069_missions_automations.sql`) before the two were folded
 * into `069_baseline.sql`. A migration after the baseline adds its own line here once it ships: 70 to 74 shipped
 * without theirs, and were written in 0.8.17 from the files as each release carried them.
 */
const SHIPPED: Record<number, number> = {
  69: -804988230,
  70: 790383837, // 0.8.7
  71: 783331231, // 0.8.9
  72: -141566156, // 0.8.10
  73: -1799595340, // 0.8.11
  74: 1180533290, // 0.8.13
  75: -1156557488, // 0.8.17
};

/**
 * The baseline's bytes. It states the chain's fingerprint rather than hashing its own text (`schemaFingerprint`), so
 * an edit to it would change no fingerprint — this is what notices one.
 */
const BASELINE_SHA256 = "463e521f032800abfef43d9b913de30e6555a112015cb4801184393aae9084d9";

describe("the migrations installs already applied", () => {
  test("are byte for byte what they were — an applied migration is never edited, comments included", () => {
    const now = Object.fromEntries(Object.keys(SHIPPED).map((version) => [version, schemaFingerprint(MIGRATIONS, Number(version))]));
    const baseline = createHash("sha256").update(MIGRATIONS[0]!.sql).digest("hex");
    if (JSON.stringify(now) !== JSON.stringify(SHIPPED) || baseline !== BASELINE_SHA256) {
      console.error("an applied migration was edited — revert it. A stale comment in one is corrected in the *.store.ts that owns the table.");
    }
    expect(now).toEqual(SHIPPED);
    expect(baseline).toBe(BASELINE_SHA256);
  });
});

let dir: string;
let db: SqliteDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-fingerprint-"));
  db = openDatabase(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A manifest with several entries, because the repository's has one.
 *
 * These four properties are about `schemaFingerprint`, not about this build's migration list — and
 * writing them against the real list was a mistake the squash exposed: with everything folded into
 * one baseline, "edit migration 3" and "slice to the first ten" both became no-ops and three tests
 * passed by asserting a value against itself. A synthetic manifest says what is actually meant.
 */
const CHAIN = [
  { version: 1, name: "001_init.sql", sql: "CREATE TABLE a (id TEXT PRIMARY KEY);" },
  { version: 2, name: "002_more.sql", sql: "CREATE TABLE b (id TEXT PRIMARY KEY);" },
  { version: 3, name: "003_index.sql", sql: "CREATE INDEX idx_a ON a (id);" },
] as const;

describe("the fingerprint itself", () => {
  test("is never zero, because zero is how 'not set' is recognised", () => {
    // A fingerprint that folded to 0 would read as an install from before the check existed and be
    // adopted rather than compared — the one value that must not be reachable.
    expect(schemaFingerprint(MIGRATIONS, 69)).not.toBe(0);
    expect(schemaFingerprint([], 0)).not.toBe(0);
  });

  test("changes when a migration's text changes", () => {
    // Including a change that alters nothing a database would enforce. A comment edit on an applied
    // migration is the exact thing that happened to `002_exec_grants.sql` when the product was
    // renamed, and it went unnoticed for weeks — see `baseline-schema.test.ts`.
    const edited = CHAIN.map((m) =>
      m.version === 2 ? { ...m, sql: `${m.sql}\n-- a harmless-looking comment\n` } : m,
    );
    expect(schemaFingerprint(edited, 3)).not.toBe(schemaFingerprint(CHAIN, 3));
  });

  test("changes when one is renamed or renumbered", () => {
    // The same class of mistake as editing the body, and it produces the same silent divergence —
    // so the version and the filename are in the hash, not only the SQL.
    const renamed = CHAIN.map((m) => (m.version === 2 ? { ...m, name: "002_renamed.sql" } : m));
    expect(schemaFingerprint(renamed, 3)).not.toBe(schemaFingerprint(CHAIN, 3));

    const renumbered = CHAIN.map((m) => (m.version === 2 ? { ...m, version: 9 } : m));
    expect(schemaFingerprint(renumbered, 9)).not.toBe(schemaFingerprint(CHAIN, 3));
  });

  test("of a baseline that states one, is that one — and what follows it is folded onto it", () => {
    // A baseline folded from a chain this build no longer has: a database at its version holds the chain's
    // fingerprint, so that is what the baseline says it is, whatever its own text hashes to.
    const base = { version: 10, name: "010_baseline.sql", sql: "CREATE TABLE a (id TEXT PRIMARY KEY);", fingerprint: 4242 };
    const next = { version: 11, name: "011_more.sql", sql: "CREATE TABLE b (id TEXT PRIMARY KEY);" };
    expect(schemaFingerprint([base], 10)).toBe(4242);
    expect(schemaFingerprint([base, next], 10)).toBe(4242);
    expect(schemaFingerprint([base, next], 11)).not.toBe(4242);
    // A later one's text counts, and so does the fingerprint it is folded onto.
    expect(schemaFingerprint([base, { ...next, sql: `${next.sql}\n-- edited\n` }], 11)).not.toBe(schemaFingerprint([base, next], 11));
    expect(schemaFingerprint([{ ...base, fingerprint: 4243 }, next], 11)).not.toBe(schemaFingerprint([base, next], 11));
  });

  test("only covers what has actually been applied", () => {
    /**
     * The property that makes an upgrade possible at all. A box at version 2 must fingerprint the
     * same under a build carrying three migrations as under the build that carried two — otherwise
     * every upgrade would look like drift and refuse to start.
     */
    expect(schemaFingerprint(CHAIN, 2)).toBe(schemaFingerprint(CHAIN.slice(0, 2), 2));
    expect(schemaFingerprint(CHAIN, 2)).not.toBe(schemaFingerprint(CHAIN, 3));
  });
});

describe("what a boot does with it", () => {
  test("a fresh database is stamped, and boots again cleanly", async () => {
    await migrate(db);
    expect(db.applicationId()).toBe(schemaFingerprint(MIGRATIONS, db.userVersion()));

    // The second boot is the one that matters: it compares rather than adopting.
    await migrate(db);
    expect(db.applicationId()).toBe(schemaFingerprint(MIGRATIONS, db.userVersion()));
  });

  test("an unset fingerprint on a database with a schema is a mismatch, not adopted", async () => {
    // Adopted once, for installs from before the check existed; 0.8.0 stamped every database it ran on, and the floor
    // is that it ran. `nouride db adopt` is the way past, on a person's word.
    await migrate(db);
    db.setApplicationId(0);

    expect(() => assertSchemaMatches(db)).toThrow(SchemaDriftError);
    expect(db.applicationId()).toBe(0);
  });

  test("a database whose applied migrations disagree refuses to boot", async () => {
    await migrate(db);
    // What an edited migration looks like from the daemon's side: same version, different content.
    db.setApplicationId(12345);

    expect(() => assertSchemaMatches(db)).toThrow(SchemaDriftError);
    try {
      assertSchemaMatches(db);
    } catch (err) {
      const message = String(err);
      // The message has to carry all three numbers and both ways out, because the person reading it
      // is looking at a box that will not start.
      expect(message).toContain("not the ones in this build");
      expect(message).toContain("nouride db list");
      expect(message).toContain("NOURIDE_ALLOW_SCHEMA_DRIFT");
    }
  });

  test("nothing is applied on top of a schema this build is wrong about", async () => {
    /**
     * The check runs *before* the migrations, so a build carrying an edited migration cannot write
     * a further one over a schema it already disagrees with. Asserted by the version not moving.
     */
    await migrate(db);
    const version = db.userVersion();
    db.setApplicationId(999);

    await expect(migrate(db)).rejects.toThrow(SchemaDriftError);
    expect(db.userVersion()).toBe(version);
  });

  test("`nouride db adopt` accepts this build's schema, and the next boot is quiet", async () => {
    /**
     * The escape hatch the squash needed. Folding thirty-two migrations into one baseline changes
     * the fingerprint of a schema that did not change at all, so every install from before the
     * squash refuses until somebody confirms the new file describes what they already have.
     *
     * A command rather than an automatic step, because the check cannot tell "an applied migration
     * was edited" from "the schema was deliberately rewritten and this build is right" — only a
     * person can. Adopting silently whenever the version matched would be the check switching
     * itself off in the case it exists for.
     */
    await migrate(db);
    db.setApplicationId(777);
    expect(() => assertSchemaMatches(db)).toThrow(SchemaDriftError);

    adoptSchema(db);
    expect(() => assertSchemaMatches(db)).not.toThrow();
    expect(db.applicationId()).toBe(schemaFingerprint(MIGRATIONS, db.userVersion()));
  });

  test("the override starts the daemon and does not make the mismatch go away", async () => {
    await migrate(db);
    db.setApplicationId(4242);

    process.env.NOURIDE_ALLOW_SCHEMA_DRIFT = "1";
    try {
      expect(() => assertSchemaMatches(db)).not.toThrow();
      // Not adopted. The override is for getting a box up while somebody works out which build is
      // the right one — adopting would silently make the next boot agree with the wrong answer.
      expect(db.applicationId()).toBe(4242);
      // Nor by a boot with nothing to apply, which stamped the fingerprint until 0.8.0.
      expect(await migrate(db)).toBe(0);
      expect(db.applicationId()).toBe(4242);
    } finally {
      delete process.env.NOURIDE_ALLOW_SCHEMA_DRIFT;
    }

    expect(() => assertSchemaMatches(db)).toThrow(SchemaDriftError);
  });
});

/**
 * A database at a version a squash folded away — anything below 69, the baseline's: a release before 0.8.0 left it,
 * or a development box stopped between two migrations. Nothing here takes it forward, and every way past the
 * fingerprint (`adopt`, the override) would only reach SQLite's "table already exists", so it is refused first, with
 * the way across (`db-floor.test.ts` has the rest of the floor).
 */
describe("a version a squash folded away", () => {
  test("is refused before the fingerprint, by adopt, and past the override — and left as it was", async () => {
    db.exec("CREATE TABLE marker (x)");
    db.setUserVersion(38);
    db.setApplicationId(12345);
    const floor = /schema 38, from before 0\.8\.0, .* Install 0\.8\.0 first/;
    expect(() => assertSchemaMatches(db)).toThrow(floor);
    expect(() => adoptSchema(db)).toThrow(floor);
    process.env.NOURIDE_ALLOW_SCHEMA_DRIFT = "1";
    try {
      await expect(migrate(db)).rejects.toThrow(floor);
    } finally {
      delete process.env.NOURIDE_ALLOW_SCHEMA_DRIFT;
    }
    expect({ version: db.userVersion(), id: db.applicationId() }).toEqual({ version: 38, id: 12345 });
  });

  test("0.8.0's fold too: a database 0.7.27 left at 67", () => {
    db.setUserVersion(67);
    db.setApplicationId(12345);
    expect(() => assertSchemaMatches(db)).toThrow(/schema 67, from before 0\.8\.0/);
    expect(() => adoptSchema(db)).toThrow(/schema 67, from before 0\.8\.0/);
  });

  test("0.8.1's fold: a database the last 0.7.x left at 68, holding 0.7.28's fingerprint, is refused and kept", () => {
    db.setUserVersion(68);
    db.setApplicationId(1737727765);
    expect(() => assertSchemaMatches(db)).toThrow(/schema 68, from before 0\.8\.0, .* Install 0\.8\.0 first/);
    expect(() => adoptSchema(db)).toThrow(/schema 68, from before 0\.8\.0/);
    expect({ version: db.userVersion(), id: db.applicationId() }).toEqual({ version: 68, id: 1737727765 });
  });

  test("a version the build has, or one past it, is not this refusal", () => {
    db.setUserVersion(69);
    db.setApplicationId(schemaFingerprint(MIGRATIONS, 69));
    expect(() => assertSchemaMatches(db)).not.toThrow();
  });
});

/**
 * A database a newer build already migrated: what the update guard leaves when it puts the previous
 * binary back after the new one migrated and then failed to come up. This build cannot vouch for
 * migrations it has never seen, so `adopt` refuses, and the message points at the snapshot instead.
 */
describe("a database from a newer build", () => {
  const latest = Math.max(...MIGRATIONS.map((migration) => migration.version));

  test("names the versions and the way back, refuses adopt, and still yields to the override", () => {
    db.setUserVersion(latest + 1);
    db.setApplicationId(12345);
    const newer = new RegExp(`schema ${latest + 1}, and this build only knows up to ${latest}`);
    expect(() => assertSchemaMatches(db)).toThrow(newer);
    expect(() => assertSchemaMatches(db)).toThrow(/nouride db restore/);
    expect(() => adoptSchema(db)).toThrow(newer);
    expect(db.applicationId()).toBe(12345);

    process.env.NOURIDE_ALLOW_SCHEMA_DRIFT = "1";
    try {
      expect(() => assertSchemaMatches(db)).not.toThrow();
    } finally {
      delete process.env.NOURIDE_ALLOW_SCHEMA_DRIFT;
    }
  });
});
