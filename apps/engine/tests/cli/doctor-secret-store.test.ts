/**
 * What `nouride doctor` says of the secret store at rest (0.8.19): encrypted or not yet, how far its key is from the
 * data (which is what the encryption is worth), the backup passphrase, and plain copies left beside it. Never the key.
 */

import { describe, expect, test } from "bun:test";
import { guardedFiles, plainCopiesCheck, secretStoreChecks } from "@/cli/commands/doctor-checks.ts";

describe("the store's lock", () => {
  test("a key outside the install is fine; a key beside it or in the data folder is said, with the way out", () => {
    expect(secretStoreChecks({ encrypted: true, key: { where: "/etc/nouride/nouride.env", level: "outside" } }, true)).toEqual([
      { level: "ok", message: "secret store: encrypted, its key in /etc/nouride/nouride.env" },
    ]);
    const install = secretStoreChecks({ encrypted: true, key: { where: "/srv/nouride/.env", level: "install" } }, true);
    expect(install[0]).toMatchObject({ level: "warn", message: "secret store: encrypted, its key in /srv/nouride/.env, beside the data" });
    expect(install[0]?.hint).toContain("Run install.sh again");
    const data = secretStoreChecks({ encrypted: true, key: { where: "/app/.nouride/encryption.key", level: "data" } }, true);
    expect(data[0]?.message).toContain("a copy of the data folder opens it");
    expect(data[0]?.hint).toContain("NOURIDE_ENCRYPTION_KEY_FILE");
  });

  test("not encrypted yet is said, and so is a missing backup passphrase; a daemon before 0.8.19 says nothing", () => {
    expect(secretStoreChecks({ encrypted: false }, true)[0]).toMatchObject({ level: "warn", message: "secret store: not encrypted yet" });
    expect(secretStoreChecks({ encrypted: true, key: { where: "the environment", level: "outside" } }, false).map((check) => check.message)).toEqual([
      "secret store: encrypted, its key in the environment",
      "backup passphrase: not set, so a lost key means setting every secret again",
    ]);
    expect(secretStoreChecks(undefined, false)).toEqual([]);
  });
});

describe("copies beside it", () => {
  test("a plain secrets.json or its backup beside the encrypted store is named; before the move it is the store", () => {
    expect(plainCopiesCheck(["secrets.enc", "secrets.json.bak-1788704461", "nouride.db"])?.message).toBe("secret store: 1 other copy beside it (secrets.json.bak-1788704461)");
    expect(plainCopiesCheck(["secrets.enc", "secrets.json", "secrets.enc.unopened-1793"])?.message).toContain("2 other copies");
    expect(plainCopiesCheck(["secrets.json", "secrets.json.bak-1"])).toBeNull();
    expect(plainCopiesCheck(["secrets.enc", "secrets.sealed", "secrets.sealed.for"])).toBeNull();
  });

  test("the encrypted store and its kept key are guarded at 0600 with the plain one", () => {
    const guarded = guardedFiles("/srv/nouride/.nouride/data", "/srv/nouride/.nouride/agents/shared/.credentials");
    expect(guarded).toContainEqual({ path: "/srv/nouride/.nouride/data/secrets.enc", mode: 0o600, what: "the secret store" });
    expect(guarded).toContainEqual({ path: "/srv/nouride/.nouride/encryption.key", mode: 0o600, what: "the secret store's key" });
  });
});
