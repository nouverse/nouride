/**
 * `scripts/check-seams.ts` compiles the engine's plugin declarations against the plugins, and the seam types kept on
 * two sides against each other. A check that compiled nothing would pass everything, so this asks that what is in this
 * tree is checked, and that a declaration made to drift — in each of the ways one has — is caught. The guards it
 * replaces read names with a regex, and `BridgeExit` kept `Error`'s constructor past every one of them.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSeams, declarations, PAIRS } from "../../../../scripts/check-seams.ts";

const ROOT = join(import.meta.dir, "../../../..");
const BRIDGE = "apps/engine/src/modules/gateways/wa-bridge.d.ts";
const UPDATE = "apps/engine/src/modules/update/nouride-update.d.ts";

/** `file` as it would read with `from` written as `to`. */
function drifted(file: string, from: string, to: string): Map<string, string> {
  const text = readFileSync(join(ROOT, file), "utf8");
  expect(text).toContain(from);
  return new Map([[file, text.replace(from, to)]]);
}

const only = (name: string) => (checked: string) => checked === name;

describe("the engine's plugin declarations", () => {
  test("hold against the plugins in this tree — and the ones every clone has are among those checked", () => {
    const report = checkSeams();
    expect(report.problems).toEqual([]);
    for (const pkg of ["nouride-wa-bridge", "nouride-update", "nouride-system-packages"]) expect(report.checked).toContain(pkg);
    expect(declarations().map((d) => d.module)).toEqual(expect.arrayContaining(["nouride-wa-bridge", "nouride-wa-bridge/io", "nouride-update"]));
    // A whole compile of every plugin against the engine's declarations — seven seconds on a CI runner with the
    // private plugins checked out, past the default five.
  }, 60_000);

  test("a function the plugin does not export is caught", () => {
    const texts = drifted(BRIDGE, "export function stopBridge(): void;", "export function stopBridge(): void;\n  export function vanished(): void;");
    const { problems } = checkSeams(texts, only("nouride-wa-bridge"));
    expect(problems.join("\n")).toContain("`vanished`");
  });

  test("an argument the engine leaves out and the plugin needs is caught", () => {
    const texts = drifted(BRIDGE, "configure(input: { sessionDir?: string; encryptionKey: string })", "configure(input: { sessionDir?: string })");
    const { problems } = checkSeams(texts, only("nouride-wa-bridge"));
    expect(problems.join("\n")).toContain("`configure`");
  });

  test("a field the engine reads and the plugin does not give is caught", () => {
    const texts = drifted(UPDATE, "    sha256: string;\n  }", "    sha256: string;\n    restartedAt: number;\n  }");
    const { problems } = checkSeams(texts, only("nouride-update"));
    expect(problems.join("\n")).toContain("the type `ApplyReport`");
  });

  test("a class is checked by its constructor, not only by its name", () => {
    const texts = drifted(BRIDGE, "    constructor(code: number);\n", "");
    const { problems } = checkSeams(texts, only("nouride-wa-bridge"));
    expect(problems.join("\n")).toContain("`BridgeExit`");
  });

  test("a plugin export the check cannot type — its module did not compile here — is not read as agreeing", () => {
    const texts = drifted("packages/wa-bridge/src/index.ts", "export function stopBridge(", 'export { stopBridge } from "./not-here.ts";\nfunction stopBridgeGone(');
    const { problems } = checkSeams(texts, only("nouride-wa-bridge"));
    expect(problems.join("\n")).toContain("`stopBridge`\n      is `any` here");
  });

  test("and neither is an import in the plugin that does not resolve — what it brings is `any` all the way down", () => {
    const texts = drifted("packages/wa-bridge/src/io.ts", "export function exit(", 'import type { Gone } from "./not-here.ts";\nexport type Kept = Gone;\nexport function exit(');
    const { problems } = checkSeams(texts, only("nouride-wa-bridge"));
    expect(problems.join("\n")).toContain("packages/wa-bridge/src/io.ts: `./not-here.ts` does not resolve");
  });

  test("a module declared for no plugin the build knows is refused rather than passed over", () => {
    const texts = drifted(BRIDGE, 'declare module "nouride-wa-bridge/io" {', 'declare module "nouride-nothing" {}\n\ndeclare module "nouride-wa-bridge/io" {');
    const { problems } = checkSeams(texts, only("nouride-wa-bridge"));
    expect(problems.join("\n")).toContain("nouride-nothing");
  });
});

describe("the types kept on two sides", () => {
  test("a field one copy of the bridge protocol has and the other does not is caught — at the same version", () => {
    const texts = drifted("packages/shared/src/types/bridge.ts", " mentions?: string[]; voice?: boolean }", " mentions?: string[] }");
    const { problems } = checkSeams(texts, only("a command to the WhatsApp bridge"));
    expect(problems.join("\n")).toContain("a command to the WhatsApp bridge");
  });

  test("a version bumped on one side only is caught", () => {
    const texts = drifted("packages/wa-bridge/src/protocol.ts", "BRIDGE_PROTOCOL_VERSION = 4;", "BRIDGE_PROTOCOL_VERSION = 5;");
    const { problems } = checkSeams(texts, only("the bridge protocol's version"));
    expect(problems.join("\n")).toContain("the bridge protocol's version");
  });

  // The Pro plugins moved under `internals/pro/packages/`, and every pair naming them kept the old folder: with the Pro
  // tree checked out, six pairs were said to be "not in this tree" and compared with nothing.
  test.skipIf(!existsSync(join(ROOT, "internals/pro/package.json")))("with the Pro tree checked out, every pair naming it is compared", () => {
    const pro = PAIRS.filter((pair) => pair.from.file.startsWith("internals/pro/") || pair.to.file.startsWith("internals/pro/")).map((pair) => pair.what);
    expect(pro.length).toBeGreaterThan(0);
    const report = checkSeams(undefined, (name) => pro.includes(name));
    expect(report.absent).toEqual([]);
    expect(report.checked.sort()).toEqual([...pro].sort());
    expect(report.problems).toEqual([]);
  }, 60_000);

  test.skipIf(!existsSync(join(ROOT, "internals/pro/package.json")))("a role the wire's accounts lose and the multi-user plugin still has is caught", () => {
    const texts = drifted("packages/wire/src/status.ts", 'export type UserRole = "admin" | "operator" | "viewer";', 'export type UserRole = "admin" | "operator";');
    const { problems } = checkSeams(texts, only("the roles an account can hold"));
    expect(problems.join("\n")).toContain("the roles an account can hold");
  }, 60_000);
});
