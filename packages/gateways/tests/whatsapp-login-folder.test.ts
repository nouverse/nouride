/**
 * A WhatsApp number's old login taken out of the way for a new link (`login-folder.ts`): all or nothing, beside itself,
 * and what could not be removed said rather than left half done. On real folders; the ones whose permissions refuse a
 * removal are skipped for root, which removes what it likes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLogin } from "../src/channels/whatsapp/login-folder.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    for (const path of [dir, ...readdirSync(dir, { recursive: true }).map((entry) => join(dir, String(entry)))]) {
      try {
        chmodSync(path, 0o755);
      } catch {
        // Gone already.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A data folder with one number's login in it. */
function aLogin() {
  const parent = mkdtempSync(join(tmpdir(), "wa-login-"));
  made.push(parent);
  const folder = join(parent, "whatsapp-shop");
  mkdirSync(join(folder, "keys"), { recursive: true });
  writeFileSync(join(folder, "creds.enc"), "the old link");
  writeFileSync(join(folder, "keys", "pre-key-1.enc"), "a key");
  return { parent, folder };
}
const asRoot = process.getuid?.() === 0;

describe("an old WhatsApp login cleared for a new link", () => {
  test("is moved away whole and removed, leaving nothing beside it", () => {
    const { parent, folder } = aLogin();
    expect(clearLogin(folder, 1)).toEqual({ ok: true });
    expect(readdirSync(parent)).toEqual([]);
  });

  test("written with a slash at its end, is moved beside itself, not into itself", () => {
    const { parent, folder } = aLogin();
    expect(clearLogin(`${folder}/`, 1)).toEqual({ ok: true });
    expect(readdirSync(parent)).toEqual([]);
  });

  test("not there, is nothing to clear", () => {
    const { parent } = aLogin();
    expect(clearLogin(join(parent, "whatsapp-none"), 1)).toEqual({ ok: true });
  });

  test.skipIf(asRoot)("with a file in it that cannot be removed, is out of the way all the same, and where it was left is said", () => {
    const { parent, folder } = aLogin();
    chmodSync(join(folder, "keys"), 0o555);
    expect(clearLogin(folder, 1)).toEqual({ ok: true, left: `${folder}.logged-out-1` });
    // The folder's name is free for the new link: nothing old of it is where the new login goes.
    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(parent)).toEqual(["whatsapp-shop.logged-out-1"]);
  });

  test.skipIf(asRoot)("that cannot be moved (a mount of its own), is emptied where it is", () => {
    const { parent, folder } = aLogin();
    chmodSync(parent, 0o555);
    expect(clearLogin(folder, 1)).toEqual({ ok: true });
    expect([existsSync(folder), readdirSync(folder)]).toEqual([true, []]);
  });

  test.skipIf(asRoot)("that can be neither moved nor emptied, is said, with what stopped it", () => {
    const { parent, folder } = aLogin();
    chmodSync(folder, 0o555);
    chmodSync(parent, 0o555);
    const cleared = clearLogin(folder, 1);
    expect(cleared.ok).toBe(false);
    expect(cleared.ok ? "" : cleared.reason).toStartWith("its old login could not be removed: ");
  });
});
