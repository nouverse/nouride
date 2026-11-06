/**
 * The encrypted session store.
 *
 * The failure this guards against is the one that makes the whole bridge not worth running: a session
 * that cannot be read back is a QR scan on every restart. So the round-trip is the first test, and the
 * wrong-key case is the second — GCM must refuse rather than hand back plausible garbage, because
 * garbage credentials fail later and look like a WhatsApp problem.
 *
 * Imported statically. The import used to sit in a try/catch that turned any failure into a skip — a
 * leftover from when the bridge was its own checkout that might not be installed — so a broken
 * dependency or an error thrown at module load read as two skipped suites while the run stayed green.
 * The bridge is a workspace member; the root `bun install` installs it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKey, useEncryptedAuthState } from "../src/auth.ts";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-auth-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the key", () => {
  test("accepts exactly 32 bytes of hex", () => {
    expect(parseKey(KEY)).toHaveLength(32);
    expect(parseKey(`  ${KEY}  `)).toHaveLength(32);
  });

  test("refuses anything else rather than padding or truncating it", () => {
    // Silently accepting a short key would encrypt the session under something weaker than it claims.
    expect(() => parseKey("abc")).toThrow(/64 hex/);
    expect(() => parseKey("z".repeat(64))).toThrow(/64 hex/);
    expect(() => parseKey("")).toThrow(/64 hex/);
  });
});

describe("round trip", () => {
  test("credentials written by one session are read back by the next", async () => {
    const first = await useEncryptedAuthState(dir, KEY);
    const registrationId = first.state.creds.registrationId;
    await first.saveCreds();

    // A second open is exactly what a restart does.
    const second = await useEncryptedAuthState(dir, KEY);

    // If this ever fails, the bridge asks for a new QR on every boot.
    expect(second.state.creds.registrationId).toBe(registrationId);
    expect(second.state.creds.noiseKey.private).toEqual(first.state.creds.noiseKey.private);
  });

  test("signal keys survive too, as Buffers rather than JSON objects", async () => {
    const auth = await useEncryptedAuthState(dir, KEY);
    await auth.state.keys.set({
      "pre-key": { "1": { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } },
    } as never);

    const reopened = await useEncryptedAuthState(dir, KEY);
    const back = (await reopened.state.keys.get("pre-key", ["1"])) as Record<
      string,
      { public: Uint8Array; private: Uint8Array }
    >;

    // Baileys hands these to libsignal, which wants bytes. A plain `{type:"Buffer",data:[…]}` object
    // survives JSON but breaks decryption, which is why BufferJSON is used on both sides.
    expect(Buffer.from(back["1"]?.public ?? [])).toEqual(Buffer.from([1, 2, 3]));
    expect(Buffer.from(back["1"]?.private ?? [])).toEqual(Buffer.from([4, 5, 6]));
  });

  test("deleting a key removes its file", async () => {
    const auth = await useEncryptedAuthState(dir, KEY);
    await auth.state.keys.set({ "pre-key": { "1": { public: Buffer.from([1]) } } } as never);
    expect(readdirSync(dir).some((f) => f.startsWith("pre-key-1"))).toBe(true);

    await auth.state.keys.set({ "pre-key": { "1": null } } as never);
    expect(readdirSync(dir).some((f) => f.startsWith("pre-key-1"))).toBe(false);
  });
});

describe("at rest", () => {
  test("nothing readable is on disk", async () => {
    const auth = await useEncryptedAuthState(dir, KEY);
    await auth.saveCreds();

    const blob = readFileSync(join(dir, "creds.enc"));
    const asText = blob.toString("utf8");

    // The point of the whole file: a copy of this directory must not be a working login.
    expect(asText).not.toContain("registrationId");
    expect(asText).not.toContain("noiseKey");
    // Not `startsWith("{")`: the file opens with a random IV, so one run in 256 it does — CI caught it once.
    expect(() => JSON.parse(asText)).toThrow();
  });

  test("the wrong key refuses rather than returning garbage", async () => {
    const first = await useEncryptedAuthState(dir, KEY);
    await first.saveCreds();

    const wrong = await useEncryptedAuthState(dir, OTHER_KEY);

    // GCM authenticates, so this is a refusal, not a silent mis-decrypt. The store falls back to a
    // fresh identity — which asks for a QR, the correct outcome for "these credentials are unreadable".
    // Compared by the 32-byte identity key, not `registrationId`: that is 14 random bits, so a fresh
    // identity drew the same one about once in 16,384 runs and failed a suite that was right.
    const identity = (creds: typeof first.state.creds) => Buffer.from(creds.signedIdentityKey.private).toString("base64");
    expect(identity(wrong.state.creds)).not.toBe(identity(first.state.creds));
  });

  test("clear() leaves nothing behind", async () => {
    const auth = await useEncryptedAuthState(dir, KEY);
    await auth.saveCreds();
    expect(readdirSync(dir).filter((f) => f.endsWith(".enc"))).not.toHaveLength(0);

    auth.clear();
    expect(readdirSync(dir).filter((f) => f.endsWith(".enc"))).toHaveLength(0);
  });
});

/**
 * A session the signal backend cannot read must read as absent — whatever wrote it.
 *
 * Not "present and empty", which is what broke a live box: Baileys reaches `loadSession` from places
 * the signal layer does not wrap, saw a record, and skipped the re-handshake — so the phone kept
 * sending `type='msg'` for a session only the cipher disagreed about, and every message failed with
 * `SessionNotFound`. Absent, a new one is negotiated and written over the file. No old format is
 * recognised or converted: the store reads bytes, and anything else is a miss.
 */
describe("a session file the backend cannot read", () => {
  test("reads as absent — the JS libsignal's shape, or other JSON — and a new session written over it reads back", async () => {
    const first = await useEncryptedAuthState(dir, KEY);
    // The shape the JS `libsignal` wrote, a record damaged into other JSON, and one the backend writes.
    await first.state.keys.set({ session: { "62811.0": { _sessions: { a: {} }, version: "v1" } } as never });
    await first.state.keys.set({ session: { "62833.0": "not a record" } as never });
    await first.state.keys.set({ session: { "62822.0": Buffer.from([1, 2, 3]) } as never });

    const reopened = await useEncryptedAuthState(dir, KEY);
    const got = await reopened.state.keys.get("session", ["62811.0", "62833.0", "62822.0"]);

    expect(Object.keys(got)).toEqual(["62822.0"]);
    expect(got["62822.0"]).toEqual(Buffer.from([1, 2, 3]) as never);
    // What Baileys does once it has found none: negotiate a session and store it under the same name.
    await reopened.state.keys.set({ session: { "62811.0": Buffer.from([7, 8]) } as never });
    expect((await reopened.state.keys.get("session", ["62811.0"]))["62811.0"]).toEqual(Buffer.from([7, 8]) as never);
  });

  test("one this key cannot open reads as absent too, and is left where it is", async () => {
    writeFileSync(join(dir, "session-62855.0.enc"), Buffer.from("not sealed with this key"));
    const auth = await useEncryptedAuthState(dir, KEY);
    expect(await auth.state.keys.get("session", ["62855.0"])).toEqual({});
    expect(readdirSync(dir)).toContain("session-62855.0.enc");
  });
});
