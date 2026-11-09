/**
 * What `balanced` answers by itself, and what it still puts to a person.
 *
 * `balanced` is the default level and the owner's everyday one. Since 0.8.0 it asks only `BALANCED_ASKS`:
 * a config.toml changed, someone given access, the daemon stopped, a stored secret
 * replaced or deleted — and a credential leaving, and the daemon's own state where nothing else guards
 * it. Everything else on the fixed list is `careful`'s.
 *
 * That is only safe because `classifyHardline` looks **through** an elevation — `sudo systemctl stop
 * nouride` is this daemon stopped, not an elevation — so a wrapper cannot carry one of the four past
 * the line. If that unwrapping is ever undone, this stops meaning what it says, which is what the
 * second block here is for.
 */

import { describe, expect, test } from "bun:test";
import { autoApprovable, BALANCED_ASKS, classifyHardline } from "@nouride/policy";

/** Whether `balanced` answers the command by itself, as the executor sees it. */
function coverable(argv: string[]): boolean {
  return autoApprovable(classifyHardline(argv)?.class);
}

describe("what balanced answers by itself", () => {
  test.each([
    ["sudo cat /var/log/syslog", ["sudo", "cat", "/var/log/syslog"]],
    ["sudo apt-get install -y htop", ["sudo", "apt-get", "install", "-y", "htop"]],
    ["sudo systemctl restart nouride", ["sudo", "systemctl", "restart", "nouride"]],
    ["rm -rf /data", ["rm", "-rf", "/data"]],
    ["kubectl delete ns prod", ["kubectl", "delete", "ns", "prod"]],
    ["git push --force", ["git", "push", "--force"]],
    ["nouride update --start", ["nouride", "update", "--start"]],
    ["git status", ["git", "status"]],
  ])("%s", (_label, argv) => {
    expect(coverable(argv)).toBe(true);
  });

  test.each([
    ["systemctl stop nouride", ["systemctl", "stop", "nouride"]],
    ["poweroff", ["poweroff"]],
    ["nouride access allow …", ["nouride", "access", "allow", "telegram:main:9"]],
    ["nouride gateway rm …", ["nouride", "gateway", "rm", "telegram:nox"]],
    ["nouride secret rm …", ["nouride", "secret", "rm", "github"]],
    ["nouride approvals allow-always", ["nouride", "approvals", "allow-always"]],
  ])("%s — still asks", (_label, argv) => {
    expect(coverable(argv)).toBe(false);
  });
});

describe("the guarantee the design rests on", () => {
  test("an elevation cannot smuggle one of balanced's questions past it", () => {
    for (const asked of [["systemctl", "stop", "nouride"], ["poweroff"], ["nouride", "access", "allow", "x"]]) {
      expect(coverable(asked)).toBe(false);
      for (const wrapper of [["sudo"], ["sudo", "-u", "root"], ["runuser", "-u", "root", "--"], ["pkexec"]]) {
        expect(coverable([...wrapper, ...asked])).toBe(false);
      }
    }
  });

  test("the same holds through ssh, a container wrapper and su", () => {
    expect(coverable(["ssh", "host", "sudo", "systemctl", "stop", "nouride"])).toBe(false);
    expect(coverable(["pct", "exec", "102", "--", "sudo", "poweroff"])).toBe(false);
    expect(coverable(["su", "-c", "systemctl stop nouride"])).toBe(false);
  });

  test("the set is the RFC's four, the two older guards, work nobody watches (0.8.0), an install every agent runs (0.8.1), a persona (0.8.8) and People (0.8.9)", () => {
    expect([...BALANCED_ASKS].sort()).toEqual(["access", "config", "credential-out", "own-state", "people", "persona", "secret", "shared-tools", "stop", "system-packages", "unwatched"]);
  });
});
