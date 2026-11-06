/**
 * Root's file of the secret store's key in the systemd unit (0.8.19): `EnvironmentFile=-/etc/nouride/nouride.env`, after
 * the install's `.env` so it wins over a key line the daemon left there, read back by the drift check, and asked for by
 * a unit written before the file existed.
 */

import { describe, expect, test } from "bun:test";
import { compareInstalledUnit, installedUnitParams } from "@/service/drift.ts";
import { systemdUnit, type UnitParams } from "@/service/unit.ts";

const BASE: UnitParams = { execStart: "/srv/nouride/nouride start", workingDir: "/srv/nouride", user: "nouride", envFile: "/srv/nouride/.env", systemdVersion: 257 };

describe("the key's file in the unit", () => {
  test("loaded after the install's .env, with `-` so a unit whose file is gone still starts", () => {
    const unit = systemdUnit({ ...BASE, keyFile: "/etc/nouride/nouride.env" });
    const lines = unit.split("\n");
    const env = lines.indexOf("EnvironmentFile=/srv/nouride/.env");
    const key = lines.indexOf("EnvironmentFile=-/etc/nouride/nouride.env");
    expect(env).toBeGreaterThan(-1);
    expect(key).toBe(env + 1);
    expect(systemdUnit(BASE)).not.toContain("/etc/nouride/nouride.env");
  });

  test("read back as the key's file, the install's .env still the env file", () => {
    expect(installedUnitParams(systemdUnit({ ...BASE, keyFile: "/etc/nouride/nouride.env" }))).toMatchObject({
      envFile: "/srv/nouride/.env",
      keyFile: "/etc/nouride/nouride.env",
    });
  });

  test("a unit written before the file existed is told the one line it lacks; one that has it, nothing", () => {
    const before = systemdUnit(BASE);
    expect(compareInstalledUnit(before, 257, "/etc/nouride/nouride.env")).toMatchObject({ added: ["EnvironmentFile=-/etc/nouride/nouride.env"], removed: [] });
    expect(compareInstalledUnit(systemdUnit({ ...BASE, keyFile: "/etc/nouride/nouride.env" }), 257, "/etc/nouride/nouride.env")).toMatchObject({ added: [], removed: [] });
    expect(compareInstalledUnit(before, 257)).toMatchObject({ added: [], removed: [] });
  });
});
