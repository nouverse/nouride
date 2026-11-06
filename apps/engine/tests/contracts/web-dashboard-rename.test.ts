/**
 * The dashboard's connection renamed `local:dev` → `web:dashboard`, its platform `local` → `web` (0.6): a
 * `[[people]]` entry written the old way. The database's half was a migration from 0.5, which this version no longer
 * takes forward (`storage/db-floor.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import { LOCAL_GATEWAY_ID } from "@/modules/gateways/local.ts";
import { canonicalPersonId, refusePersonId } from "@/modules/people/match.ts";

describe("the connection", () => {
  test("is web:dashboard", () => {
    expect(LOCAL_GATEWAY_ID).toBe("web:dashboard");
  });
});

describe("a [[people]] id in the dashboard's spelling from before 0.6", () => {
  // 0.7.x rewrote these in every file; 0.8.0 reads none of them and says what to write instead.
  test("is refused at load, naming today's spelling", () => {
    expect(refusePersonId("local:usr_61667c")).toContain('write it as "web:usr_61667c"');
    expect(refusePersonId("local:dev:usr_99")).toContain('write it as "web:usr_99"');
    expect(refusePersonId("web:dev")).toContain('write it as "web:terminal"');
  });

  test("is not translated any more", () => {
    expect(canonicalPersonId("local:dev:usr_99")).toBe("local:dev:usr_99");
    expect(canonicalPersonId("web:dev")).toBe("web:dev");
    // The connection an account came in on is still not part of it: that is today's reading, not an old form's.
    expect(canonicalPersonId("telegram:nouva:814")).toBe("telegram:814");
  });
});
