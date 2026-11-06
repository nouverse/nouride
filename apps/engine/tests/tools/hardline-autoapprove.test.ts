/**
 * The fixed list's flag and class survive `exec`'s gate, which is what the approval level reads them through.
 *
 * `decideExec` marks a command on the list with `hardline: true` and its class; the executor reads the class to decide
 * whether the level answers it (`skipsApproval`). But `exec`'s `gate()` once rebuilt the decision object on the way out
 * and dropped the field, so every listed command became answerable the moment a level answered anything — found on a
 * live box, where an agent asked to read a planted credential file did, in 2ms, with no prompt. This file's job is the
 * layer below the level: the flag and its class must reach the executor at all.
 */

import { describe, expect, test } from "bun:test";
import { createExecTool } from "@/modules/tools/builtins/exec.ts";
import type { ToolContext } from "@nouride/shared";

function gateFor(argv: string[], canAsk = true) {
  const tool = createExecTool({
    timeoutMs: 300_000,
    maxOutputBytes: 65_536,
    blocked: [],
    policy: { blocked: [] },
    canAsk: () => canAsk,
  });
  const ctx = {
    agentId: "nouva",
    workspaceDir: "/w",
    workspaceRoots: ["/w"],
    agentDir: "/pack",
  } as unknown as ToolContext;
  return tool.gate!({ command: argv }, ctx);
}

const field = (d: object, name: string) => (d as Record<string, unknown>)[name];

describe("the gate carries the fixed list through", () => {
  test("a command on it asks, never grantable, with its class", () => {
    const d = gateFor(["rm", "-rf", "/w/../var/lib/app"]);
    expect(d).toMatchObject({ action: "ask", grantable: false, hardline: true, hardlineClass: "delete" });
  });

  test("the class is what the level reads: what an elevation runs, not that it elevates", () => {
    expect(field(gateFor(["sudo", "systemctl", "stop", "nouride"]), "hardlineClass")).toBe("stop");
    // An elevation of something ordinary is a new command: asked once under careful, remembered, no class.
    const elevated = gateFor(["sudo", "cat", "/var/log/syslog"]);
    expect(elevated).toMatchObject({ action: "ask", grantable: true });
    expect(field(elevated, "hardlineClass")).toBeUndefined();
  });

  test("a credential path is a new command: asked once, remembered, on no list", () => {
    const d = gateFor(["cat", "/srv/nouride/.nouride/data/credentials/service_account.json"]);
    expect(d).toMatchObject({ action: "ask", grantable: true });
    expect(field(d, "hardline")).toBeUndefined();
    expect(field(d, "hardlineClass")).toBeUndefined();
  });

  test("the daemon's own state, where agents run as the daemon's user — this process has no helper", () => {
    const database = gateFor(["sqlite3", "/srv/nouride/.nouride/data/nouride.db", ".tables"]);
    expect(database).toMatchObject({ action: "ask", grantable: false, hardlineClass: "database" });
    // The store is past asking since 0.7.17: refused to every command, at every level (`tests/tools/own-secrets.test.ts`).
    expect(gateFor(["cat", "/srv/nouride/.nouride/data/secrets.json"]).action).toBe("refuse");

    /**
     * The live incident, as a test.
     *
     * `read` refused `/srv/nouride/.nouride/agents/nix/config.toml` as outside the workspace, and eight seconds later
     * this exact shape — a whole script in one `python3 -c` argument — rewrote every agent pack's config in 21ms with
     * no prompt. The path is inside a string literal inside the script, which is why the classifier tests whole
     * arguments rather than things that parse as paths.
     */
    const script = gateFor([
      "python3",
      "-c",
      "for a in os.listdir('/srv/nouride/.nouride/agents'):\n"
        + "    open('/srv/nouride/.nouride/agents/' + a + '/config.toml', 'w').write(block)\n",
    ]);
    expect(script).toMatchObject({ action: "ask", grantable: false });
    expect(["config", "own-state"]).toContain(field(script, "hardlineClass") as string);
  });

  test("the workspace under the same install directory is not swept up with it", () => {
    // The false-positive half, and the one that decides whether this gate survives: an agent does all of its actual
    // work under `.nouride/workspace/`.
    expect(gateFor(["ls", "/srv/nouride/.nouride/workspace/shared"]).action).toBe("run");
    expect(gateFor(["cat", "/srv/nouride/.nouride/workspace/shared/notes.md"]).action).toBe("run");
    // And an ordinary project's config.toml is not this daemon's.
    expect(gateFor(["cat", "/opt/projects/thing/config.toml"]).action).toBe("run");
  });
});

describe("with nobody to ask", () => {
  test("a command on the list is refused, carrying its question for the level", () => {
    const d = gateFor(["sudo", "rm", "-rf", "/"], false);
    expect(d.action).toBe("refuse");
    expect(field(d, "unasked")).toMatchObject({ hardline: true, hardlineClass: "delete" });
  });
});
