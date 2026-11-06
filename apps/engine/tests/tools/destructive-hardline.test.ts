/**
 * Destruction asks first — including through a shell.
 *
 * The hole that mattered was not a missing program. `sh -lc "rm -rf /"` matched **nothing**: the
 * classifier saw `sh`, every rule looked at the wrong string, and the whole thing was one `sh -c`
 * away from irrelevant. That is not an exotic shape here — `exec` uses it for anything with a pipe
 * and `cron` wraps every `--command` in it.
 *
 * The second half is knowing where to stop. A gate that fires on ordinary work is one an operator
 * learns to dismiss, and the executor already says so: asking about something routine "trains an
 * operator to click through prompts, which is how the gate stops working". So the line is
 * **irreversible and outside the workspace** (SIMPLIFY RFC §1, item 6), and the "not gated" tests below are as
 * load-bearing as the rest.
 */

import { describe, expect, test } from "bun:test";
import { classifyHardline } from "@nouride/policy";

describe("through a shell", () => {
  test("a destructive command inside sh -c is caught", () => {
    // Not `/tmp/x`: a path under a temp root is deliberately disposable now, so this would assert
    // the shell unwrapping and pass on a command that is not destructive in the first place.
    expect(classifyHardline(["sh", "-lc", "rm -rf /var/lib/x"])).not.toBeNull();
    expect(classifyHardline(["bash", "-c", "rm -rf ~/important"])).not.toBeNull();
  });

  test("it is caught anywhere in the pipeline, not only first", () => {
    // The dangerous part is usually not the part an operator reads first.
    expect(classifyHardline(["sh", "-lc", "cd /tmp && ls && rm -rf /var/log"])).not.toBeNull();
    expect(classifyHardline(["sh", "-lc", "cat x | grep y; dropdb prod"])).not.toBeNull();
  });

  test("the reason says it came from inside a shell", () => {
    // The operator is looking at `sh -lc "…"`; without this they have to find the verb themselves.
    expect(classifyHardline(["sh", "-lc", "terraform destroy"])?.reason).toMatch(/inside a shell/);
  });

  test("an ordinary shell command is still ordinary", () => {
    expect(classifyHardline(["sh", "-lc", "echo hello && ls"])).toBeNull();
    expect(classifyHardline(["sh", "-lc", "grep -r pattern src/"])).toBeNull();
  });

  test("recursion is bounded", () => {
    // Legitimate and rare; unbounded recursion on a crafted string is neither.
    const nested = ["sh", "-c", `sh -c 'sh -c "sh -c rm -rf /"'`];
    expect(() => classifyHardline(nested)).not.toThrow();
  });

  test("a shell without -c is not treated as carrying a command", () => {
    expect(classifyHardline(["sh", "script.sh"])).toBeNull();
  });
});

describe("destruction beyond the filesystem", () => {
  test("a remote's history rewritten, to any branch — its own entry on the list", () => {
    expect(classifyHardline(["git", "push", "--force", "origin", "main"])?.class).toBe("force-push");
    expect(classifyHardline(["git", "push", "-f", "origin", "feat/rebased"])?.class).toBe("force-push");
  });

  test("a repository's own history is the workspace's work, and on no list", () => {
    for (const argv of [["git", "reset", "--hard"], ["git", "clean", "-fdx"], ["git", "branch", "-D", "feat"], ["git", "filter-branch"]]) {
      expect({ argv, verdict: classifyHardline(argv) }).toEqual({ argv, verdict: null });
    }
  });

  test("docker operations that lose data", () => {
    expect(classifyHardline(["docker", "volume", "rm", "data"])).not.toBeNull();
    expect(classifyHardline(["docker", "system", "prune", "-af"])).not.toBeNull();
    expect(classifyHardline(["docker", "compose", "down", "-v"])).not.toBeNull();
  });

  test("databases", () => {
    expect(classifyHardline(["dropdb", "production"])).not.toBeNull();
    expect(classifyHardline(["redis-cli", "FLUSHALL"])).not.toBeNull();
  });

  test("find that deletes, and crontab -r", () => {
    expect(classifyHardline(["find", ".", "-name", "*.log", "-delete"])).not.toBeNull();
    expect(classifyHardline(["find", "/", "-exec", "rm", "{}", ";"])).not.toBeNull();
    // `-r` sits next to `-e` on the keyboard, and wipes what `-e` would have edited.
    expect(classifyHardline(["crontab", "-r"])).not.toBeNull();
  });

  test("removing installed software", () => {
    expect(classifyHardline(["apt-get", "purge", "-y", "nginx"])).not.toBeNull();
    expect(classifyHardline(["pacman", "-R", "vim"])).not.toBeNull();
  });

});

describe("what stays ungated, deliberately", () => {
  test("reading and listing", () => {
    for (const argv of [
      ["ls", "-la"],
      ["git", "status"],
      ["git", "checkout", "main"],
      ["git", "push"],
      ["docker", "ps"],
      ["docker", "stop", "web"],
      ["find", ".", "-name", "*.log"],
      ["crontab", "-l"],
      ["redis-cli", "GET", "key"],
      ["kubectl", "get", "pods"],
    ]) {
      expect({ argv, gated: classifyHardline(argv) !== null }).toEqual({ argv, gated: false });
    }
  });

  test("installing is not removing", () => {
    expect(classifyHardline(["apt-get", "install", "-y", "curl"])).toBeNull();
  });

  test("taking a stack down without deleting its volumes", () => {
    // The `-v` is the destructive part. `down` alone comes back with `up`.
    expect(classifyHardline(["docker", "compose", "down"])).toBeNull();
  });

  test("moving a file, anywhere — nothing is lost", () => {
    expect(classifyHardline(["mv", "./a.txt", "./b.txt"])).toBeNull();
    expect(classifyHardline(["mv", "/etc/x.conf", "/etc/x.conf.bak"])).toBeNull();
  });

  test("a mention of a dangerous command is not the command", () => {
    expect(classifyHardline(["echo", "rm -rf /"])).toBeNull();
  });
});

describe("over ssh, where the machines worth breaking actually are", () => {
  test("a destructive remote command is classified by what it would run", () => {
    // The hole that mattered most on a real install, and invisible from the local filesystem: the
    // agent's destructive reach is not this box, it is every box it can log into. Typed locally,
    // `rm -rf /var/lib/vz` was refused; sent through `ssh` it passed every rule, because the
    // program was `ssh`.
    expect(classifyHardline(["ssh", "proxmox", "rm -rf /var/lib/vz"])).not.toBeNull();
    expect(classifyHardline(["ssh", "docker-host", "docker system prune -af"])).not.toBeNull();
    expect(classifyHardline(["ssh", "host", "terraform", "destroy"])).not.toBeNull();
  });

  test("flags that take a value do not hide the host", () => {
    // `ssh -i /key host cmd`: read naively, `/key` becomes the host and `host cmd` the command.
    expect(classifyHardline(["ssh", "-i", "/k", "-p", "22", "host", "rm", "-rf", "/x"])).not.toBeNull();
  });

  test("the reason says the damage happens elsewhere", () => {
    expect(classifyHardline(["ssh", "prod", "dropdb", "main"])?.reason).toMatch(/remote host/);
  });

  test("an ordinary remote command stays ordinary", () => {
    expect(classifyHardline(["ssh", "proxmox", "uptime"])).toBeNull();
    expect(classifyHardline(["ssh", "proxmox", "docker", "ps"])).toBeNull();
  });

  test("an interactive session is not a command", () => {
    expect(classifyHardline(["ssh", "proxmox"])).toBeNull();
  });
});

describe("docker, deliberately narrowed", () => {
  test("force-removing a container is not gated", () => {
    // Gading's call, and correct: on a compose-managed host `up -d` brings it back, and it is the
    // one docker verb likely to fire during routine work.
    expect(classifyHardline(["docker", "rm", "-f", "web"])).toBeNull();
    expect(classifyHardline(["docker", "rmi", "-f", "img"])).toBeNull();
  });

  test("losing data still is", () => {
    expect(classifyHardline(["docker", "volume", "rm", "pgdata"])).not.toBeNull();
    expect(classifyHardline(["docker", "system", "prune", "-af"])).not.toBeNull();
    expect(classifyHardline(["docker", "compose", "down", "-v"])).not.toBeNull();
  });
});
