/**
 * What a Nouride command speaks, whichever side of the daemon it runs on.
 *
 * The commands that ask a running daemon and the ones that work on the install itself
 * both say things the same way, read their arguments the same way, print the same help and reach a running daemon
 * through the same client. The engine may not import the CLI, so what both speak lives here, under both.
 */

export * from "./args.ts";
export * from "./client.ts";
export * from "./diagnose.ts";
export type * from "./records.ts";
export * from "./token-wait.ts";
export * from "./ui.ts";
export * from "./usage.ts";
export * from "./wait-back.ts";
export type * from "./wire.ts";
