/**
 * The part of the `libsignal` shim these tests reach, typed.
 *
 * The shim is plain JavaScript: Baileys imports it by name and nothing that runs needs its types. These tests do, now
 * that `lint:types` checks them — without this every import of it is an implicit `any`, and a test could call a function
 * the shim does not have and still compile.
 *
 * Beside the tests rather than in the shim, because bun installs a `file:` package as hard links made at install time:
 * a declaration added to `shims/libsignal/` reaches a checkout's `node_modules` only after a reinstall, and `lint:types`
 * would fail everywhere until then.
 */

declare module "libsignal/src/crypto.js" {
  export function encrypt(key: Buffer, data: Buffer, iv: Buffer): Buffer;
  export function decrypt(key: Buffer, data: Buffer, iv: Buffer): Buffer;
  export function calculateMAC(key: Buffer, data: Buffer): Buffer;
  export function hash(data: Buffer): Buffer;
  /** HKDF, `chunks` 32-byte blocks of it — three when not given. */
  export function deriveSecrets(input: Buffer, salt: Buffer, info: Buffer, chunks?: 1 | 2 | 3): Buffer[];
  /** Throws `Bad MAC` when `mac` is not the first `length` bytes of the HMAC of `data`. */
  export function verifyMAC(data: Buffer, key: Buffer, mac: Buffer, length: number): void;
}

declare module "libsignal/src/protobufs.js" {
  /** The one field the shim decodes. `identityKey` is empty, not absent, when the message has none. */
  export const PreKeyWhisperMessage: { decode(bytes: Uint8Array): { identityKey: Uint8Array } };
}

declare module "libsignal" {
  import type {
    ProtocolAddress,
    SessionBuilder as BridgeSessionBuilder,
    SessionCipher as BridgeSessionCipher,
  } from "whatsapp-rust-bridge";

  export { ProtocolAddress } from "whatsapp-rust-bridge";

  /**
   * The bridge's classes, taking the storage Baileys hands them — `signalStorage()`'s shape, which the shim adapts to
   * the bridge's own and which is the reason the shim exists.
   */
  export const SessionCipher: new (storage: object, remoteAddress: ProtocolAddress) => BridgeSessionCipher;
  export const SessionBuilder: new (storage: object, remoteAddress: ProtocolAddress) => BridgeSessionBuilder;
}
