#!/usr/bin/env bun
/**
 * The event stream's contract as a file — `docs/contracts/events.lock.json`, `EVENT_CONTRACT` written out with its
 * keys sorted — so that changing what a row carries is a diff a reviewer reads, not a line in a source file nobody
 * notices. `apps/engine/tests/contracts/events-contract.test.ts` fails while the file and the contract disagree.
 *
 *   bun run scripts/events-contract.ts           says whether the file is current
 *   bun run scripts/events-contract.ts --write   writes it — then bump EVENT_PROTOCOL_VERSION's minor and add a line
 *                                                to docs/contracts/EVENTS_CHANGELOG.md, which the test also asks for
 *
 * The frozen 1.0 baseline beside it, `events.v1.json`, is never written by this: the test holds the lock to it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_CONTRACT } from "../packages/shared/src/types/events.ts";

export const LOCK_PATH = join(import.meta.dir, "..", "docs", "contracts", "events.lock.json");

/** The contract as the lock file holds it: object keys sorted, arrays as written, two-space indent. */
export function contractJson(contract: unknown = EVENT_CONTRACT): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]))
        : value;
  return `${JSON.stringify(sorted(contract), null, 2)}\n`;
}

if (import.meta.main) {
  const want = contractJson();
  if (process.argv.includes("--write")) {
    writeFileSync(LOCK_PATH, want);
    console.log(`wrote ${LOCK_PATH}`);
  } else {
    const current = readFileSync(LOCK_PATH, "utf8") === want;
    console.log(current ? "✓ the event contract's lock is current" : "✗ the lock differs from EVENT_CONTRACT — run with --write, bump the version, add a changelog line");
    process.exit(current ? 0 : 1);
  }
}
