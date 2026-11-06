/**
 * No `confirm()`, `alert()` or `prompt()` from the browser — every question goes through `useConfirm`.
 *
 * The dashboard asked eleven times with `window.confirm()`: removing a person, a job, a webhook, a
 * connection, a provider, an MCP server, a user; revoking and blocking a sender; rotating a webhook
 * token; resetting the setup sign-in. Unstyled, one line to say what happens, the destructive answer
 * looking like the safe one, and blocked outright by some browsers when it fires outside a gesture.
 * All of them are the modal now, and this keeps a twelfth from arriving the old way — the native call
 * is the one a hurried change reaches for, because it needs no state.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(import.meta.path), "..", "src");
const NATIVE = /(?<![\w.])(?:window\.)?(confirm|alert|prompt)\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("questions the dashboard asks", () => {
  test("are never the browser's own dialog", () => {
    const found = sources(SRC).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, index) => ({ line: line.trim(), at: `${relative(SRC, path)}:${index + 1}` }))
        // Comments may name the calls they replaced.
        .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && NATIVE.test(line)),
    );
    expect(found.map(({ at, line }) => `${at} ${line}`)).toEqual([]);
  });
});
