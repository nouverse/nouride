/**
 * Resolving a LID to the phone number behind it.
 *
 * The bug this exists for: WhatsApp addresses conversations by LID
 * (`100000000000001@lid`), Baileys 7 learns the phone number and writes it into the auth store as
 * `lid-mapping-<lid>_reverse`, and then does not use it when addressing an outgoing message. A reply
 * sent to the bare LID is accepted, returns a message key, throws nothing, and is never delivered —
 * which is indistinguishable from success in every log on both sides.
 *
 * Imported statically, as auth.test.ts says why.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useEncryptedAuthState } from "../src/auth.ts";

const KEY = "a".repeat(64);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-lid-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the reverse mapping", () => {
  test("round-trips a bare string, which is how Baileys stores it", async () => {
    const store = await useEncryptedAuthState(dir, KEY);
    await store.state.keys.set({
      "lid-mapping": { "100000000000001_reverse": "628111000001" },
    } as never);

    const reopened = await useEncryptedAuthState(dir, KEY);
    // Read back through the same encrypted store the bridge uses, not off the raw file.
    expect(reopened.read<string>("lid-mapping-100000000000001_reverse")).toBe("628111000001");
  });

  test("a LID with no mapping reads as absent rather than throwing", async () => {
    const store = await useEncryptedAuthState(dir, KEY);
    // Sending falls back to the LID in this case, which is no worse than not trying.
    expect(store.read<string>("lid-mapping-999_reverse")).toBeNull();
  });

  test("entries survive alongside the rest of the session", async () => {
    const store = await useEncryptedAuthState(dir, KEY);
    await store.saveCreds();
    await store.state.keys.set({
      "lid-mapping": { "100000000000001_reverse": "628111000001" },
    } as never);

    const reopened = await useEncryptedAuthState(dir, KEY);
    // Both, because a reader that only worked on a store containing nothing else would prove nothing.
    expect(reopened.state.creds.registrationId).toBe(store.state.creds.registrationId);
    expect(reopened.read<string>("lid-mapping-100000000000001_reverse")).toBe("628111000001");
  });
});
