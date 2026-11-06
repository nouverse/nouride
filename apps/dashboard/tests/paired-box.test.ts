/**
 * Whether My Box exists: the daemon's own `appliance` answer, and nothing read off its edition.
 *
 * It used to fall back to the edition for a daemon without the field — `device` and `device-pro` were Boxes — and no
 * daemon has said either name since 2026-09-30 (owner, 2026-10-17). A Pro pod is the Pro edition and no Box.
 */

import { describe, expect, test } from "bun:test";
import { isPairedBox } from "@/commons/lib/api.appliance";

describe("isPairedBox", () => {
  test("a daemon that says it is a paired Box is one", () => {
    expect(isPairedBox({ appliance: true })).toBe(true);
  });

  test("one that says it is not, or says nothing, is not — whatever its edition", () => {
    const health = (edition: string, appliance?: boolean) => ({ edition, ...(appliance === undefined ? {} : { appliance }) });
    expect(isPairedBox(health("pro", false))).toBe(false);
    expect(isPairedBox(health("pro-router"))).toBe(false);
    expect(isPairedBox(health("device"))).toBe(false);
    expect(isPairedBox(health("device-pro"))).toBe(false);
    expect(isPairedBox(undefined)).toBe(false);
  });
});
