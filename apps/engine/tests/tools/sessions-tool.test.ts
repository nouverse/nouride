/**
 * Processes kept open so the agent can answer a prompt.
 *
 * The shape `exec` cannot reach: a program that asks something back. With stdin closed, `sudo` waiting
 * for a password is indistinguishable from a hang, and the timeout is the only thing that ends it.
 *
 * These run real processes — `cat`, `sh`, `sleep` — because the property under test is what happens
 * between a write and the output that follows it, and a fake would be asserting on the fake.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ApprovalLevel, GateAsk, Tool, ToolCall, ToolContext } from "@nouride/shared";
import { ToolCaller } from "@/modules/llm/executor/tool-caller.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { fakeAgent } from "../helpers.ts";
import {
  activeSessionCount,
  closeAllSessions,
  createSessionTool,
} from "@/modules/tools/builtins/sessions.ts";
import { commandEnv, findBlocked, normalizeCommand, resolveCwd } from "@/modules/tools/builtins/exec.ts";
import { sleep } from "../wait.ts";

// Per run, not a fixed name: two suites at once shared it and deleted each other's files.
const dir = mkdtempSync(join(tmpdir(), "nouride-sessions-"));

/** Wired exactly as the registry wires it — the point is that both share one sandbox. */
const tool = createSessionTool({
  normalizeCommand,
  resolveCwd,
  env: (ctx) => commandEnv(ctx),
  findBlocked: (argv) => findBlocked(argv, ["forbidden"]) ?? undefined,
});

function ctx(agentId = "nouva"): ToolContext {
  return {
    agentId,
    sessionId: "s",
    chatId: "c",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "u",
    workspaceDir: dir,
    agentDir: dir,
    workspaceRoots: [dir],
    signal: new AbortController().signal,
  } as ToolContext;
}

/**
 * What a session has printed, read until `want` is in it or five seconds pass.
 *
 * `start` and `send` return on a short quiet period — 500 ms for the first output — and that is the tool's contract:
 * without a PTY nothing says a program is waiting, and `read` is how the agent waits longer. So on a loaded machine
 * the line lands after them, and asserting it lands inside that window asserts on machine speed: "a session's
 * environment" failed that way once under a full `bun run verify`, at 509 ms. A `read` answers at once, so it is
 * asked again after a pause, never in a tight loop.
 */
async function readUntil(on: Tool, id: string, first: string, want: string): Promise<string> {
  let printed = first;
  for (const deadline = Date.now() + 5_000; !printed.includes(want) && Date.now() < deadline; ) {
    await sleep(25);
    const more = (await on.execute({ action: "read", id }, ctx())).content;
    if (!more.startsWith("(nothing new)")) printed += more;
  }
  return printed;
}

afterEach(() => {
  closeAllSessions();
});

// `afterAll`, not a bare call at the end of the file: module bodies run before any test does, so a
// top-level cleanup deletes the working directory out from under everything.
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * `wait`, and the bug that produced it.
 *
 * On 2026-09-04 an agent was driving a Remotion render through an interactive PowerShell. `send`
 * returns after 500ms of quiet, `read` returns instantly — so to wait for a render it ran
 * `exec ["sleep","30"]`, which `exec` kills at exactly `tool_timeout_ms`. Every one of those calls
 * came back `error: true` at 30001ms: a wait that always failed by a millisecond, three times, each
 * costing an iteration and a tenth of the five-minute turn.
 */
describe("session wait", () => {
  test("it waits for output that arrives later than send would ever have waited", async () => {
    // 1.2s is past `FIRST_OUTPUT_TIMEOUT_MS` (500ms) by enough that `send` provably cannot see it,
    // which is the whole gap this action fills.
    const started = await tool.execute(
      { action: "start", command: ["sh", "-c", "sleep 1.2; echo done-late"] },
      ctx(),
    );
    const id = started.metadata?.session as string;
    expect(started.content).not.toContain("done-late");

    const waited = await tool.execute({ action: "wait", id, timeout_ms: 8000 }, ctx());
    expect(waited.content).toContain("done-late");
    expect(waited.metadata?.reason).toBe("exited");
  });

  test("it returns on quiet without waiting out the whole timeout", async () => {
    /**
     * The property that makes it usable rather than just correct. A build that finishes in ten
     * seconds must not hold the turn for the sixty it was allowed — that would spend the turn's clock
     * on nothing, which is the failure it replaces.
     */
    const started = await tool.execute({ action: "start", command: ["sh"] }, ctx());
    const id = started.metadata?.session as string;

    const began = Date.now();
    await tool.execute({ action: "send", id, input: "echo first" }, ctx());
    const waited = await tool.execute(
      { action: "wait", id, timeout_ms: 30_000, quiet_ms: 400 },
      ctx(),
    );
    const elapsed = Date.now() - began;

    expect(waited.metadata?.reason).toBe("quiet");
    // Generous, because the assertion is "it did not wait out 30s", not a benchmark.
    expect(elapsed).toBeLessThan(8000);
  });

  test("a cancelled turn cuts the wait short and says so", async () => {
    /**
     * The bound that matters, and it is not a number this action chose. `exec` has
     * `tool_timeout_ms`; this deliberately has no equivalent, because a render legitimately takes
     * minutes. What stops it is the turn's own signal — the deadline, or somebody pressing stop —
     * and it has to *say* it was stopped: reporting "still running after 600s" for a cancelled turn
     * sends the reader hunting a slow command that was never slow.
     */
    const started = await tool.execute({ action: "start", command: ["sh", "-c", "sleep 60"] }, ctx());
    const id = started.metadata?.session as string;

    const controller = new AbortController();
    const cancelling = { ...ctx(), signal: controller.signal } as ToolContext;
    setTimeout(() => controller.abort(), 300);

    const began = Date.now();
    const waited = await tool.execute({ action: "wait", id, timeout_ms: 600_000 }, cancelling);
    expect(waited.metadata?.reason).toBe("cancelled");
    expect(waited.content).toContain("turn was stopped");
    expect(Date.now() - began).toBeLessThan(5000);
  });

  test("waiting on a process that already exited is not an error", async () => {
    // The model does not know the render finished during the previous call. Failing here would teach
    // it to check `read` before every `wait`, which is the extra round-trip this removes.
    const started = await tool.execute({ action: "start", command: ["sh", "-c", "echo quick"] }, ctx());
    const id = started.metadata?.session as string;
    for (let i = 0; i < 40; i += 1) {
      const r = await tool.execute({ action: "read", id }, ctx());
      if (r.metadata?.running === false) break;
      await sleep(25);
    }

    const waited = await tool.execute({ action: "wait", id, timeout_ms: 1000 }, ctx());
    expect(waited.isError).toBe(false);
    expect(waited.metadata?.running).toBe(false);
  });

  test("it needs no approval, because waiting changes nothing", async () => {
    // `start` and `send` ask; `read`, `list`, `close` do not. A wait that prompted would be an
    // approval for the absence of an action, and the agent would go back to `sleep` to avoid it.
    expect(tool.gate?.({ action: "wait", id: "x" }, ctx())).toMatchObject({ action: "run" });
  });
});

describe("session", () => {
  test("starts a process and reads what it says back", async () => {
    // `cat` is the smallest thing that proves the loop: whatever goes in comes out, and only after it
    // has been sent.
    const started = await tool.execute({ action: "start", command: ["cat"] }, ctx());
    expect(started.isError).toBe(false);
    const id = started.metadata?.session as string;
    expect(id).toBeTruthy();

    const sent = await tool.execute({ action: "send", id, input: "hello there" }, ctx());
    expect(await readUntil(tool, id, sent.content, "hello there")).toContain("hello there");
  });

  test("a prompt with no newline is still delivered", async () => {
    // The reason this tool exists rather than reusing `spawnLongLived`: that one iterates lines, and a
    // `Password: ` prompt has no newline — so a line reader waits for a terminator that only arrives
    // after the answer it was supposed to prompt for.
    //
    // Polled rather than asserted on the first answer, because that is the tool's actual contract:
    // without a PTY there is no way to know a program is waiting for input, so `start` returns on a
    // short quiet period and `read` is how you wait longer. Asserting the prompt always lands inside
    // that window is asserting on machine speed — it passed alone and failed under a full suite.
    const started = await tool.execute(
      { action: "start", command: ["sh", "-c", "printf 'Password: '; read x; echo \"got:$x\""] },
      ctx(),
    );
    const id = started.metadata?.session as string;

    expect(await readUntil(tool, id, started.content, "Password:")).toContain("Password:");

    const sent = await tool.execute({ action: "send", id, input: "hunter2" }, ctx());
    expect(await readUntil(tool, id, sent.content, "got:hunter2")).toContain("got:hunter2");
  });

  test("close ends it, and the id stops working", async () => {
    const started = await tool.execute({ action: "start", command: ["cat"] }, ctx());
    const id = started.metadata?.session as string;

    expect(await tool.execute({ action: "close", id }, ctx())).toMatchObject({ isError: false });
    expect(await tool.execute({ action: "read", id }, ctx())).toMatchObject({ isError: true });
  });

  test("writing to a process that has exited says so instead of hanging", async () => {
    const started = await tool.execute({ action: "start", command: ["sh", "-c", "exit 0"] }, ctx());
    const id = started.metadata?.session as string;

    const sent = await tool.execute({ action: "send", id, input: "anything" }, ctx());
    expect(sent.isError).toBe(true);
    expect(sent.content).toContain("exited");
  });

  test("one agent cannot touch another's session", async () => {
    const started = await tool.execute({ action: "start", command: ["cat"] }, ctx("nouva"));
    const id = started.metadata?.session as string;

    // Reported as "no such session", not "not yours": the second phrasing confirms it exists.
    const stolen = await tool.execute({ action: "read", id }, ctx("other"));
    expect(stolen.isError).toBe(true);
    expect(stolen.content).not.toContain("not yours");
  });

  test("the per-agent limit refuses rather than queues", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await tool.execute({ action: "start", command: ["cat"] }, ctx())).toMatchObject({
        isError: false,
      });
    }
    const fourth = await tool.execute({ action: "start", command: ["cat"] }, ctx());
    expect(fourth.isError).toBe(true);
    expect(fourth.content).toContain("limit");
  });

  test("blocked patterns apply here exactly as they do to exec", async () => {
    // Two sandboxes would be two chances to disagree, and the one that drifts is the one nobody is
    // looking at.
    const result = await tool.execute({ action: "start", command: ["forbidden", "--now"] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked");
  });

  test("the workspace boundary applies to cwd", async () => {
    const result = await tool.execute(
      { action: "start", command: ["cat"], cwd: "/etc" },
      ctx(),
    );
    expect(result.isError).toBe(true);
  });

  test("start and send ask; read, list and close do not", () => {
    // A session is a live process accepting arbitrary input. Approving `ssh prod` once and then
    // typing freely into it would be a weaker gate than `exec` has, not a stronger one.
    expect(tool.gate?.({ action: "start" }, ctx())).toMatchObject({ action: "ask" });
    expect(tool.gate?.({ action: "send" }, ctx())).toMatchObject({ action: "ask" });
    expect(tool.gate?.({ action: "read" }, ctx())).toMatchObject({ action: "run" });
    expect(tool.gate?.({ action: "list" }, ctx())).toMatchObject({ action: "run" });
    expect(tool.gate?.({ action: "close" }, ctx())).toMatchObject({ action: "run" });
  });

  test("neither start nor send is grantable", () => {
    // "Always allow typing into this process" is the gate turned off for whatever the process turns
    // out to be.
    expect(tool.gate?.({ action: "start" }, ctx())).toMatchObject({ grantable: false });
    expect(tool.gate?.({ action: "send" }, ctx())).toMatchObject({ grantable: false });
  });

  test("list shows only this agent's sessions", async () => {
    await tool.execute({ action: "start", command: ["cat"] }, ctx("nouva"));
    await tool.execute({ action: "start", command: ["cat"] }, ctx("other"));

    const mine = await tool.execute({ action: "list" }, ctx("nouva"));
    expect(mine.metadata).toMatchObject({ count: 1 });
  });

  test("shutdown closes everything", async () => {
    await tool.execute({ action: "start", command: ["cat"] }, ctx());
    await tool.execute({ action: "start", command: ["cat"] }, ctx("other"));
    expect(activeSessionCount()).toBe(2);

    expect(closeAllSessions()).toBe(2);
    expect(activeSessionCount()).toBe(0);
  });

  test("an unknown action is refused by name", async () => {
    expect(await tool.execute({ action: "detonate" }, ctx())).toMatchObject({ isError: true });
  });
});

/**
 * A session's program gets what a command gets. It used to get the bare allowlist: no `TMPDIR`, none of
 * the agent's credentials, so a program run in a session behaved differently from the same one in `exec`.
 */
describe("a session's environment", () => {
  test("is exec's own: the scratchpad as TMPDIR, and the agent's credentials", async () => {
    const withEnv = createSessionTool({
      normalizeCommand,
      resolveCwd,
      env: (toolCtx) => commandEnv(toolCtx, { DEPLOY_TOKEN: "from-exec-secrets" }),
      findBlocked: () => undefined,
    });
    const started = await withEnv.execute(
      { action: "start", command: "echo \"tmp=$TMPDIR token=$DEPLOY_TOKEN\"; cat" },
      { ...ctx(), scratchpadDir: join(dir, ".scratchpad") },
    );
    expect(started.isError).toBe(false);
    const printed = await readUntil(withEnv, started.metadata?.session as string, started.content, "token=");
    expect(printed).toContain(`tmp=${join(dir, ".scratchpad")}`);
    expect(printed).toContain("token=from-exec-secrets");
  });
});

/**
 * The level, not just the word "ask" (S1, 2026-10-15).
 *
 * The gate always said `ask`, and the test above always passed — while at `balanced`, the default level,
 * `ToolCaller` auto-approved every one of them: `skipsApproval("balanced", undefined)` is true, and the
 * ask carried no class. So `session start bash` ran with no prompt, holding the agent's
 * `exec_secrets`. These drive the real gate through the real executor, with a recorder where a person
 * would be, so the property asserted is the one that broke.
 */
describe("whether a person is asked, at each approval level", () => {
  async function underLevel(level: ApprovalLevel, args: Record<string, unknown>): Promise<{ asked: boolean; ran: boolean }> {
    let asked = false;
    let ran = false;
    // The real gate in front of an `execute` that spawns nothing: what is under test is the decision.
    const standIn: Tool = {
      ...tool,
      async execute() {
        ran = true;
        return { content: "ran", isError: false };
      },
    };
    const toolset = {
      definitions: [tool.definition],
      get: (name: string) => (name === "session" ? standIn : undefined),
      requiresApproval: () => true,
      parallelSafe: () => false,
      gate: (_name: string, callArgs: Record<string, unknown>, callCtx: ToolContext) => tool.gate!(callArgs, callCtx),
      blockedPatterns: [],
    };
    const approvals = {
      request: async () => {
        asked = true;
        return { status: "denied" as const };
      },
    };
    const caller = new ToolCaller({ approvalLevel: () => level, approvals } as unknown as ExecutorDeps);
    const req = { toolset, agent: fakeAgent(), sessionId: "s", chatId: "c", gateway: "web", gatewayId: "web:dashboard", senderId: "u", chatType: "dm" } as unknown as TurnRequest;
    const call: ToolCall = { id: "c1", name: "session", arguments: args };
    await caller.run(req, call, 4_000);
    return { asked, ran };
  }

  test("careful asks before starting a session, and before every line typed into one", async () => {
    expect(await underLevel("careful", { action: "start", command: ["bash"] })).toEqual({ asked: true, ran: false });
    expect(await underLevel("careful", { action: "send", id: "sess_1", input: "ls" })).toEqual({ asked: true, ran: false });
  });

  test("balanced answers it itself — `interactive` is careful's — unless what is typed is one balanced asks", async () => {
    expect(await underLevel("balanced", { action: "start", command: ["bash"] })).toEqual({ asked: false, ran: true });
    expect(await underLevel("balanced", { action: "send", id: "sess_1", input: "systemctl stop nouride" })).toEqual({ asked: true, ran: false });
  });

  test("trusted answers for it — that is the whole definition of trusted", async () => {
    expect(await underLevel("trusted", { action: "start", command: ["bash"] })).toEqual({ asked: false, ran: true });
  });

  test("read, list and close still run unasked at every level", async () => {
    for (const level of ["careful", "balanced"] as const) {
      expect(await underLevel(level, { action: "list" })).toEqual({ asked: false, ran: true });
    }
  });
});

describe("what the prompt and the audit row are told", () => {
  test("a session is classed interactive", () => {
    expect(tool.gate?.({ action: "start", command: ["bash"] }, ctx())).toMatchObject({ hardline: true, hardlineClass: "interactive" });
    expect(tool.gate?.({ action: "send", id: "sess_1", input: "ls -la" }, ctx())).toMatchObject({ hardlineClass: "interactive" });
  });

  test("something more specific in what is about to run is named instead", () => {
    // "A recursive delete" is what the person deciding needs to read, not "a session".
    const start = tool.gate?.({ action: "start", command: ["rm", "-rf", "/srv/data"] }, ctx());
    expect(start).toMatchObject({ hardlineClass: "delete" });
    expect((start as GateAsk).reason).toContain("recursive delete");

    // The daemon's own state, where the session runs as the daemon's user — as this test process has no helper.
    const send = tool.gate?.({ action: "send", id: "sess_1", input: "sqlite3 /srv/nouride/.nouride/data/nouride.db" }, ctx());
    expect(send).toMatchObject({ hardlineClass: "database" });
  });

  test("an elevation on its own is still a session: `sudo -i` is the one most worth asking about", () => {
    expect(tool.gate?.({ action: "start", command: ["sudo", "-i"] }, ctx())).toMatchObject({ hardlineClass: "interactive" });
  });
});
