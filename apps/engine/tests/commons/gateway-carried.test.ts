/**
 * Whether a build carries the LLM gateway (`commons/build.ts`): its own stamp, since the edition no longer says it,
 * and for a source checkout whether the package resolves, asked without loading it.
 */

import { describe, expect, test } from "bun:test";
import { gatewayCarried } from "@/commons/build.ts";

describe("gatewayCarried", () => {
  const never = () => {
    throw new Error("a stamped or compiled build does not look for the package");
  };

  test("a build stamped `bundled` carries it, whatever the edition", () => {
    expect(gatewayCarried({ stamp: "bundled", compiled: true, resolves: never })).toBe(true);
  });

  test("a stamp that says anything else does not", () => {
    expect(gatewayCarried({ stamp: "", compiled: true, resolves: never })).toBe(false);
    expect(gatewayCarried({ stamp: "none", compiled: true, resolves: never })).toBe(false);
  });

  test("a compiled build with no stamp did not bundle it: its package is not there to resolve", () => {
    expect(gatewayCarried({ stamp: undefined, compiled: true, resolves: never })).toBe(false);
  });

  test("a source checkout carries it where the dev loop linked the package, and not where it did not", () => {
    expect(gatewayCarried({ stamp: undefined, compiled: false, resolves: () => true })).toBe(true);
    expect(gatewayCarried({ stamp: undefined, compiled: false, resolves: () => false })).toBe(false);
  });
});
