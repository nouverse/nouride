/**
 * `nouride pkg`'s own decisions, apart from the root service it talks to.
 *
 * Only its `--json` envelope was tested (`json-without-daemon.test.ts`), since the command needs the plugin and its root
 * socket, which no checkout has. What it decides before and after asking is a function each now.
 */

import { describe, expect, test } from "bun:test";
import { exitCodeFor, lineFilter, requestFrom, unreadyAnswer } from "@/cli/commands/pkg.ts";
import { isPackageName, isPackageOp } from "../../../../packages/system-packages/src/protocol.ts";

const mod = { isPackageOp, isPackageName };
const usage = (args: string[]) => {
  const request = requestFrom(mod, args);
  return "usage" in request ? request.usage : null;
};

describe("what `nouride pkg` asks for", () => {
  test("nothing, status or refresh asks that, and takes no names", () => {
    expect(requestFrom(mod, [])).toEqual({ op: "status" });
    expect(requestFrom(mod, ["refresh"])).toEqual({ op: "refresh" });
    expect(usage(["status", "curl"])).toBe("status takes no package names");
  });

  test("a change names its packages — upgrade may name none — and check asks without changing", () => {
    expect(requestFrom(mod, ["install", "curl", "jq"])).toEqual({ op: "install", names: ["curl", "jq"], check: false });
    expect(requestFrom(mod, ["upgrade"])).toEqual({ op: "upgrade", names: [], check: false });
    expect(requestFrom(mod, ["check", "remove", "vim"])).toEqual({ op: "remove", names: ["vim"], check: true });
    expect(usage(["install"])).toBe("install needs at least one package name");
  });

  test("an op it does not know, or a name that is a version, a path or an option, is asked wrongly", () => {
    expect(usage(["purge", "curl"])).toBe("unknown: nouride pkg purge curl");
    expect(usage(["check"])).toBe("unknown: nouride pkg check");
    for (const name of ["curl=7.0", "/usr/bin/curl", "--force-yes", "Curl"]) expect(usage(["install", name])).toBe(`not a package name: ${name}`);
  });
});

describe("what it shows while the service works", () => {
  test("whole lines, the service's own status lines left out, and a partial line held for its rest", () => {
    const lines = lineFilter();
    expect(lines("Reading package lists...\nSetting up cu")).toEqual(["Reading package lists..."]);
    expect(lines("rl (8.5)\n@nouride-pkg status=ok protocol=1\n")).toEqual(["Setting up curl (8.5)"]);
    expect(lines("no newline yet")).toEqual([]);
  });
});

describe("how it exits", () => {
  test("0 done, 2 refused — what was asked may not be done — and 1 for anything else", () => {
    expect([exitCodeFor({ status: "ok" }), exitCodeFor({ status: "refused" }), exitCodeFor({ status: "failed" })]).toEqual([0, 2, 1]);
  });
});

describe("a box that is not ready to be asked", () => {
  // The two branches `pkg()` takes before it reaches the service, which no test reached (the 0.7.11 mutation sweep).
  test("one that does not use system packages says why, and asks nothing", () => {
    expect(unreadyAnswer({ state: "not-applicable", why: "this build does not carry system packages" })).toEqual({
      state: "not-applicable",
      error: "system packages are not used here: this build does not carry system packages",
    });
  });

  test("one where they are off says so, with the command that turns them on — or the installer's way when there is none", () => {
    const command = "curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --allow-packages";
    const off = unreadyAnswer({ state: "off", command });
    expect(off).toMatchObject({ state: "off", error: "system packages are off on this box" });
    expect(off?.state === "off" && off.advice).toContain(`run once, as root: ${command}`);
    const licensed = unreadyAnswer({ state: "off", command: null });
    expect(licensed?.state === "off" && licensed.advice).toContain("with --allow-packages");
  });

  test("a ready one is asked", () => {
    expect(unreadyAnswer({ state: "ready" })).toBeNull();
  });
});
