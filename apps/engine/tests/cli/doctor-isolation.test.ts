/**
 * What `doctor` says about each agent's commands running as its own user (`cli/commands/doctor-isolation.ts`).
 */

import { describe, expect, test } from "bun:test";
import { agentUserChecks, agentUsersChecks, commandProbeCheck, readAccounts, rootReachCheck } from "@/cli/commands/doctor-isolation.ts";
import { guardedFiles } from "@/cli/commands/doctor-checks.ts";

const folders = { workspace: "/w", reads: [], credentials: "/c" };
const socket = { through: "socket" as const, binary: "/usr/local/lib/nouride-run/nouride-run", socket: "/run/nouride-run.sock", folders };

describe("where agents' commands run", () => {
  test("beside the daemon is a warning where the helper is expected, and a statement where it is not", () => {
    const finding = { users: null, reason: "nouride-run.socket is not running; agents' commands run as the daemon's user" };
    expect(agentUsersChecks(finding, { expected: true, landlock: "auto" })).toEqual([
      expect.objectContaining({ level: "warn", message: `agents' commands: as the daemon's own user (${finding.reason})`, hint: expect.stringContaining("install.sh") }),
    ]);
    expect(agentUsersChecks({ users: null, reason: "in a container" }, { expected: false, landlock: "auto" })[0]!.level).toBe("ok");
  });

  test("a daemon running its agents' commands through a socket that is gone: every command fails, said as bad", () => {
    const gone = { users: null, reason: "/run/nouride-run.sock is not there — nouride-run.socket is not running (run install.sh again); agents' commands run as the daemon's user" };
    const [check] = agentUsersChecks(gone, { expected: true, landlock: "auto", running: "socket" });
    expect(check).toMatchObject({ level: "bad", hint: expect.stringContaining("systemctl start nouride-run.socket") });
    expect(check!.message).toStartWith("agents' commands: the daemon runs them through nouride-run.socket, and it is not answering: every agent's command fails");
    // Not what a host without the helper is told: that its commands run as the daemon's user.
    expect(check!.message).not.toContain("run as the daemon's user");
  });

  test("each as its own user, with the helper's version and the kernel's Landlock", () => {
    const checks = agentUsersChecks({ users: socket, reason: "", version: "0.1.0", landlock: "abi 4" }, { expected: true, landlock: "auto" });
    expect(checks.map((check) => check.message)).toEqual([
      "agents' commands: each as its own user (nr-<agent>), through nouride-run.socket, helper 0.1.0",
      "landlock: auto, this kernel's abi 4",
    ]);
  });

  test("Landlock required on a kernel without it is the one line that says no command runs", () => {
    const none = { users: socket, reason: "", landlock: "none — built in but off at boot (add landlock to the kernel's lsm= list)" };
    // The helper's own words after its "none" prefix, which installed helpers keep writing as they always have.
    expect(agentUsersChecks(none, { expected: true, landlock: "require" })[1]).toMatchObject({
      level: "bad",
      message: "landlock: required, and this kernel's is built in but off at boot (add landlock to the kernel's lsm= list), so no agent's command runs",
    });
    expect(agentUsersChecks(none, { expected: true, landlock: "auto" })[1]).toMatchObject({
      level: "ok",
      message: "landlock: auto, and this kernel's is built in but off at boot (add landlock to the kernel's lsm= list); each agent's own user is the wall",
    });
  });
});

describe("each agent's user", () => {
  const accounts = readAccounts("root:x:0:0::/root:/bin/sh\nnr-nouva:x:990:990:nouride agent nouva:/w/private/nouva:/usr/sbin/nologin\nnr-nox:x:991:991::/w/private/nox:/usr/sbin/nologin\n", "nr-agents:x:900:nouride,nr-nouva,nr-nox\nnr-creds:x:901:nr-nouva\n");

  test("its user, whether it reads the credentials directory, and an id that can have none", () => {
    expect(agentUserChecks([{ id: "nouva" }, { id: "nox" }, { id: "mira" }, { id: "Nouva_2" }], accounts).map((check) => `${check.level} ${check.message}`)).toEqual([
      "ok nouva: runs as nr-nouva, reads the credentials directory",
      "ok nox: runs as nr-nox, does not read the credentials directory",
      "warn mira: no user nr-mira yet",
      "bad Nouva_2: cannot have a user of its own, so its commands are refused",
    ]);
  });

  test("a command that does not run as its agent is the bad line, whatever the accounts say", () => {
    expect(commandProbeCheck("nouva", { exitCode: 0, stdout: "nr-nouva\n", stderr: "" })).toBeNull();
    const refused = commandProbeCheck("nouva", { exitCode: 126, stdout: "", stderr: "nouride-run: could not start it as the agent: Operation not permitted (os error 1)\n" });
    expect(refused).toMatchObject({ level: "bad", message: "nouva: a command does not run as nr-nouva: nouride-run: could not start it as the agent: Operation not permitted (os error 1)" });
    expect(commandProbeCheck("nouva", { exitCode: 0, stdout: "nouride\n", stderr: "" })?.level).toBe("bad");
    expect(commandProbeCheck("nouva", null)?.message).toContain("the helper did not answer");
  });

  test("a declared root its user cannot write names the grant, and one it can says nothing", () => {
    expect(rootReachCheck("nouva", "/srv/site", true)).toBeNull();
    expect(rootReachCheck("nouva", "/srv/site", false)?.hint).toContain("sudo setfacl -R -m u:nr-nouva:rwX -m d:u:nr-nouva:rwX /srv/site");
  });

  test("the credentials directory may be group-readable only where agents have their own users", () => {
    expect(guardedFiles("/d", "/c").at(-1)?.mode).toBe(0o700);
    expect(guardedFiles("/d", "/c", true).at(-1)?.mode).toBe(0o750);
  });
});
