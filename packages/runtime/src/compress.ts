/**
 * gzip for text (TD-001) — memory's transcript archive keeps each conversation compressed.
 *
 * `node:zlib` because every runtime this ships on has it; the format is plain gzip, so an archived
 * file opens with `gunzip` on any machine without Nouride.
 */

import { gunzipSync, gzipSync } from "node:zlib";

export function gzipText(text: string): Uint8Array {
  return new Uint8Array(gzipSync(new TextEncoder().encode(text)));
}

export function gunzipText(bytes: Uint8Array): string {
  return new TextDecoder().decode(gunzipSync(bytes));
}
