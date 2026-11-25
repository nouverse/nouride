/**
 * A number's held files (`held.ts`): what the daemon has not asked for yet, kept in the number's own folder so a restart
 * keeps it, encrypted as the login is, and let go by its time and by the newest kept.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_FOR_MS, HELD_MAX, HeldFiles } from "../src/held.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-held-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const KEY = new Uint8Array(32).fill(7);
const message = (id: string) => ({ key: { remoteJid: "628111@s.whatsapp.net", id, fromMe: false }, message: { imageMessage: { mimetype: "image/jpeg", mediaKey: new Uint8Array([1, 2, 3, 250]) } } }) as never;
const files = () => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".enc")) : []);

test("held, then read back by a new start on the same folder: the message whole, its key's bytes too", () => {
  let now = 1_000_000;
  const notes: string[] = [];
  const first = new HeldFiles(dir, KEY, (said) => void notes.push(said), () => now);
  first.load();
  first.hold("m1-abc", { message: message("m1"), at: now, mimeType: "image/jpeg", fileName: "a.jpg" });
  expect(files()).toHaveLength(1);
  // What is on disk is not the message in clear: the key that opens the photo is not readable there.
  expect(readFileSync(join(dir, files()[0]!)).includes(Buffer.from("imageMessage"))).toBe(false);

  now += 60_000;
  const second = new HeldFiles(dir, KEY, (said) => void notes.push(said), () => now);
  second.load();
  const back = second.get("m1-abc");
  expect(back).toMatchObject({ at: 1_000_000, mimeType: "image/jpeg", fileName: "a.jpg" });
  expect(Buffer.from((back!.message as { message: { imageMessage: { mediaKey: Uint8Array } } }).message.imageMessage.mediaKey)).toEqual(Buffer.from([1, 2, 3, 250]));
  // Asked for again, it is there again.
  expect(second.get("m1-abc")).toBeDefined();
  expect(notes).toEqual([]);
});

test("past its time it is let go, in memory and on disk, and a start does not read it back", () => {
  let now = 5_000_000;
  const held = new HeldFiles(dir, KEY, () => {}, () => now);
  held.load();
  held.hold("old", { message: message("old"), at: now, mimeType: "image/jpeg" });
  now += HELD_FOR_MS + 1;
  expect(new HeldFiles(dir, KEY, () => {}, () => now).get("old")).toBeUndefined();
  const restarted = new HeldFiles(dir, KEY, () => {}, () => now);
  restarted.load();
  expect(restarted.get("old")).toBeUndefined();
  expect(files()).toEqual([]);
  // And one still in its time when asked, gone when its time is up.
  held.hold("new", { message: message("new"), at: now, mimeType: "image/jpeg" });
  expect(held.get("new")).toBeDefined();
  now += HELD_FOR_MS + 1;
  expect(held.get("new")).toBeUndefined();
  expect(files()).toEqual([]);
});

test("the newest are kept: past the most, the oldest goes, from disk too", () => {
  const now = 9_000_000;
  const held = new HeldFiles(dir, KEY, () => {}, () => now);
  held.load();
  for (let n = 0; n <= HELD_MAX; n++) held.hold(`m${n}`, { message: message(`m${n}`), at: now, mimeType: "image/jpeg" });
  expect(held.size).toBe(HELD_MAX);
  expect(held.get("m0")).toBeUndefined();
  expect(held.get(`m${HELD_MAX}`)).toBeDefined();
  expect(files()).toHaveLength(HELD_MAX);
});

test("a file another login's key wrote, or a half-written one, is said and let go; the rest are read", () => {
  const now = 2_000_000;
  const held = new HeldFiles(dir, KEY, () => {}, () => now);
  held.load();
  held.hold("good", { message: message("good"), at: now, mimeType: "image/jpeg" });
  new HeldFiles(dir, new Uint8Array(32).fill(9), () => {}, () => now).hold("other", { message: message("other"), at: now, mimeType: "image/jpeg" });
  writeFileSync(join(dir, "half.enc"), "not a sealed file");
  const notes: string[] = [];
  const restarted = new HeldFiles(dir, KEY, (said) => void notes.push(said), () => now);
  restarted.load();
  expect(restarted.get("good")).toBeDefined();
  expect(restarted.get("other")).toBeUndefined();
  expect(notes).toEqual(["a held file could not be read back, and is let go", "a held file could not be read back, and is let go"]);
  expect(files()).toEqual(["good.enc"]);
});
