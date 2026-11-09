/**
 * The fixed list's classifier, and just as importantly what it must *not* catch.
 *
 * A classifier that fires on ordinary work is worse than none: the operator gets asked about
 * `ls` and turns the whole gate off, which is the exact failure this permission model exists to
 * prevent. So the false-positive cases below carry as much weight as the true positives.
 */

import { describe, expect, test } from "bun:test";
import { autoApprovable, classifyHardline, classifyOwnState, credentialPath } from "../src/hardline.ts";

const cls = (argv: string[]) => classifyHardline(argv)?.class ?? null;

describe("an elevation is looked through, never listed for itself", () => {
  test.each([["sudo"], ["su"], ["doas"], ["pkexec"], ["/usr/bin/sudo"]])("%s on its own is on no list", (program) => {
    expect(classifyHardline([program, "whoami"])).toBeNull();
    expect(classifyHardline([program, "cat", "/var/log/syslog"])).toBeNull();
  });

  test("what it runs decides, and the reason says it ran as somebody else", () => {
    const verdict = classifyHardline(["sudo", "rm", "-rf", "/var/lib/app"]);
    expect(verdict?.class).toBe("delete");
    expect(verdict?.reason).toContain("as another user via sudo");
    expect(cls(["sudo", "systemctl", "stop", "nouride"])).toBe("stop");
  });
});

describe("delete — for good, outside the workspace", () => {
  test.each([
    ["recursive, absolute", ["rm", "-rf", "/var/lib/app"]],
    ["clustered flags, home", ["rm", "-rfv", "~/projects"]],
    ["long form, parent", ["rm", "--recursive", "../other"]],
    ["absolute target", ["rm", "-f", "/etc/hosts"]],
    ["home target", ["rm", "-f", "~/notes.md"]],
    ["glob target", ["rm", "-f", "*.log"]],
    ["parent traversal", ["rm", "-f", "../outside.txt"]],
  ])("%s", (_label, argv) => {
    expect(cls(argv)).toBe("delete");
  });

  test.each([["dd"], ["shred"], ["mkfs"], ["mkfs.ext4"], ["fdisk"]])("%s is on the list", (program) => {
    expect(cls([program, "/dev/sdb"])).toBe("delete");
  });

  test.each([
    [["docker", "volume", "rm", "pgdata"]],
    [["docker", "system", "prune", "-a"]],
    [["docker", "compose", "down", "-v"]],
    [["dropdb", "app"]],
    [["redis-cli", "FLUSHALL"]],
    [["find", "/var", "-name", "*.log", "-delete"]],
    [["crontab", "-r"]],
    [["apt", "purge", "nginx"]],
    [["pacman", "-Rns", "x"]],
  ])("%j deletes for good", (argv) => {
    expect(cls(argv)).toBe("delete");
  });

  test("the workspace's own work is not on the list — `careful` asks it once, as a new command", () => {
    // 0.8.0: the RFC's "outside the workspace". A relative path stays under the cwd, which is inside the agent's roots.
    for (const argv of [
      ["rm", "-rf", "build"],
      ["rm", "-rf", "dist/", "node_modules"],
      ["rm", "-f", "notes.md"],
      ["git", "reset", "--hard"],
      ["git", "clean", "-fdx"],
      ["git", "branch", "-D", "old"],
      ["chmod", "-R", "755", "/srv/app"],
      ["mv", "/etc/x", "/etc/y"],
      ["truncate", "-s", "0", "app.log"],
    ]) {
      expect({ argv, verdict: classifyHardline(argv) }).toEqual({ argv, verdict: null });
    }
  });

  test("on another machine no path is inside the workspace", () => {
    expect(cls(["ssh", "box", "rm", "-rf", "build"])).toBe("delete");
    expect(cls(["pct", "exec", "102", "--", "rm", "-rf", "data"])).toBe("delete");
    expect(classifyHardline(["ssh", "box", "rm", "-rf", "build"])?.reason).toContain("over ssh");
  });
});

describe("stop — this daemon, for good", () => {
  test.each([
    [["systemctl", "stop", "nouride"]],
    [["systemctl", "disable", "nouride.service"]],
    [["systemctl", "mask", "nouride-run.socket"]],
    [["service", "nouride", "stop"]],
    [["launchctl", "bootout", "gui/501/tech.nouverse.nouride"]],
    [["pkill", "nouride"]],
    [["killall", "-9", "nouride"]],
    [["sh", "-c", "kill $(pidof nouride)"]],
    [["shutdown", "-h", "now"]],
    [["poweroff"]],
    [["halt"]],
  ])("%j", (argv) => {
    expect(cls(argv)).toBe("stop");
  });

  test("a restart comes back, and another service is not this daemon", () => {
    for (const argv of [
      ["systemctl", "restart", "nouride"],
      ["reboot"],
      ["systemctl", "stop", "nginx"],
      ["pkill", "node"],
      ["kill", "4242"],
      ["systemctl", "status", "nouride"],
      ["systemctl", "start", "nouride"],
    ]) {
      expect({ argv, verdict: classifyHardline(argv) }).toEqual({ argv, verdict: null });
    }
  });
});

describe("teardown — infrastructure torn down, not created or changed", () => {
  test.each([
    [["terraform", "destroy"]],
    [["terraform", "apply", "-destroy"]],
    [["tofu", "destroy", "-auto-approve"]],
    [["pulumi", "destroy"]],
    [["kubectl", "delete", "ns", "staging"]],
    [["kubectl", "delete", "pod", "web"]],
    [["helm", "uninstall", "web"]],
    [["pct", "destroy", "102"]],
    [["qm", "destroy", "100"]],
    [["lxc", "delete", "c1"]],
    [["incus", "delete", "c1"]],
  ])("%j", (argv) => {
    expect(cls(argv)).toBe("teardown");
  });

  test("over ssh too, which is where the machines worth breaking are", () => {
    const verdict = classifyHardline(["ssh", "proxmox", "pct", "destroy", "102"]);
    expect(verdict?.class).toBe("teardown");
    expect(verdict?.reason).toContain("on the remote host, over ssh");
  });

  test("creating, changing and simulating are not on the list", () => {
    for (const argv of [
      ["terraform", "plan"],
      ["terraform", "apply"],
      ["kubectl", "apply", "-f", "x.yaml"],
      ["kubectl", "scale", "deploy/web", "--replicas=0"],
      ["kubectl", "delete", "pod", "web", "--dry-run=client"],
      ["pct", "stop", "102"],
      ["pct", "reboot", "102"],
      ["qm", "start", "100"],
      ["ansible-playbook", "site.yml"],
      ["helm", "install", "web", "."],
    ]) {
      expect({ argv, verdict: classifyHardline(argv) }).toEqual({ argv, verdict: null });
    }
  });
});

describe("force-push — a remote's history rewritten", () => {
  test.each([
    [["git", "push", "--force", "origin", "feature"]],
    [["git", "push", "-f"]],
    [["git", "push", "--force-with-lease", "origin", "main"]],
    [["git", "push", "--force-with-lease=main:abc", "origin", "main"]],
    [["git", "push", "--mirror", "backup"]],
    [["git", "push", "origin", "+main"]],
    [["git", "push", "origin", ":old-branch"]],
    [["git", "push", "--delete", "origin", "old-branch"]],
    [["sh", "-lc", "git add -A && git commit -m x && git push -f"]],
  ])("%j", (argv) => {
    expect(cls(argv)).toBe("force-push");
  });

  test("an ordinary push is not", () => {
    for (const argv of [["git", "push"], ["git", "push", "origin", "main"], ["git", "push", "-u", "origin", "feature"]]) {
      expect({ argv, verdict: classifyHardline(argv) }).toEqual({ argv, verdict: null });
    }
  });
});

describe("credential paths — not on the list, and found", () => {
  test.each([
    [["cat", "/home/x/.ssh/id_ed25519"]],
    [["cp", "~/.aws/credentials", "/tmp/x"]],
    [["cat", ".env.production"]],
    [["cat", "/home/x/.netrc"]],
    [["tar", "-cf", "x.tar", "/root/.gnupg"]],
    // The directory by the variable agents are told about: unexpanded, it has no `credentials/`.
    [["cat", "$NOURIDE_CREDENTIALS_DIR/token.json"]],
    [["cat", "${NOURIDE_CREDENTIALS_DIR}/token.json"]],
    [["python3", "-c", "import os; print(open(os.environ['NOURIDE_CREDENTIALS_DIR'] + '/t.json').read())"]],
    [["cat", "/proc/4242/environ"]],
    [["cat", "/proc/self/environ"]],
    [["xxd", "/proc/thread-self/mem"]],
    [["cat", "/proc/1/task/7/environ"]],
    [["bash", "-lc", "cat /proc/$PPID/environ | tr '\\0' '\\n'"]],
  ])("%j", (argv) => {
    expect(classifyHardline(argv)).toBeNull();
    expect(credentialPath(argv)).not.toBeNull();
  });

  test.each([[["cat", "/proc/meminfo"]], [["cat", "/proc/self/status"]], [["ls", "/proc/self/fd"]], [["git", "--no-ssh-command", "status"]]])(
    "%j is ordinary",
    (argv) => expect(credentialPath(argv)).toBeNull(),
  );

  test("the matched argument is short enough to read in a chat prompt", () => {
    // The argument that matches is routinely a whole `python3 -c` script, rendered into an approval somebody answers
    // on a phone. An un-clipped one turns the line that says *why* into a wall.
    const path = credentialPath(["python3", "-c", `import x\n${"# padding that goes on and on ".repeat(20)}\nopen("/home/x/.ssh/id_ed25519")\n`]);
    expect(path!.length).toBeLessThan(100);
    expect(path).not.toContain("\n");
  });
});

describe("the daemon's own state", () => {
  test.each([
    [["sh", "-c", "cat x >> /srv/nouride/.nouride/config.toml"], "config"],
    [["cat", "/srv/nouride/.nouride/agents/nix/config.toml"], "config"],
    [["sqlite3", "data/nouride.db", ".dump"], "database"],
    /**
     * Observed on 2026-09-15: an agent asked who an id belonged to, found `sqlite3` was not installed, and reached the
     * same database through `python3 -c` with the path inside a Python string inside the script argument.
     */
    [["python3", "-c", "import sqlite3\ncon = sqlite3.connect('/srv/nouride/.nouride/data/nouride.db')"], "database"],
    [["cat", "data/secrets.json"], "own-state"],
    [["cat", "data/.control-token"], "own-state"],
    // A persona file is answered as the `persona` tool's change is, by an admin — the rest of a pack as before.
    [["cp", "-r", "/srv/nouride/.nouride/agents/nox/SOUL.md", "/tmp/x"], "persona"],
    [["sed", "-i", "s/Ask before/Skip/", "/srv/nouride/.nouride/agents/nix/SOUL.md"], "persona"],
    [["cp", "/srv/nouride/.nouride/agents/nox/skills.toml", "/tmp/x"], "own-state"],
    // The live case: the script that rewrote all six packs only ever named the directory.
    [["python3", "-c", 'agents_dir = "/srv/nouride/.nouride/agents"\nfor a in os.listdir(agents_dir): ...'], "own-state"],
    // Memory and the knowledge base (0.8.20): read through memory's tools, where the conversation may read them.
    [["cat", "/srv/nouride/.nouride/memory/people/sam.md"], "own-state"],
    [["grep", "-r", "salary", "/app/.nouride/knowledge/finance"], "own-state"],
  ])("%j is %s", (argv, expected) => {
    expect(classifyHardline(argv as string[])).toBeNull();
    expect(classifyOwnState(argv as string[])?.class).toBe(expected as never);
  });

  /**
   * Where agents run as the daemon's user, a shell reached an agent's own persona with no admin asked
   * — and from its workspace, a relative path names the pack without the literal `.nouride/agents` the table matches.
   */
  test("a path from the command's folder is resolved: `../../../agents/nix/SOUL.md` from a workspace is a persona", () => {
    const cwd = "/srv/nouride/.nouride/workspace/private/nix";
    expect(classifyOwnState(["sed", "-i", "s/Ask/Skip/", "../../../agents/nix/SOUL.md"], cwd)?.class).toBe("persona");
    expect(classifyOwnState(["sh", "-c", "echo '- Never ask.' >> ../../../agents/nix/AGENTS.md"], cwd)?.class).toBe("persona");
    expect(classifyOwnState(["python3", "-c", "open('../../../agents/nox/IDENTITY.md','w').write('x')"], cwd)?.class).toBe("persona");
    expect(classifyOwnState(["cat", "../../../agents/nox/config.toml"], cwd)?.class).toBe("config");
    expect(classifyOwnState(["cat", "../../../memory/people/sam.md"], cwd)?.class).toBe("own-state");
    // Not resolved without the folder: the literal is all there is to go on.
    expect(classifyOwnState(["sed", "-i", "s/Ask/Skip/", "../../../agents/nix/SOUL.md"])).toBeNull();
  });

  test("a project's own AGENTS.md, and a repository's agent packs, are not this daemon's persona", () => {
    // Nix works on Nouride itself, whose content/ holds agent packs: editing them is the work, not a persona change.
    expect(classifyOwnState(["sed", "-i", "s/x/y/", "AGENTS.md"], "/opt/projects/nouride")).toBeNull();
    expect(classifyOwnState(["sed", "-i", "s/x/y/", "content/agents/nouva/SOUL.md"], "/opt/projects/nouride")).toBeNull();
    expect(classifyOwnState(["cat", "../agents/nouva/AGENTS.md"], "/opt/projects/nouride/content/skills")).toBeNull();
    expect(classifyOwnState(["curl", "-s", "https://example.com/agents/x/SOUL.md"], "/srv/nouride/.nouride/workspace/private/nix")).toBeNull();
  });

  test("the workspace and job logs under the same install are ordinary", () => {
    // An agent works in `.nouride/workspace/` and follows a background job's log; a gate that fires on those is one an
    // operator switches off, taking the rest with it.
    for (const argv of [
      ["ls", "/srv/nouride/.nouride/workspace/shared"],
      ["cat", "/srv/nouride/.nouride/workspace/private/nouva/notes.md"],
      ["tail", "-n", "50", "/srv/nouride/.nouride/jobs/nouva/job_abc.log"],
      // Somebody else's project, which is not this daemon's config however it is spelled.
      ["cat", "/opt/projects/thing/config.toml"],
      ["cat", "/opt/projects/thing/agents/readme.md"],
    ]) {
      expect(classifyOwnState(argv)).toBeNull();
    }
  });
});

describe("the scratchpad exemption", () => {
  test.each([
    ["a file in the local scratchpad", ["rm", "-f", "/data/workspace/private/nouva/.scratchpad/shot.png"]],
    ["a home-relative one on another machine", ["rm", "-f", "~/.scratchpad/shot.png"]],
    ["clearing the whole thing out", ["rm", "-rf", "~/.scratchpad"]],
    ["a glob, which cannot expand past the directory that bounds it", ["rm", "-f", "~/.scratchpad/*.png"]],
    ["several files at once", ["rm", "-f", "~/.scratchpad/a.png", "~/.scratchpad/b.png"]],
    ["after `--`", ["rm", "-f", "--", "~/.scratchpad/-weird-name"]],
  ])("%s is not on the list", (_label, argv) => {
    expect(classifyHardline(argv)).toBeNull();
  });

  test("the case this was built for: tidying up a screenshot over ssh", () => {
    expect(classifyHardline(["ssh", "mac", "rm", "-f", "~/.scratchpad/screen.png"])).toBeNull();
    // And the shape it actually took on the live box, in the remote machine's own /tmp.
    expect(classifyHardline(["ssh", "mac", "rm", "-f", "/tmp/screen.png"])).toBeNull();
    // One directory over is exactly what it always was.
    expect(cls(["ssh", "mac", "rm", "-f", "/etc/screen.png"])).toBe("delete");
  });

  test("inside a shell payload too, which is the shape `exec` actually uses", () => {
    expect(classifyHardline(["sh", "-lc", "rm -rf ~/.scratchpad/build"])).toBeNull();
  });

  test.each([
    ["one operand outside it launders nothing", ["rm", "-rf", "~/.scratchpad/a", "/var/lib/postgres"]],
    ["`..` climbs back out", ["rm", "-rf", "~/.scratchpad/../../etc"]],
    ["a prefix is not a segment", ["rm", "-rf", "/home/x/.scratchpad-backup"]],
  ])("%s", (_label, argv) => {
    expect(cls(argv)).toBe("delete");
  });

  test.each([
    ["find -delete", ["find", "~/.scratchpad", "-delete"]],
    ["find -exec rm", ["find", "~/.scratchpad", "-exec", "rm", "{}"]],
    ["shred", ["shred", "~/.scratchpad/secret.tmp"]],
  ])("%s is not on the list either — the rule is about operands, not the program", (_label, argv) => {
    expect(classifyHardline(argv)).toBeNull();
  });

  test.each([
    ["a find whose roots are elsewhere", ["find", "/var", "-name", "*.log", "-delete"]],
    ["a find with no root at all", ["find", "-delete"]],
    ["an -exec payload that reaches outside", ["find", "~/.scratchpad", "-exec", "rm", "/etc/passwd", ";"]],
  ])("%s is still on it", (_label, argv) => {
    expect(cls(argv)).toBe("delete");
  });

  test.each([
    ["predicates are not operands", ["find", "~/.scratchpad", "-name", "*.png", "-mtime", "+3", "-delete"]],
    ["-exec on the matched file", ["find", "~/.scratchpad", "-type", "f", "-exec", "rm", "{}", ";"]],
    ["-exec … +", ["find", "~/.scratchpad", "-exec", "shred", "{}", "+"]],
  ])("%s — find is judged on its roots, which is what find guarantees", (_label, argv) => {
    expect(classifyHardline(argv)).toBeNull();
  });

  test("an operand that is not in the scratchpad still lists the command", () => {
    // `dd` writes to devices, and the device is right there in the argv.
    expect(cls(["dd", "if=/dev/zero", "of=~/.scratchpad/x"])).toBe("delete");
  });

  test("a command with no operands is never exempt — there is nothing for a scratchpad to bound", () => {
    expect(cls(["crontab", "-r"])).toBe("delete");
    expect(cls(["poweroff"])).toBe("stop");
  });
});

describe("temp roots are disposable too", () => {
  test.each([
    ["a file in /tmp", ["rm", "-f", "/tmp/screen.png"]],
    ["a directory under it", ["rm", "-rf", "/tmp/build"]],
    ["a narrower glob", ["rm", "-f", "/tmp/*.png"]],
    ["a glob inside a subdirectory", ["rm", "-rf", "/tmp/build/*"]],
    ["/var/tmp, same convention", ["rm", "-rf", "/var/tmp/cache"]],
    ["the /private spelling macOS resolves to", ["rm", "-f", "/private/tmp/screen.png"]],
    ["what a Mac's $TMPDIR expands to", ["rm", "-f", "/var/folders/32/h0w7cq/T/screen.png"]],
    ["over ssh, which is where this mattered", ["ssh", "mac", "rm", "-rf", "/tmp/work"]],
  ])("%s is not on the list", (_label, argv) => {
    expect(classifyHardline(argv)).toBeNull();
  });

  test.each([
    ["the directory itself", ["rm", "-rf", "/tmp"]],
    ["the directory itself, spelled with a slash", ["rm", "-rf", "/tmp/"]],
    ["everything in it — other processes' sockets included", ["rm", "-rf", "/tmp/*"]],
    ["/var/tmp itself", ["rm", "-rf", "/var/tmp"]],
    ["climbing out of it", ["rm", "-rf", "/tmp/../etc"]],
    ["a lookalike that is not under it", ["rm", "-rf", "/tmpfoo"]],
    ["one operand outside it", ["rm", "-rf", "/tmp/a", "/etc"]],
  ])("%s still asks", (_label, argv) => {
    expect(cls(argv)).toBe("delete");
  });
});

describe("ordinary commands are on no list", () => {
  test.each([
    [["ls", "-la"]],
    [["git", "status"]],
    [["npm", "run", "build"]],
    [["bun", "test"]],
    [["cat", "README.md"]],
    [["mkdir", "-p", "src/lib"]],
    [["curl", "https://example.com"]],
    [["docker", "compose", "up", "-d"]],
    [["docker", "rm", "-f", "web"]],
    // `grep -r` matters here: a naive recursive-flag check would flag every recursive grep.
    [["grep", "-r", "TODO", "src"]],
    [["apt", "install", "jq"]],
    [["apt", "update"]],
  ])("%j", (argv) => {
    expect(classifyHardline(argv)).toBeNull();
  });

  test("empty argv is not listed — decideExec refuses it earlier", () => {
    expect(classifyHardline([])).toBeNull();
  });
});

describe("this daemon's own CLI", () => {
  test.each([
    ["answering an approval", ["nouride", "approvals", "allow-always"], "access"],
    ["answering a named approval", ["nouride", "approvals", "allow-once", "apr_123"], "access"],
    ["`approve`, which a 0.7.x CLI maps to allow-once itself", ["nouride", "approvals", "approve", "apr_123"], "access"],
    ["refusing on somebody's behalf", ["nouride", "approvals", "deny", "apr_123"], "access"],
    ["revoking a grant", ["nouride", "grants", "revoke", "--all"], "access"],
    ["pairing a sender", ["nouride", "access", "approve", "ABC123"], "access"],
    ["blocking a sender", ["nouride", "access", "block", "telegram:main:42"], "access"],
    ["opening access", ["nouride", "access", "mode", "open"], "access"],
    ["adding a person", ["nouride", "people", "set", "telegram:main:1", "--name", "Sam"], "people"],
    ["removing a person", ["nouride", "people", "remove", "sam"], "people"],
    ["pairing a sender as somebody known", ["nouride", "access", "approve", "ABC123", "--as", "gading"], "people"],
    ["pairing a sender as the approver", ["nouride", "access", "approve", "ABC123", "--me"], "people"],
    ["pairing a sender as somebody new", ["nouride", "access", "approve", "ABC123", "--new", "Sam"], "people"],
    ["minting an MCP token", ["nouride", "mcp-server", "token", "create", "--person", "me"], "access"],
    ["logging an MCP server in", ["nouride", "mcp", "login", "--agent", "nouva", "--server", "notion"], "access"],
    ["adding a gateway", ["nouride", "gateway", "add", "--platform", "telegram"], "config"],
    ["changing a provider", ["nouride", "providers", "set", "main", "--url", "https://x"], "config"],
    ["disabling an agent", ["nouride", "agent", "disable", "nox"], "config"],
    ["memory settings", ["nouride", "memory", "set", "facts", "on"], "config"],
    ["stopping the daemon", ["nouride", "stop"], "stop"],
    ["removing the service", ["nouride", "service", "uninstall"], "stop"],
    ["writing a secret", ["nouride", "secret", "set", "github", "--stdin"], "secret"],
    ["the plural alias", ["nouride", "secrets", "rm", "github"], "secret"],
    ["replacing the binary", ["nouride", "update", "--start"], "replace"],
    ["restoring the database", ["nouride", "db", "restore", "x.db"], "database"],
    ["a scheduled turn", ["nouride", "cron", "add", "--name", "x", "--every", "1h", "--message", "check the deploy"], "unattended"],
    ["a webhook", ["nouride", "webhook", "add", "--name", "x"], "unattended"],
    ["by the tool's absolute path", ["/srv/nouride/nouride", "approvals", "always"], "access"],
    ["inside a shell", ["sh", "-lc", "nouride approvals allow-always"], "access"],
    ["through an elevation", ["sudo", "nouride", "update", "--start"], "replace"],
  ])("%s is %s", (_label, argv, expected) => {
    expect({ argv, verdict: cls(argv as string[]) }).toEqual({ argv, verdict: expected as never });
  });

  test("a command put in a job is classified as itself, or as the job", () => {
    // A command job runs later with no model and no gate: one that would ask now asks when it is put there.
    expect(cls(["nouride", "cron", "add", "--name", "x", "--command", "nouride access allow telegram:main:9"])).toBe("access");
    expect(classifyHardline(["nouride", "cron", "add", "--command", "rm -rf /srv/data"])?.reason).toContain("scheduled");
    expect(cls(["nouride", "cron", "update", "j1", "--command", "whoami"])).toBe("unattended");
  });

  test("a command run as the daemon's user is classified as itself, its own state included", () => {
    expect(cls(["nouride", "tools", "run", "--", "sqlite3", "/srv/nouride/.nouride/data/nouride.db", ".dump"])).toBe("database");
    expect(cls(["nouride", "tools", "run", "--", "systemctl", "stop", "nouride"])).toBe("stop");
    // An install for every agent is asked under trusted too (0.8.1): its scripts run as the user that owns every pack.
    expect(cls(["nouride", "tools", "run", "--", "npm", "i", "-g", "x"])).toBe("shared-tools");
  });

  test("this machine's packages changed as root, through nouride-pkg — on the list again (0.8.15)", () => {
    // The 0.8.0 list left it out: every new agent is `balanced`, and one installed packages as root with nobody asked —
    // found when Nouride's image turned the package service on. Now it is asked every time.
    for (const argv of [
      ["nouride", "pkg", "install", "jq"],
      ["nouride", "pkg", "remove", "jq"],
      ["nouride", "pkg", "upgrade"],
      ["nouride", "pkg", "upgrade", "openssl"],
      ["nouride", "--json", "pkg", "install", "jq"],
      ["nouride", "pkg", "--json", "install", "jq"],
    ]) {
      expect({ argv, verdict: cls(argv) }).toEqual({ argv, verdict: "system-packages" });
    }
  });

  test("the words are read as the CLI dispatches them — `--json` taken off wherever it stands, `--flag=value` split", () => {
    // Read at fixed positions, `--json` stood where the verb was looked for: on no list, so `balanced` answered each of
    // these itself while the CLI ran it — an install for every agent, a shell job, an approval, another agent's CLI.
    for (const [argv, expected] of [
      [["nouride", "--json", "tools", "run", "--", "npm", "i", "-g", "x"], "shared-tools"],
      [["nouride", "tools", "--json", "run", "--", "npm", "i", "-g", "x"], "shared-tools"],
      [["nouride", "tools", "run", "--json", "--", "npm", "i", "-g", "x"], "shared-tools"],
      [["nouride", "--json", "cron", "add", "--command", "id"], "unattended"],
      [["nouride", "cron", "--json", "add", "--command", "id"], "unattended"],
      [["nouride", "--json", "approvals", "allow-always"], "access"],
      [["nouride", "approvals", "--json", "allow-always", "apr_1"], "access"],
      [["nouride", "--json", "agent", "external", "kuro", "claude-code"], "config"],
      [["nouride", "agent", "--json", "external", "kuro", "claude-code"], "config"],
      // `--json=approvals` is `--json approvals` to the CLI, and then `approvals`.
      [["nouride", "--json=approvals", "allow-always"], "access"],
      // A joined `--command=` is still the command the job runs.
      [["nouride", "cron", "add", "--command=nouride access allow telegram:main:9"], "access"],
      // `db` and `users` read their action as the first bare word, which `--` does not end.
      [["nouride", "db", "--", "restore", "x.db"], "database"],
      [["nouride", "users", "--", "reset", "admin"], "access"],
    ] as const) {
      expect({ argv, verdict: cls([...argv]) }).toEqual({ argv, verdict: expected });
    }
    // Reading stays ordinary under `--json`.
    expect(classifyHardline(["nouride", "--json", "approvals"])).toBeNull();
  });

  test("the read halves stay ordinary — listing is not deciding", () => {
    // An agent asked "what is waiting for me?" must not have to interrupt somebody to read the answer.
    for (const argv of [
      ["nouride", "status"],
      ["nouride", "approvals"],
      ["nouride", "grants", "--all"],
      ["nouride", "access", "pending"],
      ["nouride", "access", "mode"],
      ["nouride", "secret", "list"],
      ["nouride", "mcp-server", "token", "list"],
      ["nouride", "mcp", "search", "notion"],
      ["nouride", "service", "status"],
      ["nouride", "update"],
      ["nouride", "update", "--check"],
      ["nouride", "cron"],
      ["nouride", "cron", "rm", "j1"],
      ["nouride", "skills", "off", "x"],
      ["nouride", "restart"],
      // What it would change, the backend, the lists refreshed: nothing a person approves (0.8.15).
      ["nouride", "pkg"],
      ["nouride", "pkg", "status"],
      ["nouride", "pkg", "check", "install", "jq"],
      ["nouride", "pkg", "refresh"],
    ]) {
      expect({ argv, verdict: classifyHardline(argv) }).toEqual({ argv, verdict: null });
    }
  });

  test("`balanced` asks the access, config, stop and secret verbs, and answers the rest itself", () => {
    for (const argv of [["nouride", "approvals", "always"], ["nouride", "gateway", "rm", "x"], ["nouride", "stop"], ["nouride", "secret", "rm", "x"]]) {
      expect(autoApprovable(classifyHardline(argv)?.class)).toBe(false);
    }
    for (const argv of [["nouride", "update", "--start"], ["nouride", "cron", "add", "--message", "x"], ["nouride", "db", "adopt"]]) {
      expect(autoApprovable(classifyHardline(argv)?.class)).toBe(true);
    }
  });
});
