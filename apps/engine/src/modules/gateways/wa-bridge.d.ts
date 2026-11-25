/**
 * What the engine needs from `nouride-wa-bridge`, declared here rather than imported from there.
 *
 * ## Why a declaration and not a path mapping
 *
 * It *was* a path mapping — `tsconfig.json` pointed `nouride-wa-bridge` at
 * `packages/wa-bridge/src/index.ts` — and that dragged the plugin's source into this project's
 * program. Two consequences, both seen in CI:
 *
 * - Typechecking the engine failed on `Cannot find module '@whiskeysockets/baileys'`, because the
 *   plugin kept its own lockfile then and a root `bun install` did not touch it. The engine's typecheck
 *   was reporting the plugin's uninstalled dependencies as its own problem.
 * - It made the plugin *required* at typecheck time. `packages/wa-bridge` was a submodule then, so a
 *   fresh clone had an empty directory until somebody initialised it, and a typecheck that fails
 *   until they do is a clone nobody can work in.
 *
 * So the engine declares the shape it uses. This is the same choice the wire protocol already made:
 * `packages/wa-bridge/src/protocol.ts` and `packages/shared/src/types/bridge.ts` declare the same
 * messages twice, by hand, and ARCHITECTURE §6 says "the duplication is the point".
 *
 * ## Kept honest by a check, not by hope
 *
 * A hand-written contract drifts. `scripts/check-seams.ts` (`bun run lint:seams`) compiles the
 * plugin's real modules against everything declared below — each function's parameters and
 * result, the class's constructor, each type — and fails on any difference. A name that read
 * true by regex was not enough: `BridgeExit` was declared with `Error`'s constructor for months.
 *
 * Resolution for the bundler is a different question and is not solved here: every edition links
 * the plugin into `node_modules` and bundles it (`scripts/build/edition.ts`, `ALWAYS`).
 */

declare module "nouride-wa-bridge" {
  /** One WhatsApp number's bridge, as its host holds it. */
  export interface Bridge {
    /** One protocol line in. Serialised by the caller — `send` awaits the network. */
    handleLine(line: string): Promise<void>;
    /** Drop the connection without ending the host process. */
    stop(): void;
  }
  /**
   * A bridge for one number, speaking on the channel given here, with the key its session is encrypted under handed
   * over directly: `process.env` is the daemon's own, and every command an agent runs through `exec` inherits it — a
   * WhatsApp session key one `printenv` away from the model.
   */
  export function openBridge(input: { name: string; sessionDir?: string; encryptionKey: string; io: import("nouride-wa-bridge/io").BridgeIo }): Bridge;
}

declare module "nouride-wa-bridge/io" {
  export interface BridgeIo {
    write(line: string): void;
    exit(code: number): void;
  }
  /** Thrown after a bridge's `exit`, so a deliberate stop is not read as a crash. */
  export class BridgeExit extends Error {
    constructor(code: number);
    readonly code: number;
  }
}
