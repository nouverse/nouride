/**
 * Commands nested inside remote-execution and prefix wrappers are classified by what they would run.
 *
 * The bug that prompted this: the agent ran
 *   `ssh -o BatchMode=yes root@192.168.0.5 pct exec 102 -- systemctl restart nouride`
 * and the classifier saw `ssh` → extracted `pct exec 102 -- systemctl restart nouride` →
 * classified `pct` as argv[0] → fell through every rule → null. The fix makes `classifyHardline`
 * recurse into `pct exec`, `lxc exec`, `docker exec`, `kubectl exec` and `nsenter` the same way it
 * already did for `ssh` and `sh -c`. Since 0.8.0 a restart is on no list (SIMPLIFY RFC §1) — the
 * daemon comes back — so the cases below use what still is: this daemon stopped, a delete outside
 * the workspace, infrastructure torn down.
 */

import { describe, expect, test } from "bun:test";
import { classifyHardline } from "@nouride/policy";

const cls = (argv: string[]) => classifyHardline(argv)?.class ?? null;

describe("the shape of the bug", () => {
  const argv = ["ssh", "-o", "BatchMode=yes", "root@192.168.0.5", "pct", "exec", "102", "--", "systemctl", "stop", "nouride"];

  test("ssh → pct exec → systemctl stop nouride is this daemon stopped", () => {
    expect(cls(argv)).toBe("stop");
  });

  test("the reason traces through both layers", () => {
    expect(classifyHardline(argv)!.reason).toMatch(/remote host.*ssh|ssh.*remote host/i);
  });

  test("a restart through the same layers is on no list", () => {
    expect(classifyHardline(["ssh", "root@192.168.0.5", "pct", "exec", "102", "--", "systemctl", "restart", "nouride"])).toBeNull();
  });
});

describe("remote-execution wrappers", () => {
  test.each([
    ["pct exec", ["pct", "exec", "102", "--", "rm", "-rf", "/var/lib/data"], "delete"],
    ["pct exec without --", ["pct", "exec", "102", "poweroff"], "stop"],
    ["pct exec, a relative path, on another machine", ["pct", "exec", "102", "--", "rm", "-rf", "data"], "delete"],
    ["pct exec, infrastructure", ["pct", "exec", "102", "--", "terraform", "destroy"], "teardown"],
    ["lxc exec, through sudo", ["lxc", "exec", "mycontainer", "--", "sudo", "rm", "-rf", "/"], "delete"],
    ["docker exec", ["docker", "exec", "-it", "mycontainer", "rm", "-rf", "/data"], "delete"],
    ["docker exec with flags that take values", ["docker", "exec", "-u", "root", "-w", "/app", "-e", "X=1", "c1", "rm", "-rf", "/data"], "delete"],
    ["kubectl exec, through sudo", ["kubectl", "exec", "mypod", "--", "sudo", "apt", "purge", "nginx"], "delete"],
    ["kubectl exec with a namespace", ["kubectl", "exec", "-n", "prod", "mypod", "--", "rm", "-rf", "/data"], "delete"],
    ["nsenter", ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "poweroff"], "stop"],
    ["podman exec, docker's argv", ["podman", "exec", "c1", "rm", "-rf", "/"], "delete"],
    ["incus exec, what LXD is called now", ["incus", "exec", "c1", "--", "shutdown", "-h", "now"], "stop"],
  ])("%s", (_label, argv, expected) => {
    expect({ argv, class: cls(argv as string[]) }).toEqual({ argv, class: expected as never });
  });

  test("the reason names the wrapper the command came through", () => {
    expect(classifyHardline(["pct", "exec", "102", "--", "rm", "-rf", "/data"])!.reason).toContain("pct");
  });

  test("a wrapper with no exec subcommand is not described as having one", () => {
    const reason = classifyHardline(["nsenter", "-t", "1", "-m", "poweroff"])!.reason;
    expect(reason).toContain("nsenter");
    expect(reason).not.toContain("nsenter exec");
  });

  test.each([
    ["options before the container", ["lxc", "exec", "--mode=non-interactive", "c1", "--", "poweroff"]],
    ["options after the container", ["lxc", "exec", "c1", "--mode=non-interactive", "--", "poweroff"]],
    ["an option that takes a value", ["lxc", "exec", "--project", "p", "c1", "--", "poweroff"]],
    ["docker exec with -- after the container", ["docker", "exec", "c1", "--", "poweroff"]],
    ["kubectl exec without a separator", ["kubectl", "exec", "-n", "prod", "pod", "poweroff"]],
  ])("%s is still read", (_label, argv) => {
    // The first version skipped exactly one token for the container and no options at all, so every real `lxc exec`
    // invocation escaped — they all carry at least one.
    expect(cls(argv)).toBe("stop");
  });

  test.each([
    ["docker exec", ["docker", "exec", "c1", "ls", "-la"]],
    ["docker exec, an interactive shell", ["docker", "exec", "-it", "web", "bash"]],
    ["podman exec", ["podman", "exec", "c1", "cat", "/etc/os-release"]],
    ["lxc exec with options", ["lxc", "exec", "--mode=non-interactive", "c1", "--", "df", "-h"]],
    ["kubectl exec", ["kubectl", "exec", "-n", "prod", "pod", "--", "env"]],
    ["nsenter", ["nsenter", "-t", "1", "-m", "ls", "/proc"]],
    ["pct exec", ["pct", "exec", "102", "uptime"]],
    ["ssh", ["ssh", "host", "ls", "-la"]],
  ])("an ordinary command through %s stays ordinary", (_label, argv) => {
    // The point of the whole classifier. A gate that fires on `docker exec c1 ls` is a gate that gets switched off.
    expect(classifyHardline(argv)).toBeNull();
  });

  test("docker exec is not confused with docker volume rm", () => {
    expect(cls(["docker", "volume", "rm", "data"])).toBe("delete");
    expect(classifyHardline(["docker", "exec", "web", "echo", "hello"])).toBeNull();
  });
});

describe("multi-layer nesting", () => {
  test("ssh → pct exec → sh -c → a teardown", () => {
    expect(cls(["ssh", "proxmox", "pct", "exec", "102", "--", "sh", "-c", "cd /infra && terraform destroy -auto-approve"])).toBe("teardown");
  });

  test("ssh → docker exec → rm -rf", () => {
    expect(cls(["ssh", "host", "docker", "exec", "web", "rm", "-rf", "/app/data"])).toBe("delete");
  });

  test("ssh → lxc exec → sudo → rm -rf reaches the delete at the bottom", () => {
    const verdict = classifyHardline(["ssh", "host", "lxc", "exec", "c1", "--", "sudo", "rm", "-rf", "/srv"]);
    expect(verdict?.class).toBe("delete");
    expect(verdict?.reason).toContain("sudo");
  });

  test("ssh host sh -c poweroff", () => {
    expect(cls(["ssh", "host", "sh", "-c", "poweroff"])).toBe("stop");
  });
});

describe("prefix wrappers", () => {
  test.each([
    ["timeout", ["timeout", "5", "poweroff"]],
    ["timeout with a signal option", ["timeout", "-s", "KILL", "30", "poweroff"]],
    ["env", ["env", "FOO=bar", "poweroff"]],
    ["nohup", ["nohup", "poweroff"]],
    ["setsid", ["setsid", "poweroff"]],
    ["nice", ["nice", "-n", "10", "poweroff"]],
    ["ionice", ["ionice", "-c", "3", "poweroff"]],
    ["stdbuf", ["stdbuf", "-oL", "poweroff"]],
    ["systemd-run", ["systemd-run", "poweroff"]],
  ])("%s cannot launder what it runs", (_label, argv) => {
    expect(cls(argv)).toBe("stop");
  });

  test("xargs cannot launder a delete", () => {
    // The realistic route: this arrives as a segment of an `sh -c` payload — and the segment starts with `xargs`.
    expect(cls(["sh", "-c", "find / -name x | xargs rm -rf"])).toBe("delete");
    expect(cls(["xargs", "rm", "-rf", "/"])).toBe("delete");
  });

  test.each([
    ["timeout", ["timeout", "10", "bun", "test"]],
    ["env with assignments", ["env", "FOO=bar", "BAZ=qux", "ls", "-la"]],
    ["nice", ["nice", "-n", "10", "bun", "run", "build"]],
    ["nohup", ["nohup", "bun", "run", "start"]],
    ["stdbuf", ["stdbuf", "-oL", "tail", "-n", "100", "x.log"]],
    ["xargs", ["xargs", "-n", "1", "grep", "foo"]],
  ])("an ordinary command through %s stays ordinary", (_label, argv) => {
    expect(classifyHardline(argv)).toBeNull();
  });

  test("a bare wrapper with nothing to run is not a command", () => {
    for (const argv of [["timeout"], ["env"], ["xargs"], ["nohup"], ["nice"]]) {
      expect(classifyHardline(argv)).toBeNull();
    }
  });

  test("an `=` outside env is an argument, not an assignment to step over", () => {
    expect(classifyHardline(["timeout", "5", "grep", "a=b", "file"])).toBeNull();
  });
});

/**
 * Elevation is not the danger; what gets elevated is.
 *
 * `sudo` used to return immediately, so it masked every other rule beneath it: `sudo rm -rf /` came back as
 * *privilege*, the same class as `sudo cat /var/log/syslog`. Since 0.8.0 an elevation is on no list of its own: what it
 * runs is classified, and an elevation of something ordinary is a new command like any other.
 */
describe("an elevation is looked through, under every name", () => {
  test.each([
    [["sudo", "rm", "-rf", "/"], "delete"],
    [["sudo", "systemctl", "stop", "nouride"], "stop"],
    [["sudo", "-u", "nobody", "dd", "if=/dev/zero", "of=/dev/sda"], "delete"],
    [["runuser", "-u", "root", "--", "poweroff"], "stop"],
    [["chroot", "/mnt", "poweroff"], "stop"],
    [["pkexec", "kubectl", "delete", "ns", "prod"], "teardown"],
    [["doas", "git", "push", "--force"], "force-push"],
    [["su", "-c", "systemctl stop nouride"], "stop"],
    [["su", "-", "root", "-c", "rm -rf /srv/x"], "delete"],
  ])("%j is %s", (argv, expected) => {
    expect(cls(argv as string[])).toBe(expected as never);
  });

  test("the reason still says the command was elevated", () => {
    const verdict = classifyHardline(["sudo", "rm", "-rf", "/data"]);
    expect(verdict!.reason).toContain("recursive delete");
    expect(verdict!.reason).toContain("sudo");
  });

  test("an ordinary command under any of them is on no list", () => {
    for (const argv of [
      ["sudo", "cat", "/var/log/syslog"],
      ["sudo", "apt-get", "install", "-y", "htop"],
      ["runuser", "-u", "root", "--", "cat", "/var/log/syslog"],
      ["chroot", "/mnt", "cat", "/etc/os-release"],
      ["su", "postgres"],
      ["su", "-c", "whoami"],
    ]) {
      expect({ argv, verdict: classifyHardline(argv) }).toEqual({ argv, verdict: null });
    }
  });
});
