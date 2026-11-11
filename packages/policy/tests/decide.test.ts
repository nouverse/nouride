/**
 * The decision table, driven exhaustively.
 *
 * This is the file that decides whether a command runs on the operator's machine, so the tests
 * are written as a table over (blocked × fixed list × grant × everyday × canAsk × own state) rather than as narrative
 * cases — a gap in a narrative suite is invisible, a gap in a table is a missing row. Whether a question reaches a
 * person is the approval level's (`approvals.test.ts`); this is whether it is a question at all.
 */

import { describe, expect, test } from "bun:test";
import { decideExec, execGrantKey, resolveDecision } from "../src/index.ts";
import { EVERYDAY_PROGRAMS } from "../src/decide.ts";

function decide(
  argv: string[],
  options: { blocked?: string[]; grants?: string[]; canAsk?: boolean; cwd?: string; ownStateByOs?: boolean } = {},
) {
  const request = { argv, cwd: options.cwd ?? "/ws", agentId: "nouva" };
  return decideExec({
    policy: { blocked: options.blocked ?? [] },
    request,
    grantKey: execGrantKey(request),
    grants: new Set(options.grants ?? []),
    canAsk: options.canAsk ?? true,
    ownStateByOs: options.ownStateByOs ?? false,
  });
}

function keyFor(argv: string[], cwd = "/ws", agentId = "nouva"): string {
  return execGrantKey({ argv, cwd, agentId });
}

describe("blocked beats everything", () => {
  test("beats an everyday program", () => {
    expect(decide(["cat", "notes.txt"], { blocked: ["cat"] }).action).toBe("refuse");
  });

  test("beats a durable grant", () => {
    // Otherwise `allow-always` outvotes the operator's own config file, which inverts who is
    // actually in charge of the machine.
    const argv = ["curl", "example.com"];
    const outcome = decide(argv, { blocked: ["curl"], grants: [keyFor(argv)] });
    expect(outcome.action).toBe("refuse");
    expect(outcome.action === "refuse" && outcome.reason).toContain("curl");
  });

  test("matches on a substring of the whole command, not just the program", () => {
    expect(decide(["git", "push", "--force"], { blocked: ["--force"] }).action).toBe("refuse");
  });
});

describe("the fixed list", () => {
  test("asks, never grantable, with the entry it is on", () => {
    expect(decide(["rm", "-rf", "/var/lib/app"])).toMatchObject({ action: "ask", grantable: false, hardline: true, hardlineClass: "delete" });
    expect(decide(["git", "push", "--force", "origin", "feature"])).toMatchObject({ hardlineClass: "force-push" });
  });

  test("is never satisfied by a grant", () => {
    const argv = ["terraform", "destroy"];
    expect(decide(argv, { grants: [keyFor(argv)] })).toMatchObject({ action: "ask", grantable: false, hardlineClass: "teardown" });
  });

  test("refuses when nobody can be asked, carrying the question for the approval level", () => {
    const outcome = decide(["rm", "-rf", "/srv/data"], { canAsk: false });
    expect(outcome.action).toBe("refuse");
    expect(outcome.action === "refuse" && outcome.unasked).toMatchObject({ action: "ask", hardlineClass: "delete", grantable: false });
  });
});

describe("the daemon's own state", () => {
  const own = (path: string) => ["cat", path];

  test("is on the list where agents run as the daemon's user", () => {
    expect(decide(own("/srv/nouride/.nouride/config.toml"))).toMatchObject({ hardlineClass: "config", grantable: false });
    expect(decide(["sqlite3", "/srv/nouride/.nouride/data/nouride.db", ".tables"])).toMatchObject({ hardlineClass: "database" });
    // An agent's persona is an admin's to change, by a shell as by the persona tool (0.8.13); the rest of a pack is own state.
    expect(decide(own("/srv/nouride/.nouride/agents/nix/SOUL.md"))).toMatchObject({ hardlineClass: "persona" });
    expect(decide(own("/srv/nouride/.nouride/agents/nix/skills.toml"))).toMatchObject({ hardlineClass: "own-state" });
    // An agent's pack config is a config.toml like the daemon's, and a script that names only the directory is the
    // shape that rewrote every pack on the live install.
    expect(decide(own("/srv/nouride/.nouride/agents/nix/config.toml"))).toMatchObject({ hardlineClass: "config" });
    expect(decide(["python3", "-c", "d='/srv/nouride/.nouride/agents'"])).toMatchObject({ hardlineClass: "own-state" });
  });

  test("is not guessed at where each agent runs as its own user: the files' permissions answer", () => {
    expect(decide(own("/srv/nouride/.nouride/config.toml"), { ownStateByOs: true })).toEqual({ action: "run", via: "allowlist" });
    expect(decide(["sqlite3", "/srv/nouride/.nouride/data/nouride.db"], { ownStateByOs: true })).toMatchObject({ action: "ask", grantable: true });
  });

  test("a command on the list is reported by what it does, not what it touches", () => {
    expect(decide(["rm", "-rf", "/srv/nouride/.nouride/agents/nix"])).toMatchObject({ hardlineClass: "delete" });
  });
});

describe("grants", () => {
  test("a matching grant runs without asking", () => {
    const argv = ["git", "push"];
    expect(decide(argv, { grants: [keyFor(argv)] })).toEqual({ action: "run", via: "grant" });
  });

  test("a grant for a different cwd does not match", () => {
    const argv = ["git", "push"];
    expect(decide(argv, { grants: [keyFor(argv, "/elsewhere")] }).action).toBe("ask");
  });

  test("a grant for a different agent does not match", () => {
    const argv = ["git", "push"];
    expect(decide(argv, { grants: [keyFor(argv, "/ws", "nox")] }).action).toBe("ask");
  });

  test("a grant for a longer argv does not cover a shorter one", () => {
    expect(decide(["git", "push"], { grants: [keyFor(["git", "push", "origin"])] }).action).toBe("ask");
  });
});

describe("everyday programs", () => {
  test("run, by basename, arguments ignored", () => {
    expect(decide(["ls", "-la"])).toEqual({ action: "run", via: "allowlist" });
    expect(decide(["/usr/bin/cat", "README.md"])).toEqual({ action: "run", via: "allowlist" });
  });

  test("a shell whose every segment is one runs too", () => {
    expect(decide(["bash", "-lc", "ls -la && wc -l README.md"])).toEqual({ action: "run", via: "allowlist" });
    expect(decide(["bash", "-lc", "ls && curl example.com"]).action).toBe("ask");
  });

  test("leave out what prints the environment or mutates through flags", () => {
    for (const program of ["env", "printenv", "find", "xargs", "sed", "awk", "git"]) expect(Object.keys(EVERYDAY_PROGRAMS)).not.toContain(program);
  });

  /**
   * A flag that writes a file or runs a program makes an everyday program's command a new one. Until this was read per
   * program, `rg --pre=sh x notes.txt` ran a file as a script at `careful`, and `tree -o ~/.profile` overwrote the file
   * every login shell `exec` starts reads (found by a review, run against `decideExec` itself).
   */
  test("with a flag that runs a program or writes a file, is asked as a new command — however the flag is written", () => {
    const cases: string[][] = [
      ["rg", "--pre", "sh", "x", "."],
      ["rg", "--pre=sh", "x", "."],
      ["bash", "-lc", "rg --pre=sh x ./notes.txt"],
      ["rg", "--hostname-bin", "./x", "a"],
      ["rg", "-z", "a"],
      ["rg", "-nz", "a"],
      ["rg", "--search-zip", "a"],
      ["bash", "-lc", "tree -o ~/.profile"],
      ["tree", "-ao", "out.txt"],
      ["tree", "-R", "-L", "1"],
      ["date", "-s", "2020-01-01"],
      ["date", "--set=2020-01-01"],
      ["date", "--se", "2020-01-01"],
      ["date", "-us", "2020-01-01"],
      ["file", "-C", "-m", "magic"],
      ["file", "-z", "archive.gz"],
      ["bash", "-lc", "ls && tree -o /tmp/x"],
    ];
    for (const argv of cases) expect({ argv, outcome: decide(argv) }).toMatchObject({ argv, outcome: { action: "ask", grantable: true } });
  });

  test("and without one, runs as before: the flags that only read are not caught by a letter they share", () => {
    const cases: string[][] = [
      ["rg", "-n", "foo"],
      ["rg", "-e", "z", "."],
      ["rg", "-ez", "."],
      ["rg", "--pre-glob", "*.pdf", "x"],
      ["tree", "-L", "2"],
      ["date", "+%s"],
      ["date", "-Iseconds"],
      ["date", "-d", "yesterday"],
      ["file", "-m", "magic", "x"],
      ["bash", "-lc", "rg -n foo && tree -L 2 && date -u"],
    ];
    for (const argv of cases) expect({ argv, outcome: decide(argv) }).toEqual({ argv, outcome: { action: "run", via: "allowlist" } });
  });

  test("every program on the list was read for such flags: one added later lists them, or an empty list says it has none", () => {
    const programs = Object.keys(EVERYDAY_PROGRAMS);
    expect(programs.length).toBeGreaterThanOrEqual(20);
    for (const program of programs) expect({ program, flags: EVERYDAY_PROGRAMS[program]!.every((flag) => /^--?[A-Za-z]/.test(flag)) }).toEqual({ program, flags: true });
    // The ones that have them, each asked about in the table above.
    expect(programs.filter((program) => EVERYDAY_PROGRAMS[program]!.length > 0).sort()).toEqual(["date", "file", "rg", "tree"]);
  });

  test("touching a credential path is a new command, whatever the program — asked once, grantable", () => {
    // `cat` is everyday; `cat /proc/<pid>/environ` ran unasked once and put the daemon's .env in the model's context.
    for (const path of ["/proc/1234/environ", "/home/u/.ssh/id_ed25519", ".env", "$NOURIDE_CREDENTIALS_DIR/token.json"]) {
      expect(decide(["cat", path])).toMatchObject({ action: "ask", grantable: true });
      expect(decide(["cat", path])).not.toHaveProperty("hardlineClass");
    }
    const argv = ["cat", ".env"];
    expect(decide(argv, { grants: [keyFor(argv)] })).toEqual({ action: "run", via: "grant" });
  });

  test("a credential path inside a shell's script, or after a flag's =, is read as one too", () => {
    // Read whole, `cat .env` held `.env` after a space, and the patterns anchored at a word's start did not see it.
    for (const argv of [["bash", "-lc", "cat .env"], ["bash", "-lc", "ls && cat ~/.ssh/id_ed25519"], ["grep", "--file=.env", "x"]]) {
      expect({ argv, outcome: decide(argv) }).toMatchObject({ argv, outcome: { action: "ask", grantable: true } });
    }
    expect(decide(["bash", "-lc", "cat environment.md && ls .envrc-notes"])).toEqual({ action: "run", via: "allowlist" });
  });
});

describe("anything else", () => {
  test("asks the first time, grantable, on no list", () => {
    const outcome = decide(["git", "push"]);
    expect(outcome).toMatchObject({ action: "ask", grantable: true, reason: "first time this agent has run this command" });
    expect(outcome).not.toHaveProperty("hardlineClass");
  });

  test("an elevation on its own is one of them, not the list", () => {
    expect(decide(["sudo", "cat", "/var/log/syslog"])).toMatchObject({ action: "ask", grantable: true });
  });
});

describe("nobody to ask", () => {
  test("an everyday program still runs", () => {
    expect(decide(["ls"], { canAsk: false })).toEqual({ action: "run", via: "allowlist" });
  });

  test("a new command is refused, carrying the question it stands in for", () => {
    const outcome = decide(["git", "push"], { canAsk: false });
    expect(outcome.action).toBe("refuse");
    expect(outcome.action === "refuse" && outcome.unasked).toMatchObject({ action: "ask", grantable: true });
  });

  test("a refusal that does not depend on who is asked carries no question", () => {
    const outcome = decide(["curl", "x"], { canAsk: false, blocked: ["curl"] });
    expect(outcome).toEqual({ action: "refuse", reason: 'blocked by this agent\'s configuration: "curl"' });
  });
});

describe("empty argv", () => {
  test("is refused, not run", () => {
    expect(decide([]).action).toBe("refuse");
  });
});

describe("resolveDecision", () => {
  test("allow-once runs and persists nothing", () => {
    expect(resolveDecision("allow-once", true)).toEqual({
      run: true,
      persist: false,
      downgraded: false,
    });
  });

  test("allow-always on a grantable ask persists", () => {
    expect(resolveDecision("allow-always", true)).toEqual({
      run: true,
      persist: true,
      downgraded: false,
    });
  });

  test("allow-always on a non-grantable ask runs once and reports the downgrade", () => {
    // It must still run: refusing the answer would strand the turn on a technicality the
    // operator cannot see from the chat.
    expect(resolveDecision("allow-always", false)).toEqual({
      run: true,
      persist: false,
      downgraded: true,
    });
  });

  test("deny never runs", () => {
    for (const grantable of [true, false]) {
      expect(resolveDecision("deny", grantable).run).toBe(false);
    }
  });
});
