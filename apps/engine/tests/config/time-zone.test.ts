/**
 * The zone the daemon keeps time in, settled at load (`config/global/env.ts`): `TZ` when set, else `[daemon] timezone`,
 * else this machine's. A zone `Intl` refuses made every turn run without memory and the nightly pass take the daemon
 * down a minute after each start — so a name nobody can use is refused, by name, before anything runs on it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTimeZone, isTimeZone, zoneOfFile } from "@nouride/runtime";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { applyEnvOverrides, zoneFor } from "@/modules/config/global/env.ts";
import { parseConfig } from "@/modules/config/global/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `localtime` link into a zoneinfo tree, as a machine has one. */
function localtimeFor(zone: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nouride-tz-"));
  dirs.push(dir);
  const file = join(dir, "zoneinfo", ...zone.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "TZif");
  symlinkSync(file, join(dir, "localtime"));
  return join(dir, "localtime");
}

describe("the zone", () => {
  test("TZ wins when it is a zone name, as it always did", () => {
    expect(zoneFor("Asia/Jakarta", "Europe/Berlin")).toBe("Europe/Berlin");
  });

  test("TZ naming a zone file is read for the zone the file is", () => {
    const link = localtimeFor("Asia/Jakarta");
    expect(zoneOfFile(link)).toBe("Asia/Jakarta");
    expect(zoneFor("", `:${link}`)).toBe("Asia/Jakarta");
  });

  test("a POSIX TZ string is refused, naming TZ and what to set instead", () => {
    // Not `EST5EDT` or `PST8PDT`: POSIX strings that are also IANA names, which Linux's zone data has and takes —
    // there they format dates, so they are used. Each of these is refused everywhere.
    for (const posix of ["CET-1CEST", "UTC0", "GMT+7", "JST-9", "<+07>-7"]) {
      expect(() => zoneFor("", posix)).toThrow(/TZ=.* is not a zone name/);
    }
  });

  test("a typo in [daemon] timezone is refused, naming the key", () => {
    expect(() => zoneFor("Asia/Jakart", undefined)).toThrow(/\[daemon\] timezone = "Asia\/Jakart" is not a zone name/);
  });

  test("left out, it is this machine's zone — a name every date can be formatted in", () => {
    expect(DEFAULT_CONFIG.daemon.timezone).toBe("");
    const zone = zoneFor("", undefined);
    expect(isTimeZone(zone)).toBe(true);
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0)).not.toThrow();
  });

  test("left out, a parse already holds it by name — the empty default never reaches a date", () => {
    // What a config that never met the env step has: the pipeline's own tests ran every turn without memory on "".
    expect(parseConfig({}).daemon.timezone).toBe(hostTimeZone());
    expect(parseConfig({ daemon: { timezone: "Asia/Jakarta" } }).daemon.timezone).toBe("Asia/Jakarta");
  });

  test("one that is not a string is refused by name, not a TypeError naming nothing", () => {
    expect(() => zoneFor(7, undefined)).toThrow(/\[daemon\] timezone = 7 is not a zone name/);
  });
});

describe("the CLI", () => {
  const withTz = (tz: string, run: () => void) => {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try {
      run();
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  };

  test("is not stopped by a zone it cannot use — the daemon is, at load", () => {
    withTz("CET-1CEST", () => {
      const config = structuredClone(DEFAULT_CONFIG);
      expect(() => applyEnvOverrides(config, { client: true })).not.toThrow();
      expect(isTimeZone(config.daemon.timezone)).toBe(true);
      expect(() => applyEnvOverrides(structuredClone(DEFAULT_CONFIG))).toThrow(/TZ=CET-1CEST/);
    });
  });
});
