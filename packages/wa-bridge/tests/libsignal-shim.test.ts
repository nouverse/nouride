/**
 * The parts of the `libsignal` shim that are written here rather than forwarded.
 *
 * `shims/libsignal/` replaces the GPL-3.0 `libsignal` package with one that forwards to
 * `whatsapp-rust-bridge` (MIT). Most of it is a rename — the four classes and the four curve
 * primitives exist there with the same shapes, and getting a rename wrong fails loudly.
 *
 * Two modules are not renames. `src/crypto.js` reimplements AES-256-CBC, HMAC-SHA256, SHA-512 and
 * the three-chunk HKDF against `node:crypto`, because the bridge does not export them.
 * `src/protobufs.js` hand-decodes one optional `bytes` field. Both fail *quietly* when they are
 * subtly wrong: the symptom is a session the other end closes, three layers away from the cause.
 *
 * So they are pinned against **frozen vectors generated from the real `libsignal`**, in
 * `fixtures/libsignal-vectors.json`. Frozen rather than compared live, because the whole point of
 * the shim is that the real package stops being installed — an oracle that disappears with the thing
 * it is checking is no oracle at all. They were also compared live at 200 random inputs per crypto
 * function and 300 encoded messages before being frozen.
 */

import { describe, expect, test } from "bun:test";
import vectors from "./fixtures/libsignal-vectors.json";
import {
  calculateMAC,
  decrypt,
  deriveSecrets,
  encrypt,
  hash,
  verifyMAC,
} from "libsignal/src/crypto.js";
import { PreKeyWhisperMessage } from "libsignal/src/protobufs.js";

const bytes = (hex: string): Buffer => Buffer.from(hex, "hex");

describe("the crypto primitives match the implementation they replace", () => {
  test("AES-256-CBC encrypts to the same ciphertext, and decrypts back", () => {
    for (const v of vectors.crypto) {
      const got = encrypt(bytes(v.key), bytes(v.data), bytes(v.iv));
      expect(got.toString("hex")).toBe(v.encrypted);
      expect(decrypt(bytes(v.key), got, bytes(v.iv)).toString("hex")).toBe(v.data);
    }
  });

  test("HMAC-SHA256 and SHA-512 agree", () => {
    for (const v of vectors.crypto) {
      expect(calculateMAC(bytes(v.key), bytes(v.data)).toString("hex")).toBe(v.mac);
      expect(hash(bytes(v.data)).toString("hex")).toBe(v.hash);
    }
  });

  test("HKDF agrees at one, two and three chunks", () => {
    /**
     * All three, because the info block is mutated between rounds — `T(n-1) || info || n` — and a
     * loop that is wrong about which part it overwrites still produces the right answer for the
     * first chunk. The protocol uses more than one.
     */
    for (const v of vectors.crypto) {
      for (const chunks of [1, 2, 3] as const) {
        const got = deriveSecrets(bytes(v.data), bytes(v.salt), bytes(v.info), chunks);
        expect(got.map((b) => b.toString("hex"))).toEqual(v.derived[chunks - 1]!);
        expect(got).toHaveLength(chunks);
      }
    }
  });

  test("a buffer is required, because a string would encrypt something else entirely", () => {
    // `createCipheriv` accepts a utf-8 string as a key and quietly uses different bytes.
    expect(() => encrypt("not a buffer" as never, Buffer.alloc(16), Buffer.alloc(16))).toThrow(TypeError);
  });

  test("verifyMAC accepts a correct tag and refuses a wrong one", () => {
    const key = bytes(vectors.crypto[0]!.key);
    const data = bytes(vectors.crypto[0]!.data);
    const mac = calculateMAC(key, data).slice(0, 16);
    expect(() => verifyMAC(data, key, mac, 16)).not.toThrow();
    const wrong = Buffer.from(mac);
    wrong[0] = wrong[0]! ^ 0xff;
    expect(() => verifyMAC(data, key, wrong, 16)).toThrow("Bad MAC");
  });
});

describe("the PreKeyWhisperMessage decoder", () => {
  test("reads the identity key out of a real encoded message", () => {
    for (const v of vectors.protobuf) {
      expect(Buffer.from(PreKeyWhisperMessage.decode(bytes(v.encoded)).identityKey).toString("hex"))
        .toBe(v.identityKey);
    }
  });

  test("an absent identity key is empty, not undefined", () => {
    // What the real decoder does. The one consumer tests `?.length === 33`, which answers false
    // either way, but matching the oracle exactly is cheaper than arguing a difference is harmless.
    const absent = vectors.protobuf.find((v) => v.identityKey === "");
    expect(absent).toBeDefined();
    expect(PreKeyWhisperMessage.decode(bytes(absent!.encoded)).identityKey).toHaveLength(0);
  });

  test("a truncated message throws rather than returning a short key", () => {
    // The caller wraps this in `try {} catch {}` and reads a throw as "no identity key", which is
    // the right answer. Returning a half-read field would not be.
    const full = bytes(vectors.protobuf[1]!.encoded);
    expect(() => PreKeyWhisperMessage.decode(full.slice(0, full.length - 4))).toThrow();
  });
});

/**
 * Baileys' own signal repository, driven end to end through the shim.
 *
 * The rest of this file checks the two modules written here. This one checks the part that cannot be
 * checked by reading: that `makeLibSignalRepository` — 430 lines of Baileys, unmodified, importing
 * `libsignal` by name in four places — actually runs against the replacement.
 *
 * It was worth writing. The first attempt looked like it passed and was resolving to the real
 * package the whole time: a plain dependency alias does not reach Baileys' own copy, because Baileys
 * depends on `libsignal` itself and bun installs it a second time underneath. `overrides` is what
 * replaces it everywhere, and this test is what noticed.
 */
describe("Baileys' repository runs on the shim", () => {
  async function repository() {
    const rs = await import("whatsapp-rust-bridge");
    const { makeLibSignalRepository } = await import(
      "@whiskeysockets/baileys/lib/Signal/libsignal.js"
    );

    const me = rs.generateKeyPair();
    const store = new Map<string, unknown>();
    const keys = {
      get: async (type: string, ids: string[]) => {
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          const value = store.get(`${type}-${id}`);
          if (value) out[id] = value;
        }
        return out;
      },
      set: async (data: Record<string, Record<string, unknown>>) => {
        for (const [type, entries] of Object.entries(data))
          for (const [id, value] of Object.entries(entries ?? {}))
            value ? store.set(`${type}-${id}`, value) : store.delete(`${type}-${id}`);
      },
      transaction: async (fn: () => Promise<unknown>) => fn(),
      isInTransaction: () => false,
    };
    const silent = { info() {}, warn() {}, error() {}, trace() {}, debug() {}, child() { return silent; } };
    const auth = {
      // The shape Baileys reads: `.private` / `.public`, with the public key unprefixed.
      creds: { signedIdentityKey: { private: me.privKey, public: me.pubKey.slice(1) }, registrationId: 4242 },
      keys,
    };
    return { repo: makeLibSignalRepository(auth as never, silent as never), store, rs };
  }

  test("injects a session from a bundle and encrypts against it", async () => {
    const { repo, store, rs } = await repository();
    const peer = rs.generateKeyPair();
    const signed = rs.generateKeyPair();
    const pre = rs.generateKeyPair();
    const jid = "62811000111@s.whatsapp.net";

    await repo.injectE2ESession({
      jid,
      session: {
        registrationId: 99,
        identityKey: peer.pubKey,
        signedPreKey: { keyId: 1, publicKey: signed.pubKey, signature: rs.calculateSignature(peer.privKey, signed.pubKey) },
        preKey: { keyId: 2, publicKey: pre.pubKey },
      },
    } as never);

    expect([...store.keys()]).toEqual(["session-62811000111.0"]);
    expect(await repo.validateSession(jid)).toMatchObject({ exists: true });

    const out = await repo.encryptMessage({ jid, data: Buffer.from("halo dari nouride") } as never);
    // `pkmsg` is the first message on a new session — a `msg` here would mean the prekey handshake
    // never happened. The body arrives as a Uint8Array now rather than a binary string, and Baileys'
    // `Buffer.from(body, "binary")` handles both: the encoding argument is ignored for a TypedArray.
    expect(out.type).toBe("pkmsg");
    expect(out.ciphertext.length).toBeGreaterThan(100);
  });
});

/**
 * The error text Baileys keys its session recovery on.
 *
 * `decode-wa-message.js` matches exactly two patterns and sets `isSessionRecordError` on a hit,
 * which is what makes it send a retry receipt — and a retry receipt is what makes the phone re-send
 * as `pkmsg`, re-establishing the session. The Rust bridge's `SessionNotFound(...)` matches neither,
 * so a live box sat there failing every inbound message identically until this translation existed.
 */
describe("two parties, and what a missing session says", () => {
  /**
   * A full X3DH handshake through the shim, both directions.
   *
   * Worth the setup. Everything else here checks a part; this checks that the parts compose into
   * working Signal crypto — Alice initiates, Bob decrypts her `pkmsg` and gets the plaintext back,
   * then Bob replies with a `msg`. A shim that forwards correctly but wires the storage wrongly
   * passes every other test in this file and fails this one.
   *
   * It also produces the one thing the last test needs and cannot fake: a genuine `msg` ciphertext.
   */
  async function handshake() {
    const rs = await import("whatsapp-rust-bridge");
    const { SessionCipher, SessionBuilder } = await import("libsignal");

    const store = (identity: { privKey: Uint8Array; pubKey: Uint8Array }, map: Map<string, unknown>, keys?: Record<string, unknown>) => ({
      loadSession: async (id: string) => map.get(id) ?? null,
      storeSession: async (id: string, record: unknown) => void map.set(id, record),
      getOurIdentity: () => ({ privKey: identity.privKey, pubKey: identity.pubKey }),
      getOurRegistrationId: () => 1,
      isTrustedIdentity: () => true,
      /**
       * The shapes **Baileys** returns, not the ones the bridge declares.
       *
       * This is the whole point of the adapter, and using the bridge's own shapes here is how the
       * first version of this test passed while a live box failed every inbound `pkmsg` with
       * `InvalidState("load_signed_pre_key", "Missing signature bytes")`. Baileys answers
       * `loadSignedPreKey` with a bare `{privKey, pubKey}` — no keyId, no signature.
       */
      loadPreKey: async () => (keys?.pre ? { privKey: (keys.pre as never as { keyPair: { privKey: Uint8Array } }).keyPair.privKey, pubKey: (keys.pre as never as { keyPair: { pubKey: Uint8Array } }).keyPair.pubKey } : null),
      removePreKey: async () => {},
      loadSignedPreKey: async () => (keys?.signed ? { privKey: (keys.signed as never as { keyPair: { privKey: Uint8Array } }).keyPair.privKey, pubKey: (keys.signed as never as { keyPair: { pubKey: Uint8Array } }).keyPair.pubKey } : null),
      loadSenderKey: async () => null,
      storeSenderKey: async () => {},
    });

    const alice = rs.generateKeyPair();
    const bob = rs.generateKeyPair();
    const bobSigned = rs.generateKeyPair();
    const bobPre = rs.generateKeyPair();
    const signature = rs.calculateSignature(bob.privKey, bobSigned.pubKey);
    const bobKeys = { signed: { keyId: 1, keyPair: bobSigned, signature }, pre: { keyId: 2, keyPair: bobPre } };

    const aliceStore = new Map<string, unknown>();
    const bobStore = new Map<string, unknown>();
    const aliceAddr = new rs.ProtocolAddress("alice", 0);
    const bobAddr = new rs.ProtocolAddress("bob", 0);

    await new SessionBuilder(store(alice, aliceStore), bobAddr).initOutgoing({
      registrationId: 2,
      identityKey: bob.pubKey,
      signedPreKey: { keyId: 1, publicKey: bobSigned.pubKey, signature },
      preKey: { keyId: 2, publicKey: bobPre.pubKey },
    } as never);

    const opening = await new SessionCipher(store(alice, aliceStore), bobAddr).encrypt(Buffer.from("one"));
    const opened = await new SessionCipher(store(bob, bobStore, bobKeys), aliceAddr)
      .decryptPreKeyWhisperMessage(opening.body);
    const reply = await new SessionCipher(store(bob, bobStore, bobKeys), aliceAddr).encrypt(Buffer.from("two"));

    return { rs, SessionCipher, store, alice, bobAddr, opening, opened, reply };
  }

  test("a message encrypted by one side decrypts on the other", async () => {
    const { opening, opened, reply } = await handshake();
    expect(opening.type).toBe(3); // pkmsg — the first message on a new session
    expect(Buffer.from(opened).toString()).toBe("one");
    expect(reply.type).toBe(2); // and the answer continues it rather than starting again
  });

  test("two logins in one process: one contact's session with each is that login's own", async () => {
    /**
     * A daemon holds a bridge for each WhatsApp number, so two logins meet the same contact in one process. Each
     * keeps its session with them under the same address in a store of its own, and the cipher holds nothing between
     * calls but the store it is given: what the contact wrote to one number is read by that number and by no other,
     * with the two conversations going on in turn.
     */
    const { rs, SessionCipher, store } = await handshake();
    const { SessionBuilder } = await import("libsignal");
    const login = () => {
      const [identity, signed, pre] = [rs.generateKeyPair(), rs.generateKeyPair(), rs.generateKeyPair()];
      const signature = rs.calculateSignature(identity.privKey, signed.pubKey);
      return { identity, signed, pre, signature, keys: { signed: { keyId: 1, keyPair: signed, signature }, pre: { keyId: 2, keyPair: pre } }, sessions: new Map<string, unknown>() };
    };
    const [shop, home] = [login(), login()];
    const contact = rs.generateKeyPair();
    const theirPhone = new Map<string, unknown>();
    const contactAddr = new rs.ProtocolAddress("contact", 0);
    const [shopAddr, homeAddr] = [new rs.ProtocolAddress("shop", 0), new rs.ProtocolAddress("home", 0)];
    for (const [addr, number] of [[shopAddr, shop], [homeAddr, home]] as const) {
      await new SessionBuilder(store(contact, theirPhone), addr).initOutgoing({
        registrationId: 2,
        identityKey: number.identity.pubKey,
        signedPreKey: { keyId: 1, publicKey: number.signed.pubKey, signature: number.signature },
        preKey: { keyId: 2, publicKey: number.pre.pubKey },
      } as never);
    }
    const from = (addr: typeof shopAddr, text: string) => new SessionCipher(store(contact, theirPhone), addr).encrypt(Buffer.from(text));
    const at = (number: ReturnType<typeof login>) => new SessionCipher(store(number.identity, number.sessions, number.keys), contactAddr);
    const read = (bytes: Uint8Array) => Buffer.from(bytes).toString();

    // The first message to each, read in the other order than they were written.
    const [toShop, toHome] = [await from(shopAddr, "for the shop"), await from(homeAddr, "for the home")];
    expect(read(await at(home).decryptPreKeyWhisperMessage(toHome.body))).toBe("for the home");
    expect(read(await at(shop).decryptPreKeyWhisperMessage(toShop.body))).toBe("for the shop");
    // One session each, under the same address, and not the same session.
    expect([[...shop.sessions.keys()], [...home.sessions.keys()]]).toEqual([["contact.0"], ["contact.0"]]);
    const kept = (number: ReturnType<typeof login>) => Buffer.from((number.sessions.get("contact.0") as { serialize(): Uint8Array }).serialize());
    expect(kept(shop).equals(kept(home))).toBe(false);

    // Each answers, and the contact reads each answer on the session it belongs to.
    const [shopSays, homeSays] = [await at(shop).encrypt(Buffer.from("the shop answers")), await at(home).encrypt(Buffer.from("the home answers"))];
    expect(read(await new SessionCipher(store(contact, theirPhone), homeAddr).decryptWhisperMessage(homeSays.body))).toBe("the home answers");
    expect(read(await new SessionCipher(store(contact, theirPhone), shopAddr).decryptWhisperMessage(shopSays.body))).toBe("the shop answers");

    // What is written to one number next is not the other's to read, and trying leaves the right one able to.
    const next = await from(shopAddr, "again, for the shop");
    expect(next.type).toBe(2);
    await expect(at(home).decryptWhisperMessage(next.body)).rejects.toThrow();
    expect(read(await at(shop).decryptWhisperMessage(next.body))).toBe("again, for the shop");
    expect(read(await at(home).decryptWhisperMessage((await from(homeAddr, "again, for the home")).body))).toBe("again, for the home");
  });

  test("SessionNotFound is reported as `SessionError: No session record`", async () => {
    /**
     * The exact substring `isSessionRecordError` tests for, pinned because Baileys matches **text**:
     *
     *     sessionRecordErrors: ['No session record', 'SessionError: No session record']
     *
     * A match is what makes it send a retry receipt, and a retry receipt is what makes the phone
     * re-send as `pkmsg` and re-establish the session. The bridge's own `SessionNotFound(...)`
     * matches neither, so a live box failed every inbound message identically, twice across two
     * deploys, with nothing in the log saying why.
     */
    const { SessionCipher, store, alice, bobAddr, reply } = await handshake();

    const orphaned = new SessionCipher(store(alice, new Map()), bobAddr);
    const failure = await orphaned.decryptWhisperMessage(reply.body).catch((e: unknown) => e);

    expect(String((failure as Error)?.message ?? failure)).toContain("No session record");
    // The original is kept, so a real diagnosis is still one `.cause` away.
    expect(String((failure as Error)?.cause ?? "")).toContain("SessionNotFound");
  });
});
