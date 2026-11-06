/**
 * install.sh's step that puts the helper in place (`# >>> agent users`): the binary root's and outside the install,
 * the groups made, the toolchains every agent's to run — and the helper's socket started before the daemon, which asks
 * it once at boot. Run by `sh` with every command it calls stubbed, as nothing here may make real users.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
const between = (from: string, to: string) => INSTALL.slice(INSTALL.indexOf(from) + from.length, INSTALL.indexOf(to));
const BLOCK = between("# >>> agent users\n", "# <<< agent users");

/** The block, with each command it runs a function that says it was called. */
function run(o: { shadow: boolean; carried: boolean }): { calls: string[]; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "nouride-agent-users-"));
  try {
    if (o.carried) {
      mkdirSync(join(dir, "stage/run"), { recursive: true });
      writeFileSync(join(dir, "stage/run/nouride-run"), "#!/bin/sh\n", { mode: 0o755 });
    }
    const stubs = ["getent", "groupadd", "usermod", "install", "chmod", "chgrp", "find"].map((name) => `${name}() { echo "${name} $*" >>"$CALLS"; }`).join("\n");
    // Without shadow's tools there is no useradd: the one the helper itself runs, so the one that decides.
    const script = `set -eu\nsay() { echo "$*"; }\nstep() { :; }\nwarn() { echo "! $*"; }\n${stubs}\n${o.shadow ? "useradd() { :; }" : ""}\nOS=Linux; HAS_SYSTEMD=1; STAGE='${dir}/stage'; SERVICE_USER=nouride; INSTALL_DIR='${dir}/srv'; CALLS='${dir}/calls'; : >"$CALLS"\n${BLOCK}\necho "RUN_READY=$RUN_READY"`;
    const done = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: "/nonexistent" } });
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean);
    return { calls, out: done.stdout + done.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("install.sh puts the helper in place", () => {
  test("the binary root's, outside the install; the groups; the daemon in nr-agents; the toolchains every agent's to run", () => {
    const { calls, out } = run({ shadow: true, carried: true });
    expect(out).toContain("RUN_READY=1");
    expect(calls).toContain("usermod -aG nr-agents nouride");
    expect(calls.some((call) => call.startsWith("install -o root -g root -m 755 ") && call.endsWith(" /usr/local/lib/nouride-run/nouride-run"))).toBe(true);
    expect(calls.some((call) => call.startsWith("chmod o=x ") && call.endsWith("/srv/.nouride"))).toBe(true);
    for (const dir of ["bin", "lib", "opt"]) expect(calls.some((call) => call.startsWith("chgrp -R nr-agents ") && call.endsWith(`/.nouride/${dir}`))).toBe(true);
  });

  test("without useradd, or a release without the helper, says so and leaves agents on the service account", () => {
    const noShadow = run({ shadow: false, carried: true });
    expect(noShadow.out).toContain("agents' commands run as nouride");
    expect(noShadow.out).toContain("RUN_READY=0");
    const missing = run({ shadow: true, carried: false });
    expect(missing.out).toContain("this release does not carry nouride-run");
    expect(missing.out).toContain("RUN_READY=0");
    expect(missing.calls).toEqual([]);
  });

  test("its socket is started before the daemon, which asks it once at boot", () => {
    const unit = INSTALL.slice(INSTALL.indexOf('step "systemd unit"'));
    expect(unit.indexOf("systemctl restart nouride-run.socket")).toBeGreaterThan(-1);
    expect(unit.indexOf("systemctl restart nouride-run.socket")).toBeLessThan(unit.indexOf("systemctl enable --now nouride >"));
  });
});
